#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LiteralWorktreeWorkspaceAdapter } from '../dist/v4/adapters/literalWorktreeWorkspace.js';
import { PlanWorktreeManager } from '../dist/v4/adapters/planWorktrees.js';
import { openV4Database } from '../dist/v4/persistence/database.js';
import { createRepositories } from '../dist/v4/persistence/repositories.js';

if (process.getuid?.() !== 0) throw new Error('LITERAL_WORKTREE_SMOKE_REQUIRES_ROOT');

const repositoryPath =
  process.env.PIXEL_V4_WORKTREE_SMOKE_REPOSITORY ?? '/home/dev/projects/bodysense';
const managedHostRoot =
  process.env.PIXEL_V4_WORKSPACE_HOST_ROOT ?? '/opt/data/hermes-ai-office-v3/workspaces';
const executionRoot = process.env.PIXEL_V4_WORKSPACE_EXECUTION_ROOT ?? '/workspace';
const agentUid = Number(process.env.PIXEL_V4_WORKSPACE_UID ?? '10001');
const agentGid = Number(process.env.PIXEL_V4_WORKSPACE_GID ?? '10001');
const container = process.env.PIXEL_V4_OPENHANDS_CONTAINER ?? 'hermes-openhands-v3';
const projectKey = 'literal-worktree-smoke';
const stamp = `${Date.now()}-${process.pid}`;
const planId = `plan-smoke-${stamp}`;
const implementationId = `exec-impl-${stamp}`;
const reviewId = `exec-review-${stamp}`;
const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-worktree-smoke-'));
const dbFile = path.join(dbRoot, 'pixel.sqlite');
const completionEvidence = '.pixel-v4-completion-evidence.json';

function git(args, options = {}) {
  return execFileSync('git', ['-C', repositoryPath, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: '/nonexistent',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C.UTF-8',
    },
    ...options,
  }).trim();
}

const sourceStat = fs.statSync(repositoryPath);
const sourceIdentity = { uid: sourceStat.uid, gid: sourceStat.gid };
const canonicalHeadBefore = git(['rev-parse', 'HEAD'], sourceIdentity);
const canonicalStatusBefore = git(
  ['status', '--porcelain=v1', '--untracked-files=all'],
  sourceIdentity,
);
if (canonicalStatusBefore) throw new Error('SMOKE_CANONICAL_REPOSITORY_DIRTY');

const image = execFileSync('docker', ['inspect', container, '--format', '{{.Config.Image}}'], {
  encoding: 'utf8',
}).trim();
const commonRaw = git(['rev-parse', '--git-common-dir'], sourceIdentity);
const commonDir = fs.realpathSync(
  path.isAbsolute(commonRaw) ? commonRaw : path.resolve(repositoryPath, commonRaw),
);

let db;
let repositories;
let manager;
let adapter;
let implementationWorkspace;
let reviewWorkspace;
let archiveRef;

function containerRun(workspace, executionId, script) {
  const parent = path.posix.dirname(workspace.executionPath);
  const harness = path.posix.join(parent, '.executions', executionId, '.agent-harness');
  return execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      `${agentUid}:${agentGid}`,
      '--entrypoint',
      '/bin/bash',
      '-e',
      `HOME=${path.posix.join(harness, 'home')}`,
      '-e',
      `XDG_CONFIG_HOME=${path.posix.join(harness, 'xdg')}`,
      '-e',
      'GIT_CONFIG_NOSYSTEM=1',
      '-e',
      'GIT_AUTHOR_NAME=Pixel Agent',
      '-e',
      'GIT_AUTHOR_EMAIL=pixel-agent@localhost',
      '-e',
      'GIT_COMMITTER_NAME=Pixel Agent',
      '-e',
      'GIT_COMMITTER_EMAIL=pixel-agent@localhost',
      '-e',
      'GIT_OPTIONAL_LOCKS=0',
      '-e',
      'GIT_CONFIG_COUNT=4',
      '-e',
      'GIT_CONFIG_KEY_0=safe.directory',
      '-e',
      `GIT_CONFIG_VALUE_0=${workspace.executionPath}`,
      '-e',
      'GIT_CONFIG_KEY_1=safe.directory',
      '-e',
      `GIT_CONFIG_VALUE_1=${workspace.hostPath}`,
      '-e',
      'GIT_CONFIG_KEY_2=gc.auto',
      '-e',
      'GIT_CONFIG_VALUE_2=0',
      '-e',
      'GIT_CONFIG_KEY_3=maintenance.auto',
      '-e',
      'GIT_CONFIG_VALUE_3=false',
      '-v',
      `${managedHostRoot}:${executionRoot}:rw`,
      '-v',
      `${managedHostRoot}:${managedHostRoot}:rw`,
      '-v',
      `${commonDir}:${commonDir}:rw`,
      image,
      '-lc',
      script,
    ],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  ).trim();
}

function sourceGit(args, allowFailure = false) {
  try {
    return execFileSync('git', ['-C', repositoryPath, ...args], {
      encoding: 'utf8',
      ...sourceIdentity,
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: '/nonexistent',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    }).trim();
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
}

function forceRemoveRegisteredWorktrees() {
  const output = sourceGit(['worktree', 'list', '--porcelain'], true);
  for (const block of output.split(/\n\n+/)) {
    const first = block.split(/\r?\n/).find((line) => line.startsWith('worktree '));
    if (!first) continue;
    const candidate = first.slice('worktree '.length);
    if (!candidate.startsWith(path.join(managedHostRoot, 'v4', 'plans', projectKey, planId)))
      continue;
    sourceGit(['worktree', 'unlock', '--', candidate], true);
    sourceGit(['worktree', 'remove', '--force', '--', candidate], true);
  }
  sourceGit(['worktree', 'prune', '--expire', 'now'], true);
}

try {
  const baseRevision = canonicalHeadBefore;
  db = openV4Database(dbFile, { environment: 'test' });
  repositories = createRepositories(db);
  const plan = repositories.plans.createPlan({
    planId,
    idempotencyKey: planId,
    projectKey,
    objective: 'Production-shaped literal worktree smoke',
    repositoryPath,
    baseRevision,
  }).value;
  if (!plan) throw new Error('SMOKE_PLAN_CREATE_FAILED');
  const graph = repositories.plans.createGraphVersion({ planId, reason: 'literal smoke' }).value;
  if (!graph) throw new Error('SMOKE_GRAPH_CREATE_FAILED');
  const item = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'smoke',
    title: 'Literal worktree smoke',
    objective: 'Commit one disposable file from the OpenHands identity',
    acceptanceCriteria: [
      'implementation evidence',
      'review evidence',
      'canonical checkout unchanged',
    ],
    dependencies: [],
    parallelSafe: true,
    writeScopes: ['.pixel-v4-literal-worktree-smoke'],
  }).value;
  if (!item) throw new Error('SMOKE_ITEM_CREATE_FAILED');
  repositories.projectPlans.scheduleRootPlan(planId);
  repositories.plans.assignWorkItemWave(item.workItemId, 1, baseRevision);
  repositories.plans.updateWorkItemStatus(item.workItemId, 'RUNNING');
  repositories.plans.compareAndSetStatus(planId, 'READY', 'RUNNING');

  manager = new PlanWorktreeManager({
    repositories,
    allowedRepositoryRoots: [path.dirname(repositoryPath)],
    managedHostRoot,
    executionRoot,
  });
  adapter = new LiteralWorktreeWorkspaceAdapter({
    repositories,
    manager,
    managedHostRoot,
    executionRoot,
    workspaceUid: agentUid,
    workspaceGid: agentGid,
    minimumFreeBytes: 0,
  });
  await manager.ensurePlanActivated(planId);

  repositories.executions.create({
    executionId: implementationId,
    idempotencyKey: implementationId,
    identity: {
      executionId: implementationId,
      planId,
      workItemId: item.workItemId,
      phase: 'IMPLEMENT',
      attempt: 1,
      route: 'literal-worktree-smoke',
      sourceRevision: baseRevision,
    },
    objective: 'Commit one disposable smoke artifact',
  });
  implementationWorkspace = await adapter.provision({
    executionId: implementationId,
    planId,
    projectKey,
    workItemId: item.workItemId,
    repositoryPath,
    sourceRevision: baseRevision,
    phase: 'IMPLEMENT',
  });
  const implementationScript = [
    'set -euo pipefail',
    `cd ${JSON.stringify(implementationWorkspace.executionPath)}`,
    "printf 'literal-worktree-smoke\\n' > .pixel-v4-literal-worktree-smoke",
    'git add .pixel-v4-literal-worktree-smoke',
    "git commit -m 'test: literal worktree smoke' >/tmp/pixel-commit.out 2>/tmp/pixel-commit.err",
    'test ! -s /tmp/pixel-commit.err',
    'result="$(git rev-parse HEAD)"',
    `printf '{"version":1,"executionId":"${implementationId}","phase":"IMPLEMENT","sourceRevision":"${baseRevision}","resultRevision":"%s","outcome":"CHANGED","summary":"literal smoke","tests":[{"command":"smoke","status":"PASS","exitCode":0}]}\\n' "$result" > ${completionEvidence}`,
    'printf "%s\\n" "$result"',
  ].join('; ');
  const candidateRevision = containerRun(
    implementationWorkspace,
    implementationId,
    implementationScript,
  )
    .split(/\r?\n/)
    .at(-1);
  if (!candidateRevision || !/^[0-9a-f]{40}$/.test(candidateRevision))
    throw new Error('SMOKE_RESULT_REVISION_INVALID');
  const implemented = await adapter.verifyImplementation(implementationWorkspace);
  if (implemented.headRevision !== candidateRevision)
    throw new Error('SMOKE_IMPLEMENTATION_VERIFY_FAILED');
  repositories.executions.updateStatus(implementationId, 'RUNNING');
  repositories.executions.recordResult(implementationId, {
    status: 'SUCCEEDED',
    resultRevision: candidateRevision,
    resultSummary: 'literal smoke',
  });

  repositories.executions.create({
    executionId: reviewId,
    idempotencyKey: reviewId,
    identity: {
      executionId: reviewId,
      planId,
      workItemId: item.workItemId,
      phase: 'REVIEW',
      parentExecutionId: implementationId,
      attempt: 1,
      route: 'literal-worktree-review-smoke',
      sourceRevision: candidateRevision,
    },
    objective: 'Review exact smoke SHA',
  });
  reviewWorkspace = await adapter.provision({
    executionId: reviewId,
    planId,
    projectKey,
    workItemId: item.workItemId,
    repositoryPath,
    sourceRevision: candidateRevision,
    phase: 'REVIEW',
  });
  const reviewScript = [
    'set -euo pipefail',
    `cd ${JSON.stringify(reviewWorkspace.executionPath)}`,
    `test "$(git rev-parse HEAD)" = "${candidateRevision}"`,
    'test "$(git rev-parse --abbrev-ref HEAD)" = HEAD',
    `printf '{"version":1,"executionId":"${reviewId}","phase":"REVIEW","reviewedSha":"${candidateRevision}","verdict":"PASS","summary":"literal smoke review","findings":[],"checks":[{"command":"smoke","status":"PASS","exitCode":0}]}\\n' > ${completionEvidence}`,
  ].join('; ');
  containerRun(reviewWorkspace, reviewId, reviewScript);
  const reviewed = await adapter.verifyReview(reviewWorkspace, candidateRevision);
  if (reviewed.evidence.verdict !== 'PASS') throw new Error('SMOKE_REVIEW_VERIFY_FAILED');

  const integrated = await adapter.integrateAcceptedRevision({
    repositoryPath,
    expectedRevision: baseRevision,
    acceptedRevision: candidateRevision,
    candidateWorkspace: implementationWorkspace,
    planId,
    workItemId: item.workItemId,
    integrationBaseRevision: baseRevision,
  });
  const advanced = repositories.plans.advanceAcceptedRevision(
    planId,
    baseRevision,
    integrated.headRevision,
    'literal release smoke review passed',
  );
  if (advanced.status === 'rejected') throw new Error('SMOKE_PLAN_REVISION_ADVANCE_FAILED');
  const accepted = repositories.plans.acceptWorkItemRevision(
    item.workItemId,
    candidateRevision,
    integrated.headRevision,
  );
  if (accepted.status === 'rejected') throw new Error('SMOKE_WORK_ITEM_ACCEPT_FAILED');
  repositories.plans.updateStatus(planId, 'SUCCEEDED');
  await manager.retirePlan(planId, agentUid);

  archiveRef = `refs/pixel-v4/archive/${planId}`;
  if (sourceGit(['rev-parse', '--verify', `${archiveRef}^{commit}`]) !== integrated.headRevision)
    throw new Error('SMOKE_ARCHIVE_REF_INVALID');
  if (repositories.plans.getWorkItem(item.workItemId).exactAcceptedRevision !== candidateRevision)
    throw new Error('SMOKE_CANDIDATE_PROVENANCE_INVALID');
  if (repositories.plans.getPlan(planId).currentRevision !== integrated.headRevision)
    throw new Error('SMOKE_INTEGRATION_PROVENANCE_INVALID');
  if (git(['rev-parse', 'HEAD'], sourceIdentity) !== canonicalHeadBefore)
    throw new Error('SMOKE_CANONICAL_HEAD_CHANGED');
  if (
    git(['status', '--porcelain=v1', '--untracked-files=all'], sourceIdentity) !==
    canonicalStatusBefore
  )
    throw new Error('SMOKE_CANONICAL_REPOSITORY_CHANGED');

  console.log(
    JSON.stringify({
      status: 'PASS',
      baseRevision,
      candidateRevision,
      integrationRevision: integrated.headRevision,
      exactReview: true,
      canonicalUnchanged: true,
    }),
  );
} finally {
  try {
    if (archiveRef) sourceGit(['update-ref', '-d', archiveRef], true);
  } catch {}
  try {
    forceRemoveRegisteredWorktrees();
  } catch {}
  try {
    const prefix = `refs/heads/pixel-v4/${planId}/`;
    for (const ref of sourceGit(['for-each-ref', '--format=%(refname)', prefix], true)
      .split(/\r?\n/)
      .filter(Boolean))
      sourceGit(['update-ref', '-d', ref], true);
  } catch {}
  try {
    const planRoot = path.join(managedHostRoot, 'v4', 'plans', projectKey, planId);
    if (fs.existsSync(planRoot)) fs.rmSync(planRoot, { recursive: true, force: true });
  } catch {}
  try {
    db?.close();
  } catch {}
  fs.rmSync(dbRoot, { recursive: true, force: true });
}
