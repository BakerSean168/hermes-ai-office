import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import type { GitHubGovernanceStatusPort } from '../src/v3/githubGovernanceStatus.js';
import { GovernanceCoordinator } from '../src/v3/plan/governanceCoordinator.js';
import { PlanRepository } from '../src/v3/plans.js';

const OLD_HEAD = '1111111111111111111111111111111111111111';
const NEW_HEAD = '2222222222222222222222222222222222222222';
const BASE = '3333333333333333333333333333333333333333';

function externalPlan(revision: string) {
  return {
    projectKey: 'digital-biome',
    objective: 'Govern one exact pull request head.',
    analysisSummary: 'Exact-head governance test.',
    repository: { path: '/tmp/repository', baseRevision: BASE },
    source: {
      kind: 'EXTERNAL_CHANGE' as const,
      revision,
      origin: {
        kind: 'GITHUB_PULL_REQUEST' as const,
        repository: 'example/project',
        pullRequestNumber: 42,
        pullRequestUrl: 'https://github.com/example/project/pull/42',
        title: 'Proposal',
        author: 'bot',
        headRef: 'bot/change',
        baseRef: 'main',
        headRepository: 'example/project',
      },
    },
    batches: [{ key: 'external-pr', title: 'Review', workItems: [{ key: 'change', title: 'Change', objective: 'Review.' }] }],
  };
}

test('retiring an old PR head requeues the already-known current-head governance side effect', async () => {
  const db = new DatabaseSync(':memory:');
  const repository = new PlanRepository(db);
  const oldPlan = repository.create(
    externalPlan(OLD_HEAD),
    `github-pr:example/project:42:${OLD_HEAD}`,
  ).plan;
  const newPlan = repository.create(
    externalPlan(NEW_HEAD),
    `github-pr:example/project:42:${NEW_HEAD}`,
  ).plan;

  repository.setPlanStatus(oldPlan.planId, 'BLOCKED', 'GITHUB_PR_CHANGED_DURING_REPAIR_PUBLICATION');
  repository.setGovernanceStatusPublished(oldPlan.planId, OLD_HEAD, 'RUNNING');
  repository.setPlanStatus(newPlan.planId, 'SUCCEEDED');
  repository.setGovernanceStatusPublished(newPlan.planId, NEW_HEAD, 'SUCCEEDED');

  const status: GitHubGovernanceStatusPort = {
    async publish(input) {
      assert.equal(input.planId, oldPlan.planId);
      return {
        revision: OLD_HEAD,
        state: 'error',
        stale: true,
        observedHeadRevision: NEW_HEAD,
        published: true,
        superseded: true,
      };
    },
  };
  const coordinator = new GovernanceCoordinator({ repository, status });
  await coordinator.reconcile(oldPlan.planId);

  const retired = repository.get(oldPlan.planId)!;
  assert.equal(retired.governanceStatusRevision, OLD_HEAD);
  assert.equal(retired.governanceStatusPlanStatus, 'BLOCKED');

  const requeued = repository.get(newPlan.planId)!;
  assert.equal(requeued.governanceStatusRevision, undefined);
  assert.equal(requeued.governanceStatusPlanStatus, undefined);
  assert.deepEqual(repository.active().map((plan) => plan.planId), [newPlan.planId]);
});
