import Fastify, { type FastifyInstance } from 'fastify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CpaAdapter } from './adapters/cpa.mjs';
import { CpaUsageAdapter } from './adapters/cpaUsage.mjs';
import { openDb } from './db.mjs';
import { CpaCompatibilityGateway } from './gateway/cpaCompatibility.js';
import { EnvFileBearerTokenProvider, LiteLlmGateway } from './gateway/liteLlm.js';
import { GatewayRegistry } from './gateway/registry.js';
import { ControlPlaneStore } from './store.mjs';
import { registerV2Routes } from './v2/api.js';
import { DispatchService } from './v2/dispatch.js';
import { GatewayDiscoveryService } from './v2/discovery.js';
import { FinanceRepository } from './v2/finance.js';
import { IdempotencyService } from './v2/idempotency.js';
import { InvocationService } from './v2/invocation.js';
import { WorkforceLifecycleService } from './v2/lifecycle.js';
import { runV2Migrations } from './v2/migrations.js';
import { RepositoryGatewayBindingSource, V2Repository } from './v2/repository.js';
import { StaffingRepository } from './v2/staffing.js';
import { SupplyRepository } from './v2/supply.js';
import { UsageReconciliationService } from './v2/usageReconciliation.js';

const here = path.dirname(fileURLToPath(import.meta.url));

interface CpaChannelStatus {
  name: string;
  protocol: string;
  enabled: boolean;
  models: string[];
  logicalAliases?: string[];
  lastTest?: string;
  health: string;
}

interface AddChannelInput {
  name: string;
  protocol: string;
  baseUrl: string;
  models: unknown[];
  apiKey: string;
  weight: number;
  priority: number;
  proxyUrl: string;
}

export interface LegacyCpaPort {
  status(): Promise<CpaChannelStatus[]>;
  bindAlias(name: string, model: string, alias: string): Promise<unknown>;
  unbindAlias(name: string, alias: string): Promise<unknown>;
  addChannel(input: AddChannelInput): Promise<unknown>;
  test(name: string): Promise<unknown>;
  enable(name: string, reason?: string): Promise<unknown>;
  disable(name: string, reason?: string): Promise<unknown>;
  quarantine(name: string, minutes?: number, reason?: string): Promise<unknown>;
}

export interface LegacyUsagePort {
  snapshot(range?: string): Promise<unknown>;
}

interface LegacyEvent {
  seq: number;
  type: string;
  entityType?: string;
  entityId?: string;
  payload?: unknown;
  occurredAt: number;
}

type EventSender = (event: LegacyEvent) => void;

type JsonRecord = Record<string, unknown>;

export interface BuildControlPlaneOptions {
  env?: NodeJS.ProcessEnv;
  dbFile?: string;
  logger?: boolean;
  cpa?: LegacyCpaPort;
  cpaUsage?: LegacyUsagePort;
  initialSync?: boolean;
  gateways?: GatewayRegistry;
}

export interface ControlPlaneRuntime {
  app: FastifyInstance;
  store: InstanceType<typeof ControlPlaneStore>;
  v2: V2Repository;
  gateways: GatewayRegistry;
  dbFile: string;
  host: string;
  port: number;
  refreshCpa(): Promise<unknown>;
  startBackgroundJobs(): void;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function buildControlPlane(
  options: BuildControlPlaneOptions = {},
): Promise<ControlPlaneRuntime> {
  const env = options.env ?? process.env;
  const dbFile =
    options.dbFile ?? env.MODEL_CP_DB ?? path.resolve(here, '../data/control-plane.sqlite');
  const host = env.MODEL_CP_HOST ?? '127.0.0.1';
  const port = Number(env.MODEL_CP_PORT ?? 8320);
  const app = Fastify({ logger: options.logger ?? true });
  const db = openDb(dbFile);
  if (env.MODEL_CP_V2_SCHEMA !== '0') runV2Migrations(db);
  const store = new ControlPlaneStore(db);
  const v2 = new V2Repository(db);
  const gateways = options.gateways ?? new GatewayRegistry();
  if (
    !options.gateways &&
    env.MODEL_CP_V2_LITELLM !== '0' &&
    env.LITELLM_BASE_URL &&
    env.LITELLM_ENV_FILE
  ) {
    gateways.register(
      new LiteLlmGateway({
        gatewayId: env.LITELLM_GATEWAY_ID ?? 'litellm-reference',
        baseUrl: env.LITELLM_BASE_URL,
        secrets: new EnvFileBearerTokenProvider(env.LITELLM_ENV_FILE),
        bindings: new RepositoryGatewayBindingSource(
          v2,
          env.LITELLM_GATEWAY_ID ?? 'litellm-reference',
        ),
      }),
    );
  }
  const supply = new SupplyRepository(v2);
  const finance = new FinanceRepository(v2);
  const staffing = new StaffingRepository(v2);
  const dispatchService = new DispatchService(v2, gateways, supply, staffing);
  const invocationService = new InvocationService(v2, gateways);
  const lifecycleService = new WorkforceLifecycleService(v2, dispatchService);
  const idempotencyService = new IdempotencyService(db, {
    ttlMs: Number(env.MODEL_CP_V2_IDEMPOTENCY_TTL_MS ?? 24 * 60 * 60 * 1_000),
  });
  const cpa: LegacyCpaPort =
    options.cpa ??
    (new CpaAdapter({
      gatewayctl: env.GATEWAYCTL ?? '/usr/local/sbin/gatewayctl',
      sudo: env.MODEL_CP_CPA_SUDO !== '0',
    }) as unknown as LegacyCpaPort);
  const cpaUsage: LegacyUsagePort =
    options.cpaUsage ??
    new CpaUsageAdapter({
      baseUrl: env.CPA_BASE_URL ?? 'http://127.0.0.1:8317',
      keyFile: env.CPA_MANAGEMENT_KEY_FILE ?? '/opt/cpa/.mgmt_password',
    });

  if (!options.gateways && env.MODEL_CP_V2_CPA_DISCOVERY !== '0') {
    gateways.register(
      new CpaCompatibilityGateway({
        gatewayId: env.CPA_GATEWAY_ID ?? 'cpa-compat',
        statusSource: cpa,
        usageSource: cpaUsage,
        bindings: new RepositoryGatewayBindingSource(v2, env.CPA_GATEWAY_ID ?? 'cpa-compat'),
        usageRange: env.MODEL_CP_USAGE_RANGE ?? '30d',
      }),
    );
  }
  const discoveryService = new GatewayDiscoveryService(v2, gateways, {
    [env.LITELLM_GATEWAY_ID ?? 'litellm-reference']: {
      kind: 'LITELLM',
      displayName: 'LiteLLM Reference Gateway',
      baseUrlHint: env.LITELLM_BASE_URL,
    },
    [env.CPA_GATEWAY_ID ?? 'cpa-compat']: {
      kind: 'CPA',
      displayName: 'CPA Compatibility Gateway',
      baseUrlHint: env.CPA_BASE_URL,
    },
  });
  const usageReconciliationService = new UsageReconciliationService(v2, gateways);
  const listeners = new Set<EventSender>();
  const timers = new Set<NodeJS.Timeout>();

  async function reconcilePositionAliases(
    cpaChannels: CpaChannelStatus[],
    snapshot: JsonRecord,
  ): Promise<void> {
    if (env.MODEL_CP_MANAGE_POSITION_ALIASES === '0') return;
    const workers = new Map(
      ((snapshot.workers as JsonRecord[] | undefined) ?? []).map((worker) => [
        String(worker.id),
        worker,
      ]),
    );
    const channels = new Map(
      ((snapshot.channels as JsonRecord[] | undefined) ?? []).map((channel) => [
        String(channel.id),
        channel,
      ]),
    );
    for (const position of (snapshot.positions as JsonRecord[] | undefined) ?? []) {
      const positionId = String(position.id);
      const alias = `position:${positionId}`;
      const assignment = ((snapshot.assignments as JsonRecord[] | undefined) ?? []).find(
        (item) => item.positionId === positionId && item.status === 'active',
      );
      const worker = assignment ? workers.get(String(assignment.workerId)) : undefined;
      const selectedChannel = worker ? channels.get(String(worker.channelId)) : undefined;
      for (const channel of cpaChannels) {
        const workerModelId = worker ? String(worker.modelId) : '';
        const shouldBind = Boolean(
          worker &&
          selectedChannel?.name === channel.name &&
          channel.models.includes(workerModelId),
        );
        const isBound = (channel.logicalAliases ?? []).includes(alias);
        if (shouldBind && !isBound) {
          await cpa.bindAlias(channel.name, workerModelId, alias);
          store.emit('position.route_bound', 'position', positionId, {
            alias,
            workerId: worker?.id,
            channelId: worker?.channelId,
          });
        } else if (!shouldBind && isBound) {
          await cpa.unbindAlias(channel.name, alias);
          store.emit('position.route_unbound', 'position', positionId, {
            alias,
            channelName: channel.name,
          });
        }
      }
    }
  }

  async function refreshCpa(): Promise<unknown> {
    const channels = await cpa.status();
    store.syncCpa(channels);
    const usage = await cpaUsage.snapshot(env.MODEL_CP_USAGE_RANGE ?? '30d').catch(() => null);
    if (usage) store.syncExternalUsage(usage);
    const snapshot = store.autoAssignDefaults() as JsonRecord;
    await reconcilePositionAliases(channels, snapshot);
    return snapshot;
  }

  const originalEmit = store.emit.bind(store) as (
    type: string,
    entityType?: string,
    entityId?: string,
    payload?: unknown,
  ) => LegacyEvent;
  (store as unknown as { emit: typeof originalEmit }).emit = (
    type: string,
    entityType?: string,
    entityId?: string,
    payload?: unknown,
  ): LegacyEvent => {
    const event = originalEmit(type, entityType, entityId, payload);
    for (const send of listeners) send(event);
    return event;
  };

  registerV2Routes(app, v2, {
    dispatchService,
    invocationService,
    lifecycleService,
    discoveryService,
    usageReconciliationService,
    supply,
    finance,
    staffing,
    idempotencyService,
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'hermes-model-control-plane',
    db: dbFile,
  }));
  app.get('/api/v1/snapshot', async () => store.snapshot());
  app.get('/api/v1/providers', async () => store.snapshot().providers);
  app.get('/api/v1/channels', async () => store.snapshot().channels);
  app.get('/api/v1/workers', async () => store.snapshot().workers);
  app.get('/api/v1/profiles', async () => store.snapshot().profiles);
  app.get('/api/v1/positions', async () => store.snapshot().positions);
  app.get('/api/v1/assignments', async () => store.snapshot().assignments);
  app.get('/api/v1/quotas', async () => store.snapshot().quotas);
  app.get('/api/v1/contracts', async () => store.snapshot().contracts);
  app.get('/api/v1/prices', async () => store.snapshot().prices);
  app.get('/api/v1/dashboard/workforce', async () => store.snapshot());
  app.get('/api/v1/events/history', async (request) => {
    const query = asRecord(request.query);
    return store.eventsAfter(Number(query.after ?? 0), Number(query.limit ?? 500));
  });
  app.get('/api/v1/events', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const query = asRecord(request.query);
    for (const event of store.eventsAfter(Number(query.after ?? 0))) {
      reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    const send: EventSender = (event) => {
      reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    listeners.add(send);
    const timer = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    request.raw.on('close', () => {
      listeners.delete(send);
      clearInterval(timer);
    });
  });

  app.post('/api/v1/providers', async (request) => store.upsertProvider(asRecord(request.body)));
  app.post('/api/v1/channels', async (request) => store.upsertChannel(asRecord(request.body)));
  app.post('/api/v1/models', async (request) => store.upsertModel(asRecord(request.body)));
  app.post('/api/v1/workers', async (request) => store.upsertWorker(asRecord(request.body)));
  app.post('/api/v1/profiles', async (request) => store.upsertProfile(asRecord(request.body)));
  app.post('/api/v1/positions', async (request) => store.upsertPosition(asRecord(request.body)));
  app.post('/api/v1/assignments', async (request) => store.assign(asRecord(request.body)));
  app.post('/api/v1/quotas', async (request) => store.upsertQuota(asRecord(request.body)));
  app.post('/api/v1/contracts', async (request) => store.upsertContract(asRecord(request.body)));
  app.post('/api/v1/prices', async (request) => store.upsertPrice(asRecord(request.body)));
  app.post('/api/v1/usage', async (request, reply) => {
    try {
      return store.recordUsage(asRecord(request.body));
    } catch (error) {
      reply.code(400);
      return { error: errorMessage(error) };
    }
  });
  app.post<{ Params: { positionId: string } }>('/api/v1/resolve/:positionId', async (request) =>
    store.resolve(request.params.positionId),
  );
  app.post('/api/v1/adapters/cpa/sync', async (_request, reply) => {
    try {
      return await refreshCpa();
    } catch (error) {
      reply.code(502);
      return { error: 'cpa-sync-failed', message: errorMessage(error) };
    }
  });
  app.post('/api/v1/adapters/cpa/channels', async (request, reply) => {
    try {
      const body = asRecord(request.body);
      const name = String(body.name ?? '').trim();
      const protocol = String(body.protocol ?? '').trim();
      const baseUrl = String(body.baseUrl ?? '').trim();
      const apiKey = String(body.apiKey ?? '');
      if (!name || !protocol || !baseUrl || !apiKey) {
        throw new Error('name, protocol, baseUrl and apiKey are required');
      }
      if (!['openai-compatible', 'codex-responses', 'anthropic-messages'].includes(protocol)) {
        throw new Error('unsupported protocol');
      }
      const models = Array.isArray(body.models) ? body.models : [];
      await cpa.addChannel({
        name,
        protocol,
        baseUrl,
        models,
        apiKey,
        weight: Number(body.weight ?? 100),
        priority: Number(body.priority ?? 0),
        proxyUrl: String(body.proxyUrl ?? 'direct'),
      });
      let testPassed = false;
      if (body.test !== false) {
        try {
          await cpa.test(name);
          testPassed = true;
        } catch (error) {
          app.log.warn({ channel: name, err: error }, 'new CPA channel test failed');
        }
      }
      if (body.enable === true) {
        if (!testPassed) {
          throw new Error('channel was added disabled because its upstream test did not pass');
        }
        await cpa.enable(name, 'model-control-plane-new-channel');
      }
      const snapshot = await refreshCpa();
      return { channel: name, testPassed, enabled: body.enable === true && testPassed, snapshot };
    } catch (error) {
      reply.code(400);
      return { error: errorMessage(error) };
    }
  });
  app.post('/api/v1/adapters/cpa/usage/sync', async (request, reply) => {
    try {
      const body = asRecord(request.body);
      const usage = await cpaUsage.snapshot(String(body.range ?? '30d'));
      return store.syncExternalUsage(usage);
    } catch (error) {
      reply.code(502);
      return { error: 'cpa-usage-sync-failed', message: errorMessage(error) };
    }
  });
  app.post('/api/v1/assignments/reconcile', async () => store.autoAssignDefaults());
  app.patch<{ Params: { channelId: string } }>(
    '/api/v1/channels/:channelId/policy',
    async (request, reply) => {
      try {
        const result = store.updateChannelPolicy(request.params.channelId, asRecord(request.body));
        await refreshCpa();
        return result;
      } catch (error) {
        reply.code(400);
        return { error: errorMessage(error) };
      }
    },
  );
  app.patch<{ Params: { assignmentId: string } }>(
    '/api/v1/assignments/:assignmentId/policy',
    async (request, reply) => {
      try {
        const result = store.updateAssignmentPolicy(
          request.params.assignmentId,
          asRecord(request.body),
        );
        await refreshCpa();
        return result;
      } catch (error) {
        reply.code(400);
        return { error: errorMessage(error) };
      }
    },
  );
  app.post<{ Params: { channelId: string; action: string } }>(
    '/api/v1/channels/:channelId/actions/:action',
    async (request, reply) => {
      try {
        const channel = store.getChannel(request.params.channelId);
        if (!channel) throw new Error('unknown channel');
        if (channel.providerId !== 'cpa' || channel.metadata?.source === 'usage-discovery') {
          throw new Error('channel lifecycle is not managed by gatewayctl');
        }
        const body = asRecord(request.body);
        const action = request.params.action;
        const reason = String(body.reason ?? 'model-control-plane');
        if (action === 'enable') await cpa.enable(channel.name, reason);
        else if (action === 'disable') await cpa.disable(channel.name, reason);
        else if (action === 'test') await cpa.test(channel.name);
        else if (action === 'quarantine') {
          await cpa.quarantine(channel.name, Number(body.minutes ?? 30), reason);
        } else throw new Error('unsupported action');
        return { action, channel: channel.name, snapshot: await refreshCpa() };
      } catch (error) {
        reply.code(400);
        return { error: errorMessage(error) };
      }
    },
  );
  app.get<{ Params: { dimension: string } }>('/api/v1/stats/:dimension', async (request, reply) => {
    try {
      return store.statsBy(request.params.dimension);
    } catch (error) {
      reply.code(400);
      return { error: errorMessage(error) };
    }
  });

  async function seed(): Promise<void> {
    store.upsertProfile({ id: 'hermes', name: 'Hermes' });
    store.upsertProfile({ id: 'development', name: 'Development' });
    store.upsertPosition({
      id: 'hermes-brain',
      profileId: 'hermes',
      name: 'Hermes Brain',
      kind: 'brain',
      requiredCapabilities: ['reasoning', 'tools'],
      weights: { quality: 30, reliability: 30, cost: 20, latency: 5, quota: 15 },
      metadata: { routeProtocol: 'openai-compatible', logicalAlias: 'position:hermes-brain' },
    });
    store.upsertPosition({
      id: 'codex-general',
      profileId: 'development',
      name: 'Codex General Developer',
      kind: 'developer',
      requiredCapabilities: ['coding', 'tools'],
      weights: { quality: 30, reliability: 20, cost: 20, latency: 10, quota: 20 },
      metadata: { routeProtocol: 'openai-compatible', logicalAlias: 'position:codex-general' },
    });
    store.upsertPosition({
      id: 'coding-review',
      profileId: 'development',
      name: 'Coding Reviewer',
      kind: 'reviewer',
      requiredCapabilities: ['review', 'reasoning'],
      weights: { quality: 40, reliability: 25, cost: 15, latency: 5, quota: 15 },
      metadata: { routeProtocol: 'openai-compatible', logicalAlias: 'position:coding-review' },
    });
    const shouldSync = options.initialSync ?? env.MODEL_CP_SYNC_CPA !== '0';
    if (shouldSync) {
      try {
        await refreshCpa();
      } catch (error) {
        app.log.warn({ err: error }, 'CPA bootstrap sync failed');
      }
    }
  }

  function startBackgroundJobs(): () => void {
    if (timers.size > 0) return () => {};
    const syncInterval = Number(env.MODEL_CP_SYNC_INTERVAL_MS ?? 60_000);
    if (syncInterval > 0) {
      const timer = setInterval(async () => {
        try {
          await refreshCpa();
        } catch (error) {
          app.log.warn({ err: error }, 'periodic CPA sync failed');
        }
      }, syncInterval);
      timer.unref();
      timers.add(timer);
    }
    const healthInterval = Number(env.MODEL_CP_HEALTH_CHECK_INTERVAL_MS ?? 1_800_000);
    if (healthInterval > 0) {
      const timer = setInterval(async () => {
        try {
          const channels = await cpa.status();
          for (const channel of channels.filter((item) => item.enabled)) {
            try {
              await cpa.test(channel.name);
            } catch (error) {
              app.log.warn(
                { channel: channel.name, err: error },
                'CPA channel health probe failed',
              );
            }
          }
          await refreshCpa();
        } catch (error) {
          app.log.warn({ err: error }, 'periodic CPA health check failed');
        }
      }, healthInterval);
      timer.unref();
      timers.add(timer);
    }
    return () => {
      for (const timer of timers) clearInterval(timer);
      timers.clear();
    };
  }

  app.addHook('onClose', async () => {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    listeners.clear();
  });

  await seed();
  function startAllBackgroundJobs(): () => void {
    const stopLegacy = startBackgroundJobs();
    const extraTimers: NodeJS.Timeout[] = [];
    if (env.MODEL_CP_V2_DISCOVERY !== '0') {
      const intervalMs = Math.max(10_000, Number(env.MODEL_CP_V2_DISCOVERY_INTERVAL_MS ?? 60_000));
      const reconcileDiscovery = async (): Promise<void> => {
        try {
          await discoveryService.reconcileAll();
        } catch (error) {
          app.log.warn({ err: error }, 'V2 gateway discovery reconciliation failed');
        }
      };
      void reconcileDiscovery();
      const timer = setInterval(() => void reconcileDiscovery(), intervalMs);
      timer.unref();
      extraTimers.push(timer);
    }
    if (env.MODEL_CP_V2_USAGE_RECONCILIATION !== '0') {
      const intervalMs = Math.max(
        60_000,
        Number(env.MODEL_CP_V2_USAGE_RECONCILIATION_INTERVAL_MS ?? 300_000),
      );
      const reconcileUsage = async (): Promise<void> => {
        try {
          await usageReconciliationService.reconcileAll();
        } catch (error) {
          app.log.warn({ err: error }, 'V2 gateway usage reconciliation failed');
        }
      };
      const timer = setTimeout(() => {
        void reconcileUsage();
        const recurring = setInterval(() => void reconcileUsage(), intervalMs);
        recurring.unref();
        extraTimers.push(recurring);
      }, 5_000);
      timer.unref();
      extraTimers.push(timer);
    }
    return () => {
      for (const timer of extraTimers) clearInterval(timer);
      stopLegacy();
    };
  }

  return {
    app,
    store,
    v2,
    gateways,
    dbFile,
    host,
    port,
    refreshCpa,
    startBackgroundJobs: startAllBackgroundJobs,
  };
}
