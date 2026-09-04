#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
const executionId = `exec-smoke-${stamp}`;
const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-worktree-smoke-'));
const dbFile = path.join(dbRoot, 'pixel.sqlite');

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
const sourceIdentity = process.getuid?.() === 0 ? { uid: sourceStat.uid, gid: sourceStat.gid } : {};
const canonicalHeadBefore = git(['rev-parse', 'HEAD'], sourceIdentity);
const canonicalStatusBefore = git(['status', '--porcelain=v1'], sourceIdentity);
const branchRef = `refs/heads/pixel-v4/${planId}/items/`;
let db;
let repositories;
let manager;
let worktree;
let branchToDelete;

function deletePlanBranches() {
  const refs = git(['for-each-ref', '--format=%(refname)', branchRef], sourceIdentity)
    .split(/\r?\n/)
    .filter(Boolean);
  for (const ref of refs) {
    execFileSync('git', ['-C', repositoryPath, 'update-ref', '-d', ref], {
      stdio: 'ignore',
      ...sourceIdentity,
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: '/nonexistent',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
  }
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
  const graph = repositories.plans.createGraphVersion({
    planId,
    reason: 'literal worktree smoke',
  }).value;
  if (!graph) throw new Error('SMOKE_GRAPH_CREATE_FAILED');
  const item = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'smoke',
    title: 'Literal worktree smoke',
    objective: 'Commit one disposable file from the OpenHands identity',
    acceptanceCriteria: ['canonical checkout remains unchanged'],
    dependencies: [],
  }).value;
  if (!item) throw new Error('SMOKE_ITEM_CREATE_FAILED');
  repositories.projectPlans.scheduleRootPlan(planId);
  repositories.executions.create({
    executionId,
    idempotencyKey: executionId,
    identity: {
      executionId,
      planId,
      workItemId: item.workItemId,
      phase: 'IMPLEMENT',
      attempt: 1,
      route: 'literal-worktree-smoke',
      sourceRevision: baseRevision,
    },
    objective: 'Commit one disposable smoke artifact',
  });

  manager = new PlanWorktreeManager({
    repositories,
    allowedRepositoryRoots: [path.dirname(repositoryPath)],
    managedHostRoot,
    executionRoot,
  });
  worktree = await manager.ensureWorkItem({
    projectKey,
    rootPlanId: planId,
    workItemId: item.workItemId,
    repositoryPath,
    baseRevision,
  });
  branchToDelete = worktree.branchRef;
  const gitFile = fs.readFileSync(path.join(worktree.hostPath, '.git'), 'utf8').trim();
  if (!gitFile.startsWith('gitdir: ')) throw new Error('SMOKE_WORKTREE_GITDIR_INVALID');
  const adminDir = fs.realpathSync(gitFile.slice('gitdir: '.length));
  if (fs.statSync(adminDir).uid !== sourceStat.uid) throw new Error('SMOKE_ADMIN_OWNER_INVALID');
  if (!worktree.branchRef) throw new Error('SMOKE_BRANCH_MISSING');
  const commonBeforeAccessRaw = git(['rev-parse', '--git-common-dir'], sourceIdentity);
  const commonBeforeAccess = fs.realpathSync(
    path.isAbsolute(commonBeforeAccessRaw)
      ? commonBeforeAccessRaw
      : path.resolve(repositoryPath, commonBeforeAccessRaw),
  );
  const looseRef = path.join(commonBeforeAccess, worktree.branchRef.replace(/^refs\//, 'refs/'));
  if (!fs.existsSync(looseRef) || fs.statSync(looseRef).uid !== sourceStat.uid)
    throw new Error('SMOKE_BRANCH_OWNER_INVALID');
  await manager.prepareAgentAccess(worktree.worktreeId, agentUid, agentGid);
  worktree = await manager.attachWriter(worktree.worktreeId, executionId);

  const image = execFileSync('docker', ['inspect', container, '--format', '{{.Config.Image}}'], {
    encoding: 'utf8',
  }).trim();
  const commonDir = fs.realpathSync(
    path.isAbsolute(git(['rev-parse', '--git-common-dir'], sourceIdentity))
      ? git(['rev-parse', '--git-common-dir'], sourceIdentity)
      : path.resolve(repositoryPath, git(['rev-parse', '--git-common-dir'], sourceIdentity)),
  );
  const mountCommon = `${commonDir}:${commonDir}:rw`;
  const script = [
    'set -euo pipefail',
    `cd ${JSON.stringify(worktree.executionPath)}`,
    'git status --short',
    'git rev-parse --show-toplevel',
    'git rev-parse --git-common-dir',
    "printf 'literal-worktree-smoke\\n' > .pixel-v4-literal-worktree-smoke",
    'git add .pixel-v4-literal-worktree-smoke',
    "git commit -m 'test: literal worktree smoke' >/tmp/pixel-commit.out 2>/tmp/pixel-commit.err",
    'test ! -s /tmp/pixel-commit.err',
    'test -z "$(git status --porcelain=v1)"',
    'git rev-parse HEAD',
  ].join('; ');
  const containerOutput = execFileSync(
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
      `HOME=${path.posix.join(path.posix.dirname(worktree.executionPath), '.agent-harness/home')}`,
      '-e',
      `XDG_CONFIG_HOME=${path.posix.join(path.posix.dirname(worktree.executionPath), '.agent-harness/xdg')}`,
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
      `GIT_CONFIG_VALUE_0=${worktree.executionPath}`,
      '-e',
      'GIT_CONFIG_KEY_1=safe.directory',
      '-e',
      `GIT_CONFIG_VALUE_1=${worktree.hostPath}`,
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
      mountCommon,
      image,
      '-lc',
      script,
    ],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
  const lines = containerOutput.trim().split(/\r?\n/);
  const resultRevision = lines.at(-1);
  if (!resultRevision || !/^[0-9a-f]{40}$/.test(resultRevision))
    throw new Error('SMOKE_RESULT_REVISION_INVALID');

  worktree = await manager.releaseWriter(worktree.worktreeId, executionId);
  if (worktree.currentRevision !== resultRevision)
    throw new Error('SMOKE_DURABLE_REVISION_MISMATCH');
  worktree = await manager.retire(worktree.worktreeId);
  if (worktree.state !== 'RETIRED') throw new Error('SMOKE_RETIRE_FAILED');
  await manager.revokePlanAgentAccess(planId, agentUid);
  deletePlanBranches();

  const canonicalHeadAfter = git(['rev-parse', 'HEAD'], sourceIdentity);
  const canonicalStatusAfter = git(['status', '--porcelain=v1'], sourceIdentity);
  if (canonicalHeadAfter !== canonicalHeadBefore || canonicalStatusAfter !== canonicalStatusBefore)
    throw new Error('SMOKE_CANONICAL_REPOSITORY_CHANGED');
  console.log(
    JSON.stringify({ status: 'PASS', baseRevision, resultRevision, worktreeState: worktree.state }),
  );
} finally {
  try {
    if (manager && worktree && worktree.state !== 'RETIRED') {
      const latest = repositories?.planWorktrees.getOptional(worktree.worktreeId);
      if (latest?.ownerExecutionId) {
        // Failed smoke cleanup is intentionally host-controlled; do not claim success.
        const identity = fs.statSync(repositoryPath);
        const stack = [latest.hostPath];
        while (stack.length) {
          const current = stack.pop();
          if (!current || !fs.existsSync(current)) continue;
          const stat = fs.lstatSync(current);
          fs.lchownSync(current, identity.uid, identity.gid);
          if (stat.isDirectory() && !stat.isSymbolicLink())
            for (const name of fs.readdirSync(current)) stack.push(path.join(current, name));
        }
      }
    }
  } catch {}
  try {
    const worktreePath = worktree?.hostPath;
    if (worktreePath && fs.existsSync(worktreePath)) {
      execFileSync('git', ['-C', repositoryPath, 'worktree', 'unlock', worktreePath], {
        stdio: 'ignore',
        ...sourceIdentity,
      });
      execFileSync('git', ['-C', repositoryPath, 'worktree', 'remove', '--force', worktreePath], {
        stdio: 'ignore',
        ...sourceIdentity,
      });
    }
    execFileSync('git', ['-C', repositoryPath, 'worktree', 'prune', '--expire', 'now'], {
      stdio: 'ignore',
      ...sourceIdentity,
    });
  } catch {}
  try {
    deletePlanBranches();
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
