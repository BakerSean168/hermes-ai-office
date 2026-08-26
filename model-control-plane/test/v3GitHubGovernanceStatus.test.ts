import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GITHUB_GOVERNANCE_STATUS_CONTEXT,
  GitHubGovernanceStatus,
  type GitHubGovernanceCommandRunner,
} from '../src/v3/githubGovernanceStatus.js';

const HEAD = '1111111111111111111111111111111111111111';
const NEW_HEAD = '2222222222222222222222222222222222222222';
const THIRD_HEAD = '3333333333333333333333333333333333333333';

function pull(head = HEAD, state = 'open') {
  return JSON.stringify({ number: 42, state, head: { sha: head } });
}

function fixture() {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'github-governance-'));
  const commands: string[] = [];
  let currentPull = pull();
  const runner: GitHubGovernanceCommandRunner = async (_cwd, command, args) => {
    const key = `${command} ${args.join(' ')}`;
    commands.push(key);
    if (key === 'gh api repos/example/project/pulls/42') return currentPull;
    if (key.startsWith('gh api -X POST repos/example/project/statuses/')) return '{}';
    throw new Error(`unexpected command: ${key}`);
  };
  return {
    repositoryPath,
    commands,
    runner,
    setPull(value: string) {
      currentPull = value;
    },
  };
}

function input(repositoryPath: string) {
  return {
    repositoryPath,
    repository: 'example/project',
    pullRequestNumber: 42,
    pullRequestUrl: 'https://github.com/example/project/pull/42',
    expectedHeadRevision: HEAD,
    planId: 'plan_governance',
  } as const;
}

test('GitHub governance status publishes pending and success on the exact PR head context', async () => {
  const state = fixture();
  const reporter = new GitHubGovernanceStatus({ commandRunner: state.runner });

  const pending = await reporter.publish({ ...input(state.repositoryPath), planStatus: 'RUNNING' });
  assert.deepEqual(pending, {
    revision: HEAD,
    state: 'pending',
    stale: false,
    observedHeadRevision: HEAD,
    published: true,
  });
  assert.ok(
    state.commands.some(
      (command) =>
        command.includes(`state=pending`) &&
        command.includes(`context=${GITHUB_GOVERNANCE_STATUS_CONTEXT}`) &&
        command.includes(`target_url=https://github.com/example/project/pull/42`),
    ),
  );

  const success = await reporter.publish({ ...input(state.repositoryPath), planStatus: 'SUCCEEDED' });
  assert.deepEqual(success, {
    revision: HEAD,
    state: 'success',
    stale: false,
    observedHeadRevision: HEAD,
    published: true,
  });
  assert.ok(state.commands.some((command) => command.includes('state=success')));
});

test('GitHub governance status rechecks the PR head after posting and fails closed on a publish race', async () => {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'github-governance-post-race-'));
  const commands: string[] = [];
  let reads = 0;
  const runner: GitHubGovernanceCommandRunner = async (_cwd, command, args) => {
    const key = `${command} ${args.join(' ')}`;
    commands.push(key);
    if (key === 'gh api repos/example/project/pulls/42') {
      reads += 1;
      return reads === 1 ? pull(HEAD) : pull(NEW_HEAD);
    }
    if (key.startsWith('gh api -X POST repos/example/project/statuses/')) return '{}';
    throw new Error(`unexpected command: ${key}`);
  };
  const reporter = new GitHubGovernanceStatus({ commandRunner: runner });

  const result = await reporter.publish({ ...input(repositoryPath), planStatus: 'SUCCEEDED' });
  assert.deepEqual(result, {
    revision: HEAD,
    state: 'error',
    stale: true,
    observedHeadRevision: NEW_HEAD,
    published: true,
  });
  assert.ok(commands.some((command) => command.includes(`statuses/${HEAD}`) && command.includes('state=success')));
  assert.ok(commands.some((command) => command.includes(`statuses/${HEAD}`) && command.includes('state=error')));
  assert.ok(commands.some((command) => command.includes(`statuses/${NEW_HEAD}`) && command.includes('state=error')));
  assert.ok(reads >= 3, 'the fail-closed status write must itself be verified against the current PR head');
});

test('GitHub governance status leaves reconciliation retryable when the PR head keeps moving during fail-closed publication', async () => {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'github-governance-unstable-head-'));
  let reads = 0;
  const runner: GitHubGovernanceCommandRunner = async (_cwd, command, args) => {
    const key = `${command} ${args.join(' ')}`;
    if (key === 'gh api repos/example/project/pulls/42') {
      reads += 1;
      if (reads === 1) return pull(HEAD);
      if (reads === 2) return pull(NEW_HEAD);
      return pull(THIRD_HEAD);
    }
    if (key.startsWith('gh api -X POST repos/example/project/statuses/')) return '{}';
    throw new Error(`unexpected command: ${key}`);
  };
  const reporter = new GitHubGovernanceStatus({ commandRunner: runner });

  await assert.rejects(
    () => reporter.publish({ ...input(repositoryPath), planStatus: 'SUCCEEDED' }),
    /GITHUB_GOVERNANCE_HEAD_UNSTABLE/,
  );
  assert.equal(reads, 3);
});

test('GitHub governance status never marks a stale reviewed SHA green after PR synchronize', async () => {
  const state = fixture();
  state.setPull(pull(NEW_HEAD));
  const reporter = new GitHubGovernanceStatus({ commandRunner: state.runner });

  const result = await reporter.publish({ ...input(state.repositoryPath), planStatus: 'SUCCEEDED' });
  assert.deepEqual(result, {
    revision: HEAD,
    state: 'error',
    stale: true,
    observedHeadRevision: NEW_HEAD,
    published: true,
  });
  const post = state.commands.find((command) => command.includes('gh api -X POST')) ?? '';
  assert.match(post, /state=error/);
  assert.match(post, /review is stale because the pull request head changed/);
  assert.doesNotMatch(post, /state=success/);
});

test('GitHub governance status defers publication while the control-plane repair head is propagating', async () => {
  const state = fixture();
  const now = Date.parse('2026-08-26T08:00:00.000Z');
  const reporter = new GitHubGovernanceStatus({ commandRunner: state.runner, now: () => now });

  const result = await reporter.publish({
    ...input(state.repositoryPath),
    expectedHeadRevision: NEW_HEAD,
    previousHeadRevision: HEAD,
    repairPublishedAt: now - 30_000,
    planStatus: 'RUNNING',
  });

  assert.deepEqual(result, {
    revision: NEW_HEAD,
    state: 'pending',
    stale: true,
    observedHeadRevision: HEAD,
    published: false,
  });
  assert.equal(state.commands.some((command) => command.includes('gh api -X POST')), false);
});

test('GitHub governance status stops treating the previous head as propagation lag after the bounded grace window', async () => {
  const state = fixture();
  const now = Date.parse('2026-08-26T08:00:00.000Z');
  const reporter = new GitHubGovernanceStatus({
    commandRunner: state.runner,
    now: () => now,
  });

  const result = await reporter.publish({
    ...input(state.repositoryPath),
    expectedHeadRevision: NEW_HEAD,
    previousHeadRevision: HEAD,
    repairPublishedAt: now - 5 * 60_000,
    planStatus: 'SUCCEEDED',
  });

  assert.deepEqual(result, {
    revision: NEW_HEAD,
    state: 'error',
    stale: true,
    observedHeadRevision: HEAD,
    published: true,
  });
  assert.ok(state.commands.some((command) => command.includes('state=error')));
});

test('GitHub governance status maps blocking and cancelled plans to non-green commit statuses', async () => {
  const state = fixture();
  const reporter = new GitHubGovernanceStatus({ commandRunner: state.runner });

  const blocked = await reporter.publish({
    ...input(state.repositoryPath),
    planStatus: 'BLOCKED',
    blockedReason: 'EXTERNAL_CHANGE_INVALID',
  });
  assert.equal(blocked.state, 'failure');
  assert.ok(state.commands.some((command) => command.includes('state=failure')));

  const cancelled = await reporter.publish({ ...input(state.repositoryPath), planStatus: 'CANCELLED' });
  assert.equal(cancelled.state, 'error');
});
