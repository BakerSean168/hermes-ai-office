import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AntigravityExecutionProvider,
  AntigravityReviewProvider,
} from '../src/v4/adapters/antigravity.js';
import type {
  ProviderLaunchInput,
  ProviderSessionSnapshot,
} from '../src/v4/orchestration/contracts.js';

function executable(file: string, content: string): string {
  fs.writeFileSync(file, content, { mode: 0o755 });
  return file;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function fixture(mode: 'implementation' | 'review' | 'wait' = 'implementation') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-antigravity-'));
  const executionRoot = path.join(root, 'workspaces', 'v4', 'executions', 'exec-ant');
  const repository = path.join(executionRoot, 'repo');
  const evidence = path.join(executionRoot, 'completion-evidence.json');
  const stateRoot = path.join(root, 'state');
  const home = path.join(root, 'home');
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repository]);
  git(repository, ['config', 'user.name', 'Antigravity Test']);
  git(repository, ['config', 'user.email', 'antigravity-test@local']);
  fs.writeFileSync(path.join(repository, 'README.md'), '# before\n');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'chore: initialize']);
  const sourceRevision = git(repository, ['rev-parse', 'HEAD']);

  const launcher = executable(
    path.join(root, 'fake-unshare.sh'),
    `#!/bin/sh
set -eu
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ "$#" -gt 0 ] && shift
exec "$@"
`,
  );
  const wrapper = executable(
    path.join(root, 'fake-wrapper.sh'),
    `#!/bin/sh
set -eu
binary=''
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  if [ "$1" = "--binary" ]; then shift; binary="$1"; fi
  shift
done
[ "$#" -gt 0 ] && shift
exec "$binary" "$@"
`,
  );
  const agy = executable(
    path.join(root, 'fake-agy.mjs'),
    `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input.trim());
  if (request.event !== 'user' || !String(request.message?.content ?? '').includes('bounded objective')) process.exit(41);
  const args = process.argv.slice(2);
  if (!args.includes('--sandbox') || !args.includes('--dangerously-skip-permissions')) process.exit(42);
  if (${JSON.stringify(mode)} === 'wait') {
    setInterval(() => {}, 1000);
    return;
  }
  if (${JSON.stringify(mode)} === 'implementation') {
    fs.appendFileSync('README.md', 'implemented-by-antigravity\\n');
    execFileSync('git', ['add', 'README.md']);
    execFileSync('git', ['commit', '-m', 'feat: implement antigravity smoke']);
  }
  console.log(JSON.stringify({ event: 'tool', command: 'git status --short', exit_code: 0, output: 'clean' }));
  console.log(JSON.stringify({
    event: 'result',
    result: ${
      mode === 'review'
        ? `{ status: 'SUCCESS', response: 'reviewed', structured_output: { verdict: 'PASS', summary: 'Exact revision passes review.', findings: [] } }`
        : `{ status: 'SUCCESS', response: 'Implemented bounded objective.' }`
    }
  }));
});
`,
  );

  return {
    root,
    repository,
    evidence,
    stateRoot,
    home,
    launcher,
    wrapper,
    agy,
    sourceRevision,
  };
}

function input(
  value: ReturnType<typeof fixture>,
  phase: 'IMPLEMENT' | 'REVIEW',
): ProviderLaunchInput {
  return {
    executionId: 'exec-ant',
    planId: 'plan-ant',
    projectKey: 'digital-biome',
    workItemId: 'work-ant',
    phase,
    objective: 'Complete the bounded objective.',
    acceptanceCriteria: ['produce deterministic evidence'],
    sourceRevision: value.sourceRevision,
    route: 'resource:antigravity-primary:test',
    workspace: {
      executionId: 'exec-ant',
      hostPath: value.repository,
      executionPath: '/workspace/v4/executions/exec-ant/repo',
      evidenceHostPath: value.evidence,
      evidenceExecutionPath: '/workspace/v4/executions/exec-ant/completion-evidence.json',
      sourceRepositoryPath: value.repository,
      sourceRevision: value.sourceRevision,
      createdAt: new Date().toISOString(),
    },
  };
}

function options(value: ReturnType<typeof fixture>, model: string) {
  return {
    binary: value.agy,
    stateRoot: value.stateRoot,
    workspaceHostRoot: path.join(value.root, 'workspaces'),
    home: value.home,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    workspaceGid: process.getgid?.() ?? 1000,
    sandboxWrapper: value.wrapper,
    launcherBinary: value.launcher,
    model,
  };
}

async function terminal(
  provider: AntigravityExecutionProvider | AntigravityReviewProvider,
  sessionId: string,
): Promise<ProviderSessionSnapshot> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await provider.inspect(sessionId);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Antigravity fake provider did not terminate');
}

test('Antigravity implementation requires a clean committed workspace and writes controller evidence', async () => {
  const value = fixture('implementation');
  const provider = new AntigravityExecutionProvider(options(value, 'gemini-3.8-flash-high'));
  const launched = await provider.launch(input(value, 'IMPLEMENT'));
  assert.equal(launched.status, 'RUNNING');
  assert.equal(launched.providerSessionId, 'antigravity:exec-ant');
  const completed = await terminal(provider, launched.providerSessionId!);
  assert.equal(completed.status, 'SUCCEEDED');
  assert.match(completed.finalResponse ?? '', /Implemented bounded objective/);
  assert.equal(git(value.repository, ['status', '--porcelain']), '');
  assert.notEqual(git(value.repository, ['rev-parse', 'HEAD']), value.sourceRevision);
  const evidence = JSON.parse(fs.readFileSync(value.evidence, 'utf8'));
  assert.equal(evidence.phase, 'IMPLEMENT');
  assert.equal(evidence.outcome, 'CHANGED');
  assert.equal(evidence.resultRevision, git(value.repository, ['rev-parse', 'HEAD']));
  assert.ok(evidence.tests.some((item: any) => item.status === 'PASS'));
  const recovered = await provider.recover({
    executionId: 'exec-ant',
    createdAt: new Date().toISOString(),
    projectKey: 'digital-biome',
    phase: 'IMPLEMENT',
    expectedWorkspacePath: '/workspace/v4/executions/exec-ant/repo',
  });
  assert.equal(recovered?.status, 'SUCCEEDED');
});

test('Antigravity review remains independent and writes exact-SHA structured evidence', async () => {
  const value = fixture('review');
  const provider = new AntigravityReviewProvider(options(value, 'gemini-3.1-pro-high'));
  const launched = await provider.launch(input(value, 'REVIEW'));
  const completed = await terminal(provider, launched.providerSessionId!);
  assert.equal(provider.independentReview, true);
  assert.equal(completed.status, 'SUCCEEDED');
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), value.sourceRevision);
  assert.equal(git(value.repository, ['status', '--porcelain']), '');
  const evidence = JSON.parse(fs.readFileSync(value.evidence, 'utf8'));
  assert.equal(evidence.phase, 'REVIEW');
  assert.equal(evidence.reviewedSha, value.sourceRevision);
  assert.equal(evidence.verdict, 'PASS');
  assert.ok(evidence.checks.some((item: any) => item.status === 'PASS'));
});

test('Antigravity cancellation is durable and terminates the detached process group', async () => {
  const value = fixture('wait');
  const provider = new AntigravityExecutionProvider(options(value, 'gemini-3.8-flash-high'));
  const launched = await provider.launch(input(value, 'IMPLEMENT'));
  const cancelled = await provider.cancel(launched.providerSessionId!);
  assert.equal(cancelled.status, 'CANCELLED');
  assert.ok(fs.existsSync(path.join(value.stateRoot, 'exec-ant', 'cancelled')));
});
