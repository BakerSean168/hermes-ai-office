import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function source(relative: string): string {
  return fs.readFileSync(path.join(root, 'src/v3', relative), 'utf8');
}

test('durable plan orchestrator stays a plan-level coordinator rather than regrowing feature internals', () => {
  const orchestrator = source('planOrchestrator.ts');

  for (const requiredImport of [
    "./plan/workItemCoordinator.js",
    "./plan/batchCoordinator.js",
    "./plan/externalProgress.js",
    "./plan/recoveryCoordinator.js",
  ]) {
    assert.match(orchestrator, new RegExp(requiredImport.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const delegatedConcern of [
    'EXTERNAL_PROGRESS_SYNC_STARTED',
    'EXTERNAL_PROGRESS_AUDIT_INCOMPLETE',
    'BATCH_INTEGRATION_REPAIR_SCHEDULED',
    'BATCH_AGGREGATE_REVIEW_FAILED',
    'REVIEW_FIX_LIMIT_EXCEEDED',
  ]) {
    assert.doesNotMatch(orchestrator, new RegExp(delegatedConcern));
  }
});

test('plan application modules depend inward and do not import HTTP adapters', () => {
  for (const file of [
    'plan/workItemCoordinator.ts',
    'plan/batchCoordinator.ts',
    'plan/externalProgress.ts',
    'plan/recoveryCoordinator.ts',
  ]) {
    const text = source(file);
    assert.doesNotMatch(text, /from ['"]\.\.\/api\.js['"]/);
    assert.doesNotMatch(text, /from ['"]\.\.\/app\.js['"]/);
  }
});
