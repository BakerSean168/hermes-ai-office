import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const service = fs.readFileSync(path.join(root, 'deploy/gcp/hermes-model-control-plane.service'), 'utf8');
const installer = fs.readFileSync(path.join(root, 'deploy/gcp/install-gcp-execution-plane.sh'), 'utf8');

test('V4 service enables durable execution with narrowly scoped writable paths', () => {
  assert.match(service, /Description=Hermes Pixel Agent V4 Durable Coding Control Plane/);
  assert.match(service, /MODEL_CP_DB=\/srv\/hermes-personal\/data\/model-control-plane\/pixel-v4\.sqlite/);
  assert.match(service, /MODEL_CP_EXECUTION_RUNTIME_ENABLED=true/);
  assert.match(service, /MODEL_CP_AUTOMATION_RUNTIME_ENABLED=true/);
  assert.match(service, /MODEL_CP_V4_IMPLEMENTATION_ROUTES=gpt-5\.6-luna,implementation-efficient,implementation-glm=glm-5\.2/);
  assert.match(service, /MODEL_CP_V4_REVIEW_ROUTES=gpt-5\.6-sol,codex-auto-review,review-glm=glm-5\.2/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /ProtectHome=read-only/);
  for (const writable of [
    '/srv/hermes-personal/data/model-control-plane',
    '/opt/data/hermes-ai-office-v3/workspaces',
    '/home/dev/projects/memoflow-platform-1003',
    '/home/dev/projects/digital-biome',
  ]) assert.match(service, new RegExp('ReadWritePaths=' + writable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(service, /ReadWritePaths=\/home\/dev\/projects\s*$/m);
  assert.doesNotMatch(service, /(?:SESSION_API_KEY|LITELLM_V3_KEY|OH_SECRET_KEY)=\S+/);
});

test('V4 installer takes a SQLite backup and requires V4 execution health', () => {
  assert.match(installer, /from 'node:sqlite'/);
  assert.match(installer, /await backup\(db, target\)/);
  assert.match(installer, /pixel-v4-\$\(date -u/);
  assert.match(installer, /http:\/\/127\.0\.0\.1:8320\/api\/health/);
  assert.match(installer, /payload\.apiVersion !== 4/);
  assert.match(installer, /payload\.executionRuntime\?\.enabled !== true/);
  assert.doesNotMatch(installer, /PIXEL_V4_ALLOW_DATA_RESET=true/);
});
