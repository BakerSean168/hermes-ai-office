import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  PLAN_LIMITS,
  WORKSPACE_GIT_LARGE_BUFFER_BYTES,
  WORKSPACE_GIT_MAX_BUFFER_BYTES,
  WORKSPACE_GIT_TIMEOUT_MS,
} from './planConstants.js';

const execFileAsync = promisify(execFile);

export interface UnixIdentity {
  uid: number;
  gid: number;
}

export function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function executionRefComponent(executionId: string): string {
  const safe = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/.test(executionId);
  if (!safe || executionId.endsWith('.lock')) throw new Error('V3_EXECUTION_ID_INVALID');
  return executionId;
}

export function writerBaselineRef(executionId: string): string {
  return `refs/ai-office/writers/${executionRefComponent(executionId)}/start`;
}

export function safeDirectory(directory: string): string[] {
  return [
    '-c',
    `safe.directory=${directory}`,
    '-c',
    `safe.directory=${path.join(directory, '.git')}`,
  ];
}

export async function git(
  cwd: string,
  args: string[],
  identity?: UnixIdentity,
): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      ...(identity ? { uid: identity.uid, gid: identity.gid } : {}),
      encoding: 'utf8',
      timeout: WORKSPACE_GIT_TIMEOUT_MS,
      maxBuffer: WORKSPACE_GIT_MAX_BUFFER_BYTES,
    });
    return result.stdout.trim();
  } catch (error) {
    const failure = error as Error & { stderr?: string; stdout?: string };
    const detail =
      [failure.stdout?.trim(), failure.stderr?.trim()].filter(Boolean).join('\n') ||
      failure.message;
    throw new Error(`GIT_COMMAND_FAILED:${detail.slice(0, PLAN_LIMITS.errorDetailCharacters)}`);
  }
}

export async function gitNullList(
  cwd: string,
  args: string[],
  identity?: UnixIdentity,
): Promise<string[]> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    ...(identity ? { uid: identity.uid, gid: identity.gid } : {}),
    encoding: 'utf8',
    timeout: WORKSPACE_GIT_TIMEOUT_MS,
    maxBuffer: WORKSPACE_GIT_LARGE_BUFFER_BYTES,
  });
  return result.stdout.split('\0').filter(Boolean);
}
