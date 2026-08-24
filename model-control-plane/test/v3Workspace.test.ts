import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WorkspaceProvisioner } from '../src/v3/workspace.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

test('review snapshot freezes Git-visible implementation working tree without ignored artifacts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-review-'));
  const source = path.join(root, 'source');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.mkdirSync(source, { recursive: true });
  git(source, 'init');
  git(source, 'config', 'user.email', 'v3-test@example.invalid');
  git(source, 'config', 'user.name', 'V3 Test');
  fs.writeFileSync(path.join(source, 'tracked.txt'), 'original\n');
  fs.writeFileSync(path.join(source, 'deleted.txt'), 'remove me\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'base');
  const head = git(source, 'rev-parse', 'HEAD');

  fs.writeFileSync(path.join(source, 'tracked.txt'), 'implementation change\n');
  fs.rmSync(path.join(source, 'deleted.txt'));
  fs.writeFileSync(path.join(source, '.gitignore'), 'ignored/\n');
  fs.writeFileSync(path.join(source, 'new-file.txt'), 'new implementation file\n');
  fs.mkdirSync(path.join(source, 'ignored'), { recursive: true });
  fs.writeFileSync(path.join(source, 'ignored', 'cache.bin'), 'do not review\n');

  const provisioner = new WorkspaceProvisioner({
    hostRoot: workspaceRoot,
    executionRoot: '/workspace',
    allowedRepositoryRoots: [root],
  });

  let snapshotRoot: string | undefined;
  try {
    const snapshot = await provisioner.provision({
      executionId: 'review-1',
      repositoryPath: source,
      baseRevision: 'HEAD',
      workspaceMode: 'review_snapshot',
    });
    snapshotRoot = snapshot.hostPath;

    assert.equal(snapshot.sourceRevision, head);
    assert.equal(
      fs.readFileSync(path.join(snapshot.hostPath, 'tracked.txt'), 'utf8'),
      'implementation change\n',
    );
    assert.equal(fs.existsSync(path.join(snapshot.hostPath, 'deleted.txt')), false);
    assert.equal(
      fs.readFileSync(path.join(snapshot.hostPath, 'new-file.txt'), 'utf8'),
      'new implementation file\n',
    );
    assert.equal(fs.existsSync(path.join(snapshot.hostPath, 'ignored', 'cache.bin')), false);

    execFileSync('chmod', ['-R', 'u+w', snapshot.hostPath]);
    const status = git(snapshot.hostPath, 'status', '--short');
    assert.match(status, /M tracked\.txt/);
    assert.match(status, /D deleted\.txt/);
    assert.match(status, /\?\? \.gitignore/);
    assert.match(status, /\?\? new-file\.txt/);
    assert.doesNotMatch(status, /ignored\/cache\.bin/);

    // Snapshotting must not stage, commit, or otherwise mutate the implementation source.
    assert.equal(git(source, 'rev-parse', 'HEAD'), head);
    assert.match(git(source, 'status', '--short'), /M tracked\.txt/);
  } finally {
    if (snapshotRoot && fs.existsSync(snapshotRoot)) {
      execFileSync('chmod', ['-R', 'u+w', snapshotRoot]);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review snapshot can anchor committed implementation content at the original source revision', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-committed-review-'));
  const source = path.join(root, 'source');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.mkdirSync(source, { recursive: true });
  git(source, 'init');
  git(source, 'config', 'user.email', 'v3-test@example.invalid');
  git(source, 'config', 'user.name', 'V3 Test');
  fs.writeFileSync(path.join(source, 'tracked.txt'), 'base\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'base');
  const base = git(source, 'rev-parse', 'HEAD');

  fs.writeFileSync(path.join(source, 'tracked.txt'), 'committed implementation\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'implementation commit');
  const implementationHead = git(source, 'rev-parse', 'HEAD');
  assert.notEqual(implementationHead, base);

  const provisioner = new WorkspaceProvisioner({
    hostRoot: workspaceRoot,
    executionRoot: '/workspace',
    allowedRepositoryRoots: [root],
  });

  let snapshotRoot: string | undefined;
  try {
    const snapshot = await provisioner.provision({
      executionId: 'review-committed-1',
      repositoryPath: source,
      baseRevision: base,
      workspaceMode: 'review_snapshot',
    });
    snapshotRoot = snapshot.hostPath;

    assert.equal(snapshot.sourceRevision, base);
    assert.equal(git(snapshot.hostPath, 'rev-parse', 'HEAD'), base);
    assert.equal(
      fs.readFileSync(path.join(snapshot.hostPath, 'tracked.txt'), 'utf8'),
      'committed implementation\n',
    );

    execFileSync('chmod', ['-R', 'u+w', snapshot.hostPath]);
    const diff = git(snapshot.hostPath, 'diff', '--no-ext-diff', 'HEAD', '--', 'tracked.txt');
    assert.match(diff, /-base/);
    assert.match(diff, /\+committed implementation/);
  } finally {
    if (snapshotRoot && fs.existsSync(snapshotRoot)) {
      execFileSync('chmod', ['-R', 'u+w', snapshotRoot]);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('batch integration creates a durable repository ref without changing the source worktree', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-integrate-'));
  const source = path.join(root, 'source');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.mkdirSync(source, { recursive: true });
  git(source, 'init');
  git(source, 'config', 'user.email', 'v3-test@example.invalid');
  git(source, 'config', 'user.name', 'V3 Test');
  fs.writeFileSync(path.join(source, 'tracked.txt'), 'base\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'base');
  const base = git(source, 'rev-parse', 'HEAD');

  const provisioner = new WorkspaceProvisioner({
    hostRoot: workspaceRoot,
    executionRoot: '/workspace',
    allowedRepositoryRoots: [root],
  });

  try {
    const implementation = await provisioner.provision({
      executionId: 'implementation-1',
      repositoryPath: source,
      baseRevision: base,
      workspaceMode: 'isolated_write',
    });
    fs.writeFileSync(path.join(implementation.hostPath, 'tracked.txt'), 'implemented\n');
    git(implementation.hostPath, 'config', 'user.email', 'worker@example.invalid');
    git(implementation.hostPath, 'config', 'user.name', 'Worker');
    git(implementation.hostPath, 'add', '.');
    git(implementation.hostPath, 'commit', '-m', 'implement change');

    const integrated = await provisioner.integrateBatch({
      planId: 'plan-1',
      batchKey: 'batch-1',
      repositoryPath: source,
      baseRevision: base,
      implementations: [
        {
          workspaceRef: implementation.executionPath,
          sourceRevision: implementation.sourceRevision,
        },
      ],
    });

    assert.equal(integrated.ref, 'refs/ai-office/plans/plan-1/batches/batch-1');
    assert.equal(git(source, 'rev-parse', integrated.ref), integrated.revision);
    assert.equal(git(source, 'rev-parse', 'HEAD'), base);
    assert.equal(fs.readFileSync(path.join(source, 'tracked.txt'), 'utf8'), 'base\n');
    assert.equal(git(source, 'show', `${integrated.revision}:tracked.txt`), 'implemented');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
