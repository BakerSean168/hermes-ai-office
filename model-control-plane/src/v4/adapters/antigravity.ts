import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { V4Error, failClosed } from '../domain/errors.js';
import type { ResourceObservation } from '../domain/resource.js';
import type {
  ExecutionProviderPort,
  ProviderLaunchInput,
  ProviderRecoveryInput,
  ProviderSessionSnapshot,
  ProviderSessionStatus,
  ReviewProviderPort,
  TestCommandEvidence,
} from '../orchestration/contracts.js';

export interface AntiGravityProbe {
  probe(): ResourceObservation;
}

export class AntiGravityReadinessAdapter {
  constructor(readonly probeClient?: AntiGravityProbe) {}

  observe(resourceId = 'antigravity'): ResourceObservation {
    const observation = this.probeClient?.probe() ?? {
      resourceId,
      kind: 'NATIVE_MACHINE' as const,
      status: 'UNCONFIGURED' as const,
      capabilities: [],
      observedAt: new Date().toISOString(),
    };
    return { ...observation, resourceId };
  }

  requireReady(resourceId = 'antigravity'): ResourceObservation {
    const observation = this.observe(resourceId);
    if (observation.status !== 'AVAILABLE')
      throw new V4Error(
        'RESOURCE_NOT_READY',
        'Anti-Gravity is not available: ' + observation.status,
      );
    return observation;
  }
}

interface JsonRecord {
  [key: string]: unknown;
}

interface AntigravityExecutionMeta {
  version: 1;
  executionId: string;
  providerSessionId: string;
  pid?: number;
  systemdUnit?: string;
  model: string;
  role: 'IMPLEMENTATION' | 'REVIEW';
  phase: ProviderLaunchInput['phase'];
  sourceRevision: string;
  workspaceHostPath: string;
  evidenceHostPath: string;
  startedAt: string;
}

export interface AntigravityProviderOptions {
  binary: string;
  stateRoot: string;
  workspaceHostRoot: string;
  home: string;
  uid: number;
  gid: number;
  workspaceGid: number;
  user?: string;
  printTimeout?: string;
  sandboxWrapper: string;
  launcherBinary?: string;
  systemdUnitTemplate?: string;
  systemctlBinary?: string;
  model: string;
}

const OUTPUT_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_FINAL_TEXT = 64_000;
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

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function safeId(value: string): string {
  failClosed(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value), 'ANTIGRAVITY_EXECUTION_ID_INVALID');
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

function events(file: string): JsonRecord[] {
  return readTail(file)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [record(JSON.parse(line))];
      } catch {
        return [];
      }
    });
}

function lastResult(file: string): JsonRecord | undefined {
  for (const event of events(file).reverse()) {
    if (event.event === 'result') return record(event.result);
  }
  return undefined;
}

function sanitize(value: unknown, maximum = MAX_FINAL_TEXT): string {
  return String(value ?? '')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s'",}]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(
      /(api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]',
    )
    .slice(0, maximum);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function requiredText(value: unknown, code: string, maximum = 8_000): string {
  failClosed(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum, code);
  return value.trim();
}

function number(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function commandEvidence(stdoutFile: string): TestCommandEvidence[] {
  const result: TestCommandEvidence[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const item = value as JsonRecord;
    const command =
      typeof item.command === 'string'
        ? item.command.trim()
        : typeof item.cmd === 'string'
          ? item.cmd.trim()
          : '';
    const exitCode = number(item.exit_code ?? item.exitCode);
    if (command && exitCode !== undefined && Number.isInteger(exitCode)) {
      const key = command + '\u0000' + String(exitCode);
      if (!seen.has(key) && result.length < 20) {
        seen.add(key);
        result.push({
          command: command.slice(0, 4_000),
          status: exitCode === 0 ? 'PASS' : 'FAIL',
          exitCode,
          summary: sanitize(
            item.output ?? item.stdout ?? item.result ?? `command exited ${exitCode}`,
            4_000,
          ),
        });
      }
    }
    Object.values(item).forEach(visit);
  };
  events(stdoutFile).forEach(visit);
  return result;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('/usr/bin/git', ['-c', `safe.directory=${cwd}`, '-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        GIT_OPTIONAL_LOCKS: '0',
      },
    }).trim();
  } catch (error) {
    throw new V4Error(
      'ANTIGRAVITY_GIT_VERIFICATION_FAILED',
      sanitize(error instanceof Error ? error.message : error, 2_000),
    );
  }
}

function atomicJson(target: string, value: unknown): void {
  const parent = path.dirname(target);
  const temporary = path.join(
    parent,
    '.' + path.basename(target) + '.tmp-' + process.pid + '-' + Date.now(),
  );
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, target);
}

abstract class AntigravityProviderBase implements ExecutionProviderPort {
  abstract readonly provider: string;
  protected abstract readonly role: 'IMPLEMENTATION' | 'REVIEW';
  readonly binary: string;
  readonly stateRoot: string;
  readonly workspaceHostRoot: string;
  readonly home: string;
  readonly uid: number;
  readonly gid: number;
  readonly workspaceGid: number;
  readonly user: string;
  readonly printTimeout: string;
  readonly sandboxWrapper: string;
  readonly launcherBinary: string;
  readonly systemdUnitTemplate?: string;
  readonly systemctlBinary: string;
  readonly model: string;

  constructor(options: AntigravityProviderOptions) {
    this.binary = path.resolve(options.binary);
    this.stateRoot = path.resolve(options.stateRoot);
    this.workspaceHostRoot = path.resolve(options.workspaceHostRoot);
    this.home = path.resolve(options.home);
    this.uid = options.uid;
    this.gid = options.gid;
    this.workspaceGid = options.workspaceGid;
    this.user = options.user ?? path.basename(this.home);
    this.printTimeout = options.printTimeout ?? '20m';
    this.sandboxWrapper = path.resolve(options.sandboxWrapper);
    this.launcherBinary = path.resolve(options.launcherBinary ?? '/usr/bin/unshare');
    this.systemdUnitTemplate = options.systemdUnitTemplate?.trim() || undefined;
    this.systemctlBinary = path.resolve(options.systemctlBinary ?? '/usr/bin/systemctl');
    this.model = requiredText(options.model, 'ANTIGRAVITY_MODEL_REQUIRED', 500);
    fs.mkdirSync(this.stateRoot, { recursive: true, mode: 0o700 });
  }

  health(): 'OK' | 'UNAVAILABLE' {
    try {
      fs.accessSync(this.binary, fs.constants.X_OK);
      fs.accessSync(this.sandboxWrapper, fs.constants.X_OK);
      fs.accessSync(this.home, fs.constants.R_OK | fs.constants.X_OK);
      fs.accessSync(
        this.systemdUnitTemplate ? this.systemctlBinary : this.launcherBinary,
        fs.constants.X_OK,
      );
      return 'OK';
    } catch {
      return 'UNAVAILABLE';
    }
  }

  async launch(input: ProviderLaunchInput): Promise<ProviderSessionSnapshot> {
    this.validateInput(input);
    const executionId = safeId(input.executionId);
    const directory = this.executionDirectory(executionId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.statSync(path.join(directory, 'meta.json'), { throwIfNoEntry: false })?.isFile())
      return await this.inspect(this.providerSessionId(executionId));
    if (this.health() !== 'OK') throw new V4Error('ANTIGRAVITY_UNAVAILABLE');

    const workspace = path.resolve(input.workspace.hostPath);
    if (!inside(workspace, this.workspaceHostRoot))
      throw new V4Error('ANTIGRAVITY_WORKSPACE_NOT_ALLOWED');
    if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory())
      throw new V4Error('ANTIGRAVITY_WORKSPACE_NOT_FOUND');
    if (path.resolve(input.workspace.evidenceHostPath).startsWith(workspace + path.sep))
      throw new V4Error('ANTIGRAVITY_EVIDENCE_PATH_INVALID');

    if (this.role === 'IMPLEMENTATION') this.grantWriterAccess(workspace);

    const stdoutFile = path.join(directory, 'stdout.ndjson');
    const stderrFile = path.join(directory, 'stderr.log');
    fs.closeSync(fs.openSync(stdoutFile, 'a', 0o600));
    fs.closeSync(fs.openSync(stderrFile, 'a', 0o600));
    const args = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      this.model,
      '--print-timeout',
      this.printTimeout,
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '--sandbox',
      '--mode',
      this.role === 'REVIEW' ? 'plan' : 'accept-edits',
    ];
    if (this.role === 'REVIEW') args.push('--json-schema', REVIEW_SCHEMA);
    const prompt =
      JSON.stringify({ event: 'user', message: { content: this.prompt(input, workspace) } }) + '\n';
    const startedAt = new Date().toISOString();
    const providerSessionId = this.providerSessionId(executionId);

    if (this.systemdUnitTemplate) {
      const systemdUnit = this.systemdUnit(executionId);
      const meta: AntigravityExecutionMeta = {
        version: 1,
        executionId,
        providerSessionId,
        systemdUnit,
        model: this.model,
        role: this.role,
        phase: input.phase,
        sourceRevision: input.sourceRevision,
        workspaceHostPath: workspace,
        evidenceHostPath: path.resolve(input.workspace.evidenceHostPath),
        startedAt,
      };
      atomicJson(path.join(directory, 'meta.json'), meta);
      atomicJson(path.join(directory, 'request.json'), {
        version: 1,
        executionId,
        workspaceRoot: this.workspaceHostRoot,
        workspace,
        home: this.home,
        binary: this.binary,
        sandboxWrapper: this.sandboxWrapper,
        uid: this.uid,
        gid: this.gid,
        workspaceGid: this.workspaceGid,
        user: this.user,
        args,
      });
      fs.writeFileSync(path.join(directory, 'stdin.ndjson'), prompt, { mode: 0o600 });
      try {
        execFileSync(this.systemctlBinary, ['start', systemdUnit], {
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
        });
      } catch (error) {
        fs.rmSync(path.join(directory, 'meta.json'), { force: true });
        throw new V4Error(
          'ANTIGRAVITY_SYSTEMD_START_FAILED',
          sanitize(error instanceof Error ? error.message : error, 2_000),
        );
      }
      return this.snapshot(meta, 'RUNNING', startedAt);
    }

    const stdoutFd = fs.openSync(stdoutFile, 'a', 0o600);
    const stderrFd = fs.openSync(stderrFile, 'a', 0o600);
    const child = spawn(
      this.launcherBinary,
      [
        '--mount',
        '--propagation',
        'private',
        '--pid',
        '--fork',
        '--kill-child=SIGKILL',
        '--mount-proc',
        '--',
        this.sandboxWrapper,
        '--workspace-root',
        this.workspaceHostRoot,
        '--workspace',
        workspace,
        '--home',
        this.home,
        '--binary',
        this.binary,
        '--uid',
        String(this.uid),
        '--gid',
        String(this.gid),
        '--workspace-gid',
        String(this.workspaceGid),
        '--user',
        this.user,
        '--',
        ...args,
      ],
      {
        cwd: workspace,
        detached: true,
        stdio: ['pipe', stdoutFd, stderrFd],
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
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    if (!child.pid || !child.stdin) throw new V4Error('ANTIGRAVITY_PROCESS_START_FAILED');
    const meta: AntigravityExecutionMeta = {
      version: 1,
      executionId,
      providerSessionId,
      pid: child.pid,
      model: this.model,
      role: this.role,
      phase: input.phase,
      sourceRevision: input.sourceRevision,
      workspaceHostPath: workspace,
      evidenceHostPath: path.resolve(input.workspace.evidenceHostPath),
      startedAt,
    };
    atomicJson(path.join(directory, 'meta.json'), meta);
    child.stdin.end(prompt);
    child.unref();
    return this.snapshot(meta, 'RUNNING', startedAt);
  }

  async recover(input: ProviderRecoveryInput): Promise<ProviderSessionSnapshot | undefined> {
    const executionId = safeId(input.executionId);
    if (
      !fs
        .statSync(path.join(this.executionDirectory(executionId), 'meta.json'), {
          throwIfNoEntry: false,
        })
        ?.isFile()
    )
      return undefined;
    return await this.inspect(this.providerSessionId(executionId));
  }

  async inspect(providerSessionId: string): Promise<ProviderSessionSnapshot> {
    const executionId = this.executionId(providerSessionId);
    const directory = this.executionDirectory(executionId);
    const meta = this.meta(executionId);
    if (fs.existsSync(path.join(directory, 'cancelled')))
      return this.snapshot(meta, 'CANCELLED', new Date().toISOString());

    const result = lastResult(path.join(directory, 'stdout.ndjson'));
    if (result) {
      const status = String(result.status ?? '').toUpperCase();
      if (status === 'SUCCESS') {
        try {
          this.materializeEvidence(meta, result, path.join(directory, 'stdout.ndjson'));
          return this.snapshot(meta, 'SUCCEEDED', new Date().toISOString(), this.finalText(result));
        } catch (error) {
          return this.snapshot(
            meta,
            'FAILED',
            new Date().toISOString(),
            sanitize(error instanceof Error ? error.message : error),
            error instanceof V4Error ? error.code : 'ANTIGRAVITY_EVIDENCE_FAILED',
            true,
          );
        }
      }
      if (status === 'CANCELED' || status === 'CANCELLED')
        return this.snapshot(meta, 'CANCELLED', new Date().toISOString());
      return this.snapshot(
        meta,
        'FAILED',
        new Date().toISOString(),
        sanitize(result.error ?? result.response ?? status),
        'ANTIGRAVITY_' + (status || 'ERROR'),
        ['ERROR', 'INTERRUPTED', 'RUNNING', 'WAITING'].includes(status),
      );
    }
    if (meta.systemdUnit) {
      const state = this.systemdState(meta.systemdUnit);
      if (
        state.active === 'active' ||
        state.active === 'activating' ||
        state.active === 'reloading'
      )
        return this.snapshot(meta, 'RUNNING', new Date().toISOString());
      return this.snapshot(
        meta,
        'FAILED',
        new Date().toISOString(),
        sanitize(
          [state.result, state.status, readTail(path.join(directory, 'stderr.log')).slice(-2_000)]
            .filter(Boolean)
            .join(' '),
        ),
        'ANTIGRAVITY_SYSTEMD_' + String(state.result || state.active || 'LOST').toUpperCase(),
        true,
      );
    }
    if (meta.pid && isAlive(meta.pid))
      return this.snapshot(meta, 'RUNNING', new Date().toISOString());
    return this.snapshot(
      meta,
      'FAILED',
      new Date().toISOString(),
      sanitize(readTail(path.join(directory, 'stderr.log')).slice(-2_000)),
      'ANTIGRAVITY_PROCESS_LOST',
      true,
    );
  }

  async cancel(providerSessionId: string): Promise<ProviderSessionSnapshot> {
    const executionId = this.executionId(providerSessionId);
    const directory = this.executionDirectory(executionId);
    const meta = this.meta(executionId);
    fs.writeFileSync(path.join(directory, 'cancelled'), new Date().toISOString(), { mode: 0o600 });
    if (meta.systemdUnit) {
      try {
        execFileSync(this.systemctlBinary, ['stop', meta.systemdUnit], {
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
        });
      } catch {
        // A concurrently completed unit is already cancelled for V4 purposes.
      }
    } else if (meta.pid && isAlive(meta.pid)) {
      try {
        process.kill(-meta.pid, 'SIGTERM');
      } catch {
        try {
          process.kill(meta.pid, 'SIGTERM');
        } catch {
          // A concurrent exit is equivalent to cancellation.
        }
      }
    }
    return this.snapshot(meta, 'CANCELLED', new Date().toISOString());
  }

  async interrupt(providerSessionId: string): Promise<ProviderSessionSnapshot> {
    return await this.cancel(providerSessionId);
  }

  private validateInput(input: ProviderLaunchInput): void {
    if (this.role === 'REVIEW' && input.phase !== 'REVIEW')
      throw new V4Error('ANTIGRAVITY_REVIEW_PHASE_REQUIRED');
    if (this.role === 'IMPLEMENTATION' && input.phase === 'REVIEW')
      throw new V4Error('ANTIGRAVITY_IMPLEMENTATION_PHASE_REQUIRED');
    requiredText(input.executionId, 'EXECUTION_ID_REQUIRED', 200);
    requiredText(input.sourceRevision, 'EXECUTION_SOURCE_REVISION_REQUIRED', 200);
  }

  private grantWriterAccess(workspace: string): void {
    const stat = fs.statSync(workspace);
    if (stat.gid === this.workspaceGid && (stat.mode & 0o030) === 0o030) return;
    execFileSync('/usr/bin/chgrp', ['-R', String(this.workspaceGid), workspace], {
      timeout: 120_000,
    });
    execFileSync('/usr/bin/chmod', ['-R', 'g+rwX', workspace], { timeout: 120_000 });
  }

  private prompt(input: ProviderLaunchInput, workspace: string): string {
    const acceptance = input.acceptanceCriteria.length
      ? ['Acceptance criteria:', ...input.acceptanceCriteria.map((item) => '- ' + item)]
      : [];
    const common = [
      'Pixel Agent V4 provider-native Antigravity execution.',
      'Execution: ' + input.executionId,
      'Workspace: ' + workspace,
      'Exact source revision: ' + input.sourceRevision,
      '',
      'Objective:',
      input.objective.trim(),
      '',
      ...acceptance,
    ];
    if (this.role === 'REVIEW') {
      return [
        ...common,
        '',
        'Review rules:',
        '- Independently inspect this exact repository snapshot and run at least one focused verification command.',
        '- Keep every tracked repository file unchanged.',
        '- Return PASS only when the exact revision satisfies the objective and your checks pass.',
        '- Return FAIL for concrete implementation defects and INVALID only when evidence cannot be evaluated.',
        '- Use the required structured JSON schema. The outer controller writes completion evidence.',
      ].join('\n');
    }
    return [
      ...common,
      '',
      'Implementation rules:',
      '- Work directly in the current repository and complete the objective, not merely analyze it.',
      '- Inspect repository instructions and preserve contracts outside scope.',
      '- Run focused verification and the appropriate wider checks.',
      '- Commit every intended tracked change with a concise conventional commit and leave git status clean.',
      '- Do not write completion-evidence.json; the outer controller validates the result and writes it.',
      '- Finish only after implementation, checks, commit, and clean-status verification are complete.',
    ].join('\n');
  }

  private materializeEvidence(
    meta: AntigravityExecutionMeta,
    result: JsonRecord,
    stdoutFile: string,
  ): void {
    const clean = git(meta.workspaceHostPath, ['status', '--porcelain=v1', '-z']).length === 0;
    if (!clean) throw new V4Error('ANTIGRAVITY_WORKSPACE_DIRTY');
    const head = git(meta.workspaceHostPath, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const checks = commandEvidence(stdoutFile);
    const diffCheckArgs =
      head === meta.sourceRevision
        ? ['diff', '--check', 'HEAD']
        : ['diff', '--check', meta.sourceRevision + '..' + head];
    git(meta.workspaceHostPath, diffCheckArgs);
    if (!checks.some((item) => item.status === 'PASS'))
      checks.push({
        command: 'git ' + diffCheckArgs.join(' '),
        status: 'PASS',
        exitCode: 0,
        summary: 'Git diff integrity check passed.',
      });
    if (checks.some((item) => item.status === 'FAIL'))
      throw new V4Error('ANTIGRAVITY_CHECK_FAILED');

    if (meta.role === 'IMPLEMENTATION') {
      atomicJson(meta.evidenceHostPath, {
        version: 1,
        executionId: meta.executionId,
        phase: meta.phase,
        sourceRevision: meta.sourceRevision,
        resultRevision: head,
        outcome: head === meta.sourceRevision ? 'SATISFIED' : 'CHANGED',
        summary:
          this.finalText(result) ||
          (head === meta.sourceRevision
            ? 'The exact source revision already satisfies the bounded objective.'
            : 'Antigravity completed and committed the bounded implementation.'),
        tests: checks,
      });
      return;
    }

    const structured = record(result.structured_output);
    const verdict = structured.verdict;
    if (verdict !== 'PASS' && verdict !== 'FAIL' && verdict !== 'INVALID')
      throw new V4Error('ANTIGRAVITY_REVIEW_VERDICT_INVALID');
    const findings = Array.isArray(structured.findings)
      ? structured.findings.map((finding) => {
          const value = record(finding);
          const severity = ['P0', 'P1', 'P2', 'P3'].includes(String(value.severity))
            ? String(value.severity)
            : 'P2';
          const title = requiredText(value.title ?? 'Finding', 'ANTIGRAVITY_REVIEW_TITLE_INVALID');
          const evidence = typeof value.evidence === 'string' ? value.evidence.trim() : '';
          return `[${severity}] ${title}${evidence ? ` — ${evidence}` : ''}`.slice(0, 8_000);
        })
      : [];
    if (verdict !== 'PASS' && findings.length === 0)
      findings.push(
        verdict === 'INVALID'
          ? '[P2] Review evidence could not be evaluated.'
          : '[P2] Antigravity reported a blocking review result.',
      );
    atomicJson(meta.evidenceHostPath, {
      version: 1,
      executionId: meta.executionId,
      phase: 'REVIEW',
      reviewedSha: meta.sourceRevision,
      verdict,
      findings,
      checks,
      summary: requiredText(
        structured.summary ?? this.finalText(result) ?? verdict,
        'ANTIGRAVITY_REVIEW_SUMMARY_INVALID',
      ),
    });
  }

  private finalText(result: JsonRecord): string {
    const structured = record(result.structured_output);
    if (typeof structured.verdict === 'string') {
      const findings = Array.isArray(structured.findings) ? structured.findings.map(record) : [];
      return [
        structured.verdict,
        typeof structured.summary === 'string' ? structured.summary.trim() : '',
        ...findings.map((finding) => {
          const severity = String(finding.severity ?? 'P2').trim();
          const title = String(finding.title ?? 'Finding').trim();
          const evidence = String(finding.evidence ?? '').trim();
          return `- ${severity} ${title}${evidence ? `: ${evidence}` : ''}`;
        }),
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, MAX_FINAL_TEXT);
    }
    return sanitize(result.response, MAX_FINAL_TEXT).trim();
  }

  private snapshot(
    meta: AntigravityExecutionMeta,
    status: ProviderSessionStatus,
    observedAt: string,
    finalResponse?: string,
    errorCode?: string,
    retryable?: boolean,
  ): ProviderSessionSnapshot {
    return {
      provider: this.provider,
      providerSessionId: meta.providerSessionId,
      status,
      ...(finalResponse ? { finalResponse: sanitize(finalResponse) } : {}),
      ...(errorCode ? { errorCode: sanitize(errorCode, 500) } : {}),
      ...(retryable === undefined ? {} : { retryable }),
      observedAt,
    };
  }

  private systemdUnit(executionId: string): string {
    const template = requiredText(
      this.systemdUnitTemplate,
      'ANTIGRAVITY_SYSTEMD_TEMPLATE_INVALID',
      300,
    );
    if (!template.includes('%i')) throw new V4Error('ANTIGRAVITY_SYSTEMD_TEMPLATE_INVALID');
    const unit = template.replaceAll('%i', safeId(executionId));
    if (!/^[A-Za-z0-9_.@-]+\.service$/.test(unit))
      throw new V4Error('ANTIGRAVITY_SYSTEMD_UNIT_INVALID');
    return unit;
  }

  private systemdState(unit: string): { active: string; result: string; status: string } {
    try {
      const output = execFileSync(
        this.systemctlBinary,
        ['show', unit, '-p', 'ActiveState', '-p', 'Result', '-p', 'ExecMainStatus'],
        {
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
          env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
        },
      );
      const values = Object.fromEntries(
        output
          .split(/\r?\n/)
          .filter((line) => line.includes('='))
          .map((line) => line.split('=', 2) as [string, string]),
      );
      return {
        active: values.ActiveState ?? 'unknown',
        result: values.Result ?? '',
        status: values.ExecMainStatus ?? '',
      };
    } catch {
      return { active: 'unknown', result: 'query-failed', status: '' };
    }
  }

  private providerSessionId(executionId: string): string {
    return 'antigravity:' + executionId;
  }

  private executionId(providerSessionId: string): string {
    if (!providerSessionId.startsWith('antigravity:'))
      throw new V4Error('ANTIGRAVITY_SESSION_ID_INVALID');
    return safeId(providerSessionId.slice('antigravity:'.length));
  }

  private executionDirectory(executionId: string): string {
    return path.join(this.stateRoot, safeId(executionId));
  }

  private meta(executionId: string): AntigravityExecutionMeta {
    const value = record(
      JSON.parse(
        fs.readFileSync(path.join(this.executionDirectory(executionId), 'meta.json'), 'utf8'),
      ),
    );
    const pid = value.pid === undefined ? undefined : number(value.pid);
    const systemdUnit =
      typeof value.systemdUnit === 'string' && value.systemdUnit.trim()
        ? value.systemdUnit.trim()
        : undefined;
    const workspaceHostPath = path.resolve(
      requiredText(value.workspaceHostPath, 'ANTIGRAVITY_META_INVALID'),
    );
    const evidenceHostPath = path.resolve(
      requiredText(value.evidenceHostPath, 'ANTIGRAVITY_META_INVALID'),
    );
    if (
      value.version !== 1 ||
      value.executionId !== executionId ||
      value.providerSessionId !== this.providerSessionId(executionId) ||
      ((pid === undefined || !Number.isInteger(pid) || pid <= 0) && !systemdUnit) ||
      (pid !== undefined && systemdUnit !== undefined) ||
      (systemdUnit !== undefined && !/^[A-Za-z0-9_.@-]+\.service$/.test(systemdUnit)) ||
      (value.role !== 'IMPLEMENTATION' && value.role !== 'REVIEW') ||
      !inside(workspaceHostPath, this.workspaceHostRoot) ||
      !inside(evidenceHostPath, this.workspaceHostRoot) ||
      path.dirname(evidenceHostPath) !== path.dirname(workspaceHostPath) ||
      path.basename(evidenceHostPath) !== 'completion-evidence.json' ||
      typeof value.startedAt !== 'string' ||
      Number.isNaN(Date.parse(value.startedAt))
    ) {
      throw new V4Error('ANTIGRAVITY_META_INVALID');
    }
    return {
      version: 1,
      executionId,
      providerSessionId: this.providerSessionId(executionId),
      ...(pid === undefined ? {} : { pid }),
      ...(systemdUnit === undefined ? {} : { systemdUnit }),
      model: requiredText(value.model, 'ANTIGRAVITY_META_INVALID', 500),
      role: value.role,
      phase: requiredText(
        value.phase,
        'ANTIGRAVITY_META_INVALID',
        100,
      ) as ProviderLaunchInput['phase'],
      sourceRevision: requiredText(value.sourceRevision, 'ANTIGRAVITY_META_INVALID', 200),
      workspaceHostPath,
      evidenceHostPath,
      startedAt: value.startedAt,
    };
  }
}

export class AntigravityExecutionProvider extends AntigravityProviderBase {
  readonly provider = 'antigravity-worker';
  protected readonly role = 'IMPLEMENTATION' as const;
}

export class AntigravityReviewProvider
  extends AntigravityProviderBase
  implements ReviewProviderPort
{
  readonly provider = 'antigravity-review';
  readonly independentReview = true as const;
  protected readonly role = 'REVIEW' as const;
}
