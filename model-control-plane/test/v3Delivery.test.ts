import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GitHubPlanDelivery,
  type DeliveryCommandRunner,
  type PlanDeliveryRequest,
} from '../src/v3/delivery.js';

const request: PlanDeliveryRequest = {
  planId: 'plan-1',
  repositoryPath: '/repository',
  objective: 'Deliver a verified change',
  revision: 'abc123',
  config: {
    remote: 'origin',
    branch: 'feature/durable-delivery',
    targetBranch: 'main',
    autoMerge: true,
    mergeMethod: 'squash',
  },
};

function commandKey(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

test('production delivery waits when an open pull request has not published checks yet', async () => {
  const commands: string[] = [];
  const runner: DeliveryCommandRunner = async (_cwd, command, args) => {
    const key = commandKey(command, args);
    commands.push(key);
    if (key === 'git remote get-url origin') return 'git@github.com:example/project.git';
    if (key.includes('gh pr list')) {
      return JSON.stringify([
        {
          number: 7,
          url: 'https://github.com/example/project/pull/7',
          state: 'OPEN',
          baseRefName: 'main',
          headRefOid: 'abc123',
          statusCheckRollup: [],
        },
      ]);
    }
    if (key === 'git push origin abc123:refs/heads/feature/durable-delivery') return '';
    throw new Error(`unexpected command: ${key}`);
  };

  const result = await new GitHubPlanDelivery({ commandRunner: runner }).reconcile(request);

  assert.equal(result.outcome, 'WAITING');
  assert.equal(result.stage, 'CHECKS');
  assert.equal(
    commands.some((command) => command.includes('gh pr merge')),
    false,
  );
});


test('production delivery turns an open pull-request merge conflict into a bounded repair signal before checks', async () => {
  const commands: string[] = [];
  const runner: DeliveryCommandRunner = async (_cwd, command, args) => {
    const key = commandKey(command, args);
    commands.push(key);
    if (key === 'git remote get-url origin') return 'git@github.com:example/project.git';
    if (key.includes('gh pr list')) {
      return JSON.stringify([
        {
          number: 10,
          url: 'https://github.com/example/project/pull/10',
          state: 'OPEN',
          baseRefName: 'main',
          headRefOid: 'abc123',
          mergeStateStatus: 'DIRTY',
          mergeable: 'CONFLICTING',
          statusCheckRollup: [],
        },
      ]);
    }
    if (key === 'git push origin abc123:refs/heads/feature/durable-delivery') return '';
    throw new Error(`unexpected command: ${key}`);
  };

  const result = await new GitHubPlanDelivery({ commandRunner: runner }).reconcile(request);

  assert.equal(result.outcome, 'NEEDS_FIX');
  assert.equal(result.stage, 'MERGE');
  assert.equal(result.reason, 'DELIVERY_MERGE_CONFLICT');
  assert.equal(result.pullRequestUrl, 'https://github.com/example/project/pull/10');
  assert.deepEqual(result.evidence, {
    reason: 'DELIVERY_MERGE_CONFLICT',
    mergeStateStatus: 'DIRTY',
    mergeable: 'CONFLICTING',
    branch: 'feature/durable-delivery',
    targetBranch: 'main',
    expectedRevision: 'abc123',
    pullRequestNumber: 10,
  });
  assert.equal(commands.some((command) => command.includes('gh pr merge')), false);
});

test('production delivery never mistakes an older merged pull request for the requested revision', async () => {
  const commands: string[] = [];
  let pullRequestLists = 0;
  const runner: DeliveryCommandRunner = async (_cwd, command, args) => {
    const key = commandKey(command, args);
    commands.push(key);
    if (key === 'git remote get-url origin') return 'https://github.com/example/project.git';
    if (key.includes('gh pr list')) {
      pullRequestLists += 1;
      if (pullRequestLists < 3) {
        return JSON.stringify([
          {
            number: 3,
            url: 'https://github.com/example/project/pull/3',
            state: 'MERGED',
            baseRefName: 'main',
            headRefOid: 'old456',
            mergeCommit: { oid: 'merge-old' },
            statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
          },
        ]);
      }
      return JSON.stringify([
        {
          number: 8,
          url: 'https://github.com/example/project/pull/8',
          state: 'OPEN',
          baseRefName: 'main',
          headRefOid: 'abc123',
          statusCheckRollup: [],
        },
      ]);
    }
    if (key === 'git push origin abc123:refs/heads/feature/durable-delivery') return '';
    if (key.includes('gh pr create')) return 'https://github.com/example/project/pull/8';
    throw new Error(`unexpected command: ${key}`);
  };

  const result = await new GitHubPlanDelivery({ commandRunner: runner }).reconcile(request);

  assert.equal(result.outcome, 'WAITING');
  assert.equal(
    commands.some((command) => command.includes('gh pr create')),
    true,
  );
  assert.equal(
    commands.some((command) => command.includes('gh pr merge 3')),
    false,
  );
});

test('production delivery waits for an open pull request to observe the pushed revision', async () => {
  const commands: string[] = [];
  const runner: DeliveryCommandRunner = async (_cwd, command, args) => {
    const key = commandKey(command, args);
    commands.push(key);
    if (key === 'git remote get-url origin') return 'git@github.com:example/project.git';
    if (key.includes('gh pr list')) {
      return JSON.stringify([
        {
          number: 9,
          url: 'https://github.com/example/project/pull/9',
          state: 'OPEN',
          baseRefName: 'main',
          headRefOid: 'stale123',
          statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        },
      ]);
    }
    if (key === 'git push origin abc123:refs/heads/feature/durable-delivery') return '';
    throw new Error(`unexpected command: ${key}`);
  };

  const result = await new GitHubPlanDelivery({ commandRunner: runner }).reconcile(request);

  assert.equal(result.outcome, 'WAITING');
  assert.equal(result.stage, 'CHECKS');
  assert.deepEqual(result.evidence, {
    expectedRevision: 'abc123',
    observedRevision: 'stale123',
  });
  assert.equal(
    commands.some((command) => command.includes('gh pr merge')),
    false,
  );
});

test('production delivery turns failed post-merge checks into a follow-up repair signal with merge evidence', async () => {
  const commands: string[] = [];
  const runner: DeliveryCommandRunner = async (_cwd, command, args) => {
    const key = commandKey(command, args);
    commands.push(key);
    if (key === 'git remote get-url origin') return 'git@github.com:example/project.git';
    if (key.includes('gh pr list')) {
      return JSON.stringify([
        {
          number: 12,
          url: 'https://github.com/example/project/pull/12',
          state: 'MERGED',
          baseRefName: 'main',
          headRefOid: 'abc123',
          mergeCommit: { oid: 'merge-bad-123' },
          statusCheckRollup: [{ name: 'PR CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        },
      ]);
    }
    if (key.includes('repos/example/project/commits/merge-bad-123/check-runs')) {
      return JSON.stringify([
        { name: 'main-smoke', status: 'completed', conclusion: 'failure' },
        { name: 'typecheck', status: 'completed', conclusion: 'success' },
      ]);
    }
    if (key.includes('repos/example/project/commits/merge-bad-123/status')) {
      return JSON.stringify([]);
    }
    throw new Error(`unexpected command: ${key}`);
  };

  const result = await new GitHubPlanDelivery({ commandRunner: runner }).reconcile(request);

  assert.equal(result.outcome, 'NEEDS_FIX');
  assert.equal(result.stage, 'POST_MERGE_CHECKS');
  assert.equal(result.reason, 'DELIVERY_POST_MERGE_CHECKS_FAILED');
  assert.equal(result.mergeRevision, 'merge-bad-123');
  assert.equal(result.pullRequestUrl, 'https://github.com/example/project/pull/12');
  assert.deepEqual(result.evidence, {
    reason: 'DELIVERY_POST_MERGE_CHECKS_FAILED',
    mergeRevision: 'merge-bad-123',
    branch: 'feature/durable-delivery',
    targetBranch: 'main',
    pullRequestNumber: 12,
    pending: [],
    failed: ['main-smoke'],
    passed: ['typecheck'],
  });
  assert.equal(commands.some((command) => command.includes('git push')), false);
  assert.equal(commands.some((command) => command.includes('gh pr create')), false);
});
