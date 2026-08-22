import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LiteLlmSpendObservability } from '../src/v3/adapters/liteLlm.js';
import { EnvFileValueProvider } from '../src/v3/adapters/openHands.js';

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('missing address'));
      else resolve(address.port);
    });
  });
}

test('LiteLLM spend observability correlates exact execution end_user and aggregates safe route/usage facts', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'litellm-observability-'));
  const envFile = path.join(directory, 'litellm.env');
  fs.writeFileSync(envFile, 'LITELLM_MASTER_KEY=admin-secret\n');
  const seen: URL[] = [];
  const server = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer admin-secret') {
      response.writeHead(401).end('{}');
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    seen.push(url);
    response.setHeader('content-type', 'application/json');
    if (url.pathname !== '/spend/logs/v2') {
      response.writeHead(404).end('{}');
      return;
    }
    const endUser = url.searchParams.get('end_user');
    if (endUser === '__hermes_v3_observability_health__') {
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    response.end(
      JSON.stringify({
        data: [
          {
            end_user: 'exec_obs_1',
            startTime: '2026-08-22T03:00:02Z',
            model_group: 'implementation-efficient',
            model: 'openai/deepseek-v4-flash-free',
            model_id: 'deployment-new',
            custom_llm_provider: 'openai',
            prompt_tokens: 120,
            completion_tokens: 20,
            spend: 0.03,
            metadata: {
              usage_object: {
                prompt_tokens_details: { cached_tokens: 80 },
                completion_tokens_details: { reasoning_tokens: 5 },
              },
            },
          },
          {
            end_user: 'exec_obs_1',
            startTime: '2026-08-22T03:00:01Z',
            model_group: 'implementation-efficient',
            model: 'openai/deepseek-v4-flash-free',
            model_id: 'deployment-old',
            custom_llm_provider: 'openai',
            prompt_tokens: 100,
            completion_tokens: 10,
            spend: 0.02,
            metadata: {
              usage_object: {
                prompt_tokens_details: { cached_tokens: 50 },
                completion_tokens_details: { reasoning_tokens: 2 },
              },
            },
          },
          // Defense-in-depth: even if upstream returned an unrelated row, ignore it.
          {
            end_user: 'exec_other',
            model: 'should/not-count',
            prompt_tokens: 999999,
            completion_tokens: 999999,
            spend: 999,
          },
        ],
      }),
    );
  });
  const port = await listen(server);
  const adapter = new LiteLlmSpendObservability({
    baseUrl: `http://127.0.0.1:${port}`,
    secrets: new EnvFileValueProvider(envFile),
    healthTtlMs: 60_000,
  });

  try {
    assert.equal(await adapter.health(), 'OK');
    const summary = await adapter.getExecutionSummary('exec_obs_1');
    assert.equal(summary.health, 'OK');
    assert.deepEqual(summary.usage, {
      source: 'LITELLM_REPORTED',
      input: 220,
      output: 30,
      cachedInput: 130,
      reasoningOutput: 7,
      costUsd: 0.05,
      calls: 2,
    });
    assert.deepEqual(summary.lastObservedRoute, {
      model: 'openai/deepseek-v4-flash-free',
      provider: 'openai',
      deploymentId: 'deployment-new',
    });
    const executionQuery = seen.find((url) => url.searchParams.get('end_user') === 'exec_obs_1');
    assert.ok(executionQuery);
    assert.equal(executionQuery.searchParams.get('page'), '1');
    assert.equal(executionQuery.searchParams.get('page_size'), '100');
    assert.match(executionQuery.searchParams.get('start_date') ?? '', /^\d{4}-\d{2}-\d{2}$/);
    assert.match(executionQuery.searchParams.get('end_date') ?? '', /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('LiteLLM spend observability keeps no-row executions uncorrelated instead of guessing', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'litellm-observability-empty-'));
  const envFile = path.join(directory, 'litellm.env');
  fs.writeFileSync(envFile, 'LITELLM_MASTER_KEY=admin-secret\n');
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"data":[]}');
  });
  const port = await listen(server);
  const adapter = new LiteLlmSpendObservability({
    baseUrl: `http://127.0.0.1:${port}`,
    secrets: new EnvFileValueProvider(envFile),
  });
  try {
    const summary = await adapter.getExecutionSummary('legacy_execution_without_correlation');
    assert.equal(summary.health, 'OK');
    assert.equal(summary.usage, null);
    assert.equal(summary.lastObservedRoute, undefined);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('LiteLLM spend observability degrades without failing the execution facade', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'litellm-observability-down-'));
  const envFile = path.join(directory, 'litellm.env');
  fs.writeFileSync(envFile, 'LITELLM_MASTER_KEY=admin-secret\n');
  const adapter = new LiteLlmSpendObservability({
    baseUrl: 'http://127.0.0.1:1',
    secrets: new EnvFileValueProvider(envFile),
    requestTimeoutMs: 1_000,
  });
  try {
    assert.deepEqual(await adapter.getExecutionSummary('exec_down'), { health: 'UNAVAILABLE' });
    assert.equal(await adapter.health(), 'UNAVAILABLE');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
