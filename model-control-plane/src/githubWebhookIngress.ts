import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

export interface GitHubWebhookIngressConfig {
  webhookSecret: string;
  eventToken: string;
  repository: string;
  projectKey: string;
  repositoryPath: string;
  remote?: string;
  targetUrl?: string;
  maxBodyBytes?: number;
}

export interface NormalizedGitHubPullRequestEvent {
  event: 'pull_request';
  action: 'opened' | 'reopened' | 'synchronize';
  projectKey: string;
  repository: {
    path: string;
    remote: string;
    fullName: string;
  };
  pullRequest: {
    number: number;
    headSha?: string;
  };
}

export interface GitHubWebhookIngressResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

export type GitHubWebhookForwarder = (
  event: NormalizedGitHubPullRequestEvent,
) => Promise<{ statusCode: number }>;

function singleHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function validSignature(raw: Buffer, signature: string, secret: string): boolean {
  if (!/^sha256=[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const actualBuffer = Buffer.from(signature.toLowerCase(), 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function requiredText(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function validatedTarget(value: string | undefined): string {
  const raw = value ?? 'http://127.0.0.1:8320/api/v3/development/external-changes/github/events';
  const literalLoopbackAuthority =
    /^http:\/\/127\.0\.0\.1(?::[0-9]{1,5})?(?:\/|$)/.test(raw) ||
    /^http:\/\/\[::1\](?::[0-9]{1,5})?(?:\/|$)/.test(raw);
  if (!literalLoopbackAuthority) {
    throw new Error('GITHUB_WEBHOOK_INGRESS_TARGET_MUST_BE_LITERAL_LOOPBACK');
  }
  const target = new URL(raw);
  if (
    target.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(target.hostname) ||
    target.username ||
    target.password ||
    !target.port ||
    Number(target.port) <= 0 ||
    Number(target.port) > 65535
  ) {
    throw new Error('GITHUB_WEBHOOK_INGRESS_TARGET_MUST_BE_LITERAL_LOOPBACK');
  }
  return target.toString();
}

async function defaultForwarder(
  targetUrl: string,
  eventToken: string,
  event: NormalizedGitHubPullRequestEvent,
): Promise<{ statusCode: number }> {
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hermes-event-token': eventToken,
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(15_000),
  });
  return { statusCode: response.status };
}

export function createGitHubWebhookProcessor(
  config: GitHubWebhookIngressConfig,
  forwarder?: GitHubWebhookForwarder,
): (raw: Buffer, headers: IncomingHttpHeaders) => Promise<GitHubWebhookIngressResponse> {
  const webhookSecret = requiredText(config.webhookSecret, 'GITHUB_WEBHOOK_SECRET_REQUIRED');
  const eventToken = requiredText(config.eventToken, 'GITHUB_EVENT_TOKEN_REQUIRED');
  const repository = requiredText(config.repository, 'GITHUB_WEBHOOK_REPOSITORY_REQUIRED');
  const projectKey = requiredText(config.projectKey, 'GITHUB_WEBHOOK_PROJECT_KEY_REQUIRED');
  const repositoryPath = requiredText(
    config.repositoryPath,
    'GITHUB_WEBHOOK_REPOSITORY_PATH_REQUIRED',
  );
  const remote = config.remote?.trim() || 'origin';
  const targetUrl = validatedTarget(config.targetUrl);
  const send =
    forwarder ?? ((event: NormalizedGitHubPullRequestEvent) => defaultForwarder(targetUrl, eventToken, event));

  return async (raw, headers) => {
    const signature = singleHeader(headers['x-hub-signature-256']);
    if (!validSignature(raw, signature, webhookSecret)) {
      return { statusCode: 401, body: { error: { code: 'GITHUB_WEBHOOK_SIGNATURE_INVALID' } } };
    }

    const eventName = singleHeader(headers['x-github-event']);
    if (eventName === 'ping') {
      return { statusCode: 202, body: { accepted: false, ignored: true, reason: 'PING' } };
    }
    if (eventName !== 'pull_request') {
      return {
        statusCode: 202,
        body: { accepted: false, ignored: true, reason: 'EVENT_NOT_GOVERNED' },
      };
    }

    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not-object');
      body = parsed as Record<string, unknown>;
    } catch {
      return { statusCode: 400, body: { error: { code: 'GITHUB_WEBHOOK_JSON_INVALID' } } };
    }

    const action = typeof body.action === 'string' ? body.action : '';
    if (!['opened', 'reopened', 'synchronize'].includes(action)) {
      return {
        statusCode: 202,
        body: { accepted: false, ignored: true, reason: 'PULL_REQUEST_ACTION_NOT_GOVERNED' },
      };
    }

    const repositoryObject =
      body.repository && typeof body.repository === 'object' && !Array.isArray(body.repository)
        ? (body.repository as Record<string, unknown>)
        : {};
    if (repositoryObject.full_name !== repository) {
      return {
        statusCode: 403,
        body: { error: { code: 'GITHUB_WEBHOOK_REPOSITORY_NOT_ALLOWED' } },
      };
    }

    const pullRequest =
      body.pull_request && typeof body.pull_request === 'object' && !Array.isArray(body.pull_request)
        ? (body.pull_request as Record<string, unknown>)
        : {};
    const pullRequestNumber = Number(pullRequest.number ?? body.number);
    if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
      return {
        statusCode: 400,
        body: { error: { code: 'GITHUB_WEBHOOK_PULL_REQUEST_NUMBER_INVALID' } },
      };
    }
    const head =
      pullRequest.head && typeof pullRequest.head === 'object' && !Array.isArray(pullRequest.head)
        ? (pullRequest.head as Record<string, unknown>)
        : {};
    const headSha = String(head.sha ?? '').trim();
    if (headSha && !/^[0-9a-f]{40}$/i.test(headSha)) {
      return { statusCode: 400, body: { error: { code: 'GITHUB_WEBHOOK_HEAD_SHA_INVALID' } } };
    }

    const normalized: NormalizedGitHubPullRequestEvent = {
      event: 'pull_request',
      action: action as NormalizedGitHubPullRequestEvent['action'],
      projectKey,
      repository: { path: repositoryPath, remote, fullName: repository },
      pullRequest: { number: pullRequestNumber, ...(headSha ? { headSha } : {}) },
    };

    try {
      const response = await send(normalized);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return {
          statusCode: 502,
          body: { error: { code: 'GITHUB_EVENT_BRIDGE_FORWARD_REJECTED' } },
        };
      }
      return { statusCode: 202, body: { accepted: true } };
    } catch {
      return { statusCode: 502, body: { error: { code: 'GITHUB_EVENT_BRIDGE_FORWARD_FAILED' } } };
    }
  };
}

function writeJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBodyBytes) throw new Error('GITHUB_WEBHOOK_BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function createGitHubWebhookIngressServer(
  config: GitHubWebhookIngressConfig,
  forwarder?: GitHubWebhookForwarder,
): Server {
  const processor = createGitHubWebhookProcessor(config, forwarder);
  const maxBodyBytes = config.maxBodyBytes ?? 1024 * 1024;

  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (request.method === 'GET' && pathname === '/health') {
        writeJson(response, 200, { status: 'ok', service: 'github-webhook-ingress' });
        return;
      }
      if (request.method !== 'POST' || pathname !== '/github/webhook') {
        writeJson(response, 404, { error: { code: 'NOT_FOUND' } });
        return;
      }
      const contentType = singleHeader(request.headers['content-type']);
      const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        writeJson(response, 415, { error: { code: 'GITHUB_WEBHOOK_CONTENT_TYPE_INVALID' } });
        return;
      }
      const raw = await readBody(request, maxBodyBytes);
      const result = await processor(raw, request.headers);
      writeJson(response, result.statusCode, result.body);
    } catch (error) {
      if (error instanceof Error && error.message === 'GITHUB_WEBHOOK_BODY_TOO_LARGE') {
        writeJson(response, 413, { error: { code: 'GITHUB_WEBHOOK_BODY_TOO_LARGE' } });
        return;
      }
      writeJson(response, 500, { error: { code: 'GITHUB_WEBHOOK_INGRESS_INTERNAL_ERROR' } });
    }
  });
}
