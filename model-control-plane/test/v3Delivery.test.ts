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
