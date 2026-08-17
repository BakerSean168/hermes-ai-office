import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CpaAdapter } from '../src/adapters/cpa.mjs';

test('CPA model discovery uses the configured client key without exposing it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hao-cpa-adapter-'));
  const configFile = path.join(dir, 'config.yaml');
  const secret = 'test-private-cpa-key';
  fs.writeFileSync(configFile, `host: 127.0.0.1\napi-keys:\n  - "${secret}"\ndebug: false\n`);
  let observed = '';
  const server = http.createServer((req, res) => {
    observed = String(req.headers.authorization || '');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'grok-4.5' }, { id: 'grok-4.6' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const adapter = new CpaAdapter({
      sudo: false,
      gatewayctl: '/bin/false',
      configFile,
      baseUrl: `http://127.0.0.1:${address.port}`,
    });
    assert.deepEqual(await adapter.models(), ['grok-4.5', 'grok-4.6']);
    assert.equal(observed, `Bearer ${secret}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
