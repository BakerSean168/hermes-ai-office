#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const executionId = process.argv[2] ?? '';
const stateRoot = path.resolve(
  process.env.MODEL_CP_V4_ANTIGRAVITY_STATE_ROOT ??
    '/srv/hermes-personal/data/model-control-plane/antigravity-v4',
);
const workspaceRoot = path.resolve(
  process.env.MODEL_CP_V4_WORKSPACE_HOST_ROOT ?? '/opt/data/hermes-ai-office-v3/workspaces',
);
const canonicalHome = path.resolve(process.env.MODEL_CP_V4_ANTIGRAVITY_HOME ?? '/home/dev');
const canonicalBinary = path.resolve(
  process.env.MODEL_CP_V4_ANTIGRAVITY_BIN ?? '/home/dev/.local/bin/agy',
);
const canonicalWrapper = path.resolve(
  process.env.MODEL_CP_V4_ANTIGRAVITY_SANDBOX_WRAPPER ??
    '/home/dev/projects/pixel-agents/model-control-plane/scripts/run-antigravity-sandbox.sh',
);
const expectedUid = Number(process.env.MODEL_CP_V4_ANTIGRAVITY_UID ?? '1001');
const expectedGid = Number(process.env.MODEL_CP_V4_ANTIGRAVITY_GID ?? '1002');
const expectedWorkspaceGid = Number(process.env.MODEL_CP_V4_WORKSPACE_GID ?? '10001');
const expectedUser = process.env.MODEL_CP_V4_ANTIGRAVITY_USER ?? 'dev';
const allowedModels = new Set([
  'gemini-3.8-flash-high',
  'gemini-3.7-flash-high',
  'gemini-3.1-pro-high',
]);

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exit(2);
}

function inside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(executionId))
  fail('ANTIGRAVITY_UNIT_EXECUTION_ID_INVALID');
if (![expectedUid, expectedGid, expectedWorkspaceGid].every(Number.isSafeInteger))
  fail('ANTIGRAVITY_UNIT_IDENTITY_INVALID');

const executionDirectory = path.join(stateRoot, executionId);
const stateParent = fs.realpathSync(path.dirname(executionDirectory));
if (!inside(stateParent, stateRoot) || path.basename(executionDirectory) !== executionId)
  fail('ANTIGRAVITY_UNIT_STATE_PATH_INVALID');
const directoryStat = fs.lstatSync(executionDirectory, { throwIfNoEntry: false });
if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink())
  fail('ANTIGRAVITY_UNIT_STATE_DIRECTORY_INVALID');

const requestFile = path.join(executionDirectory, 'request.json');
const stdinFile = path.join(executionDirectory, 'stdin.ndjson');
const stdoutFile = path.join(executionDirectory, 'stdout.ndjson');
const stderrFile = path.join(executionDirectory, 'stderr.log');
const requestStat = fs.lstatSync(requestFile, { throwIfNoEntry: false });
const stdinStat = fs.lstatSync(stdinFile, { throwIfNoEntry: false });
if (
  !requestStat?.isFile() ||
  requestStat.isSymbolicLink() ||
  !stdinStat?.isFile() ||
  stdinStat.isSymbolicLink()
)
  fail('ANTIGRAVITY_UNIT_REQUEST_INVALID');
if ((requestStat.mode & 0o077) !== 0 || (stdinStat.mode & 0o077) !== 0)
  fail('ANTIGRAVITY_UNIT_REQUEST_PERMISSIONS_INVALID');

const request = record(JSON.parse(fs.readFileSync(requestFile, 'utf8')));
const workspace = path.resolve(String(request.workspace ?? ''));
const expectedWorkspace = path.join(workspaceRoot, 'v4', 'executions', executionId, 'repo');
const args = Array.isArray(request.args) ? request.args : [];
const modelIndex = args.indexOf('--model');
const model = modelIndex >= 0 ? args[modelIndex + 1] : undefined;
if (
  request.version !== 1 ||
  request.executionId !== executionId ||
  path.resolve(String(request.workspaceRoot ?? '')) !== workspaceRoot ||
  workspace !== expectedWorkspace ||
  !inside(workspace, workspaceRoot) ||
  path.resolve(String(request.home ?? '')) !== canonicalHome ||
  path.resolve(String(request.binary ?? '')) !== canonicalBinary ||
  path.resolve(String(request.sandboxWrapper ?? '')) !== canonicalWrapper ||
  request.uid !== expectedUid ||
  request.gid !== expectedGid ||
  request.workspaceGid !== expectedWorkspaceGid ||
  request.user !== expectedUser ||
  !args.every((value) => typeof value === 'string' && value.length <= 64_000) ||
  !args.includes('--input-format') ||
  !args.includes('stream-json') ||
  !args.includes('--output-format') ||
  !args.includes('--sandbox') ||
  !args.includes('--dangerously-skip-permissions') ||
  !allowedModels.has(model)
)
  fail('ANTIGRAVITY_UNIT_REQUEST_POLICY_INVALID');

const workspaceStat = fs.lstatSync(workspace, { throwIfNoEntry: false });
if (!workspaceStat?.isDirectory() || workspaceStat.isSymbolicLink())
  fail('ANTIGRAVITY_UNIT_WORKSPACE_INVALID');
if (fs.realpathSync(workspace) !== fs.realpathSync(expectedWorkspace))
  fail('ANTIGRAVITY_UNIT_WORKSPACE_PROVENANCE_INVALID');
for (const executable of ['/usr/bin/unshare', canonicalWrapper, canonicalBinary]) {
  fs.accessSync(executable, fs.constants.X_OK);
}

const stdinFd = fs.openSync(stdinFile, 'r');
const stdoutFd = fs.openSync(stdoutFile, 'a', 0o600);
const stderrFd = fs.openSync(stderrFile, 'a', 0o600);
const child = spawn(
  '/usr/bin/unshare',
  [
    '--mount',
    '--propagation',
    'private',
    '--pid',
    '--fork',
    '--kill-child=SIGKILL',
    '--mount-proc',
    '--',
    canonicalWrapper,
    '--workspace-root',
    workspaceRoot,
    '--workspace',
    workspace,
    '--home',
    canonicalHome,
    '--binary',
    canonicalBinary,
    '--uid',
    String(expectedUid),
    '--gid',
    String(expectedGid),
    '--workspace-gid',
    String(expectedWorkspaceGid),
    '--user',
    expectedUser,
    '--',
    ...args,
  ],
  {
    cwd: workspace,
    stdio: [stdinFd, stdoutFd, stderrFd],
    env: {
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: '/root',
      USER: 'root',
      LOGNAME: 'root',
      LANG: process.env.LANG ?? 'C.UTF-8',
      LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
      CI: '1',
      NO_COLOR: '1',
      TERM: 'dumb',
    },
  },
);
fs.closeSync(stdinFd);
fs.closeSync(stdoutFd);
fs.closeSync(stderrFd);

const forward = (signal) => {
  try {
    child.kill(signal);
  } catch {
    // systemd KillMode=control-group remains the final containment boundary.
  }
};
process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));
child.once('error', (error) => {
  fs.appendFileSync(stderrFile, `${error.message}\n`, { mode: 0o600 });
  process.exit(1);
});
child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
