import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/v4');

function files(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
}

test('V4 has no HTTP, child-process or legacy coordinator dependency', () => {
  for (const file of files(root)) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /from ['"][^'"]*(fastify|http|child_process|v3)[^'"]*['"]/i, file);
    assert.doesNotMatch(source, /execFile|spawnSync|fork\(/, file);
  }
});

test('supervisor code only calls typed kernel ports', () => {
  for (const file of files(path.join(root, 'supervisor'))) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /node:child_process|from ['"][^'"]*(workspace|node:fs)[^'"]*['"]/i, file);
  }
});

test('V4 source has explicit safety terms and no credential/header values', () => {
  const source = files(root).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.match(source, /UNSAFE_EVENT_PAYLOAD/);
  assert.match(source, /STALE_PROJECTION_DIGEST/);
  assert.match(source, /REAL_MERGE_DISABLED/);
  assert.doesNotMatch(source, /authorization:\s*['"][^'"]+['"]/i);
  assert.doesNotMatch(source, /rawHeaders\s*:/i);
});
