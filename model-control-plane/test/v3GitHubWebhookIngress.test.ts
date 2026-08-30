import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  createGitHubWebhookIngressServer,
  createGitHubWebhookProcessor,
  type NormalizedGitHubPullRequestEvent,
} from '../src/githubWebhookIngress.js';

const SECRET = 'webhook-secret';

function signed(payload: unknown, event = 'pull_request') {
  const raw = Buffer.from(JSON.stringify(payload));
  return {
    raw,
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`,
    },
  };
}

function prPayload(action = 'opened') {
  return {
    action,
    number: 42,
    repository: { full_name: 'BakerSean168/digital-biome' },
    pull_request: { number: 42, head: { sha: '1'.repeat(40) } },
  };
}

function processor(forwarded: NormalizedGitHubPullRequestEvent[]) {
  return createGitHubWebhookProcessor(
    {
      webhookSecret: SECRET,
      eventToken: 'bridge-token',
      repository: 'BakerSean168/digital-biome',
      projectKey: 'digital-biome',
      repositoryPath: '/home/dev/projects/digital-biome',
    },
    async (event) => {
      forwarded.push(event);
      return { statusCode: 202 };
    },
  );
}

test('GitHub webhook ingress verifies HMAC before parsing or forwarding', async () => {
  const forwarded: NormalizedGitHubPullRequestEvent[] = [];
  const process = processor(forwarded);
  const response = await process(Buffer.from('{not-json'), {
    'content-type': 'application/json',
    'x-github-event': 'pull_request',
    'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
  });
  assert.equal(response.statusCode, 401);
  assert.equal((response.body.error as { code: string }).code, 'GITHUB_WEBHOOK_SIGNATURE_INVALID');
  assert.equal(forwarded.length, 0);
});

test('GitHub webhook ingress normalizes only the configured repository and governed PR actions', async () => {
  const forwarded: NormalizedGitHubPullRequestEvent[] = [];
  const process = processor(forwarded);
  const accepted = signed(prPayload('opened'));
  const response = await process(accepted.raw, accepted.headers);
  assert.equal(response.statusCode, 202);
  assert.equal(response.body.accepted, true);
  assert.deepEqual(forwarded, [
    {
      event: 'pull_request', action: 'opened', projectKey: 'digital-biome',
      repository: {
        path: '/home/dev/projects/digital-biome', remote: 'origin',
        fullName: 'BakerSean168/digital-biome',
      },
      pullRequest: { number: 42, headSha: '1'.repeat(40) },
    },
  ]);

  const ignored = signed(prPayload('edited'));
  const ignoredResponse = await process(ignored.raw, ignored.headers);
  assert.equal(ignoredResponse.statusCode, 202);
  assert.equal(ignoredResponse.body.ignored, true);
  assert.equal(forwarded.length, 1);

  const wrongRepo = prPayload('opened');
  wrongRepo.repository.full_name = 'attacker/other';
  const rejected = signed(wrongRepo);
  const rejectedResponse = await process(rejected.raw, rejected.headers);
  assert.equal(rejectedResponse.statusCode, 403);
  assert.equal((rejectedResponse.body.error as { code: string }).code, 'GITHUB_WEBHOOK_REPOSITORY_NOT_ALLOWED');
  assert.equal(forwarded.length, 1);
});

test('GitHub webhook ingress accepts signed ping without forwarding and fails closed on bridge rejection', async () => {
  const forwarded: NormalizedGitHubPullRequestEvent[] = [];
  const process = createGitHubWebhookProcessor(
    {
      webhookSecret: SECRET,
      eventToken: 'bridge-token',
      repository: 'BakerSean168/digital-biome',
      projectKey: 'digital-biome',
      repositoryPath: '/home/dev/projects/digital-biome',
    },
    async (event) => {
      forwarded.push(event);
      return { statusCode: 409 };
    },
  );
  const ping = signed({ zen: 'keep it logically awesome' }, 'ping');
  const pingResponse = await process(ping.raw, ping.headers);
  assert.equal(pingResponse.statusCode, 202);
  assert.equal(pingResponse.body.reason, 'PING');
  assert.equal(forwarded.length, 0);

  const event = signed(prPayload('synchronize'));
  const response = await process(event.raw, event.headers);
  assert.equal(response.statusCode, 502);
  assert.equal((response.body.error as { code: string }).code, 'GITHUB_EVENT_BRIDGE_FORWARD_REJECTED');
  assert.equal(forwarded.length, 1);
});

test('GitHub webhook ingress requires exact signed repository and action values', async () => {
  const forwarded: NormalizedGitHubPullRequestEvent[] = [];
  const process = processor(forwarded);
  for (const payload of [
    { ...prPayload('opened'), action: 'OPENED' },
    { ...prPayload('opened'), action: ' opened ' },
    { ...prPayload('opened'), repository: { full_name: 'BakerSean168/digital-biome ' } },
  ]) {
    const event = signed(payload);
    const response = await process(event.raw, event.headers);
    if (payload.repository.full_name.endsWith(' ')) {
      assert.equal(response.statusCode, 403);
    } else {
      assert.equal(response.statusCode, 202);
      assert.equal(response.body.ignored, true);
    }
  }
  assert.equal(forwarded.length, 0);
});

test('GitHub webhook HTTP server accepts JSON media type parameters but rejects JSON lookalikes', async () => {
  const server = createGitHubWebhookIngressServer({
    webhookSecret: SECRET,
    eventToken: 'bridge-token',
    repository: 'BakerSean168/digital-biome',
    projectKey: 'digital-biome',
    repositoryPath: '/home/dev/projects/digital-biome',
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const body = Buffer.from(JSON.stringify({ zen: 'test' }));
    const signature = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
    const send = (contentType: string) =>
      fetch(`http://127.0.0.1:${address.port}/github/webhook`, {
        method: 'POST',
        headers: {
          'content-type': contentType,
          'x-github-event': 'ping',
          'x-hub-signature-256': signature,
        },
        body,
      });
    assert.equal((await send('application/json; charset=utf-8')).status, 202);
    assert.equal((await send('application/jsonp')).status, 415);
    assert.equal((await send('application/json-malformed')).status, 415);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('GitHub webhook ingress target accepts only literal loopback addresses', () => {
  for (const targetUrl of [
    'https://example.com/bridge',
    'http://localhost:8320/bridge',
    'http://127.1:8320/bridge',
    'http://2130706433:8320/bridge',
    'http://0x7f000001:8320/bridge',
  ]) {
    assert.throws(
      () =>
        createGitHubWebhookProcessor({
          webhookSecret: SECRET,
          eventToken: 'bridge-token',
          repository: 'BakerSean168/digital-biome',
          projectKey: 'digital-biome',
          repositoryPath: '/home/dev/projects/digital-biome',
          targetUrl,
        }),
      /GITHUB_WEBHOOK_INGRESS_TARGET_MUST_BE_LITERAL_LOOPBACK/,
    );
  }
  assert.doesNotThrow(() =>
    createGitHubWebhookProcessor({
      webhookSecret: SECRET,
      eventToken: 'bridge-token',
      repository: 'BakerSean168/digital-biome',
      projectKey: 'digital-biome',
      repositoryPath: '/home/dev/projects/digital-biome',
      targetUrl: 'http://127.0.0.1:8320/bridge',
    }),
  );
});
