#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const packageRoot = process.argv[2];
if (!packageRoot) {
  console.error('usage: verify_dsh_no_default_max_tokens.mjs <dsh-llm-deepseek-package-root>');
  process.exit(2);
}

const mod = await import(pathToFileURL(path.join(packageRoot, 'lib', 'index.js')).href);

function resolved(baseURL, maxTokens) {
  return mod.resolveAdapterOptions({
    baseURL,
    thinking: 'disabled',
    reasoningEffort: 'off',
    models: [],
    ...(maxTokens === undefined ? {} : { maxTokens }),
  });
}

async function captureWireBody(maxTokens) {
  let captured;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    captured = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'intentional verifier stop' } }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('verifier failed to allocate loopback port');
  const connection = resolved(`http://127.0.0.1:${address.port}`, maxTokens);
  const adapter = new mod.DeepSeekAdapter({
    options: () => connection,
    resolveApiKey: async () => 'verifier-key',
    resolveUserId: () => 'verifier-user',
  });
  try {
    const iterator = adapter.request(
      {
        provider: 'deepseek-official',
        model: 'implementation-efficient',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        ...(maxTokens === undefined ? {} : { maxTokens }),
      },
      new AbortController().signal,
      connection,
      'verifier-key',
      'verifier-user',
      undefined,
      () => {},
    );
    try {
      for await (const _chunk of iterator) {
        // The verifier endpoint intentionally returns HTTP 400 after capturing the body.
      }
    } catch {
      // Expected: the local verifier endpoint stops the request after body capture.
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  if (!captured) throw new Error('DSH verifier did not capture a request body');
  return captured;
}

const implicitConnection = resolved('http://127.0.0.1:9');
if (Object.prototype.hasOwnProperty.call(implicitConnection, 'maxTokens')) {
  throw new Error(`implicit DSH maxTokens survived: ${implicitConnection.maxTokens}`);
}
const implicitAdapter = new mod.DeepSeekAdapter({
  options: () => implicitConnection,
  resolveApiKey: async () => 'verifier-key',
  resolveUserId: () => 'verifier-user',
});
const implicitModel = await implicitAdapter.prepareCall(
  'deepseek-official',
  'implementation-efficient',
);
if (Object.prototype.hasOwnProperty.call(implicitModel.model, 'defaultMaxTokens')) {
  throw new Error(
    `implicit DSH defaultMaxTokens survived: ${implicitModel.model.defaultMaxTokens}`,
  );
}

const implicitBody = await captureWireBody();
if (Object.prototype.hasOwnProperty.call(implicitBody, 'max_tokens')) {
  throw new Error(`implicit DSH wire max_tokens survived: ${implicitBody.max_tokens}`);
}

const explicitBody = await captureWireBody(12345);
if (explicitBody.max_tokens !== 12345) {
  throw new Error(`explicit DSH max_tokens was not preserved: ${explicitBody.max_tokens}`);
}

console.log('DSH no-default-max-tokens verification passed');
