import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LiteralWorktreeWorkspaceAdapter } from '../src/v4/adapters/literalWorktreeWorkspace.js';
import { PlanWorktreeManager } from '../src/v4/adapters/planWorktrees.js';
import { openV4Database } from '../src/v4/persistence/database.js';
import { createRepositories } from '../src/v4/persistence/repositories.js';
import { REPOSITORY_COMPLETION_EVIDENCE_FILE } from '../src/v4/orchestration/contracts.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-literal-workspace-'));
  const repositoriesRoot = path.join(root, 'repositories');
  const repository = path.join(repositoriesRoot, 'project');
  const managed = path.join(root, 'managed');
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(managed, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repository]);
  git(repository, ['config', 'user.name', 'Literal Test']);
  git(repository, ['config', 'user.email', 'literal@test.local']);
  fs.writeFileSync(path.join(repository, 'README.md'), 'base\n');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'chore: base']);
  const revision = git(repository, ['rev-parse', 'HEAD']);
  const db = openV4Database(path.join(root, 'pixel.sqlite'), { environment: 'test' });
  const repositories = createRepositories(db);
  const plan = repositories.plans.createPlan({
    planId: 'plan-literal',
    idempotencyKey: 'plan-literal',
    projectKey: 'literal',
    objective: 'literal worktree E2E',
    repositoryPath: repository,
    baseRevision: revision,
  }).value!;
  const graph = repositories.plans.createGraphVersion({
    planId: plan.planId,
    reason: 'graph',
  }).value!;
  const item = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'item',
    title: 'Item',
    objective: 'implement item',
    acceptanceCriteria: ['tests pass'],
    dependencies: [],
    parallelSafe: true,
    writeScopes: ['src/item'],
  }).value!;
  repositories.projectPlans.scheduleRootPlan(plan.planId);
  repositories.plans.compareAndSetStatus(plan.planId, 'READY', 'RUNNING');
  repositories.plans.assignWorkItemWave(item.workItemId, 1, revision);
  const manager = new PlanWorktreeManager({
    repositories,
    allowedRepositoryRoots: [repositoriesRoot],
    managedHostRoot: managed,
    executionRoot: '/workspace',
  });
  const adapter = new LiteralWorktreeWorkspaceAdapter({
    repositories,
    manager,
    managedHostRoot: managed,
    executionRoot: '/workspace',
    workspaceUid: process.getuid?.() ?? 1000,
    workspaceGid: process.getgid?.() ?? 1000,
    minimumFreeBytes: 0,
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
    item,
    manager,
    adapter,
  };
}

function createExecution(
  value: ReturnType<typeof fixture>,
  executionId: string,
  phase: 'IMPLEMENT' | 'REVIEW',
  sourceRevision: string,
  parentExecutionId?: string,
) {
  return value.repositories.executions.create({
    executionId,
    idempotencyKey: executionId,
    identity: {
      executionId,
      planId: value.plan.planId,
      workItemId: value.item.workItemId,
      phase,
      ...(parentExecutionId ? { parentExecutionId } : {}),
      attempt: 1,
      route: phase === 'REVIEW' ? 'review' : 'implementation',
      sourceRevision,
    },
    objective: phase === 'REVIEW' ? 'review item' : 'implement item',
  }).value!;
}

test('literal workspace completes implementation, exact-SHA review and Plan integration without touching canonical checkout', async () => {
  const value = fixture();
  const implementation = createExecution(value, 'exec-literal-impl', 'IMPLEMENT', value.revision);
  const workspace = await value.adapter.provision({
    executionId: implementation.identity.executionId,
    planId: value.plan.planId,
    projectKey: value.plan.projectKey,
    workItemId: value.item.workItemId,
    repositoryPath: value.repository,
    sourceRevision: value.revision,
    phase: 'IMPLEMENT',
  });
  assert.match(workspace.executionPath, /^\/workspace\/v4\/plans\/literal\/plan-literal\/items\//);
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), value.revision);
  fs.mkdirSync(path.join(workspace.hostPath, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace.hostPath, 'src/item.txt'), 'implemented\n');
  git(workspace.hostPath, ['add', 'src/item.txt']);
  git(workspace.hostPath, ['commit', '-m', 'feat: implement literal item']);
  const candidate = git(workspace.hostPath, ['rev-parse', 'HEAD']);
  fs.writeFileSync(
    path.join(workspace.hostPath, REPOSITORY_COMPLETION_EVIDENCE_FILE),
    JSON.stringify({
      version: 1,
      executionId: implementation.identity.executionId,
      phase: 'IMPLEMENT',
      sourceRevision: value.revision,
      resultRevision: candidate,
      outcome: 'CHANGED',
      summary: 'implemented',
      tests: [{ command: 'test', status: 'PASS', exitCode: 0 }],
    }) + '\n',
  );
  const completed = await value.adapter.verifyImplementation(workspace);
  assert.equal(completed.headRevision, candidate);
  assert.equal(
    value.repositories.planWorktrees.findForWorkItem(value.plan.planId, value.item.workItemId)
      ?.ownerExecutionId,
    undefined,
  );
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), value.revision);

  value.repositories.executions.updateStatus(implementation.identity.executionId, 'RUNNING');
  value.repositories.executions.recordResult(implementation.identity.executionId, {
    status: 'SUCCEEDED',
    resultRevision: candidate,
    resultSummary: 'implemented',
  });
  const reviewExecution = createExecution(
    value,
    'exec-literal-review',
    'REVIEW',
    candidate,
    implementation.identity.executionId,
  );
  const reviewWorkspace = await value.adapter.provision({
    executionId: reviewExecution.identity.executionId,
    planId: value.plan.planId,
    projectKey: value.plan.projectKey,
    workItemId: value.item.workItemId,
    repositoryPath: value.repository,
    sourceRevision: candidate,
    phase: 'REVIEW',
  });
  assert.equal(git(reviewWorkspace.hostPath, ['rev-parse', 'HEAD']), candidate);
  assert.equal(git(reviewWorkspace.hostPath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');
  fs.writeFileSync(
    path.join(reviewWorkspace.hostPath, REPOSITORY_COMPLETION_EVIDENCE_FILE),
    JSON.stringify({
      version: 1,
      executionId: reviewExecution.identity.executionId,
      phase: 'REVIEW',
      reviewedSha: candidate,
      verdict: 'PASS',
      summary: 'review passed',
      findings: [],
      checks: [{ command: 'test', status: 'PASS', exitCode: 0 }],
    }) + '\n',
  );
  const reviewed = await value.adapter.verifyReview(reviewWorkspace, candidate);
  assert.equal(reviewed.evidence.phase, 'REVIEW');
  assert.equal(reviewed.evidence.verdict, 'PASS');

  const integrated = await value.adapter.integrateAcceptedRevision({
    repositoryPath: value.repository,
    expectedRevision: value.revision,
    acceptedRevision: candidate,
    candidateWorkspace: workspace,
    planId: value.plan.planId,
    workItemId: value.item.workItemId,
    integrationBaseRevision: value.revision,
  });
  assert.notEqual(integrated.headRevision, value.revision);
  assert.equal(
    fs.readFileSync(path.join(integrated.rootPath, 'src/item.txt'), 'utf8'),
    'implemented\n',
  );
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), value.revision);
  assert.equal(fs.existsSync(path.join(value.repository, 'src/item.txt')), false);

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('literal workspace retry reuses WorkItem path across Execution ids', async () => {
  const value = fixture();
  const first = createExecution(value, 'exec-literal-failed', 'IMPLEMENT', value.revision);
  const firstWorkspace = await value.adapter.provision({
    executionId: first.identity.executionId,
    planId: value.plan.planId,
    projectKey: value.plan.projectKey,
    workItemId: value.item.workItemId,
    repositoryPath: value.repository,
    sourceRevision: value.revision,
    phase: 'IMPLEMENT',
  });
  fs.writeFileSync(path.join(firstWorkspace.hostPath, 'dirty.txt'), 'unverified\n');
  value.repositories.executions.updateStatus(first.identity.executionId, 'RUNNING');
  value.repositories.executions.recordResult(first.identity.executionId, {
    status: 'FAILED',
    errorCode: 'PROVIDER_TRANSPORT_FAILED',
    retryable: true,
  });
  const retry = createExecution(value, 'exec-literal-retry', 'IMPLEMENT', value.revision);
  const retryWorkspace = await value.adapter.provision({
    executionId: retry.identity.executionId,
    planId: value.plan.planId,
    projectKey: value.plan.projectKey,
    workItemId: value.item.workItemId,
    repositoryPath: value.repository,
    sourceRevision: value.revision,
    phase: 'IMPLEMENT',
  });
  assert.equal(retryWorkspace.hostPath, firstWorkspace.hostPath);
  assert.notEqual(retryWorkspace.evidenceHostPath, firstWorkspace.evidenceHostPath);
  assert.equal(fs.existsSync(path.join(retryWorkspace.hostPath, 'dirty.txt')), false);
  assert.equal(
    value.repositories.planWorktrees.findForWorkItem(value.plan.planId, value.item.workItemId)
      ?.ownerExecutionId,
    retry.identity.executionId,
  );

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});
