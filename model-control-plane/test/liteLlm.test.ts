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
