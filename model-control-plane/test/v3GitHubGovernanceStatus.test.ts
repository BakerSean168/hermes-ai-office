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
    if (key.startsWith(`gh api -X POST repos/example/project/statuses/${HEAD}`)) return '{}';
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
  assert.deepEqual(pending, { revision: HEAD, state: 'pending', stale: false });
  assert.ok(
    state.commands.some(
      (command) =>
        command.includes(`state=pending`) &&
        command.includes(`context=${GITHUB_GOVERNANCE_STATUS_CONTEXT}`) &&
        command.includes(`target_url=https://github.com/example/project/pull/42`),
    ),
  );

  const success = await reporter.publish({ ...input(state.repositoryPath), planStatus: 'SUCCEEDED' });
  assert.deepEqual(success, { revision: HEAD, state: 'success', stale: false });
  assert.ok(state.commands.some((command) => command.includes('state=success')));
});

test('GitHub governance status never marks a stale reviewed SHA green after PR synchronize', async () => {
  const state = fixture();
  state.setPull(pull(NEW_HEAD));
  const reporter = new GitHubGovernanceStatus({ commandRunner: state.runner });

  const result = await reporter.publish({ ...input(state.repositoryPath), planStatus: 'SUCCEEDED' });
  assert.deepEqual(result, { revision: HEAD, state: 'error', stale: true });
  const post = state.commands.find((command) => command.includes('gh api -X POST')) ?? '';
  assert.match(post, /state=error/);
  assert.match(post, /review is stale because the pull request head changed/);
  assert.doesNotMatch(post, /state=success/);
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
