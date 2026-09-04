import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  execFileSync,
  spawnSync as realSpawnSync,
  type SpawnSyncReturns,
} from 'node:child_process';

import { GitHubCliDeliveryAdapter } from '../src/v4/adapters/githubDelivery.js';
import { V4Error } from '../src/v4/domain/errors.js';
import type { PlanDelivery } from '../src/v4/domain/delivery.js';
import type { Plan } from '../src/v4/domain/plan.js';

function result(stdout = '', stderr = '', status = 0): SpawnSyncReturns<string> {
  return { pid: 1, output: [null, stdout, stderr], stdout, stderr, status, signal: null };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-delivery-'));
  fs.mkdirSync(path.join(root, '.git'));
  const plan: Plan = {
    planId: 'plan-delivery',
    idempotencyKey: 'delivery',
    projectKey: 'test',
    objective: 'Deliver exact reviewed change',
    repositoryPath: root,
    baseRevision: 'base-sha',
    currentRevision: 'head-sha',
    status: 'RUNNING',
    childPlanIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const delivery: PlanDelivery = {
    planId: plan.planId,
    remote: 'origin',
    branch: 'pixel/exact-delivery',
    targetBranch: 'main',
    autoMerge: true,
    mergeMethod: 'merge',
    requiredChecks: ['CI'],
    status: 'PENDING',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return { root, plan, delivery };
}

test('GitHub delivery pushes the exact reviewed SHA and opens a PR without bypassing pending checks', async () => {
  const value = fixture();
  const calls: Array<{ command: string; args: string[]; uid?: number; gid?: number }> = [];
  let prLists = 0;
  const spawn = ((
    command: string,
    args: readonly string[],
    options: { uid?: number; gid?: number } = {},
  ) => {
    const argv = [...args];
    calls.push({ command, args: argv, uid: options.uid, gid: options.gid });
    if (command === '/usr/bin/getent')
      return result(
        `dev:x:${fs.statSync(value.root).uid}:${fs.statSync(value.root).gid}:dev:/tmp:/bin/bash\n`,
      );
    if (command === '/usr/bin/git') {
      if (argv.includes('rev-parse')) return result('head-sha\n');
      if (argv.includes('status')) return result('');
      if (argv.includes('check-ref-format')) return result('');
      if (argv.includes('remote') && argv.includes('get-url'))
        return result('https://github.com/acme/repo.git\n');
      if (argv.includes('ls-remote')) return result('');
      if (argv.includes('push')) return result('');
    }
    if (command === '/usr/bin/gh') {
      if (argv[0] === 'pr' && argv[1] === 'list') {
        prLists += 1;
        if (prLists === 1) return result('[]');
        return result(
          JSON.stringify([
            {
              number: 7,
              state: 'OPEN',
              url: 'https://github.com/acme/repo/pull/7',
              headRefOid: 'head-sha',
              statusCheckRollup: [{ name: 'CI', status: 'IN_PROGRESS', conclusion: '' }],
            },
          ]),
        );
      }
      if (argv[0] === 'pr' && argv[1] === 'create')
        return result('https://github.com/acme/repo/pull/7\n');
    }
    return result('', 'unexpected command: ' + command + ' ' + argv.join(' '), 1);
  }) as any;
  const adapter = new GitHubCliDeliveryAdapter({ allowedRepositoryRoots: [value.root], spawn });
  const observed = await adapter.advance(value.plan, value.delivery);
  assert.equal(observed.status, 'CHECKS_PENDING');
  assert.equal(observed.headSha, 'head-sha');
  assert.equal(observed.pullRequestNumber, 7);
  assert.ok(
    calls.some(
      (call) =>
        call.command === '/usr/bin/git' &&
        call.args.includes('head-sha:refs/heads/pixel/exact-delivery'),
    ),
  );
  assert.ok(calls.some((call) => call.command === '/usr/bin/gh' && call.args[1] === 'create'));
  assert.ok(
    calls
      .filter((call) => call.command === '/usr/bin/git')
      .every((call) => call.uid === fs.statSync(value.root).uid || call.args[1] === undefined),
  );
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('GitHub delivery merges only the exact PR head after required checks and verifies remote target', async () => {
  const value = fixture();
  const calls: Array<{ command: string; args: string[] }> = [];
  const openPr = {
    number: 8,
    state: 'OPEN',
    url: 'https://github.com/acme/repo/pull/8',
    headRefOid: 'head-sha',
    statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  };
  const mergedPr = { ...openPr, state: 'MERGED', mergeCommit: { oid: 'merge-sha' } };
  const spawn = ((command: string, args: readonly string[]) => {
    const argv = [...args];
    calls.push({ command, args: argv });
    if (command === '/usr/bin/getent')
      return result(
        `dev:x:${fs.statSync(value.root).uid}:${fs.statSync(value.root).gid}:dev:/tmp:/bin/bash\n`,
      );
    if (command === '/usr/bin/git') {
      if (argv.includes('rev-parse')) return result('head-sha\n');
      if (argv.includes('status')) return result('');
      if (argv.includes('check-ref-format')) return result('');
      if (argv.includes('remote') && argv.includes('get-url'))
        return result('git@github.com:acme/repo.git\n');
      if (argv.includes('ls-remote')) {
        const ref = argv.at(-1);
        return ref === 'refs/heads/main'
          ? result('merge-sha\trefs/heads/main\n')
          : result('head-sha\trefs/heads/pixel/exact-delivery\n');
      }
    }
    if (command === '/usr/bin/gh') {
      if (argv[0] === 'pr' && argv[1] === 'list') return result(JSON.stringify([openPr]));
      if (argv[0] === 'pr' && argv[1] === 'merge') return result('');
      if (argv[0] === 'pr' && argv[1] === 'view') return result(JSON.stringify(mergedPr));
    }
    return result('', 'unexpected command: ' + command + ' ' + argv.join(' '), 1);
  }) as any;
  const adapter = new GitHubCliDeliveryAdapter({ allowedRepositoryRoots: [value.root], spawn });
  const observed = await adapter.advance(value.plan, value.delivery);
  assert.equal(observed.status, 'VERIFIED');
  assert.equal(observed.mergeSha, 'merge-sha');
  const merge = calls.find((call) => call.command === '/usr/bin/gh' && call.args[1] === 'merge');
  assert.ok(merge);
  assert.ok(merge!.args.includes('--match-head-commit'));
  assert.ok(merge!.args.includes('head-sha'));
  assert.ok(!calls.some((call) => call.command === '/usr/bin/git' && call.args.includes('push')));
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('GitHub delivery runs the repository commitlint contract before pushing and converts failure to typed repair', async () => {
  const value = fixture();
  value.delivery.requiredChecks = ['commit-lint'];
  fs.writeFileSync(path.join(value.root, 'commitlint.config.ts'), 'export default {};\n');
  fs.writeFileSync(
    path.join(value.root, 'package.json'),
    JSON.stringify({ devDependencies: { '@commitlint/cli': '21.2.1' } }),
  );
  fs.writeFileSync(path.join(value.root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn = ((command: string, args: readonly string[]) => {
    const argv = [...args];
    calls.push({ command, args: argv });
    if (command === '/usr/bin/getent')
      return result(
        `dev:x:${fs.statSync(value.root).uid}:${fs.statSync(value.root).gid}:dev:/tmp:/bin/bash\n`,
      );
    if (command === '/usr/bin/git') {
      if (argv.includes('rev-parse')) return result('head-sha\n');
      if (argv.includes('status')) return result('');
      if (argv.includes('check-ref-format')) return result('');
      if (argv.includes('ls-remote')) {
        const ref = argv.at(-1);
        if (ref === 'refs/heads/main') return result('base-sha\trefs/heads/main\n');
        return result('');
      }
    }
    if (command === '/usr/bin/pnpm') return result('', 'commit message violates config', 1);
    return result('', 'unexpected command: ' + command + ' ' + argv.join(' '), 1);
  }) as any;
  const adapter = new GitHubCliDeliveryAdapter({ allowedRepositoryRoots: [value.root], spawn });
  await assert.rejects(
    () => adapter.advance(value.plan, value.delivery),
    (error: unknown) => error instanceof V4Error && error.code === 'DELIVERY_REQUIRED_CHECK_FAILED',
  );
  const lint = calls.find((call) => call.command === '/usr/bin/pnpm');
  assert.deepEqual(lint?.args, ['commitlint', '--from', 'base-sha', '--to', 'head-sha']);
  assert.ok(!calls.some((call) => call.command === '/usr/bin/git' && call.args.includes('push')));
  assert.ok(!calls.some((call) => call.command === '/usr/bin/gh'));
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('GitHub delivery reports a failed required check as durable repairable delivery state', async () => {
  const value = fixture();
  const calls: Array<{ command: string; args: string[] }> = [];
  const failedPr = {
    number: 12,
    state: 'OPEN',
    url: 'https://github.com/acme/repo/pull/12',
    headRefOid: 'head-sha',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' }],
  };
  const spawn = ((command: string, args: readonly string[]) => {
    const argv = [...args];
    calls.push({ command, args: argv });
    if (command === '/usr/bin/getent')
      return result(
        `dev:x:${fs.statSync(value.root).uid}:${fs.statSync(value.root).gid}:dev:/tmp:/bin/bash\n`,
      );
    if (command === '/usr/bin/git') {
      if (argv.includes('rev-parse')) return result('head-sha\n');
      if (argv.includes('status')) return result('');
      if (argv.includes('check-ref-format')) return result('');
      if (argv.includes('remote') && argv.includes('get-url'))
        return result('https://github.com/acme/repo.git\n');
      if (argv.includes('ls-remote')) return result('head-sha\trefs/heads/pixel/exact-delivery\n');
    }
    if (command === '/usr/bin/gh' && argv[0] === 'pr' && argv[1] === 'list')
      return result(JSON.stringify([failedPr]));
    return result('', 'unexpected command: ' + command + ' ' + argv.join(' '), 1);
  }) as any;
  const adapter = new GitHubCliDeliveryAdapter({ allowedRepositoryRoots: [value.root], spawn });
  const observed = await adapter.advance(value.plan, value.delivery);
  assert.deepEqual(observed, {
    status: 'CHECKS_FAILED',
    headSha: 'head-sha',
    pullRequestNumber: 12,
    pullRequestUrl: 'https://github.com/acme/repo/pull/12',
    errorCode: 'DELIVERY_REQUIRED_CHECK_FAILED',
  });
  assert.ok(!calls.some((call) => call.command === '/usr/bin/gh' && call.args[1] === 'merge'));
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('GitHub delivery fast-forwards an existing delivery branch only when it is an ancestor of the reviewed SHA', async () => {
  const value = fixture();
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn = ((command: string, args: readonly string[]) => {
    const argv = [...args];
    calls.push({ command, args: argv });
    if (command === '/usr/bin/getent')
      return result(
        `dev:x:${fs.statSync(value.root).uid}:${fs.statSync(value.root).gid}:dev:/tmp:/bin/bash\n`,
      );
    if (command === '/usr/bin/git') {
      if (argv.includes('rev-parse')) return result('head-sha\n');
      if (argv.includes('status')) return result('');
      if (argv.includes('check-ref-format')) return result('');
      if (argv.includes('remote') && argv.includes('get-url'))
        return result('https://github.com/acme/repo.git\n');
      if (argv.includes('ls-remote')) {
        const ref = argv.at(-1);
        return ref === 'refs/heads/pixel/exact-delivery'
          ? result('old-sha\trefs/heads/pixel/exact-delivery\n')
          : result('');
      }
      if (argv.includes('merge-base')) return result('');
      if (argv.includes('push')) return result('');
    }
    if (command === '/usr/bin/gh' && argv[0] === 'pr' && argv[1] === 'list') {
      return result(
        JSON.stringify([
          {
            number: 9,
            state: 'OPEN',
            url: 'https://github.com/acme/repo/pull/9',
            headRefOid: 'head-sha',
            statusCheckRollup: [{ name: 'CI', status: 'IN_PROGRESS', conclusion: '' }],
          },
        ]),
      );
    }
    return result('', 'unexpected command: ' + command + ' ' + argv.join(' '), 1);
  }) as any;
  const adapter = new GitHubCliDeliveryAdapter({ allowedRepositoryRoots: [value.root], spawn });
  const observed = await adapter.advance(value.plan, value.delivery);
  assert.equal(observed.status, 'CHECKS_PENDING');
  assert.ok(
    calls.some((call) => call.command === '/usr/bin/git' && call.args.includes('merge-base')),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.command === '/usr/bin/git' &&
        call.args.includes('head-sha:refs/heads/pixel/exact-delivery'),
    ),
  );
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('GitHub delivery publishes exact-head Hermes governance before satisfying a protected governance context', async () => {
  const value = fixture();
  value.delivery.requiredChecks = ['check', 'Hermes / PR Governance'];
  const calls: Array<{ command: string; args: string[] }> = [];
  let viewed = false;
  const basePr = {
    number: 10,
    state: 'OPEN',
    url: 'https://github.com/acme/repo/pull/10',
    headRefOid: 'head-sha',
    mergeStateStatus: 'CLEAN',
  };
  const spawn = ((command: string, args: readonly string[]) => {
    const argv = [...args];
    calls.push({ command, args: argv });
    if (command === '/usr/bin/getent')
      return result(
        `dev:x:${fs.statSync(value.root).uid}:${fs.statSync(value.root).gid}:dev:/tmp:/bin/bash\n`,
      );
    if (command === '/usr/bin/git') {
      if (argv.includes('rev-parse')) return result('head-sha\n');
      if (argv.includes('status')) return result('');
      if (argv.includes('check-ref-format')) return result('');
      if (argv.includes('remote') && argv.includes('get-url'))
        return result('https://github.com/acme/repo.git\n');
      if (argv.includes('ls-remote')) {
        const ref = argv.at(-1);
        if (ref === 'refs/heads/pixel/exact-delivery')
          return result('head-sha\trefs/heads/pixel/exact-delivery\n');
        if (ref === 'refs/heads/main') return result('merge-sha\trefs/heads/main\n');
      }
    }
    if (command === '/usr/bin/gh') {
      if (argv[0] === 'pr' && argv[1] === 'list') {
        return result(
          JSON.stringify([
            {
              ...basePr,
              statusCheckRollup: [{ name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }],
            },
          ]),
        );
      }
      if (argv[0] === 'api' && argv[1] === 'repos/acme/repo/commits/head-sha/status')
        return result(JSON.stringify({ statuses: [] }));
      if (argv[0] === 'api' && argv.includes('repos/acme/repo/statuses/head-sha'))
        return result('{}');
      if (argv[0] === 'pr' && argv[1] === 'view') {
        viewed = true;
        return result(
          JSON.stringify({
            ...basePr,
            statusCheckRollup: [
              { name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' },
              { context: 'Hermes / PR Governance', state: 'SUCCESS' },
            ],
            ...(calls.filter((call) => call.command === '/usr/bin/gh' && call.args[1] === 'merge')
              .length
              ? { state: 'MERGED', mergeCommit: { oid: 'merge-sha' } }
              : {}),
          }),
        );
      }
      if (argv[0] === 'pr' && argv[1] === 'merge') return result('');
    }
    return result('', 'unexpected command: ' + command + ' ' + argv.join(' '), 1);
  }) as any;
  const adapter = new GitHubCliDeliveryAdapter({ allowedRepositoryRoots: [value.root], spawn });
  const observed = await adapter.advance(value.plan, value.delivery);
  assert.equal(observed.status, 'VERIFIED');
  assert.equal(viewed, true);
  const publish = calls.find(
    (call) =>
      call.command === '/usr/bin/gh' && call.args.includes('repos/acme/repo/statuses/head-sha'),
  );
  assert.ok(publish);
  assert.ok(publish!.args.includes('context=Hermes / PR Governance'));
  assert.ok(publish!.args.includes('target_url=https://github.com/acme/repo/pull/10'));
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('GitHub delivery waits when GitHub still reports the PR blocked after configured checks pass', async () => {
  const value = fixture();
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn = ((command: string, args: readonly string[]) => {
    const argv = [...args];
    calls.push({ command, args: argv });
    if (command === '/usr/bin/getent')
      return result(
        `dev:x:${fs.statSync(value.root).uid}:${fs.statSync(value.root).gid}:dev:/tmp:/bin/bash\n`,
      );
    if (command === '/usr/bin/git') {
      if (argv.includes('rev-parse')) return result('head-sha\n');
      if (argv.includes('status')) return result('');
      if (argv.includes('check-ref-format')) return result('');
      if (argv.includes('remote') && argv.includes('get-url'))
        return result('https://github.com/acme/repo.git\n');
      if (argv.includes('ls-remote')) return result('head-sha\trefs/heads/pixel/exact-delivery\n');
    }
    if (command === '/usr/bin/gh' && argv[0] === 'pr' && argv[1] === 'list') {
      return result(
        JSON.stringify([
          {
            number: 11,
            state: 'OPEN',
            url: 'https://github.com/acme/repo/pull/11',
            headRefOid: 'head-sha',
            mergeStateStatus: 'BLOCKED',
            statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
          },
        ]),
      );
    }
    return result('', 'unexpected command: ' + command + ' ' + argv.join(' '), 1);
  }) as any;
  const adapter = new GitHubCliDeliveryAdapter({ allowedRepositoryRoots: [value.root], spawn });
  const observed = await adapter.advance(value.plan, value.delivery);
  assert.equal(observed.status, 'CHECKS_PENDING');
  assert.ok(!calls.some((call) => call.command === '/usr/bin/gh' && call.args[1] === 'merge'));
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('GitHub delivery refuses a durable merged PR whose head is not the exact reviewed Plan SHA', async () => {
  const value = fixture();
  value.delivery.status = 'CHECKS_PENDING';
  value.delivery.headSha = 'head-sha';
  value.delivery.pullRequestNumber = 165;
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn = ((command: string, args: readonly string[]) => {
    const argv = [...args];
    calls.push({ command, args: argv });
    if (command === '/usr/bin/getent')
      return result(
        `dev:x:${fs.statSync(value.root).uid}:${fs.statSync(value.root).gid}:dev:/tmp:/bin/bash\n`,
      );
    if (command === '/usr/bin/git') {
      if (argv.includes('check-ref-format')) return result('');
      if (argv.includes('remote') && argv.includes('get-url'))
        return result('https://github.com/acme/repo.git\n');
      return result('', 'unexpected local access: ' + argv.join(' '), 1);
    }
    if (command === '/usr/bin/gh' && argv[0] === 'pr' && argv[1] === 'view')
      return result(
        JSON.stringify({
          number: 165,
          state: 'MERGED',
          url: 'https://github.com/acme/repo/pull/165',
          headRefOid: 'different-head',
          headRefName: 'pixel/exact-delivery',
          baseRefName: 'main',
          mergeCommit: { oid: 'merge-sha' },
        }),
      );
    return result('', 'unexpected command: ' + command + ' ' + argv.join(' '), 1);
  }) as any;
  const adapter = new GitHubCliDeliveryAdapter({ allowedRepositoryRoots: [value.root], spawn });
  await assert.rejects(
    () => adapter.advance(value.plan, value.delivery),
    (error: unknown) => error instanceof V4Error && error.code === 'DELIVERY_PR_HEAD_STALE',
  );
  assert.ok(
    !calls.some((call) => call.command === '/usr/bin/git' && call.args.includes('rev-parse')),
  );
  assert.ok(!calls.some((call) => call.command === '/usr/bin/git' && call.args.includes('push')));
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('GitHub delivery reconciles an exact durable merged PR after the canonical and target heads advance', async () => {
  const value = fixture();
  value.delivery.status = 'CHECKS_PENDING';
  value.delivery.headSha = 'head-sha';
  value.delivery.pullRequestNumber = 165;
  value.delivery.pullRequestUrl = 'https://github.com/acme/repo/pull/165';
  const calls: Array<{ command: string; args: string[] }> = [];
  const mergedPr = {
    number: 165,
    state: 'MERGED',
    url: 'https://github.com/acme/repo/pull/165',
    headRefOid: 'head-sha',
    headRefName: 'pixel/exact-delivery',
    baseRefName: 'main',
    mergeCommit: { oid: 'merge-sha' },
    statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  };
  const spawn = ((command: string, args: readonly string[]) => {
    const argv = [...args];
    calls.push({ command, args: argv });
    if (command === '/usr/bin/getent')
      return result(
        `dev:x:${fs.statSync(value.root).uid}:${fs.statSync(value.root).gid}:dev:/tmp:/bin/bash\n`,
      );
    if (command === '/usr/bin/git') {
      if (argv.includes('check-ref-format')) return result('');
      if (argv.includes('remote') && argv.includes('get-url'))
        return result('https://github.com/acme/repo.git\n');
      if (argv.includes('ls-remote')) return result('later-main\trefs/heads/main\n');
      if (argv.includes('merge-base')) return result('');
      return result('', 'unexpected local mutation/read: ' + argv.join(' '), 1);
    }
    if (command === '/usr/bin/gh' && argv[0] === 'pr' && argv[1] === 'view')
      return result(JSON.stringify(mergedPr));
    return result('', 'unexpected command: ' + command + ' ' + argv.join(' '), 1);
  }) as any;
  const adapter = new GitHubCliDeliveryAdapter({ allowedRepositoryRoots: [value.root], spawn });
  const observed = await adapter.advance(value.plan, value.delivery);
  assert.deepEqual(observed, {
    status: 'VERIFIED',
    headSha: 'head-sha',
    pullRequestNumber: 165,
    pullRequestUrl: 'https://github.com/acme/repo/pull/165',
    mergeSha: 'merge-sha',
  });
  assert.ok(
    calls.some((call) => call.command === '/usr/bin/git' && call.args.includes('merge-base')),
  );
  assert.ok(
    !calls.some((call) => call.command === '/usr/bin/git' && call.args.includes('rev-parse')),
  );
  assert.ok(!calls.some((call) => call.command === '/usr/bin/git' && call.args.includes('status')));
  assert.ok(!calls.some((call) => call.command === '/usr/bin/git' && call.args.includes('push')));
  assert.ok(!calls.some((call) => call.command === '/usr/bin/pnpm'));
  assert.ok(!calls.some((call) => call.command === '/usr/bin/gh' && call.args[1] === 'create'));
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('GitHub delivery uses an exact linked worktree when canonical HEAD intentionally stays on the base revision', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-v4-delivery-worktree-'));
  const sourceRoot = path.join(root, 'repositories');
  const repository = path.join(sourceRoot, 'project');
  const workspaceRoot = path.join(root, 'workspaces');
  const worktree = path.join(workspaceRoot, 'integration');
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repository]);
  execFileSync('git', ['-C', repository, 'config', 'user.name', 'Delivery Test']);
  execFileSync('git', ['-C', repository, 'config', 'user.email', 'delivery@test.local']);
  fs.writeFileSync(path.join(repository, 'README.md'), 'base\n');
  execFileSync('git', ['-C', repository, 'add', 'README.md']);
  execFileSync('git', ['-C', repository, 'commit', '-m', 'chore: base']);
  const base = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  execFileSync('git', [
    '-C',
    repository,
    'worktree',
    'add',
    '-b',
    'pixel-v4/test/integration',
    worktree,
    base,
  ]);
  fs.writeFileSync(path.join(worktree, 'feature.txt'), 'feature\n');
  fs.writeFileSync(path.join(worktree, 'commitlint.config.cjs'), 'module.exports = {};\n');
  fs.writeFileSync(
    path.join(worktree, 'package.json'),
    JSON.stringify({ devDependencies: { '@commitlint/cli': '1.0.0' } }),
  );
  fs.writeFileSync(path.join(worktree, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  execFileSync('git', ['-C', worktree, 'add', '.']);
  execFileSync('git', ['-C', worktree, 'commit', '-m', 'feat: exact worktree delivery']);
  const candidate = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  execFileSync('git', [
    '-C',
    repository,
    'remote',
    'add',
    'origin',
    'git@github.com:acme/repo.git',
  ]);

  const plan: Plan = {
    planId: 'plan-worktree-delivery',
    idempotencyKey: 'worktree-delivery',
    projectKey: 'test',
    objective: 'Deliver exact linked worktree',
    repositoryPath: repository,
    baseRevision: base,
    currentRevision: candidate,
    status: 'RUNNING',
    childPlanIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const delivery: PlanDelivery = {
    planId: plan.planId,
    remote: 'origin',
    branch: 'pixel/exact-worktree',
    targetBranch: 'main',
    autoMerge: false,
    mergeMethod: 'merge',
    requiredChecks: ['commit-lint'],
    status: 'PENDING',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  let prLists = 0;
  const spawn = ((command: string, args: readonly string[], options: any = {}) => {
    const argv = [...args];
    calls.push({ command, args: argv, cwd: options.cwd });
    if (command === '/usr/bin/git') {
      if (argv.includes('ls-remote')) {
        const ref = argv.at(-1);
        if (ref === 'refs/heads/main') return result(base + '\trefs/heads/main\n');
        return result('');
      }
      if (argv.includes('push')) return result('');
      return realSpawnSync(command, argv, options) as SpawnSyncReturns<string>;
    }
    if (command === '/usr/bin/getent')
      return realSpawnSync(command, argv, options) as SpawnSyncReturns<string>;
    if (command === '/usr/bin/pnpm') return result('');
    if (command === '/usr/bin/gh') {
      if (argv[0] === 'pr' && argv[1] === 'list') {
        prLists += 1;
        if (prLists === 1) return result('[]');
        return result(
          JSON.stringify([
            {
              number: 17,
              state: 'OPEN',
              url: 'https://github.com/acme/repo/pull/17',
              headRefOid: candidate,
              mergeStateStatus: 'CLEAN',
              statusCheckRollup: [
                { name: 'commit-lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
              ],
            },
          ]),
        );
      }
      if (argv[0] === 'pr' && argv[1] === 'create')
        return result('https://github.com/acme/repo/pull/17\n');
    }
    return result('', 'unexpected command: ' + command + ' ' + argv.join(' '), 1);
  }) as any;

  const adapter = new GitHubCliDeliveryAdapter({
    allowedRepositoryRoots: [sourceRoot],
    allowedWorkspaceRoots: [workspaceRoot],
    spawn,
  });
  const observed = await adapter.advance(plan, delivery, { workspacePath: worktree });
  assert.equal(observed.status, 'PR_OPEN');
  assert.equal(observed.headSha, candidate);
  assert.equal(
    execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    base,
  );
  const lint = calls.find((call) => call.command === '/usr/bin/pnpm');
  assert.equal(lint?.cwd, worktree);
  assert.ok(
    calls.some(
      (call) =>
        call.command === '/usr/bin/git' &&
        call.args.includes(candidate + ':refs/heads/pixel/exact-worktree'),
    ),
  );

  execFileSync('git', ['-C', repository, 'worktree', 'remove', '--force', worktree]);
  fs.rmSync(root, { recursive: true, force: true });
});
