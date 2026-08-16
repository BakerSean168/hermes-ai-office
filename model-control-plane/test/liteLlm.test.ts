import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import {
  EnvFileBearerTokenProvider,
  LiteLlmGateway,
  StaticBearerTokenProvider,
} from '../src/gateway/liteLlm.js';
import { StaticGatewayBindingSource } from '../src/gateway/staticBindings.js';

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('missing test port'));
      else resolve(address.port);
    });
  });
}

test('LiteLLM adapter discovers and resolves only an Employment-scoped model group', async () => {
  const requests: Array<{ url: string; authorization?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url ?? '',
      authorization: request.headers.authorization,
    });
    if (request.headers.authorization !== 'Bearer test-master') {
      response.writeHead(401).end('{}');
      return;
    }
    if (request.url === '/health/liveliness') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'healthy' }));
      return;
    }
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          data: [{ id: 'employment:empl_review' }, { id: 'employment:empl_other' }],
        }),
      );
      return;
    }
    response.writeHead(404).end('{}');
  });
  const port = await listen(server);
  const bindings = new StaticGatewayBindingSource([
    {
      gatewayId: 'litellm-reference',
      employmentId: 'empl_review',
      externalRouteRef: 'employment:empl_review',
      protocol: 'openai-responses',
    },
  ]);
  const gateway = new LiteLlmGateway({
    baseUrl: `http://127.0.0.1:${port}`,
    secrets: new StaticBearerTokenProvider('test-master'),
    bindings,
    routeProtocols: { 'employment:empl_review': 'openai-responses' },
  });

  try {
    const discovery = await gateway.discover();
    assert.deepEqual(
      discovery.routes.map((route) => route.externalRouteRef),
      ['employment:empl_other', 'employment:empl_review'],
    );
    assert.equal(
      discovery.routes.find((route) => route.externalRouteRef === 'employment:empl_review')
        ?.protocol,
      'openai-responses',
    );

    const resolved = await gateway.resolveRoute('empl_review');
    assert.equal(resolved.routable, true);
    assert.equal(resolved.route?.externalRouteRef, 'employment:empl_review');
    assert.equal(resolved.route?.employmentId, 'empl_review');

    const missing = await gateway.resolveRoute('empl_missing');
    assert.equal(missing.routable, false);
    assert.deepEqual(missing.reasons, ['NO_GATEWAY_BINDING']);

    assert.ok(requests.length >= 3);
    assert.equal(
      requests.every((item) => item.authorization === 'Bearer test-master'),
      true,
    );
    assert.equal(JSON.stringify(discovery).includes('test-master'), false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('LiteLLM adapter reports an unavailable route without crossing Employment', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/health/liveliness') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'healthy' }));
      return;
    }
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'employment:another' }] }));
      return;
    }
    response.writeHead(404).end('{}');
  });
  const port = await listen(server);
  const bindings = new StaticGatewayBindingSource([
    {
      gatewayId: 'litellm-reference',
      employmentId: 'empl_review',
      externalRouteRef: 'employment:empl_review',
      protocol: 'openai-chat-completions',
    },
  ]);
  const gateway = new LiteLlmGateway({
    baseUrl: `http://127.0.0.1:${port}`,
    secrets: new StaticBearerTokenProvider('test-master'),
    bindings,
  });

  try {
    const resolved = await gateway.resolveRoute('empl_review');
    assert.equal(resolved.routable, false);
    assert.equal(resolved.route, null);
    assert.deepEqual(resolved.reasons, ['LITELLM_ROUTE_UNAVAILABLE']);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('env-file token provider reads only the requested key', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'litellm-secret-'));
  const file = path.join(directory, 'gateway.env');
  fs.writeFileSync(file, 'OTHER=value\nLITELLM_MASTER_KEY=secret-value\n');
  try {
    const provider = new EnvFileBearerTokenProvider(file);
    assert.equal(await provider.readBearerToken(), 'secret-value');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('LiteLLM invocation normalizes Responses API evidence without exposing provider details', async () => {
  const server = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer test-master') {
      response.writeHead(401).end('{}');
      return;
    }
    if (request.url === '/v1/responses' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const payload = JSON.parse(body);
        assert.equal(payload.model, 'employment:empl_review');
        response.setHeader('content-type', 'application/json');
        response.setHeader('x-litellm-call-id', 'call_123');
        response.setHeader('x-litellm-model-id', 'deployment_hash');
        response.setHeader('x-litellm-version', 'test-version');
        response.setHeader('x-litellm-model-group', 'employment:empl_review');
        response.setHeader('x-litellm-attempted-retries', '1');
        response.setHeader('x-litellm-attempted-fallbacks', '0');
        response.setHeader('x-litellm-response-cost-original', '0.125');
        response.setHeader('x-litellm-response-duration-ms', '42.5');
        response.end(
          JSON.stringify({
            id: 'resp_123',
            status: 'completed',
            model: 'employment:empl_review',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'REVIEW_OK' }],
              },
            ],
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              input_tokens_details: { cached_tokens: 10 },
              output_tokens_details: { reasoning_tokens: 5 },
            },
          }),
        );
      });
      return;
    }
    if (request.url === '/health/liveliness') {
      response.setHeader('content-type', 'application/json');
      response.end('{}');
      return;
    }
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'employment:empl_review' }] }));
      return;
    }
    response.writeHead(404).end('{}');
  });
  const port = await listen(server);
  const bindings = new StaticGatewayBindingSource([
    {
      gatewayId: 'litellm-reference',
      employmentId: 'empl_review',
      externalRouteRef: 'employment:empl_review',
      protocol: 'openai-responses',
    },
  ]);
  const gateway = new LiteLlmGateway({
    baseUrl: `http://127.0.0.1:${port}`,
    secrets: new StaticBearerTokenProvider('test-master'),
    bindings,
  });

  try {
    const route = (await gateway.resolveRoute('empl_review')).route!;
    const result = await gateway.invoke({ route, input: 'Review this change.' });
    assert.deepEqual(result, {
      gatewayRequestId: 'call_123',
      externalDeploymentRef: 'deployment_hash',
      outputText: 'REVIEW_OK',
      responseModel: 'employment:empl_review',
      status: 'succeeded',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      reasoningTokens: 5,
      actualCost: 0.125,
      currency: 'USD',
      latencyMs: 42.5,
      metadata: {
        liteLlmVersion: 'test-version',
        modelGroup: 'employment:empl_review',
        attemptedRetries: 1,
        attemptedFallbacks: 0,
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
