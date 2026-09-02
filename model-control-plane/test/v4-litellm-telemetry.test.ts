import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LiteLlmExecutionTelemetry } from '../src/v4/adapters/liteLlmTelemetry.js';

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

test('V4 LiteLLM telemetry uses exact end_user correlation and reports physical provider routes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-litellm-telemetry-'));
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
    if (url.pathname === '/model/info') {
      response.end(
        JSON.stringify({
          data: [
            {
              model_name: 'implementation-efficient',
              litellm_params: {
                model: 'openai/deepseek-v4-flash',
                api_base: 'https://relay.example/v1',
                litellm_credential_name: 'relay-credential',
                order: 7,
              },
              model_info: {
                id: 'deployment-1',
                metadata: {
                  legacy_provider_key: 'relay-provider',
                  commercial_type: 'METERED',
                  supply_origin: 'COMMERCIAL_RELAY',
                },
              },
            },
          ],
        }),
      );
      return;
    }
    if (url.pathname === '/spend/logs/v2') {
      response.end(
        JSON.stringify({
          data: [
            {
              end_user: 'execution-1',
              request_id: 'request-1',
              model_id: 'deployment-1',
              model_group: 'implementation-efficient',
              model: 'openai/deepseek-v4-flash',
              custom_llm_provider: 'openai',
              api_base: 'https://relay.example/v1/',
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
              end_user: 'another-execution',
              model: 'must-not-count',
              prompt_tokens: 999,
              completion_tokens: 999,
              spend: 9,
            },
          ],
        }),
      );
      return;
    }
    response.writeHead(404).end('{}');
  });
  const port = await listen(server);
  const telemetry = new LiteLlmExecutionTelemetry({
    baseUrl: `http://127.0.0.1:${port}`,
    envFile,
    activeTtlMs: 60_000,
    terminalTtlMs: 60_000,
  });

  try {
    const result = await telemetry.project({
      executionId: 'execution-1',
      status: 'SUCCEEDED',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T01:00:00.000Z',
    });
    assert.deepEqual(result.usage, {
      source: 'LITELLM_REPORTED',
      input: 120,
      output: 20,
      cachedInput: 80,
      reasoningOutput: 5,
      costUsd: 0.03,
      calls: 1,
    });
    assert.equal(result.route?.providerKey, 'relay-provider');
    assert.equal(result.route?.model, 'openai/deepseek-v4-flash');
    assert.equal(result.route?.deploymentId, 'deployment-1');
    assert.equal(result.route?.commercialType, 'METERED');
    assert.equal(result.routeUsage[0]?.input, 120);
    const spend = seen.find((url) => url.pathname === '/spend/logs/v2');
    assert.ok(spend);
    assert.equal(spend.searchParams.get('end_user'), 'execution-1');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
