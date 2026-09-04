import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PlanWorktreeManager, worktreeRefComponent } from '../src/v4/adapters/planWorktrees.js';
import { V4Error } from '../src/v4/domain/errors.js';
import { openV4Database, SCHEMA_VERSION } from '../src/v4/persistence/database.js';
import { createRepositories } from '../src/v4/persistence/repositories.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-plan-worktrees-'));
  const repositoriesRoot = path.join(root, 'repositories');
  const repository = path.join(repositoriesRoot, 'bodysense');
  const managed = path.join(root, 'managed');
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(managed, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repository]);
  git(repository, ['config', 'user.name', 'Pixel Worktree Test']);
  git(repository, ['config', 'user.email', 'pixel-worktree@test.local']);
  fs.writeFileSync(path.join(repository, 'README.md'), 'base\n');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'chore: base']);
  const revision = git(repository, ['rev-parse', 'HEAD']);
  const db = openV4Database(path.join(root, 'pixel.sqlite'), { environment: 'test' });
  const repositories = createRepositories(db);
  const plan = repositories.plans.createPlan({
    planId: 'plan-a',
    idempotencyKey: 'worktree-plan-a',
    projectKey: 'bodysense',
    objective: 'exercise literal worktrees',
    repositoryPath: repository,
    baseRevision: revision,
  }).value!;
  const graph = repositories.plans.createGraphVersion({
    planId: plan.planId,
    reason: 'test graph',
  }).value!;
  const itemA = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'item-a',
    title: 'Item A',
    objective: 'change A',
    acceptanceCriteria: ['commit A'],
    dependencies: [],
  }).value!;
  const itemB = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'item-b',
    title: 'Item B',
    objective: 'change B',
    acceptanceCriteria: ['commit B'],
    dependencies: [],
  }).value!;
  repositories.projectPlans.scheduleRootPlan(plan.planId);
  const manager = new PlanWorktreeManager({
    repositories,
    allowedRepositoryRoots: [repositoriesRoot],
    managedHostRoot: managed,
    executionRoot: '/workspace',
  });
  return {
    root,
    repositoriesRoot,
    repository,
    managed,
    revision,
    db,
    repositories,
    plan,
    itemA,
    itemB,
    manager,
  };
}

function createExecution(
  repositories: ReturnType<typeof createRepositories>,
  planId: string,
  workItemId: string,
  executionId: string,
  sourceRevision: string,
) {
  return repositories.executions.create({
    executionId,
    idempotencyKey: executionId,
    identity: {
      executionId,
      planId,
      workItemId,
      phase: 'IMPLEMENT',
      attempt: 1,
      route: 'test-route',
      sourceRevision,
    },
    objective: 'exercise writer ownership',
  }).value!;
}

test('PlanWorktreeManager creates one literal shared-common-dir worktree per role and preserves canonical checkout', async () => {
  const value = fixture();
  const canonicalHead = git(value.repository, ['rev-parse', 'HEAD']);
  const integration = await value.manager.ensureIntegration({
    projectKey: 'bodysense',
    rootPlanId: value.plan.planId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });
  const item = await value.manager.ensureWorkItem({
    projectKey: 'bodysense',
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });

  assert.equal(integration.role, 'INTEGRATION');
  assert.equal(item.role, 'WORK_ITEM');
  assert.match(integration.branchRef!, /^refs\/heads\/pixel-v4\/plan-a\/integration$/);
  assert.match(item.branchRef!, new RegExp('^refs/heads/pixel-v4/plan-a/items/'));
  const canonicalCommon = fs.realpathSync(path.join(value.repository, '.git'));
  for (const worktree of [integration, item]) {
    const commonRaw = git(worktree.hostPath, ['rev-parse', '--git-common-dir']);
    const common = fs.realpathSync(
      path.isAbsolute(commonRaw) ? commonRaw : path.resolve(worktree.hostPath, commonRaw),
    );
    assert.equal(common, canonicalCommon);
  }
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), canonicalHead);
  assert.equal(fs.readFileSync(path.join(value.repository, 'README.md'), 'utf8'), 'base\n');

  const listed = git(value.repository, ['worktree', 'list', '--porcelain']);
  assert.match(listed, new RegExp(integration.hostPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(listed, /locked pixel-v4:worktree:integration:plan-a:integration/);

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('WorkItem worktree survives provider retries and enforces one durable writer at a time', async () => {
  const value = fixture();
  let worktree = await value.manager.ensureWorkItem({
    projectKey: 'bodysense',
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });
  createExecution(
    value.repositories,
    value.plan.planId,
    value.itemA.workItemId,
    'exec-1',
    value.revision,
  );
  createExecution(
    value.repositories,
    value.plan.planId,
    value.itemA.workItemId,
    'exec-2',
    value.revision,
  );

  worktree = await value.manager.attachWriter(worktree.worktreeId, 'exec-1');
  assert.equal(worktree.ownerExecutionId, 'exec-1');
  await assert.rejects(
    () => value.manager.attachWriter(worktree.worktreeId, 'exec-2'),
    (error: unknown) => error instanceof V4Error && error.code === 'WORKTREE_WRITER_HELD',
  );

  fs.writeFileSync(path.join(worktree.hostPath, 'result.txt'), 'done\n');
  git(worktree.hostPath, ['add', 'result.txt']);
  git(worktree.hostPath, ['commit', '-m', 'feat: implement item a']);
  const resultRevision = git(worktree.hostPath, ['rev-parse', 'HEAD']);
  worktree = await value.manager.releaseWriter(worktree.worktreeId, 'exec-1');
  assert.equal(worktree.state, 'QUIESCENT');
  assert.equal(worktree.currentRevision, resultRevision);
  assert.equal(worktree.ownerExecutionId, undefined);

  const reused = await value.manager.ensureWorkItem({
    projectKey: 'bodysense',
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });
  assert.equal(reused.worktreeId, worktree.worktreeId);
  assert.equal(reused.hostPath, worktree.hostPath);
  assert.equal(reused.currentRevision, resultRevision);
  const secondOwner = await value.manager.attachWriter(worktree.worktreeId, 'exec-2');
  assert.equal(secondOwner.ownerExecutionId, 'exec-2');
  const releasedAgain = await value.manager.releaseWriter(worktree.worktreeId, 'exec-2');
  assert.equal(releasedAgain.currentRevision, resultRevision);
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), value.revision);

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('review worktree is detached at exact SHA and restart reconcile re-adopts registered worktrees without cloning', async () => {
  const value = fixture();
  const item = await value.manager.ensureWorkItem({
    projectKey: 'bodysense',
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });
  createExecution(
    value.repositories,
    value.plan.planId,
    value.itemA.workItemId,
    'exec-review-source',
    value.revision,
  );
  await value.manager.attachWriter(item.worktreeId, 'exec-review-source');
  fs.writeFileSync(path.join(item.hostPath, 'review-me.txt'), 'candidate\n');
  git(item.hostPath, ['add', 'review-me.txt']);
  git(item.hostPath, ['commit', '-m', 'feat: candidate']);
  const reviewedSha = git(item.hostPath, ['rev-parse', 'HEAD']);
  await value.manager.releaseWriter(item.worktreeId, 'exec-review-source');

  const review = await value.manager.createReview({
    projectKey: 'bodysense',
    rootPlanId: value.plan.planId,
    reviewId: 'review-1',
    repositoryPath: value.repository,
    baseRevision: value.revision,
    reviewedSha,
  });
  assert.equal(review.state, 'REVIEWING');
  assert.equal(review.branchRef, undefined);
  assert.equal(git(review.hostPath, ['rev-parse', 'HEAD']), reviewedSha);
  assert.equal(git(review.hostPath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');

  const before = value.repositories.planWorktrees
    .listByPlan(value.plan.planId)
    .map((entry) => entry.hostPath);
  const restarted = new PlanWorktreeManager({
    repositories: value.repositories,
    allowedRepositoryRoots: [value.repositoriesRoot],
    managedHostRoot: value.managed,
    executionRoot: '/workspace',
  });
  const reconciled = await restarted.reconcile(value.plan.planId);
  assert.deepEqual(
    reconciled.map((entry) => entry.hostPath),
    before,
  );
  await restarted.retire(review.worktreeId);
  assert.equal(value.repositories.planWorktrees.get(review.worktreeId).state, 'RETIRED');
  assert.equal(fs.existsSync(review.hostPath), false);
  assert.equal(git(item.hostPath, ['cat-file', '-e', reviewedSha + '^{commit}']), '');

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('unknown worktree path residue is never silently adopted', async () => {
  const value = fixture();
  const project = worktreeRefComponent('bodysense');
  const plan = worktreeRefComponent(value.plan.planId);
  const item = worktreeRefComponent(value.itemB.workItemId);
  const roguePath = path.join(value.managed, 'v4', 'plans', project, plan, 'items', item, 'repo');
  fs.mkdirSync(roguePath, { recursive: true });
  await assert.rejects(
    () =>
      value.manager.ensureWorkItem({
        projectKey: 'bodysense',
        rootPlanId: value.plan.planId,
        workItemId: value.itemB.workItemId,
        repositoryPath: value.repository,
        baseRevision: value.revision,
      }),
    (error: unknown) => error instanceof V4Error && error.code === 'WORKTREE_UNKNOWN_PATH_RESIDUE',
  );
  const durable = value.repositories.planWorktrees.findForWorkItem(
    value.plan.planId,
    value.itemB.workItemId,
  );
  assert.equal(durable?.state, 'PROVISIONING');

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('schema v7 migrates additively to the durable worktree registry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-worktree-schema-'));
  const dbFile = path.join(root, 'pixel.sqlite');
  const current = openV4Database(dbFile, { environment: 'test' });
  current.exec(
    "DROP TABLE plan_worktrees; UPDATE schema_meta SET schema_version=7 WHERE schema_id='pixel-v4';",
  );
  current.close();
  const migrated = openV4Database(dbFile, { environment: 'test' });
  assert.equal(
    migrated.prepare("SELECT schema_version FROM schema_meta WHERE schema_id='pixel-v4'").get()
      ?.schema_version,
    SCHEMA_VERSION,
  );
  const columns = new Set(
    (migrated.prepare('PRAGMA table_info(plan_worktrees)').all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  assert.equal(columns.has('owner_execution_id'), true);
  assert.equal(columns.has('version'), true);
  migrated.close();
  fs.rmSync(root, { recursive: true, force: true });
});
