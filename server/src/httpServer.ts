import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import * as crypto from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';

import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type {
  AssetCache,
  ReloadAssetsSideEffect,
  SetHooksEnabledSideEffect,
} from './clientMessageHandler.js';
import { handleClientMessage } from './clientMessageHandler.js';
import { HOOK_API_PREFIX, MAX_HOOK_BODY_SIZE } from './constants.js';
import type { OrgStore } from './orgStore.js';
import type { HermesProvider } from './providers/hermes/hermesProvider.js';
import type { AgentState } from './types.js';

/** Options for creating the HTTP + WebSocket server. */
export interface HttpServerOptions {
  /** true = VS Code embedded mode (ephemeral port, no static, quiet logging) */
  embedded: boolean;
  /** Host to bind to. Default: '127.0.0.1' */
  host?: string;
  /** Port to listen on. Default: 0 (auto-assign) */
  port?: number;
  /** Bearer auth token for hook and WebSocket endpoints */
  token: string;
  /** AgentStateStore for WebSocket broadcast piping */
  store: AgentStateStore;
  /** Shared agent lifecycle core (for toggle side effects + standalone restore). Optional in embedded mode. */
  runtime?: AgentRuntime;
  /** Path to SPA dist directory for static serving (standalone only) */
  staticDir?: string;
  /** Cached assets loaded at startup (standalone only) */
  assetCache?: AssetCache;
  /** Hermes Organization graph store (present only when the Hermes bridge is enabled) */
  orgStore?: OrgStore;
  /** Hermes bridge provider (present only when the bridge is enabled) */
  hermesProvider?: HermesProvider;
  /** Callback when a hook event is received */
  onHookEvent?: (providerId: string, event: Record<string, unknown>) => void;
  /** Invoked when setHooksEnabled is toggled via WebSocket. Standalone installs/uninstalls hooks here. */
  onSetHooksEnabled?: SetHooksEnabledSideEffect;
  /** Invoked when an external asset directory is added/removed. Standalone reloads + re-broadcasts assets here. */
  onReloadAssets?: ReloadAssetsSideEffect;
}

/** Result of createHttpServer(). */
export interface HttpServerHandle {
  app: FastifyInstance;
  port: number;
}

const startTime = Date.now();

/**
 * Create a Fastify server with hook endpoint, health check, and WebSocket support.
 *
 * All Fastify-specific code lives in this file. The rest of the server layer is
 * framework-agnostic. If Fastify is ever replaced, only this file changes.
 */
export async function createHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const app = Fastify({
    logger: !options.embedded,
    bodyLimit: MAX_HOOK_BODY_SIZE,
  });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  // Static SPA serving (standalone mode only)
  if (!options.embedded && options.staticDir) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: '/',
    });
    // HTML5 history fallback applies only to browser navigation. Unknown API
    // paths must remain real 404s so retired/invalid contracts cannot masquerade
    // as successful HTML responses.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        reply.code(404).send({ error: 'not-found' });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  // ── Routes ──────────────────────────────────────────────────

  registerHealthRoute(app);
  registerModelControlPlaneRoutes(app);
  registerOrgRoutes(app, options);
  registerHookRoute(app, options);
  registerWebSocketRoute(app, options);

  // ── Listen ──────────────────────────────────────────────────

  await app.listen({ host: options.host ?? '127.0.0.1', port: options.port ?? 0 });
  const address = app.server.address();
  const port = typeof address === 'object' ? (address?.port ?? 0) : 0;

  return { app, port };
}

// ── Health ──────────────────────────────────────────────────────

function registerHealthRoute(app: FastifyInstance): void {
  app.get('/api/health', async () => ({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    pid: process.pid,
  }));
}

// ── Model Control Plane adapter ─────────────────────────────────

function modelControlPlaneUrl(): string | null {
  const value = process.env['MODEL_CONTROL_PLANE_URL']?.trim();
  return value ? value.replace(/\/$/, '') : null;
}

export function registerModelControlPlaneRoutes(app: FastifyInstance): void {
  const baseUrl = modelControlPlaneUrl();
  if (!baseUrl) return;

  const proxyJson = async (
    path: string,
    reply: FastifyReply,
    notFoundError?: string,
  ): Promise<unknown> => {
    try {
      const response = await fetch(`${baseUrl}${path}`);
      if (!response.ok) {
        reply.code(response.status === 404 && notFoundError ? 404 : 502);
        return {
          error:
            response.status === 404 && notFoundError
              ? notFoundError
              : 'model-control-plane-v2-unavailable',
          status: response.status,
        };
      }
      return await response.json();
    } catch (error) {
      reply.code(502);
      return { error: 'model-control-plane-v2-unavailable', message: String(error) };
    }
  };

  app.get('/api/model/v2/workforce', async (_request, reply) =>
    proxyJson('/api/v2/projections/workforce', reply),
  );

  app.get('/api/model/v2/projections/office', async (_request, reply) =>
    proxyJson('/api/v2/projections/office', reply),
  );

  app.get('/api/model/v2/incidents', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const key of ['lifecycle', 'runId', 'positionId', 'limit']) {
      const value = query?.[key];
      if (typeof value === 'string') params.set(key, value);
      else if (typeof value === 'number') params.set(key, String(value));
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return proxyJson(`/api/v2/incidents${suffix}`, reply);
  });

  app.get<{ Params: { employeeId: string } }>(
    '/api/model/v2/employees/:employeeId/dossier',
    async (request, reply) =>
      proxyJson(
        `/api/v2/projections/employees/${encodeURIComponent(request.params.employeeId)}/dossier`,
        reply,
        'model-control-plane-v2-employee-not-found',
      ),
  );

  app.get('/api/model/v2/events', async (request, reply) => {
    const controller = new AbortController();
    request.raw.on('close', () => controller.abort());
    try {
      const lastEventId = request.headers['last-event-id'];
      const response = await fetch(`${baseUrl}/api/v2/events`, {
        signal: controller.signal,
        headers: typeof lastEventId === 'string' ? { 'Last-Event-ID': lastEventId } : undefined,
      });
      if (!response.ok || !response.body) {
        reply.code(502).send({ error: 'model-control-plane-v2-events-unavailable' });
        return;
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          const id = chunk
            .split('\n')
            .find((line) => line.startsWith('id: '))
            ?.slice(4);
          const data = chunk.split('\n').filter((line) => line.startsWith('data: '));
          for (const line of data) {
            if (id) reply.raw.write(`id: ${id}\n`);
            reply.raw.write(`data: ${line.slice(6)}\n\n`);
          }
        }
      }
      reply.raw.end();
    } catch (error) {
      if (!controller.signal.aborted && !reply.raw.headersSent) {
        reply
          .code(502)
          .send({ error: 'model-control-plane-v2-events-unavailable', message: String(error) });
      }
    }
  });
}

// ── Organization read API ──────────────────────────────────────

function registerOrgRoutes(app: FastifyInstance, options: HttpServerOptions): void {
  if (!options.orgStore) return;

  app.get('/api/org/snapshot', async () => options.orgStore!.snapshot());
  app.get('/api/org/runs', async () => ({ runs: [...options.orgStore!.runs.values()] }));
  app.get<{ Params: { runId: string } }>('/api/org/graph/:runId', async (request) => {
    const runId = decodeURIComponent(request.params.runId);
    return { runId, ...options.orgStore!.getGraph(runId) };
  });
}

// ── Hook Events ────────────────────────────────────────────────

function registerHookRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.post<{
    Params: { providerId: string };
    Body: Record<string, unknown>;
  }>(
    `${HOOK_API_PREFIX}/:providerId`,
    {
      preHandler: bearerAuth(options.token),
      schema: {
        params: {
          type: 'object',
          properties: {
            providerId: { type: 'string', pattern: '^[a-z0-9-]+$' },
          },
          required: ['providerId'],
        },
      },
    },
    async (request, reply) => {
      const { providerId } = request.params;
      const event = request.body;

      if (event.session_id && event.hook_event_name) {
        options.onHookEvent?.(providerId, event);
      }

      reply.send('ok');
    },
  );
}

// ── WebSocket ──────────────────────────────────────────────────

function registerWebSocketRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.get('/ws', { websocket: true }, (socket, request) => {
    // In standalone mode (not embedded), skip auth for WebSocket connections.
    // The server binds to 127.0.0.1, so only local clients can connect.
    // In embedded mode (VS Code), require Bearer token for security.
    if (options.embedded) {
      const auth = request.headers.authorization ?? '';
      const expected = `Bearer ${options.token}`;
      const authBuf = Buffer.from(auth);
      const expectedBuf = Buffer.from(expected);
      if (authBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(authBuf, expectedBuf)) {
        socket.close(4001, 'unauthorized');
        return;
      }
    }

    const { store } = options;

    // Pipe store events to WebSocket client
    const onAgentAdded = (id: number, agent: AgentState) => {
      safeSend(socket, {
        type: 'agentCreated',
        id,
        folderName: agent.folderName,
        isExternal: agent.isExternal || undefined,
        isTeammate: agent.leadAgentId !== undefined || undefined,
        teammateName: agent.agentName,
        parentAgentId: agent.leadAgentId,
        teamName: agent.teamName,
        hooksOnly: agent.hooksOnly || undefined,
        palette: agent.palette,
        hueShift: agent.hueShift,
      });
    };

    const onAgentRemoved = (id: number) => {
      safeSend(socket, { type: 'agentClosed', id });
    };

    const onBroadcast = (message: Record<string, unknown>) => {
      safeSend(socket, message);
    };

    store.on('agentAdded', onAgentAdded);
    store.on('agentRemoved', onAgentRemoved);
    store.on('broadcast', onBroadcast);

    // Handle incoming client messages
    socket.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (!options.embedded && msg.type) {
          console.log('[Pixel Agents] WS client message:', msg.type);
        }
        handleClientMessage(msg, (m) => safeSend(socket, m), {
          store,
          runtime: options.runtime,
          cache: options.assetCache ?? null,
          orgStore: options.orgStore,
          hermesProvider: options.hermesProvider,
          onSetHooksEnabled: options.onSetHooksEnabled,
          onReloadAssets: options.onReloadAssets,
        });
      } catch {
        // Malformed JSON, ignore
      }
    });

    socket.on('close', () => {
      store.off('agentAdded', onAgentAdded);
      store.off('agentRemoved', onAgentRemoved);
      store.off('broadcast', onBroadcast);
    });
  });
}

// ── Auth Helper ────────────────────────────────────────────────

function bearerAuth(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.headers.authorization ?? '';
    const expected = `Bearer ${expectedToken}`;
    const authBuf = Buffer.from(auth);
    const expectedBuf = Buffer.from(expected);
    if (authBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(authBuf, expectedBuf)) {
      reply.code(401).send('unauthorized');
    }
  };
}

// ── Utilities ──────────────────────────────────────────────────

function safeSend(
  socket: { send: (data: string) => void; readyState: number },
  message: Record<string, unknown>,
): void {
  // WebSocket.OPEN = 1
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}
