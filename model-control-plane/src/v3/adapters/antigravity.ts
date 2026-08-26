import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
  ExecutionHostCreateInput,
  ExecutionHostPort,
  ExecutionHostSnapshot,
} from '../ports.js';
import type { ExecutionFailure, UsageSummary } from '../types.js';

const execFileAsync = promisify(execFile);

interface JsonRecord {
  [key: string]: unknown;
}

interface AntigravityExecutionMeta {
  executionId: string;
  pid: number;
  model: string;
  phase: string;
  startedAt: string;
}

export interface AntigravityExecutionHostOptions {
  binary: string;
  stateRoot: string;
  workspaceHostRoot: string;
  workspaceExecutionRoot?: string;
  home: string;
  uid?: number;
  gid?: number;
  user?: string;
  printTimeout?: string;
  sandboxWrapper?: string;
}

const OUTPUT_TAIL_BYTES = 8 * 1024 * 1024;
const REVIEW_SCHEMA = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'INVALID'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          title: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['severity', 'title', 'evidence'],
      },
    },
  },
  required: ['verdict', 'summary', 'findings'],
});

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function safeId(value: string): string {
  if (!/^exec_[A-Za-z0-9._-]+$/.test(value)) throw new Error('ANTIGRAVITY_EXECUTION_ID_INVALID');
  return value;
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readTail(file: string): string {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size === 0) return '';
  const length = Math.min(stat.size, OUTPUT_TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, stat.size - length);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString('utf8');
}

function lastResult(file: string): JsonRecord | undefined {
  const lines = readTail(file)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    try {
      const event = asRecord(JSON.parse(line));
      if (event.event === 'result') return asRecord(event.result);
    } catch {
      // Ignore non-JSON diagnostic lines. Terminal state is derived only from a result event.
    }
  }
  return undefined;
}

function usage(result: JsonRecord): UsageSummary | null {
  const raw = asRecord(result.usage);
  if (Object.keys(raw).length === 0) return null;
  const number = (value: unknown): number => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    source: 'ANTIGRAVITY_REPORTED',
    input: number(raw.input_tokens),
    output: number(raw.output_tokens),
    cachedInput: number(raw.cache_read_tokens),
    cacheWrite: number(raw.cache_write_tokens),
    reasoningOutput: number(raw.thinking_tokens),
    calls: Number(result.num_turns ?? 1),
  };
}

function finalText(result: JsonRecord): string {
  const structured = asRecord(result.structured_output);
  const verdict = typeof structured.verdict === 'string' ? structured.verdict.trim() : '';
  if (verdict) {
    const summary = typeof structured.summary === 'string' ? structured.summary.trim() : '';
    const findings = Array.isArray(structured.findings) ? structured.findings.map(asRecord) : [];
    return [
      verdict,
      summary,
      ...findings.map((finding) => {
        const severity = String(finding.severity ?? 'P2').trim();
        const title = String(finding.title ?? 'Finding').trim();
        const evidence = String(finding.evidence ?? '').trim();
        return `- ${severity} ${title}${evidence ? `: ${evidence}` : ''}`;
      }),
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 50_000);
  }
  return String(result.response ?? '').trim().slice(0, 50_000);
}

function failureFromResult(result: JsonRecord): ExecutionFailure {
  const status = String(result.status ?? 'ERROR').toUpperCase();
  const detail = String(result.error ?? result.response ?? status)
    .replace(/(authorization\s*:\s*bearer\s+)[^\s'",}]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .slice(0, 2_000);
  return {
    code: `ANTIGRAVITY_${status}`,
    detail,
    retryable: ['ERROR', 'INTERRUPTED', 'RUNNING', 'WAITING'].includes(status),
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class AntigravityExecutionHost implements ExecutionHostPort {
  readonly #binary: string;
  readonly #stateRoot: string;
  readonly #workspaceHostRoot: string;
  readonly #workspaceExecutionRoot: string;
  readonly #home: string;
  readonly #uid?: number;
  readonly #gid?: number;
  readonly #user: string;
  readonly #printTimeout: string;
  readonly #sandboxWrapper?: string;

  constructor(options: AntigravityExecutionHostOptions) {
    this.#binary = path.resolve(options.binary);
    this.#stateRoot = path.resolve(options.stateRoot);
    this.#workspaceHostRoot = path.resolve(options.workspaceHostRoot);
    this.#workspaceExecutionRoot = path.posix.resolve(options.workspaceExecutionRoot ?? '/workspace');
    this.#home = path.resolve(options.home);
    this.#uid = options.uid;
    this.#gid = options.gid;
    this.#user = options.user ?? path.basename(this.#home);
    this.#printTimeout = options.printTimeout ?? '20m';
    this.#sandboxWrapper = options.sandboxWrapper ? path.resolve(options.sandboxWrapper) : undefined;
    if (this.#sandboxWrapper) {
      if (
        !Number.isInteger(this.#uid) ||
        !Number.isInteger(this.#gid) ||
        (this.#uid ?? 0) <= 0 ||
        (this.#gid ?? 0) <= 0
      ) {
        throw new Error('ANTIGRAVITY_SANDBOX_NON_ROOT_IDENTITY_REQUIRED');
      }
      const homeStat = fs.statSync(this.#home, { throwIfNoEntry: false });
      if (!homeStat?.isDirectory()) throw new Error('ANTIGRAVITY_SANDBOX_HOME_NOT_FOUND');
      if (homeStat.uid !== this.#uid || homeStat.gid !== this.#gid) {
        throw new Error('ANTIGRAVITY_SANDBOX_HOME_OWNER_MISMATCH');
      }
    }
    fs.mkdirSync(this.#stateRoot, { recursive: true, mode: 0o700 });
  }

  #executionDir(executionId: string): string {
    return path.join(this.#stateRoot, safeId(executionId));
  }

  #workspacePath(workspaceRef: string): string {
    const resolved = path.posix.resolve(workspaceRef);
    const relative = path.posix.relative(this.#workspaceExecutionRoot, resolved);
    if (relative === '' || relative.startsWith('..') || path.posix.isAbsolute(relative)) {
      throw new Error('ANTIGRAVITY_WORKSPACE_REF_NOT_ALLOWED');
    }
    const hostPath = path.resolve(this.#workspaceHostRoot, ...relative.split('/'));
    if (!inside(hostPath, this.#workspaceHostRoot)) {
      throw new Error('ANTIGRAVITY_WORKSPACE_REF_NOT_ALLOWED');
    }
    return hostPath;
  }

  #meta(executionId: string): AntigravityExecutionMeta {
    const file = path.join(this.#executionDir(executionId), 'meta.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as AntigravityExecutionMeta;
    return parsed;
  }

  async #grantNativeWriterAccess(cwd: string): Promise<void> {
    if (this.#gid == null) return;
    // OpenHands remains the owning UID. Reconcile the complete tree before every
    // native writer admission: checking only the root directory is insufficient
    // because OpenHands may have created nested files with its own primary GID
    // since the previous Antigravity run.
    await execFileAsync('/usr/bin/chgrp', ['-R', String(this.#gid), cwd], { timeout: 120_000 });
    await execFileAsync('/usr/bin/chmod', ['-R', 'g+rwX', cwd], { timeout: 120_000 });
  }

  async health(): Promise<'OK' | 'UNAVAILABLE'> {
    try {
      fs.accessSync(this.#binary, fs.constants.X_OK);
      fs.accessSync(this.#home, fs.constants.R_OK | fs.constants.X_OK);
      if (this.#sandboxWrapper) {
        fs.accessSync(this.#sandboxWrapper, fs.constants.X_OK);
        fs.accessSync('/usr/bin/unshare', fs.constants.X_OK);
      }
      return 'OK';
    } catch {
      return 'UNAVAILABLE';
    }
  }

  async createExecution(input: ExecutionHostCreateInput): Promise<ExecutionHostSnapshot> {
    if (input.selection.transportMode !== 'PROVIDER_NATIVE') {
      throw new Error('ANTIGRAVITY_PROVIDER_NATIVE_REQUIRED');
    }
    const executionId = safeId(input.executionId);
    const directory = this.#executionDir(executionId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const existingMeta = fs.statSync(path.join(directory, 'meta.json'), { throwIfNoEntry: false });
    if (existingMeta?.isFile()) return this.getExecution(`antigravity:${executionId}`);

    const cwd = this.#workspacePath(input.repositoryPath);
    const cwdStat = fs.statSync(cwd, { throwIfNoEntry: false });
    if (!cwdStat?.isDirectory()) throw new Error('ANTIGRAVITY_WORKSPACE_NOT_FOUND');
    if (input.phase !== 'VERIFY_REVIEW') await this.#grantNativeWriterAccess(cwd);

    const stdoutFile = path.join(directory, 'stdout.ndjson');
    const stderrFile = path.join(directory, 'stderr.log');
    const stdoutFd = fs.openSync(stdoutFile, 'a', 0o600);
    const stderrFd = fs.openSync(stderrFile, 'a', 0o600);
    const args = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      input.selection.modelClass,
      '--print-timeout',
      this.#printTimeout,
      '--dangerously-skip-permissions',
    ];
    if (input.phase === 'VERIFY_REVIEW') {
      args.push('--mode', 'plan', '--json-schema', REVIEW_SCHEMA);
    } else {
      args.push('--mode', 'accept-edits');
    }

    let command = this.#binary;
    let commandArgs = args;
    let spawnUid = this.#uid;
    let spawnGid = this.#gid;
    if (this.#sandboxWrapper) {
      if (this.#uid == null || this.#gid == null) throw new Error('ANTIGRAVITY_SANDBOX_IDENTITY_REQUIRED');
      command = '/usr/bin/unshare';
      commandArgs = [
        '--mount',
        '--propagation',
        'private',
        '--',
        this.#sandboxWrapper,
        '--workspace-root',
        this.#workspaceHostRoot,
        '--workspace',
        cwd,
        '--home',
        this.#home,
        '--binary',
        this.#binary,
        '--uid',
        String(this.#uid),
        '--gid',
        String(this.#gid),
        '--user',
        this.#user,
        '--',
        ...args,
      ];
      // The namespace setup needs mount privileges. The wrapper drops to the
      // configured native-agent identity before exec'ing Antigravity.
      spawnUid = undefined;
      spawnGid = undefined;
    }
    const child = spawn(command, commandArgs, {
      cwd,
      detached: true,
      stdio: ['pipe', stdoutFd, stderrFd],
      uid: spawnUid,
      gid: spawnGid,
      env: {
        PATH: '/home/dev/.local/bin:/usr/local/bin:/usr/bin:/bin',
        HOME: this.#home,
        USER: this.#user,
        LOGNAME: this.#user,
        LANG: process.env.LANG ?? 'C.UTF-8',
        LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
        CI: '1',
        NO_COLOR: '1',
        TERM: 'dumb',
        GIT_AUTHOR_NAME: 'Hermes Antigravity',
        GIT_AUTHOR_EMAIL: 'antigravity@localhost',
        GIT_COMMITTER_NAME: 'Hermes Antigravity',
        GIT_COMMITTER_EMAIL: 'antigravity@localhost',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: cwd,
      },
    });
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    if (!child.pid || !child.stdin) throw new Error('ANTIGRAVITY_PROCESS_START_FAILED');

    const startedAt = new Date().toISOString();
    const meta: AntigravityExecutionMeta = {
      executionId,
      pid: child.pid,
      model: input.selection.modelClass,
      phase: input.phase,
      startedAt,
    };
    fs.writeFileSync(path.join(directory, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
    const nativeObjective = [
      `Native execution workspace: ${cwd}`,
      'Keep all repository file inspection and terminal commands inside that exact workspace. Use /tmp only for disposable verification scratch. Do not search or inspect unrelated host paths.',
      '',
      input.objective,
    ].join('\n');
    const message = JSON.stringify({ event: 'user', message: { content: nativeObjective } });
    child.stdin.end(`${message}\n`);
    child.unref();

    return {
      conversationId: `antigravity:${executionId}`,
      status: 'RUNNING',
      startedAt,
      currentModelId: input.selection.modelClass,
      upstream: { provider: 'antigravity-cli', model: input.selection.modelClass },
    };
  }

  async getExecution(conversationId: string): Promise<ExecutionHostSnapshot> {
    if (!conversationId.startsWith('antigravity:')) throw new Error('ANTIGRAVITY_CONVERSATION_ID_INVALID');
    const executionId = safeId(conversationId.slice('antigravity:'.length));
    const directory = this.#executionDir(executionId);
    const meta = this.#meta(executionId);
    const cancelled = fs.existsSync(path.join(directory, 'cancelled'));
    if (cancelled) {
      return {
        conversationId,
        status: 'CANCELLED',
        startedAt: meta.startedAt,
        updatedAt: new Date().toISOString(),
        currentModelId: meta.model,
        upstream: { provider: 'antigravity-cli', model: meta.model },
      };
    }

    const result = lastResult(path.join(directory, 'stdout.ndjson'));
    if (result) {
      const status = String(result.status ?? '').toUpperCase();
      if (status === 'SUCCESS') {
        return {
          conversationId,
          status: 'SUCCEEDED',
          finalText: finalText(result),
          startedAt: meta.startedAt,
          updatedAt: new Date().toISOString(),
          usage: usage(result),
          currentModelId: meta.model,
          upstream: {
            provider: 'antigravity-cli',
            model: meta.model,
            conversationId: result.conversation_id,
          },
        };
      }
      if (status === 'CANCELED' || status === 'CANCELLED') {
        return {
          conversationId,
          status: 'CANCELLED',
          startedAt: meta.startedAt,
          updatedAt: new Date().toISOString(),
          usage: usage(result),
          currentModelId: meta.model,
          upstream: { provider: 'antigravity-cli', model: meta.model },
        };
      }
      return {
        conversationId,
        status: 'FAILED',
        error: failureFromResult(result),
        startedAt: meta.startedAt,
        updatedAt: new Date().toISOString(),
        usage: usage(result),
        currentModelId: meta.model,
        upstream: { provider: 'antigravity-cli', model: meta.model },
      };
    }

    if (isAlive(meta.pid)) {
      return {
        conversationId,
        status: 'RUNNING',
        startedAt: meta.startedAt,
        updatedAt: new Date().toISOString(),
        currentModelId: meta.model,
        upstream: { provider: 'antigravity-cli', model: meta.model },
      };
    }

    return {
      conversationId,
      status: 'FAILED',
      error: {
        code: 'ANTIGRAVITY_PROCESS_LOST',
        detail: readTail(path.join(directory, 'stderr.log')).slice(-2_000),
        retryable: true,
      },
      startedAt: meta.startedAt,
      updatedAt: new Date().toISOString(),
      currentModelId: meta.model,
      upstream: { provider: 'antigravity-cli', model: meta.model },
    };
  }

  async cancelExecution(conversationId: string): Promise<ExecutionHostSnapshot> {
    if (!conversationId.startsWith('antigravity:')) throw new Error('ANTIGRAVITY_CONVERSATION_ID_INVALID');
    const executionId = safeId(conversationId.slice('antigravity:'.length));
    const directory = this.#executionDir(executionId);
    const meta = this.#meta(executionId);
    fs.writeFileSync(path.join(directory, 'cancelled'), new Date().toISOString(), { mode: 0o600 });
    if (isAlive(meta.pid)) {
      try {
        process.kill(-meta.pid, 'SIGTERM');
      } catch {
        try {
          process.kill(meta.pid, 'SIGTERM');
        } catch {
          // A concurrent exit is equivalent to cancellation from product state.
        }
      }
    }
    return this.getExecution(conversationId);
  }
}
