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

test('review snapshot preserves committed implementation HEAD and records original source base', async () => {
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
      baseRevision: 'HEAD',
      workspaceMode: 'review_snapshot',
      reviewBaseRevision: base,
    });
    snapshotRoot = snapshot.hostPath;

    assert.equal(snapshot.sourceRevision, implementationHead);
    assert.equal(git(snapshot.hostPath, 'rev-parse', 'HEAD'), implementationHead);
    assert.equal(git(snapshot.hostPath, 'rev-parse', 'refs/ai-office/review-base'), base);
    assert.equal(
      fs.readFileSync(path.join(snapshot.hostPath, 'tracked.txt'), 'utf8'),
      'committed implementation\n',
    );

    execFileSync('chmod', ['-R', 'u+w', snapshot.hostPath]);
    assert.equal(git(snapshot.hostPath, 'status', '--short'), '');
    const diff = git(
      snapshot.hostPath,
      'diff',
      '--no-ext-diff',
      'refs/ai-office/review-base..HEAD',
      '--',
      'tracked.txt',
    );
    assert.match(diff, /-base/);
    assert.match(diff, /\+committed implementation/);
  } finally {
    if (snapshotRoot && fs.existsSync(snapshotRoot)) {
      execFileSync('chmod', ['-R', 'u+w', snapshotRoot]);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('execution provisioning rejects tracked symlinks that escape the workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-symlink-boundary-'));
  const source = path.join(root, 'source');
  const workspaceRoot = path.join(root, 'workspaces');
  const victim = path.join(root, 'host-owned.txt');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(victim, 'host-owned\n', { mode: 0o600 });
  git(source, 'init');
  git(source, 'config', 'user.email', 'v3-test@example.invalid');
  git(source, 'config', 'user.name', 'V3 Test');
  fs.writeFileSync(path.join(source, 'tracked.txt'), 'base\n');
  fs.symlinkSync(victim, path.join(source, 'outside-link'));
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'base with external symlink');
  const base = git(source, 'rev-parse', 'HEAD');
  const before = fs.statSync(victim);

  const provisioner = new WorkspaceProvisioner({
    hostRoot: workspaceRoot,
    executionRoot: '/workspace',
    allowedRepositoryRoots: [root],
    executionOwner: { uid: process.getuid!(), gid: process.getgid!() },
  });

  try {
    await assert.rejects(
      provisioner.provision({
        executionId: 'symlink-review-1',
        repositoryPath: source,
        baseRevision: base,
        workspaceMode: 'read_oriented',
      }),
      /V3_WORKSPACE_SYMLINK_OUTSIDE_ROOT/,
    );
    const after = fs.statSync(victim);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.equal(after.mode & 0o777, before.mode & 0o777);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'host-owned\n');
    assert.equal(fs.existsSync(provisioner.hostPathForExecution('symlink-review-1')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('execution provisioning preserves relative symlinks contained inside the workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-contained-symlink-'));
  const source = path.join(root, 'source');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.mkdirSync(path.join(source, 'content'), { recursive: true });
  git(source, 'init');
  git(source, 'config', 'user.email', 'v3-test@example.invalid');
  git(source, 'config', 'user.name', 'V3 Test');
  fs.writeFileSync(path.join(source, 'content', 'target.txt'), 'inside\n');
  fs.symlinkSync('content/target.txt', path.join(source, 'inside-link'));
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'base with contained symlink');
  const base = git(source, 'rev-parse', 'HEAD');

  const provisioner = new WorkspaceProvisioner({
    hostRoot: workspaceRoot,
    executionRoot: '/workspace',
    allowedRepositoryRoots: [root],
  });

  try {
    const workspace = await provisioner.provision({
      executionId: 'contained-symlink-1',
      repositoryPath: source,
      baseRevision: base,
      workspaceMode: 'isolated_write',
    });
    assert.equal(fs.lstatSync(path.join(workspace.hostPath, 'inside-link')).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(workspace.hostPath, 'inside-link'), 'utf8'), 'inside\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('execution workspace names reject lossy identifiers instead of colliding', () => {
  const provisioner = new WorkspaceProvisioner({
    hostRoot: '/tmp/v3-workspace-id-test',
    executionRoot: '/workspace',
    allowedRepositoryRoots: ['/tmp'],
  });

  assert.match(provisioner.hostPathForExecution('exec_safe-1.2'), /exec_safe-1\.2\/repo$/);
  for (const invalid of ['exec/a', 'exec:a', '.', '..', 'foo..bar', 'foo.', 'foo.lock', '.hidden']) {
    assert.throws(() => provisioner.hostPathForExecution(invalid), /V3_EXECUTION_ID_INVALID/);
  }
});

test('existing execution workspace symlinks are rejected before reuse', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-existing-symlink-'));
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
  const hostPath = provisioner.hostPathForExecution('existing-symlink-1');
  fs.mkdirSync(path.dirname(hostPath), { recursive: true });
  fs.symlinkSync(source, hostPath);

  try {
    await assert.rejects(
      provisioner.provision({
        executionId: 'existing-symlink-1',
        repositoryPath: source,
        baseRevision: base,
        workspaceMode: 'isolated_write',
      }),
      /V3_EXECUTION_WORKSPACE_SYMLINK/,
    );
    assert.equal(git(source, 'rev-parse', 'HEAD'), base);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unattached execution crash residue is recreated from the requested repository and base', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-crash-residue-'));
  const sourceA = path.join(root, 'source-a');
  const sourceB = path.join(root, 'source-b');
  const workspaceRoot = path.join(root, 'workspaces');
  for (const [source, content, message] of [
    [sourceA, 'from-a\n', 'base a'],
    [sourceB, 'from-b\n', 'base b'],
  ] as const) {
    fs.mkdirSync(source, { recursive: true });
    git(source, 'init');
    git(source, 'config', 'user.email', 'v3-test@example.invalid');
    git(source, 'config', 'user.name', 'V3 Test');
    fs.writeFileSync(path.join(source, 'tracked.txt'), content);
    git(source, 'add', '.');
    git(source, 'commit', '-m', message);
  }
  const baseA = git(sourceA, 'rev-parse', 'HEAD');
  const baseB = git(sourceB, 'rev-parse', 'HEAD');
  const provisioner = new WorkspaceProvisioner({
    hostRoot: workspaceRoot,
    executionRoot: '/workspace',
    allowedRepositoryRoots: [root],
  });

  try {
    const first = await provisioner.provision({
      executionId: 'crash-residue-1',
      repositoryPath: sourceA,
      baseRevision: baseA,
      workspaceMode: 'isolated_write',
    });
    fs.writeFileSync(path.join(first.hostPath, 'residue.txt'), 'stale execution residue\n');
    fs.writeFileSync(path.join(first.hostPath, 'tracked.txt'), 'dirty residue\n');

    const second = await provisioner.provision({
      executionId: 'crash-residue-1',
      repositoryPath: sourceB,
      baseRevision: baseB,
      workspaceMode: 'isolated_write',
    });

    assert.equal(second.hostPath, first.hostPath);
    assert.equal(second.sourceRevision, baseB);
    assert.equal(git(second.hostPath, 'rev-parse', 'HEAD'), baseB);
    assert.equal(fs.readFileSync(path.join(second.hostPath, 'tracked.txt'), 'utf8'), 'from-b\n');
    assert.equal(fs.existsSync(path.join(second.hostPath, 'residue.txt')), false);
    assert.equal(git(second.hostPath, 'status', '--porcelain'), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writer reuse rejects Git object-directory redirection introduced after provisioning', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-reuse-object-redirect-'));
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
    const workspace = await provisioner.provision({
      executionId: 'reuse-object-redirect-1',
      repositoryPath: source,
      baseRevision: base,
      workspaceMode: 'isolated_write',
    });
    const objects = path.join(workspace.hostPath, '.git', 'objects');
    fs.rmSync(objects, { recursive: true, force: true });
    fs.symlinkSync(path.join(source, '.git', 'objects'), objects);

    await assert.rejects(
      provisioner.prepareWriterExecution({
        executionId: 'reuse-object-redirect-attempt',
        workspaceRef: workspace.executionPath,
      }),
      /V3_EXECUTION_WORKSPACE_GIT_DIRECTORY_INVALID/,
    );
    assert.equal(git(source, 'rev-parse', 'HEAD'), base);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writer reuse rejects escaping working-tree symlinks introduced after provisioning', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-reuse-tree-symlink-'));
  const source = path.join(root, 'source');
  const workspaceRoot = path.join(root, 'workspaces');
  const victim = path.join(root, 'victim.txt');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(victim, 'victim\n');
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
    const workspace = await provisioner.provision({
      executionId: 'reuse-tree-symlink-1',
      repositoryPath: source,
      baseRevision: base,
      workspaceMode: 'isolated_write',
    });
    fs.symlinkSync(victim, path.join(workspace.hostPath, 'late-outside-link'));

    await assert.rejects(
      provisioner.prepareWriterExecution({
        executionId: 'reuse-tree-symlink-attempt',
        workspaceRef: workspace.executionPath,
      }),
      /V3_WORKSPACE_SYMLINK_OUTSIDE_ROOT/,
    );
    assert.equal(fs.readFileSync(victim, 'utf8'), 'victim\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writer reuse rejects special files inside private Git metadata', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-git-special-file-'));
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
    const workspace = await provisioner.provision({
      executionId: 'git-special-file-1',
      repositoryPath: source,
      baseRevision: base,
      workspaceMode: 'isolated_write',
    });
    const fifo = path.join(workspace.hostPath, '.git', 'hostile-fifo');
    execFileSync('mkfifo', [fifo]);

    await assert.rejects(
      provisioner.prepareWriterExecution({
        executionId: 'git-special-file-attempt',
        workspaceRef: workspace.executionPath,
      }),
      /V3_EXECUTION_WORKSPACE_GIT_DIRECTORY_INVALID/,
    );
    assert.equal(fs.lstatSync(fifo).isFIFO(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('existing execution workspaces reject redirected Git metadata', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-existing-gitdir-'));
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
  const hostPath = provisioner.hostPathForExecution('redirected-gitdir-1');
  fs.mkdirSync(hostPath, { recursive: true });
  fs.writeFileSync(path.join(hostPath, 'tracked.txt'), 'base\n');
  fs.symlinkSync(path.join(source, '.git'), path.join(hostPath, '.git'));

  try {
    await assert.rejects(
      provisioner.provision({
        executionId: 'redirected-gitdir-1',
        repositoryPath: source,
        baseRevision: base,
        workspaceMode: 'isolated_write',
      }),
      /V3_EXECUTION_WORKSPACE_GIT_DIRECTORY_INVALID/,
    );
    assert.equal(git(source, 'rev-parse', 'HEAD'), base);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('execution provisioning treats a symlinked canonical object directory as private', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-object-symlink-'));
  const source = path.join(root, 'source');
  const workspaceRoot = path.join(root, 'workspaces');
  const externalObjects = path.join(root, 'external-objects');
  fs.mkdirSync(source, { recursive: true });
  git(source, 'init');
  git(source, 'config', 'user.email', 'v3-test@example.invalid');
  git(source, 'config', 'user.name', 'V3 Test');
  for (let index = 0; index < 12; index += 1) {
    fs.writeFileSync(path.join(source, `file-${index}.txt`), `base-${index}\n`);
  }
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'base');
  git(source, 'gc', '--prune=now');
  const base = git(source, 'rev-parse', 'HEAD');

  const sourceObjects = path.join(source, '.git', 'objects');
  fs.renameSync(sourceObjects, externalObjects);
  fs.symlinkSync(externalObjects, sourceObjects);
  const pack = fs.readdirSync(path.join(externalObjects, 'pack')).find((entry) => entry.endsWith('.pack'));
  assert.ok(pack);
  const externalPackPath = path.join(externalObjects, 'pack', pack);
  const before = fs.statSync(externalPackPath);

  const provisioner = new WorkspaceProvisioner({
    hostRoot: workspaceRoot,
    executionRoot: '/workspace',
    allowedRepositoryRoots: [root],
    executionOwner: { uid: process.getuid!(), gid: process.getgid!() },
  });

  try {
    const workspace = await provisioner.provision({
      executionId: 'object-symlink-1',
      repositoryPath: source,
      baseRevision: base,
      workspaceMode: 'isolated_write',
    });
    const workspacePack = fs
      .readdirSync(path.join(workspace.hostPath, '.git', 'objects', 'pack'))
      .find((entry) => entry.endsWith('.pack'));
    assert.ok(workspacePack);
    const workspacePackStat = fs.statSync(
      path.join(workspace.hostPath, '.git', 'objects', 'pack', workspacePack),
    );
    const after = fs.statSync(externalPackPath);

    assert.notEqual(workspacePackStat.ino, before.ino);
    assert.doesNotThrow(() => git(workspace.hostPath, 'cat-file', '-e', `${base}^{commit}`));
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.equal(after.mode & 0o777, before.mode & 0o777);
    assert.equal(git(source, 'rev-parse', 'HEAD'), base);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('execution provisioning does not normalize an external common Git directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-external-gitdir-'));
  const canonical = path.join(root, 'canonical');
  const linked = path.join(root, 'linked');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.mkdirSync(canonical, { recursive: true });
  git(canonical, 'init');
  git(canonical, 'config', 'user.email', 'v3-test@example.invalid');
  git(canonical, 'config', 'user.name', 'V3 Test');
  fs.writeFileSync(path.join(canonical, 'tracked.txt'), 'base\n');
  git(canonical, 'add', '.');
  git(canonical, 'commit', '-m', 'base');
  git(canonical, 'gc', '--prune=now');
  git(canonical, 'worktree', 'add', '-b', 'linked-test', linked, 'HEAD');
  const base = git(linked, 'rev-parse', 'HEAD');
  const canonicalConfig = path.join(canonical, '.git', 'config');
  const beforeConfig = fs.readFileSync(canonicalConfig, 'utf8');
  const sourcePack = fs
    .readdirSync(path.join(canonical, '.git', 'objects', 'pack'))
    .find((entry) => entry.endsWith('.pack'));
  assert.ok(sourcePack);
  const sourcePackPath = path.join(canonical, '.git', 'objects', 'pack', sourcePack);
  const beforePack = fs.statSync(sourcePackPath);

  const provisioner = new WorkspaceProvisioner({
    hostRoot: workspaceRoot,
    executionRoot: '/workspace',
    allowedRepositoryRoots: [root],
    executionOwner: { uid: process.getuid!(), gid: process.getgid!() },
  });

  try {
    const implementation = await provisioner.provision({
      executionId: 'external-gitdir-1',
      repositoryPath: linked,
      baseRevision: base,
      workspaceMode: 'isolated_write',
    });
    const workspacePack = fs
      .readdirSync(path.join(implementation.hostPath, '.git', 'objects', 'pack'))
      .find((entry) => entry.endsWith('.pack'));
    assert.ok(workspacePack);
    const workspacePackStat = fs.statSync(
      path.join(implementation.hostPath, '.git', 'objects', 'pack', workspacePack),
    );
    const afterPack = fs.statSync(sourcePackPath);

    assert.notEqual(workspacePackStat.ino, beforePack.ino);
    assert.doesNotThrow(() => git(implementation.hostPath, 'cat-file', '-e', `${base}^{commit}`));
    assert.equal(fs.readFileSync(canonicalConfig, 'utf8'), beforeConfig);
    assert.equal(afterPack.uid, beforePack.uid);
    assert.equal(afterPack.gid, beforePack.gid);
    assert.equal(afterPack.mode & 0o777, beforePack.mode & 0o777);
  } finally {
    try {
      git(canonical, 'worktree', 'remove', '--force', linked);
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('execution provisioning falls back to private objects when the execution identity owns the source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-private-object-fallback-'));
  const source = path.join(root, 'source');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.mkdirSync(source, { recursive: true });
  git(source, 'init');
  git(source, 'config', 'user.email', 'v3-test@example.invalid');
  git(source, 'config', 'user.name', 'V3 Test');
  for (let index = 0; index < 16; index += 1) {
    fs.writeFileSync(path.join(source, `file-${index}.txt`), `base-${index}\n`);
  }
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'base');
  git(source, 'gc', '--prune=now');
  const base = git(source, 'rev-parse', 'HEAD');
  const sourcePack = fs
    .readdirSync(path.join(source, '.git', 'objects', 'pack'))
    .find((entry) => entry.endsWith('.pack'));
  assert.ok(sourcePack);

  const provisioner = new WorkspaceProvisioner({
    hostRoot: workspaceRoot,
    executionRoot: '/workspace',
    allowedRepositoryRoots: [root],
    executionOwner: { uid: process.getuid!(), gid: process.getgid!() },
  });

  try {
    const implementation = await provisioner.provision({
      executionId: 'private-objects-1',
      repositoryPath: source,
      baseRevision: base,
      workspaceMode: 'isolated_write',
    });
    const sourcePackPath = path.join(source, '.git', 'objects', 'pack', sourcePack);
    const workspacePackPath = path.join(
      implementation.hostPath,
      '.git',
      'objects',
      'pack',
      sourcePack,
    );
    const sourceStat = fs.statSync(sourcePackPath);
    const workspaceStat = fs.statSync(workspacePackPath);

    assert.notEqual(workspaceStat.ino, sourceStat.ino);
    assert.doesNotMatch(
      fs.readFileSync(path.join(source, '.git', 'config'), 'utf8'),
      /sharedRepository/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('execution provisioning shares packed source objects without sharing mutable Git state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-linked-objects-'));
  const source = path.join(root, 'source');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.mkdirSync(source, { recursive: true });
  git(source, 'init');
  git(source, 'config', 'user.email', 'v3-test@example.invalid');
  git(source, 'config', 'user.name', 'V3 Test');
  for (let index = 0; index < 24; index += 1) {
    fs.writeFileSync(path.join(source, `file-${index}.txt`), `base-${index}\n`);
  }
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'base');
  git(source, 'gc', '--prune=now');
  const base = git(source, 'rev-parse', 'HEAD');
  const sourcePack = fs
    .readdirSync(path.join(source, '.git', 'objects', 'pack'))
    .find((entry) => entry.endsWith('.pack'));
  assert.ok(sourcePack);

  const provisioner = new WorkspaceProvisioner({
    hostRoot: workspaceRoot,
    executionRoot: '/workspace',
    allowedRepositoryRoots: [root],
  });

  try {
    const implementation = await provisioner.provision({
      executionId: 'linked-objects-1',
      repositoryPath: source,
      baseRevision: base,
      workspaceMode: 'isolated_write',
    });
    const sourcePackPath = path.join(source, '.git', 'objects', 'pack', sourcePack);
    const workspacePackPath = path.join(
      implementation.hostPath,
      '.git',
      'objects',
      'pack',
      sourcePack,
    );
    const sourceStat = fs.statSync(sourcePackPath);
    const workspaceStat = fs.statSync(workspacePackPath);

    assert.equal(workspaceStat.dev, sourceStat.dev);
    assert.equal(workspaceStat.ino, sourceStat.ino);
    assert.ok(sourceStat.nlink >= 2);

    git(implementation.hostPath, 'config', 'user.email', 'worker@example.invalid');
    git(implementation.hostPath, 'config', 'user.name', 'Worker');
    fs.writeFileSync(path.join(implementation.hostPath, 'file-0.txt'), 'execution-only\n');
    git(implementation.hostPath, 'add', 'file-0.txt');
    git(implementation.hostPath, 'commit', '-m', 'execution change');
    const implementationHead = git(implementation.hostPath, 'rev-parse', 'HEAD');

    assert.notEqual(implementationHead, base);
    assert.equal(git(source, 'rev-parse', 'HEAD'), base);
    assert.equal(fs.readFileSync(path.join(source, 'file-0.txt'), 'utf8'), 'base-0\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('batch integration rejects canonical object alternates outside the repository trust boundary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-integration-alternates-'));
  const source = path.join(root, 'source');
  const externalObjects = path.join(root, 'external-objects');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(externalObjects, { recursive: true });
  git(source, 'init');
  git(source, 'config', 'user.email', 'v3-test@example.invalid');
  git(source, 'config', 'user.name', 'V3 Test');
  fs.writeFileSync(path.join(source, 'tracked.txt'), 'base\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'base');
  const base = git(source, 'rev-parse', 'HEAD');
  fs.mkdirSync(path.join(source, '.git', 'objects', 'info'), { recursive: true });
  fs.writeFileSync(
    path.join(source, '.git', 'objects', 'info', 'alternates'),
    `${externalObjects}\n`,
  );
  const provisioner = new WorkspaceProvisioner({
    hostRoot: workspaceRoot,
    executionRoot: '/workspace',
    allowedRepositoryRoots: [root],
  });

  try {
    await assert.rejects(
      provisioner.integrateBatch({
        planId: 'plan-alternates',
        batchKey: 'batch-1',
        repositoryPath: source,
        baseRevision: base,
        implementations: [],
      }),
      /V3_REPOSITORY_GIT_DIRECTORY_NOT_ALLOWED/,
    );
    assert.throws(
      () => git(source, 'rev-parse', 'refs/ai-office/plans/plan-alternates/batches/batch-1'),
      /Command failed/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('batch integration rejects descendant symlinks in the canonical object tree', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-integration-object-symlink-'));
  const source = path.join(root, 'source');
  const external = path.join(root, 'external');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(external, { recursive: true });
  git(source, 'init');
  git(source, 'config', 'user.email', 'v3-test@example.invalid');
  git(source, 'config', 'user.name', 'V3 Test');
  fs.writeFileSync(path.join(source, 'tracked.txt'), 'base\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'base');
  const base = git(source, 'rev-parse', 'HEAD');
  fs.symlinkSync(external, path.join(source, '.git', 'objects', 'hostile-link'));
  const provisioner = new WorkspaceProvisioner({
    hostRoot: workspaceRoot,
    executionRoot: '/workspace',
    allowedRepositoryRoots: [root],
  });

  try {
    await assert.rejects(
      provisioner.integrateBatch({
        planId: 'plan-object-symlink',
        batchKey: 'batch-1',
        repositoryPath: source,
        baseRevision: base,
        implementations: [],
      }),
      /V3_REPOSITORY_GIT_DIRECTORY_NOT_ALLOWED/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('batch integration rejects a worktree whose common Git directory is external', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-integration-gitdir-'));
  const allowedRoot = path.join(root, 'allowed');
  const canonical = path.join(root, 'canonical');
  const linked = path.join(allowedRoot, 'linked');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.mkdirSync(allowedRoot, { recursive: true });
  fs.mkdirSync(canonical, { recursive: true });
  git(canonical, 'init');
  git(canonical, 'config', 'user.email', 'v3-test@example.invalid');
  git(canonical, 'config', 'user.name', 'V3 Test');
  fs.writeFileSync(path.join(canonical, 'tracked.txt'), 'base\n');
  git(canonical, 'add', '.');
  git(canonical, 'commit', '-m', 'base');
  const base = git(canonical, 'rev-parse', 'HEAD');
  git(canonical, 'worktree', 'add', '-b', 'integration-linked', linked, base);

  const provisioner = new WorkspaceProvisioner({
    hostRoot: workspaceRoot,
    executionRoot: '/workspace',
    allowedRepositoryRoots: [allowedRoot],
  });

  try {
    await assert.rejects(
      provisioner.integrateBatch({
        planId: 'plan-external-gitdir',
        batchKey: 'batch-1',
        repositoryPath: linked,
        baseRevision: base,
        implementations: [],
      }),
      /V3_REPOSITORY_GIT_DIRECTORY_NOT_ALLOWED/,
    );
    assert.equal(git(canonical, 'rev-parse', 'HEAD'), base);
    assert.throws(
      () => git(canonical, 'rev-parse', 'refs/ai-office/plans/plan-external-gitdir/batches/batch-1'),
      /Command failed/,
    );
  } finally {
    try {
      git(canonical, 'worktree', 'remove', '--force', linked);
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('batch integration rejects a repository that resolves outside the allowed root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-integration-root-'));
  const allowedRoot = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.mkdirSync(allowedRoot, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  git(outside, 'init');
  git(outside, 'config', 'user.email', 'v3-test@example.invalid');
  git(outside, 'config', 'user.name', 'V3 Test');
  fs.writeFileSync(path.join(outside, 'tracked.txt'), 'base\n');
  git(outside, 'add', '.');
  git(outside, 'commit', '-m', 'outside base');
  const base = git(outside, 'rev-parse', 'HEAD');
  const redirect = path.join(allowedRoot, 'redirect');
  fs.symlinkSync(outside, redirect);

  const provisioner = new WorkspaceProvisioner({
    hostRoot: workspaceRoot,
    executionRoot: '/workspace',
    allowedRepositoryRoots: [allowedRoot],
  });

  try {
    await assert.rejects(
      provisioner.integrateBatch({
        planId: 'plan-outside',
        batchKey: 'batch-outside',
        repositoryPath: redirect,
        baseRevision: base,
        implementations: [],
      }),
      /V3_REPOSITORY_ROOT_NOT_ALLOWED/,
    );
    assert.equal(git(outside, 'rev-parse', 'HEAD'), base);
    assert.throws(
      () => git(outside, 'rev-parse', 'refs/ai-office/plans/plan-outside/batches/batch-outside'),
      /Command failed/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('batch integration durable refs encode unsafe identifiers without collisions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-integration-ref-'));
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
    const unsafe = await provisioner.integrateBatch({
      planId: 'plan/ref',
      batchKey: 'batch/a',
      repositoryPath: source,
      baseRevision: base,
      implementations: [],
    });
    const safe = await provisioner.integrateBatch({
      planId: 'plan_ref',
      batchKey: 'batch_a',
      repositoryPath: source,
      baseRevision: base,
      implementations: [],
    });

    assert.notEqual(unsafe.ref, safe.ref);
    assert.equal(safe.ref, 'refs/ai-office/plans/plan_ref/batches/batch_a');
    assert.match(unsafe.ref, /^refs\/ai-office\/plans\/%x[0-9a-f]+\/batches\/%x[0-9a-f]+$/);
    assert.equal(git(source, 'rev-parse', unsafe.ref), base);
    assert.equal(git(source, 'rev-parse', safe.ref), base);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('batch integration requires implementation sourceRevision to be an ancestor of HEAD', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-integration-source-ancestor-'));
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

  git(source, 'checkout', '-b', 'sibling-source');
  fs.writeFileSync(path.join(source, 'sibling.txt'), 'sibling\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'sibling source');
  const sibling = git(source, 'rev-parse', 'HEAD');
  git(source, 'checkout', '-B', 'main-test', base);

  const provisioner = new WorkspaceProvisioner({
    hostRoot: workspaceRoot,
    executionRoot: '/workspace',
    allowedRepositoryRoots: [root],
  });

  try {
    const implementation = await provisioner.provision({
      executionId: 'source-ancestor-implementation',
      repositoryPath: source,
      baseRevision: base,
      workspaceMode: 'isolated_write',
    });
    fs.writeFileSync(path.join(implementation.hostPath, 'implemented.txt'), 'implementation\n');
    git(implementation.hostPath, 'config', 'user.email', 'worker@example.invalid');
    git(implementation.hostPath, 'config', 'user.name', 'Worker');
    git(implementation.hostPath, 'add', '.');
    git(implementation.hostPath, 'commit', '-m', 'implementation');

    await assert.rejects(
      provisioner.integrateBatch({
        planId: 'plan-source-ancestor',
        batchKey: 'batch-1',
        repositoryPath: source,
        baseRevision: base,
        implementations: [
          { workspaceRef: implementation.executionPath, repositoryRoot: implementation.repositoryRoot, sourceRevision: sibling },
        ],
      }),
      /BATCH_INTEGRATION_SOURCE_NOT_ANCESTOR/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('batch integration disables worker-controlled fsmonitor configuration', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-integration-fsmonitor-'));
  const source = path.join(root, 'source');
  const workspaceRoot = path.join(root, 'workspaces');
  const marker = path.join(root, 'fsmonitor-executed.txt');
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
      executionId: 'fsmonitor-implementation',
      repositoryPath: source,
      baseRevision: base,
      workspaceMode: 'isolated_write',
    });
    fs.writeFileSync(path.join(implementation.hostPath, 'implemented.txt'), 'implementation\n');
    git(implementation.hostPath, 'config', 'user.email', 'worker@example.invalid');
    git(implementation.hostPath, 'config', 'user.name', 'Worker');
    git(implementation.hostPath, 'add', '.');
    git(implementation.hostPath, 'commit', '-m', 'implementation');

    const monitor = path.join(implementation.hostPath, '.git', 'malicious-fsmonitor.sh');
    fs.writeFileSync(
      monitor,
      `#!/bin/sh\nprintf 'executed\\n' > '${marker}'\nexit 0\n`,
      { mode: 0o755 },
    );
    git(implementation.hostPath, 'config', 'core.fsmonitor', monitor);

    const integrated = await provisioner.integrateBatch({
      planId: 'plan-fsmonitor',
      batchKey: 'batch-1',
      repositoryPath: source,
      baseRevision: base,
      implementations: [
        {
          workspaceRef: implementation.executionPath,
          repositoryRoot: implementation.repositoryRoot,
          sourceRevision: base,
        },
      ],
    });

    assert.equal(fs.existsSync(marker), false);
    assert.equal(git(source, 'show', `${integrated.revision}:implemented.txt`), 'implementation');
    assert.equal(git(source, 'rev-parse', 'HEAD'), base);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('batch integration rejects implementation provenance bound to another repository', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-integration-repository-binding-'));
  const target = path.join(root, 'target');
  const other = path.join(root, 'other');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.mkdirSync(target, { recursive: true });
  git(target, 'init');
  git(target, 'config', 'user.email', 'v3-test@example.invalid');
  git(target, 'config', 'user.name', 'V3 Test');
  fs.writeFileSync(path.join(target, 'tracked.txt'), 'base\n');
  git(target, 'add', '.');
  git(target, 'commit', '-m', 'shared base');
  const base = git(target, 'rev-parse', 'HEAD');
  git(target, 'clone', '--no-local', '.', other);
  git(other, 'config', 'user.email', 'worker@example.invalid');
  git(other, 'config', 'user.name', 'Worker');

  const provisioner = new WorkspaceProvisioner({
    hostRoot: workspaceRoot,
    executionRoot: '/workspace',
    allowedRepositoryRoots: [root],
  });

  try {
    const implementation = await provisioner.provision({
      executionId: 'other-repository-implementation',
      repositoryPath: other,
      baseRevision: base,
      workspaceMode: 'isolated_write',
    });
    fs.writeFileSync(path.join(implementation.hostPath, 'other.txt'), 'other repository change\n');
    git(implementation.hostPath, 'config', 'user.email', 'worker@example.invalid');
    git(implementation.hostPath, 'config', 'user.name', 'Worker');
    git(implementation.hostPath, 'add', '.');
    git(implementation.hostPath, 'commit', '-m', 'other repository implementation');

    await assert.rejects(
      provisioner.integrateBatch({
        planId: 'plan-repository-binding',
        batchKey: 'batch-1',
        repositoryPath: target,
        baseRevision: base,
        implementations: [
          {
            workspaceRef: implementation.executionPath,
            repositoryRoot: implementation.repositoryRoot,
            sourceRevision: base,
          },
        ],
      }),
      /BATCH_INTEGRATION_REPOSITORY_MISMATCH/,
    );
    assert.throws(
      () => git(target, 'rev-parse', 'refs/ai-office/plans/plan-repository-binding/batches/batch-1'),
      /Command failed/,
    );
  } finally {
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
          repositoryRoot: implementation.repositoryRoot,
          sourceRevision: implementation.sourceRevision,
        },
      ],
    });

    assert.equal(integrated.ref, 'refs/ai-office/plans/plan-1/batches/batch-1');
    assert.equal(git(source, 'rev-parse', integrated.ref), integrated.revision);
    assert.equal(git(source, 'rev-parse', 'HEAD'), base);
    assert.equal(fs.readFileSync(path.join(source, 'tracked.txt'), 'utf8'), 'base\n');
    assert.equal(git(source, 'show', `${integrated.revision}:tracked.txt`), 'implemented');
    assert.doesNotMatch(
      git(source, 'worktree', 'list', '--porcelain'),
      /hermes-ai-office-integrate-/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writer completion requires a clean commit that advances the durable execution baseline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-writer-completion-'));
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
      executionId: 'writer-implementation',
      repositoryPath: source,
      baseRevision: base,
      workspaceMode: 'isolated_write',
    });
    const prepared = await provisioner.prepareWriterExecution({
      executionId: 'writer-execution-1',
      workspaceRef: implementation.executionPath,
    });
    assert.equal(prepared.startRevision, base);

    await assert.rejects(
      provisioner.verifyWriterCompletion({
        executionId: 'writer-execution-1',
        workspaceRef: implementation.executionPath,
      }),
      /WRITER_COMPLETION_NO_COMMIT/,
    );

    fs.writeFileSync(path.join(implementation.hostPath, 'tracked.txt'), 'dirty\n');
    await assert.rejects(
      provisioner.verifyWriterCompletion({
        executionId: 'writer-execution-1',
        workspaceRef: implementation.executionPath,
      }),
      /WRITER_COMPLETION_DIRTY/,
    );

    git(implementation.hostPath, 'config', 'user.email', 'worker@example.invalid');
    git(implementation.hostPath, 'config', 'user.name', 'Worker');
    git(implementation.hostPath, 'add', 'tracked.txt');
    git(implementation.hostPath, 'commit', '-m', 'advance writer');
    const head = git(implementation.hostPath, 'rev-parse', 'HEAD');
    assert.notEqual(head, base);

    const verified = await provisioner.verifyWriterCompletion({
      executionId: 'writer-execution-1',
      workspaceRef: implementation.executionPath,
    });
    assert.deepEqual(verified, { startRevision: base, headRevision: head });

    // Re-preparing the same durable execution must never move the baseline forward.
    const preparedAgain = await provisioner.prepareWriterExecution({
      executionId: 'writer-execution-1',
      workspaceRef: implementation.executionPath,
    });
    assert.equal(preparedAgain.startRevision, base);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('batch integration classifies Git conflicts with conflict evidence for LLM repair', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-integration-conflict-'));
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
    const left = await provisioner.provision({
      executionId: 'left',
      repositoryPath: source,
      baseRevision: base,
      workspaceMode: 'isolated_write',
    });
    fs.writeFileSync(path.join(left.hostPath, 'tracked.txt'), 'left\n');
    git(left.hostPath, 'config', 'user.email', 'worker@example.invalid');
    git(left.hostPath, 'config', 'user.name', 'Worker');
    git(left.hostPath, 'add', 'tracked.txt');
    git(left.hostPath, 'commit', '-m', 'left change');

    const right = await provisioner.provision({
      executionId: 'right',
      repositoryPath: source,
      baseRevision: base,
      workspaceMode: 'isolated_write',
    });
    fs.writeFileSync(path.join(right.hostPath, 'tracked.txt'), 'right\n');
    git(right.hostPath, 'config', 'user.email', 'worker@example.invalid');
    git(right.hostPath, 'config', 'user.name', 'Worker');
    git(right.hostPath, 'add', 'tracked.txt');
    git(right.hostPath, 'commit', '-m', 'right change');

    await assert.rejects(
      provisioner.integrateBatch({
        planId: 'plan-conflict',
        batchKey: 'batch-1',
        repositoryPath: source,
        baseRevision: base,
        implementations: [
          { workspaceRef: left.executionPath, repositoryRoot: left.repositoryRoot, sourceRevision: base },
          { workspaceRef: right.executionPath, repositoryRoot: right.repositoryRoot, sourceRevision: base },
        ],
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /^BATCH_INTEGRATION_CONFLICT:/);
        assert.match(message, /CONFLICT/);
        assert.match(message, /tracked\.txt/);
        return true;
      },
    );
    assert.equal(git(source, 'rev-parse', 'HEAD'), base);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repaired batch integration rejects a repair head that drops an approved source revision', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-integration-ancestor-'));
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
    const approved = await provisioner.provision({
      executionId: 'approved',
      repositoryPath: source,
      baseRevision: base,
      workspaceMode: 'isolated_write',
    });
    fs.writeFileSync(path.join(approved.hostPath, 'approved.txt'), 'approved\n');
    git(approved.hostPath, 'config', 'user.email', 'worker@example.invalid');
    git(approved.hostPath, 'config', 'user.name', 'Worker');
    git(approved.hostPath, 'add', '.');
    git(approved.hostPath, 'commit', '-m', 'approved source');
    const approvedHead = git(approved.hostPath, 'rev-parse', 'HEAD');

    const incompleteRepair = await provisioner.provision({
      executionId: 'repair',
      repositoryPath: source,
      baseRevision: base,
      workspaceMode: 'isolated_write',
    });
    fs.writeFileSync(path.join(incompleteRepair.hostPath, 'repair.txt'), 'repair without source\n');
    git(incompleteRepair.hostPath, 'config', 'user.email', 'worker@example.invalid');
    git(incompleteRepair.hostPath, 'config', 'user.name', 'Worker');
    git(incompleteRepair.hostPath, 'add', '.');
    git(incompleteRepair.hostPath, 'commit', '-m', 'incomplete repair');

    await assert.rejects(
      provisioner.integrateBatch({
        planId: 'plan-repair',
        batchKey: 'batch-1',
        repositoryPath: source,
        baseRevision: base,
        implementations: [{ workspaceRef: incompleteRepair.executionPath, repositoryRoot: incompleteRepair.repositoryRoot, sourceRevision: base }],
        requiredAncestorRevisions: [approvedHead],
      }),
      /BATCH_INTEGRATION_REPAIR_INCOMPLETE/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('external progress discovery selects the descendant ref with the strongest durable-plan ticket evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-external-progress-'));
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

  git(source, 'checkout', '-b', 'external-short');
  fs.writeFileSync(path.join(source, 'tracked.txt'), 'task\n');
  git(source, 'commit', '-am', 'feat(task): external progress TASK-1001');

  git(source, 'checkout', '-b', 'external-continuation', base);
  fs.writeFileSync(path.join(source, 'tracked.txt'), 'goal\n');
  git(source, 'commit', '-am', 'feat(goal): external progress GOAL-2001');
  fs.writeFileSync(path.join(source, 'tracked.txt'), 'planner\n');
  git(source, 'commit', '-am', 'feat(planner): external progress PLAN-3001');
  const expected = git(source, 'rev-parse', 'HEAD');
  git(source, 'checkout', 'external-short');

  const provisioner = new WorkspaceProvisioner({
    hostRoot: workspaceRoot,
    executionRoot: '/workspace',
    allowedRepositoryRoots: [root],
  });

  try {
    const candidate = await provisioner.discoverExternalProgress?.({
      repositoryPath: source,
      currentRevision: base,
      workItemKeys: ['TASK-1001', 'GOAL-2001', 'PLAN-3001', 'OTHER-9999'],
    });
    assert.ok(candidate);
    assert.equal(candidate.revision, expected);
    assert.equal(candidate.ref, 'external-continuation');
    assert.equal(candidate.aheadBy, 2);
    assert.deepEqual(candidate.matchedWorkItemKeys.sort(), ['GOAL-2001', 'PLAN-3001']);
    assert.ok(candidate.commitSubjects.some((subject) => subject.includes('PLAN-3001')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('external handoff verification accepts only the exact committed descendant ref', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-handoff-'));
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

  git(source, 'checkout', '-b', 'agent-handoff');
  fs.writeFileSync(path.join(source, 'tracked.txt'), 'one\n');
  git(source, 'commit', '-am', 'feat: external handoff one');
  fs.writeFileSync(path.join(source, 'tracked.txt'), 'two\n');
  git(source, 'commit', '-am', 'feat: external handoff two');
  const head = git(source, 'rev-parse', 'HEAD');

  const provisioner = new WorkspaceProvisioner({
    hostRoot: workspaceRoot,
    executionRoot: '/workspace',
    allowedRepositoryRoots: [root],
  });

  try {
    const verified = await provisioner.verifyExternalHandoff?.({
      repositoryPath: source,
      baseRevision: base,
      headRevision: head,
      ref: 'agent-handoff',
    });
    assert.ok(verified);
    assert.equal(verified.baseRevision, base);
    assert.equal(verified.headRevision, head);
    assert.equal(verified.ref, 'agent-handoff');
    assert.equal(verified.aheadBy, 2);

    await assert.rejects(
      () =>
        provisioner.verifyExternalHandoff!({
          repositoryPath: source,
          baseRevision: head,
          headRevision: base,
          ref: 'agent-handoff',
        }),
      /HANDOFF_HEAD_NOT_DESCENDANT/,
    );

    git(source, 'branch', 'moved-ref', base);
    await assert.rejects(
      () =>
        provisioner.verifyExternalHandoff!({
          repositoryPath: source,
          baseRevision: base,
          headRevision: head,
          ref: 'moved-ref',
        }),
      /HANDOFF_REF_REVISION_MISMATCH/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace retention pruning removes only ignored artifacts and can release the execution directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-workspace-retention-'));
  const source = path.join(root, 'source');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.mkdirSync(source, { recursive: true });
  git(source, 'init');
  git(source, 'config', 'user.email', 'v3-test@example.invalid');
  git(source, 'config', 'user.name', 'V3 Test');
  fs.writeFileSync(path.join(source, '.gitignore'), 'node_modules/\n.cache/\n');
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
      executionId: 'retention-1',
      repositoryPath: source,
      baseRevision: base,
      workspaceMode: 'isolated_write',
    });
    fs.mkdirSync(path.join(implementation.hostPath, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(
      path.join(implementation.hostPath, 'node_modules', 'pkg', 'index.js'),
      'cache\n',
    );
    fs.mkdirSync(path.join(implementation.hostPath, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(implementation.hostPath, '.cache', 'state'), 'cache\n');
    fs.writeFileSync(path.join(implementation.hostPath, 'untracked.txt'), 'preserve me\n');
    const harnessPath = path.join(path.dirname(implementation.hostPath), '.agent-harness');
    fs.mkdirSync(path.join(harnessPath, 'home'), { recursive: true });
    fs.writeFileSync(path.join(harnessPath, 'home', 'cache'), 'execution cache\n');

    assert.equal(
      await provisioner.pruneExecutionArtifacts({
        executionId: 'retention-1',
        workspaceRef: implementation.executionPath,
      }),
      true,
    );
    assert.equal(fs.existsSync(path.join(implementation.hostPath, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(implementation.hostPath, '.cache')), false);
    assert.equal(
      fs.readFileSync(path.join(implementation.hostPath, 'untracked.txt'), 'utf8'),
      'preserve me\n',
    );
    assert.equal(
      fs.readFileSync(path.join(implementation.hostPath, 'tracked.txt'), 'utf8'),
      'base\n',
    );
    assert.equal(fs.existsSync(harnessPath), false);

    assert.equal(await provisioner.removeExecutionWorkspace('retention-1'), true);
    assert.equal(fs.existsSync(path.dirname(implementation.hostPath)), false);
    assert.equal(await provisioner.removeExecutionWorkspace('retention-1'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
