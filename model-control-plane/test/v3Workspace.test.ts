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
          { workspaceRef: left.executionPath, sourceRevision: base },
          { workspaceRef: right.executionPath, sourceRevision: base },
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
        implementations: [{ workspaceRef: incompleteRepair.executionPath, sourceRevision: base }],
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
