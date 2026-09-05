import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/prune-v4-host-cache.sh');
const GiB = 1024 ** 3;

function writeExecutable(file: string, content: string) {
  fs.writeFileSync(file, content, { mode: 0o755 });
}

function fixture(freeBytes: number, activeExecutions: number, reclaimToBytes?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-host-cache-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const freeFile = path.join(dir, 'free-bytes');
  const dockerLog = path.join(dir, 'docker.log');
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(freeFile, String(freeBytes));
  writeExecutable(
    path.join(bin, 'df'),
    `#!/usr/bin/env bash\nset -euo pipefail\nfree=$(cat "$PIXEL_TEST_FREE_FILE")\nkb=$((free / 1024))\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'\nprintf '/dev/fake 200000000 0 %s 0%% /\\n' "$kb"\n`,
  );
  writeExecutable(
    path.join(bin, 'curl'),
    `#!/usr/bin/env bash\nset -euo pipefail\nprintf '{"count":%s,"items":[]}' "$PIXEL_TEST_ACTIVE_EXECUTIONS"\n`,
  );
  writeExecutable(
    path.join(bin, 'docker'),
    `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" >> "$PIXEL_TEST_DOCKER_LOG"\nif [[ -n "${reclaimToBytes ?? ''}" && "$1" == builder && "$2" == prune ]]; then\n  printf '%s\\n' '${reclaimToBytes ?? ''}' > "$PIXEL_TEST_FREE_FILE"\nfi\n`,
  );
  const env = {
    ...process.env,
    PATH: bin + ':' + process.env.PATH,
    PIXEL_V4_HOST_CACHE_TEST_MODE: 'true',
    PIXEL_V4_HOST_CACHE_STATE_FILE: stateFile,
    PIXEL_V4_HOST_CACHE_LOCK: path.join(dir, 'maintenance.lock'),
    PIXEL_V4_RELEASE_LOCK: path.join(dir, 'release.lock'),
    PIXEL_TEST_FREE_FILE: freeFile,
    PIXEL_TEST_DOCKER_LOG: dockerLog,
    PIXEL_TEST_ACTIVE_EXECUTIONS: String(activeExecutions),
  };
  return { dir, stateFile, dockerLog, env };
}

function run(value: ReturnType<typeof fixture>) {
  return execFileSync('bash', [script], { env: value.env, encoding: 'utf8', stdio: 'pipe' });
}

function state(value: ReturnType<typeof fixture>) {
  return JSON.parse(fs.readFileSync(value.stateFile, 'utf8')) as {
    action: string;
    reason: string;
    freeBytesBefore: number;
    freeBytesAfter: number;
    activeExecutions: number;
    steps: string[];
  };
}

test('host cache maintenance is a no-op above the trigger and never calls Docker', () => {
  const value = fixture(20 * GiB, 0);
  try {
    run(value);
    assert.equal(state(value).action, 'NOOP_CAPACITY_OK');
    assert.equal(fs.existsSync(value.dockerLog), false);
  } finally {
    fs.rmSync(value.dir, { recursive: true, force: true });
  }
});

test('host cache maintenance protects a running Pixel execution', () => {
  const value = fixture(12 * GiB, 1);
  try {
    run(value);
    const result = state(value);
    assert.equal(result.action, 'SKIPPED_ACTIVE_EXECUTION');
    assert.equal(result.activeExecutions, 1);
    assert.equal(fs.existsSync(value.dockerLog), false);
  } finally {
    fs.rmSync(value.dir, { recursive: true, force: true });
  }
});

test('host cache maintenance skips while the release lock is held', async () => {
  const value = fixture(12 * GiB, 0);
  const holder = spawn('flock', [value.env.PIXEL_V4_RELEASE_LOCK!, 'sleep', '3'], {
    env: value.env,
    stdio: 'ignore',
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    run(value);
    assert.equal(state(value).action, 'SKIPPED_RELEASE_ACTIVE');
    assert.equal(fs.existsSync(value.dockerLog), false);
  } finally {
    holder.kill('SIGTERM');
    await new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    fs.rmSync(value.dir, { recursive: true, force: true });
  }
});

test('host cache maintenance stops after aged build cache restores the target', () => {
  const value = fixture(12 * GiB, 0, 26 * GiB);
  try {
    run(value);
    const result = state(value);
    assert.equal(result.action, 'PRUNED_TARGET_REACHED');
    assert.deepEqual(result.steps, ['BUILDER_CACHE_OLDER_THAN_POLICY']);
    const log = fs.readFileSync(value.dockerLog, 'utf8');
    assert.match(log, /^builder prune -af --filter until=24h/m);
    assert.doesNotMatch(log, /image prune/);
  } finally {
    fs.rmSync(value.dir, { recursive: true, force: true });
  }
});

test('host cache maintenance exhausts only safe cache/image tiers and never prunes volumes', () => {
  const value = fixture(12 * GiB, 0);
  try {
    assert.throws(() => run(value));
    const result = state(value);
    assert.equal(result.action, 'CAPACITY_STILL_LOW');
    assert.deepEqual(result.steps, [
      'BUILDER_CACHE_OLDER_THAN_POLICY',
      'ALL_UNUSED_BUILDER_CACHE',
      'DANGLING_IMAGES',
      'OLD_UNUSED_IMAGES',
    ]);
    const log = fs.readFileSync(value.dockerLog, 'utf8');
    assert.match(log, /builder prune -af --filter until=24h/);
    assert.match(log, /builder prune -af/);
    assert.match(log, /image prune -f/);
    assert.match(log, /image prune -af --filter until=168h/);
    assert.doesNotMatch(log, /volume|--volumes|system prune/);
  } finally {
    fs.rmSync(value.dir, { recursive: true, force: true });
  }
});
