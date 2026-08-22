import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveVSCodeExecutablePath } from './global-setup';

function createBundle(
  options: {
    executableName?: string;
    plistExecutable?: string;
    extraFiles?: string[];
  } = {},
): { root: string; requested: string; executable: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-bundle-'));
  const app = path.join(root, 'Visual Studio Code.app');
  const macos = path.join(app, 'Contents', 'MacOS');
  fs.mkdirSync(macos, { recursive: true });

  const executableName = options.executableName ?? 'Code';
  const executable = path.join(macos, executableName);
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(executable, 0o755);

  for (const name of options.extraFiles ?? []) {
    fs.writeFileSync(path.join(macos, name), 'fixture');
  }

  if (options.plistExecutable !== undefined) {
    fs.writeFileSync(
      path.join(app, 'Contents', 'Info.plist'),
      `<?xml version="1.0"?><plist><dict><key>CFBundleExecutable</key><string>${options.plistExecutable}</string></dict></plist>`,
    );
  }

  return {
    root,
    requested: path.join(macos, 'Electron'),
    executable,
  };
}

test('resolves renamed macOS VS Code executable from Info.plist', () => {
  const fixture = createBundle({ plistExecutable: 'Code' });
  try {
    assert.equal(resolveVSCodeExecutablePath(fixture.requested, 'darwin'), fixture.executable);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('falls back to the sole regular file in Contents/MacOS', () => {
  const fixture = createBundle();
  try {
    assert.equal(resolveVSCodeExecutablePath(fixture.requested, 'darwin'), fixture.executable);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects unsafe plist executable paths instead of escaping the bundle', () => {
  const fixture = createBundle({ plistExecutable: '../../outside', extraFiles: ['helper'] });
  try {
    assert.equal(resolveVSCodeExecutablePath(fixture.requested, 'darwin'), null);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('does not guess a replacement executable on non-macOS platforms', () => {
  const fixture = createBundle({ plistExecutable: 'Code' });
  try {
    assert.equal(resolveVSCodeExecutablePath(fixture.requested, 'linux'), null);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
