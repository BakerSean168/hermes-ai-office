import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GitHubPullRequestRepairPublisher,
  type GitHubRepairCommandRunner,
} from '../src/v3/githubPrRepairPublisher.js';

const ORIGINAL = '1111111111111111111111111111111111111111';
const REPAIRED = '3333333333333333333333333333333333333333';

function pull(head = ORIGINAL) {
  return JSON.stringify({
    number: 42,
    state: 'open',
    head: {
      sha: head,
      ref: 'jules/fix-42',
      repo: { full_name: 'example/project' },
    },
  });
}

test('GitHub PR repair publication pushes the reviewed descendant with an exact-head lease', async () => {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-repair-repo-'));
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-repair-workspace-'));
  const commands: string[] = [];
  const runner: GitHubRepairCommandRunner = async (cwd, command, args) => {
    const key = `${command} ${args.join(' ')}`;
    commands.push(`${cwd} :: ${key}`);
    if (key === 'git remote get-url origin') return 'https://github.com/example/project.git';
    if (key === 'gh api repos/example/project/pulls/42') return pull();
    if (key.includes('status --porcelain')) return '';
    if (key.endsWith('rev-parse HEAD')) return REPAIRED;
    if (key.endsWith(`merge-base ${ORIGINAL} ${REPAIRED}`)) return ORIGINAL;
    if (key.includes('bundle create ')) return '';
    if (key.startsWith('git fetch ') && key.includes('refs/ai-office/external/github/pr-42/repairs/')) return '';
    if (key.startsWith('git push --force-with-lease=')) return '';
    if (key === 'git ls-remote origin refs/heads/jules/fix-42') {
      return `${REPAIRED}\trefs/heads/jules/fix-42`;
    }
    throw new Error(`unexpected command: ${key}`);
  };

  const result = await new GitHubPullRequestRepairPublisher({ commandRunner: runner }).publish({
    planId: 'plan_test',
    repositoryPath,
    workspacePath,
    repository: 'example/project',
    pullRequestNumber: 42,
    headRepository: 'example/project',
    headRef: 'jules/fix-42',
    expectedHeadRevision: ORIGINAL,
  });

  assert.equal(result.previousRevision, ORIGINAL);
  assert.equal(result.publishedRevision, REPAIRED);
  assert.match(result.auditRef, /refs\/ai-office\/external\/github\/pr-42\/repairs\/plan_test\//);
  assert.ok(
    commands.some((command) =>
      command.includes(
        `git push --force-with-lease=refs/heads/jules/fix-42:${ORIGINAL} origin`,
      ),
    ),
  );
  assert.equal(commands.some((command) => /\bgit (checkout|reset)\b/.test(command)), false);
});

test('GitHub PR repair publication refuses to overwrite a concurrently updated head', async () => {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-repair-race-repo-'));
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-repair-race-workspace-'));
  let pushed = false;
  const runner: GitHubRepairCommandRunner = async (_cwd, command, args) => {
    const key = `${command} ${args.join(' ')}`;
    if (key === 'git remote get-url origin') return 'https://github.com/example/project.git';
    if (key.includes('status --porcelain')) return '';
    if (key.endsWith('rev-parse HEAD')) return REPAIRED;
    if (key.endsWith(`merge-base ${ORIGINAL} ${REPAIRED}`)) return ORIGINAL;
    if (key === 'gh api repos/example/project/pulls/42') {
      return pull('4444444444444444444444444444444444444444');
    }
    if (key.startsWith('git push ')) pushed = true;
    return '';
  };

  await assert.rejects(
    () =>
      new GitHubPullRequestRepairPublisher({ commandRunner: runner }).publish({
        planId: 'plan_race',
        repositoryPath,
        workspacePath,
        repository: 'example/project',
        pullRequestNumber: 42,
        headRepository: 'example/project',
        headRef: 'jules/fix-42',
        expectedHeadRevision: ORIGINAL,
      }),
    /GITHUB_PR_CHANGED_DURING_REPAIR_PUBLICATION/,
  );
  assert.equal(pushed, false);
});

test('GitHub PR repair publication classifies a force-with-lease race as a changed PR head', async () => {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-repair-lease-race-repo-'));
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-repair-lease-race-workspace-'));
  const concurrentHead = '4444444444444444444444444444444444444444';
  let pushAttempted = false;
  const runner: GitHubRepairCommandRunner = async (_cwd, command, args) => {
    const key = `${command} ${args.join(' ')}`;
    if (key === 'git remote get-url origin') return 'https://github.com/example/project.git';
    if (key.includes('status --porcelain')) return '';
    if (key.endsWith('rev-parse HEAD')) return REPAIRED;
    if (key.endsWith(`merge-base ${ORIGINAL} ${REPAIRED}`)) return ORIGINAL;
    if (key === 'gh api repos/example/project/pulls/42') return pull(ORIGINAL);
    if (key.includes('bundle create ')) return '';
    if (key.startsWith('git fetch ') && key.includes('refs/ai-office/external/github/pr-42/repairs/')) return '';
    if (key.startsWith('git push --force-with-lease=')) {
      pushAttempted = true;
      throw new Error('stale info');
    }
    if (key === 'git ls-remote origin refs/heads/jules/fix-42') {
      return `${concurrentHead}\trefs/heads/jules/fix-42`;
    }
    throw new Error(`unexpected command: ${key}`);
  };

  await assert.rejects(
    () =>
      new GitHubPullRequestRepairPublisher({ commandRunner: runner }).publish({
        planId: 'plan_lease_race',
        repositoryPath,
        workspacePath,
        repository: 'example/project',
        pullRequestNumber: 42,
        headRepository: 'example/project',
        headRef: 'jules/fix-42',
        expectedHeadRevision: ORIGINAL,
      }),
    /GITHUB_PR_CHANGED_DURING_REPAIR_PUBLICATION/,
  );
  assert.equal(pushAttempted, true);
});

test('GitHub PR repair publication fails closed for fork heads', async () => {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-repair-fork-repo-'));
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-repair-fork-workspace-'));
  let commands = 0;
  await assert.rejects(
    () =>
      new GitHubPullRequestRepairPublisher({
        commandRunner: async () => {
          commands += 1;
          return '';
        },
      }).publish({
        planId: 'plan_fork',
        repositoryPath,
        workspacePath,
        repository: 'example/project',
        pullRequestNumber: 42,
        headRepository: 'contributor/project',
        headRef: 'fix-42',
        expectedHeadRevision: ORIGINAL,
      }),
    /GITHUB_PR_REPAIR_CROSS_REPOSITORY_UNSUPPORTED/,
  );
  assert.equal(commands, 0);
});

test('GitHub PR repair publication is crash-idempotent when the exact reviewed repair was already pushed', async () => {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-repair-replay-repo-'));
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-repair-replay-workspace-'));
  const commands: string[] = [];
  const runner: GitHubRepairCommandRunner = async (_cwd, command, args) => {
    const key = `${command} ${args.join(' ')}`;
    commands.push(key);
    if (key === 'git remote get-url origin') return 'https://github.com/example/project.git';
    if (key.includes('status --porcelain')) return '';
    if (key.endsWith('rev-parse HEAD')) return REPAIRED;
    if (key.endsWith(`merge-base ${ORIGINAL} ${REPAIRED}`)) return ORIGINAL;
    if (key === 'gh api repos/example/project/pulls/42') return pull(REPAIRED);
    if (key.startsWith('git fetch --no-tags origin +refs/heads/jules/fix-42:refs/ai-office/external/')) {
      return '';
    }
    if (key.includes('rev-parse --verify refs/ai-office/external/github/pr-42/repairs/')) {
      return REPAIRED;
    }
    throw new Error(`unexpected command: ${key}`);
  };

  const result = await new GitHubPullRequestRepairPublisher({ commandRunner: runner }).publish({
    planId: 'plan_replay',
    repositoryPath,
    workspacePath,
    repository: 'example/project',
    pullRequestNumber: 42,
    headRepository: 'example/project',
    headRef: 'jules/fix-42',
    expectedHeadRevision: ORIGINAL,
  });

  assert.equal(result.previousRevision, ORIGINAL);
  assert.equal(result.publishedRevision, REPAIRED);
  assert.equal(commands.some((command) => command.startsWith('git push ')), false);
  assert.ok(commands.some((command) => command.startsWith('git fetch --no-tags origin ')));
});
