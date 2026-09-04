#!/usr/bin/env node
import * as acp from 'file:///openhands-state/tooling/node_modules/@agentclientprotocol/sdk/dist/acp.js';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

const DRIVER = process.env.AI_OFFICE_HEADLESS_DRIVER ?? '';
const DEFAULT_MODEL = process.env.AI_OFFICE_HEADLESS_MODEL ?? 'gpt-5.6-sol';
const LITELLM_BASE_URL = (process.env.AI_OFFICE_LITELLM_BASE_URL ?? '').replace(/\/$/, '');
const LITELLM_API_KEY = process.env.AI_OFFICE_LITELLM_API_KEY ?? '';
const HEADLESS_TRANSPORT = process.env.AI_OFFICE_HEADLESS_TRANSPORT ?? 'litellm-managed';
const HEADLESS_ROLE = process.env.AI_OFFICE_HEADLESS_ROLE ?? 'review';
const IS_WORKER = HEADLESS_ROLE === 'worker';
const IS_PLANNER = HEADLESS_ROLE === 'planner';
const HEADLESS_REASONING_EFFORT =
  process.env.AI_OFFICE_HEADLESS_REASONING_EFFORT ?? (IS_WORKER ? 'xhigh' : 'medium');
const CODEX_AUTH_HOME = process.env.AI_OFFICE_CODEX_AUTH_HOME ?? '';
const HARNESS_CTL = process.env.AI_OFFICE_HARNESS_CTL ?? '/opt/agent-harness/bin/harnessctl.py';
const HARNESS_PROFILE =
  process.env.AI_OFFICE_HARNESS_PROFILE ??
  (HEADLESS_ROLE === 'review' ? 'openhands-review' : 'openhands');
const CODEX_BIN =
  process.env.AI_OFFICE_CODEX_BIN ?? '/openhands-state/tooling/node_modules/.bin/codex';
const CLAUDE_BIN =
  process.env.AI_OFFICE_CLAUDE_BIN ?? '/openhands-state/tooling/node_modules/.bin/claude';
const WORKSPACE_ROOT = path.resolve(process.env.AI_OFFICE_WORKSPACE_ROOT ?? '/workspace');
const STATE_ROOT = path.resolve(
  process.env.AI_OFFICE_HEADLESS_STATE_ROOT ?? '/openhands-state/ai-office-headless-review',
);
const TIMEOUT_MS = Math.max(
  30_000,
  Math.min(30 * 60_000, Number(process.env.AI_OFFICE_HEADLESS_TIMEOUT_SECONDS ?? '900') * 1000),
);
const HEARTBEAT_MS = 15_000;
const IDLE_EXIT_MS = Math.max(
  30_000,
  Math.min(15 * 60_000, Number(process.env.AI_OFFICE_HEADLESS_IDLE_EXIT_SECONDS ?? '120') * 1000),
);
let idleExitTimer;
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const EVIDENCE_LIMIT = 768 * 1024;
const UNTRACKED_FILE_LIMIT = 128 * 1024;
const MAX_UNTRACKED_FILES = 80;
const PIXEL_V4_REVIEW_EVIDENCE_PATH = process.env.PIXEL_V4_REVIEW_EVIDENCE_PATH ?? '';
const PIXEL_V4_IMPLEMENTATION_EVIDENCE_PATH =
  process.env.PIXEL_V4_IMPLEMENTATION_EVIDENCE_PATH ?? '';
const PIXEL_V4_EXECUTION_ID = process.env.PIXEL_V4_EXECUTION_ID ?? '';
const PIXEL_V4_REVIEWED_SHA = process.env.PIXEL_V4_REVIEWED_SHA ?? '';
const PIXEL_V4_SOURCE_SHA = process.env.PIXEL_V4_SOURCE_SHA ?? '';
const PIXEL_V4_IMPLEMENTATION_PHASE = process.env.PIXEL_V4_IMPLEMENTATION_PHASE ?? 'IMPLEMENT';

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'INVALID'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          title: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['severity', 'title', 'evidence'],
        additionalProperties: false,
      },
    },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          status: { type: 'string', enum: ['PASS', 'FAIL', 'SKIP'] },
          exitCode: { type: 'integer' },
          summary: { type: 'string' },
        },
        required: ['command', 'status', 'exitCode', 'summary'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'summary', 'findings', 'checks'],
  additionalProperties: false,
};

function redact(value) {
  let text = String(value ?? '');
  for (const secret of [
    LITELLM_API_KEY,
    process.env.AI_OFFICE_LITELLM_API_KEY,
    process.env.DEEPSEEK_API_KEY,
    process.env.ZCODE_API_KEY,
    process.env.SESSION_API_KEY,
    process.env.OPENHANDS_SESSION_API_KEY,
    process.env.CODEX_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
  ]) {
    if (secret) text = text.split(secret).join('<secret-hidden>');
  }
  text = text
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s'",}]+/gi, '$1<secret-hidden>')
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      '$1<secret-hidden>',
    )
    .replace(/\b(?:sk|sess|key|token)-[A-Za-z0-9_.:/_-]{8,}\b/g, '<secret-hidden>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer <secret-hidden>');
  return text.slice(0, 12_000);
}

function safeSessionDirectory(sessionId) {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const target = path.join(STATE_ROOT, safe);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  return target;
}

function assertWorkspace(cwd) {
  const resolved = path.resolve(cwd);
  const relative = path.relative(WORKSPACE_ROOT, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('HEADLESS_REVIEW_WORKSPACE_NOT_ALLOWED');
  }
  return resolved;
}

function prepareHarness(session, host) {
  if (!fs.existsSync(HARNESS_CTL)) throw new Error('HEADLESS_REVIEW_HARNESS_MISSING');
  const executionId = String(process.env.HERMES_V3_EXECUTION_ID ?? '');
  const literal =
    /^\/workspace\/v4\/plans\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/(?:items|reviews|repairs)\/[A-Za-z0-9._-]+\/repo$/.test(
      session.cwd,
    );
  if (literal && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(executionId))
    throw new Error('HEADLESS_REVIEW_EXECUTION_ID_REQUIRED');
  const executionRoot = literal
    ? path.join(path.dirname(session.cwd), '.executions', executionId)
    : path.dirname(session.cwd);
  const privateRoot = path.join(executionRoot, '.agent-harness');
  const home = path.join(privateRoot, 'home');
  const state = path.join(privateRoot, 'state');
  const share = path.join(privateRoot, 'share');
  for (const directory of [privateRoot, home, state, share]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const env = {
    ...process.env,
    HOME: home,
    AGENT_HARNESS_STATE: state,
    AGENT_HARNESS_SHARE: share,
    PATH: [
      '/openhands-state/tooling/node_modules/.bin',
      '/openhands-state/dsh-cli/node_modules/.bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ].join(':'),
  };
  delete env.OPENCODE_CONFIG;
  const prepared = spawnSync(
    '/usr/local/bin/python3',
    [
      HARNESS_CTL,
      '--state-root',
      state,
      'prepare',
      session.cwd,
      '--profile',
      HARNESS_PROFILE,
      '--host',
      host,
      '--execution',
      '--json',
    ],
    {
      cwd: session.cwd,
      env,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (prepared.error) throw prepared.error;
  if (prepared.status !== 0) {
    throw new Error(
      `HEADLESS_REVIEW_HARNESS_BLOCKED:${redact(prepared.stderr || prepared.stdout)}`,
    );
  }
  const payload = JSON.parse(prepared.stdout);
  if (payload?.admission?.status !== 'READY') {
    throw new Error('HEADLESS_REVIEW_HARNESS_NOT_READY');
  }
  const root = String(payload?.environment?.root ?? '');
  if (!root || !path.isAbsolute(root)) throw new Error('HEADLESS_REVIEW_HARNESS_ROOT_MISSING');
  return { root, env };
}

function safeSymlink(source, destination) {
  if (!fs.existsSync(source) || fs.existsSync(destination)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.symlinkSync(source, destination);
}

function git(cwd, args, options = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${redact(result.stderr)}`);
  }
  return result.stdout;
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function optionalGit(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return '';
  return result.stdout.trim();
}

function codexWritableArgs(session, harness) {
  const executionRoot = path.dirname(session.cwd);
  const roots = [
    ...(IS_WORKER
      ? [path.resolve(git(session.cwd, ['rev-parse', '--absolute-git-dir']).trim())]
      : []),
    harness.env.HOME,
    harness.env.AGENT_HARNESS_STATE,
    harness.env.AGENT_HARNESS_SHARE,
  ]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => path.resolve(value));
  for (const root of roots) {
    if (!isInside(root, executionRoot)) {
      throw new Error(`HEADLESS_WORKER_WRITABLE_ROOT_NOT_ALLOWED:${root}`);
    }
  }
  return [...new Set(roots)].flatMap((root) => ['--add-dir', root]);
}

function collectEvidence(cwd) {
  const sections = [];
  const implementationHead = git(cwd, ['rev-parse', 'HEAD']).trim();
  const reviewBase = optionalGit(cwd, ['rev-parse', '--verify', 'refs/ai-office/review-base']);

  sections.push(`IMPLEMENTATION HEAD:\n${implementationHead}`);
  if (reviewBase) {
    sections.push(`ORIGINAL IMPLEMENTATION BASE (refs/ai-office/review-base):\n${reviewBase}`);
    sections.push(
      `COMMITTED IMPLEMENTATION DIFF AGAINST REVIEW BASE:\n${
        git(cwd, [
          'diff',
          '--no-ext-diff',
          '--unified=60',
          'refs/ai-office/review-base..HEAD',
          '--',
          '.',
        ]) || '(no committed implementation diff)\n'
      }`,
    );
    sections.push(
      `COMMITTED DIFF CHECK:\n${
        git(cwd, ['diff', '--check', 'refs/ai-office/review-base..HEAD', '--', '.']) ||
        'PASS (git diff --check exited 0)\n'
      }`,
    );
  }

  sections.push(`GIT STATUS:\n${git(cwd, ['status', '--short']) || '(clean)\n'}`);
  sections.push(
    `UNCOMMITTED IMPLEMENTATION DIFF AGAINST HEAD:\n${
      git(cwd, ['diff', '--no-ext-diff', '--unified=60', 'HEAD', '--', '.']) ||
      '(no tracked uncommitted diff)\n'
    }`,
  );
  sections.push(
    `UNCOMMITTED DIFF CHECK:\n${
      git(cwd, ['diff', '--check', 'HEAD', '--', '.']) || 'PASS (git diff --check exited 0)\n'
    }`,
  );

  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
    .slice(0, MAX_UNTRACKED_FILES);
  if (untracked.length) {
    const files = [];
    for (const relative of untracked) {
      const absolute = path.resolve(cwd, relative);
      if (!isInside(absolute, cwd)) continue;
      const stat = fs.statSync(absolute, { throwIfNoEntry: false });
      if (!stat?.isFile()) continue;
      if (stat.size > UNTRACKED_FILE_LIMIT) {
        files.push(`UNTRACKED FILE ${relative}: [omitted: ${stat.size} bytes]`);
        continue;
      }
      const bytes = fs.readFileSync(absolute);
      if (bytes.includes(0)) {
        files.push(`UNTRACKED FILE ${relative}: [binary omitted: ${stat.size} bytes]`);
        continue;
      }
      files.push(`UNTRACKED FILE ${relative}:\n${bytes.toString('utf8')}`);
    }
    sections.push(files.join('\n\n'));
  }

  const combined = sections.join('\n\n');
  if (combined.length <= EVIDENCE_LIMIT) return combined;
  return `${combined.slice(0, EVIDENCE_LIMIT)}\n\n[EVIDENCE TRUNCATED AT ${EVIDENCE_LIMIT} CHARACTERS; inspect the supplied snapshot for additional context.]`;
}

function promptText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function canonicalReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('HEADLESS_REVIEW_RESULT_INVALID');
  }
  const verdict = value.verdict;
  if (verdict !== 'PASS' && verdict !== 'FAIL' && verdict !== 'INVALID') {
    throw new Error('HEADLESS_REVIEW_VERDICT_INVALID');
  }
  const summary = typeof value.summary === 'string' ? value.summary.trim() : '';
  const findings = Array.isArray(value.findings) ? value.findings : [];
  const lines = [
    verdict,
    redact(summary) ||
      (verdict === 'PASS'
        ? 'No blocking findings.'
        : verdict === 'INVALID'
          ? 'Review environment invalid.'
          : 'Blocking findings exist.'),
  ];
  if (findings.length) {
    lines.push('', 'Findings:');
    for (const finding of findings) {
      if (!finding || typeof finding !== 'object') continue;
      const severity = ['P0', 'P1', 'P2', 'P3'].includes(finding.severity)
        ? finding.severity
        : 'P2';
      const title = typeof finding.title === 'string' ? redact(finding.title.trim()) : 'Finding';
      const evidence = typeof finding.evidence === 'string' ? redact(finding.evidence.trim()) : '';
      lines.push(`- [${severity}] ${title}`);
      if (evidence) lines.push(`  Evidence: ${evidence}`);
    }
  }
  return lines.join('\n').trim();
}

function parseConcatenatedJsonObjects(text) {
  const values = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start < 0) {
      if (char !== '{') continue;
      start = index;
      depth = 1;
      inString = false;
      escaped = false;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          values.push(JSON.parse(text.slice(start, index + 1)));
        } catch {
          // Ignore malformed fragments and keep scanning for the next object.
        }
        start = -1;
      }
    }
  }
  return values;
}

function parseCodexResult(sessionDir, stdout) {
  const lastMessage = path.join(sessionDir, 'codex-last-message.json');
  const candidates = [];
  if (fs.existsSync(lastMessage)) {
    candidates.push(
      ...parseConcatenatedJsonObjects(fs.readFileSync(lastMessage, 'utf8')).reverse(),
    );
  }
  for (const line of stdout.split(/\r?\n/).reverse()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const text = event?.item?.type === 'agent_message' ? event.item.text : null;
      if (typeof text === 'string') {
        candidates.push(...parseConcatenatedJsonObjects(text).reverse());
      }
    } catch {
      // Ignore non-JSON event lines.
    }
  }
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
  }
  throw new Error('CODEX_STRUCTURED_REVIEW_MISSING');
}

function parseCodexWorkerResult(stdout) {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const text = event?.item?.type === 'agent_message' ? event.item.text : null;
      if (typeof text === 'string' && text.trim()) return text.trim();
    } catch {
      // Ignore non-JSON event lines.
    }
  }
  throw new Error('CODEX_WORKER_RESULT_MISSING');
}

function codexWorkspaceActivity(stdout) {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const item = event?.item;
      if (
        item?.type === 'command_execution' ||
        item?.type === 'mcp_tool_call' ||
        item?.type === 'file_change'
      ) {
        return true;
      }
    } catch {
      // Ignore non-JSON event lines.
    }
  }
  return false;
}

function parseClaudeResult(stdout) {
  const envelope = JSON.parse(stdout);
  if (envelope?.is_error === true) {
    throw new Error(`CLAUDE_REVIEW_ERROR:${envelope.subtype ?? 'unknown'}`);
  }
  if (envelope?.structured_output && typeof envelope.structured_output === 'object') {
    return envelope.structured_output;
  }
  if (typeof envelope?.result === 'string') return JSON.parse(envelope.result);
  if (envelope?.result && typeof envelope.result === 'object') return envelope.result;
  throw new Error('CLAUDE_STRUCTURED_REVIEW_MISSING');
}

function successfulCodexChecks(stdout) {
  const checks = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const item = event?.item;
      if (item?.type !== 'command_execution') continue;
      const command = typeof item.command === 'string' ? item.command.trim() : '';
      const exitCode = Number(item.exit_code ?? item.exitCode);
      if (!command || !Number.isInteger(exitCode) || exitCode !== 0) continue;
      const output =
        typeof item.aggregated_output === 'string'
          ? item.aggregated_output
          : typeof item.output === 'string'
            ? item.output
            : '';
      checks.push({
        command: redact(command).slice(0, 2_000),
        status: 'PASS',
        exitCode,
        summary: redact(
          output.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? 'command exited 0',
        ).slice(0, 2_000),
      });
      if (checks.length >= 20) break;
    } catch {
      // Ignore non-JSON event lines.
    }
  }
  return checks;
}

function normalizedReviewChecks(value, stdout) {
  const checks = Array.isArray(value?.checks) ? value.checks : [];
  const normalized = [];
  for (const item of checks) {
    if (!item || typeof item !== 'object') continue;
    const command = typeof item.command === 'string' ? item.command.trim() : '';
    const status = ['PASS', 'FAIL', 'SKIP'].includes(item.status) ? item.status : null;
    const exitCode = Number(item.exitCode);
    const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
    if (!command || !status || !Number.isInteger(exitCode)) continue;
    normalized.push({
      command: redact(command).slice(0, 2_000),
      status,
      exitCode,
      summary: redact(summary || `command ${status.toLowerCase()}`).slice(0, 2_000),
    });
    if (normalized.length >= 20) break;
  }
  return normalized.length ? normalized : successfulCodexChecks(stdout);
}

function writePixelV4ImplementationEvidence(session, summary, stdout) {
  if (!PIXEL_V4_IMPLEMENTATION_EVIDENCE_PATH) return;
  if (!PIXEL_V4_EXECUTION_ID || !PIXEL_V4_SOURCE_SHA) {
    throw new Error('PIXEL_V4_IMPLEMENTATION_EVIDENCE_METADATA_MISSING');
  }
  if (
    PIXEL_V4_IMPLEMENTATION_PHASE !== 'IMPLEMENT' &&
    PIXEL_V4_IMPLEMENTATION_PHASE !== 'IMPLEMENT_FIX'
  ) {
    throw new Error('PIXEL_V4_IMPLEMENTATION_PHASE_INVALID');
  }
  const target = path.resolve(PIXEL_V4_IMPLEMENTATION_EVIDENCE_PATH);
  const executionRoot = path.dirname(session.cwd);
  if (
    path.dirname(target) !== executionRoot ||
    path.basename(target) !== 'completion-evidence.json'
  ) {
    throw new Error('PIXEL_V4_IMPLEMENTATION_EVIDENCE_PATH_INVALID');
  }
  const status = git(session.cwd, ['status', '--porcelain=v1', '-z']);
  if (status.length > 0) throw new Error('PIXEL_V4_IMPLEMENTATION_WORKSPACE_DIRTY');
  const resultRevision = git(session.cwd, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  if (!/^[0-9a-f]{7,64}$/i.test(PIXEL_V4_SOURCE_SHA))
    throw new Error('PIXEL_V4_IMPLEMENTATION_SOURCE_SHA_INVALID');
  const sourceRevision = git(session.cwd, [
    'rev-parse',
    '--verify',
    `${PIXEL_V4_SOURCE_SHA}^{commit}`,
  ]).trim();
  if (resultRevision !== sourceRevision)
    git(session.cwd, ['merge-base', '--is-ancestor', sourceRevision, resultRevision]);
  const tests = successfulCodexChecks(stdout);
  if (!tests.some((item) => item.status === 'PASS')) {
    throw new Error('PIXEL_V4_IMPLEMENTATION_TEST_EVIDENCE_MISSING');
  }
  const outcome = resultRevision === sourceRevision ? 'SATISFIED' : 'CHANGED';
  const evidence = {
    version: 1,
    executionId: PIXEL_V4_EXECUTION_ID,
    phase: PIXEL_V4_IMPLEMENTATION_PHASE,
    sourceRevision,
    resultRevision,
    outcome,
    summary: redact(
      String(
        summary ||
          (outcome === 'CHANGED'
            ? 'Implementation completed.'
            : 'Source revision already satisfies the objective.'),
      ),
    )
      .trim()
      .slice(0, 8_000),
    tests,
  };
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function isPixelV4ImplementationFinalizationError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    message === 'PIXEL_V4_IMPLEMENTATION_WORKSPACE_DIRTY' ||
    message === 'PIXEL_V4_IMPLEMENTATION_TEST_EVIDENCE_MISSING'
  );
}

function writePixelV4ReviewEvidence(session, value, stdout) {
  if (!PIXEL_V4_REVIEW_EVIDENCE_PATH) return;
  if (!PIXEL_V4_EXECUTION_ID || !PIXEL_V4_REVIEWED_SHA) {
    throw new Error('PIXEL_V4_REVIEW_EVIDENCE_METADATA_MISSING');
  }
  const target = path.resolve(PIXEL_V4_REVIEW_EVIDENCE_PATH);
  const executionRoot = path.dirname(session.cwd);
  if (
    path.dirname(target) !== executionRoot ||
    path.basename(target) !== 'completion-evidence.json'
  ) {
    throw new Error('PIXEL_V4_REVIEW_EVIDENCE_PATH_INVALID');
  }
  const checks = normalizedReviewChecks(value, stdout);
  if (
    value?.verdict === 'PASS' &&
    (!checks.some((item) => item.status === 'PASS') ||
      checks.some((item) => item.status === 'FAIL'))
  ) {
    throw new Error('PIXEL_V4_REVIEW_CHECK_EVIDENCE_INVALID');
  }
  const findings = Array.isArray(value?.findings)
    ? value.findings
        .filter((item) => item && typeof item === 'object')
        .map((item) => {
          const severity = ['P0', 'P1', 'P2', 'P3'].includes(item.severity) ? item.severity : 'P2';
          const title = typeof item.title === 'string' ? item.title.trim() : 'Finding';
          const evidence = typeof item.evidence === 'string' ? item.evidence.trim() : '';
          return redact(`[${severity}] ${title}${evidence ? ` — ${evidence}` : ''}`).slice(
            0,
            4_000,
          );
        })
    : [];
  const evidence = {
    version: 1,
    executionId: PIXEL_V4_EXECUTION_ID,
    phase: 'REVIEW',
    reviewedSha: PIXEL_V4_REVIEWED_SHA,
    verdict: value.verdict,
    findings,
    checks,
    summary: redact(
      typeof value?.summary === 'string' && value.summary.trim()
        ? value.summary.trim()
        : value?.verdict === 'PASS'
          ? 'No blocking findings.'
          : 'Blocking findings exist.',
    ).slice(0, 8_000),
  };
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function codexIndependentActivity(stdout) {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const item = event?.item;
      if (item?.type === 'command_execution' || item?.type === 'mcp_tool_call') {
        return true;
      }
    } catch {
      // Ignore non-JSON event lines.
    }
  }
  return false;
}

function codexCommand(session, prompt, evidence) {
  const sessionDir = safeSessionDirectory(session.id);
  const native = HEADLESS_TRANSPORT === 'provider-native';
  const harness = prepareHarness(session, 'codex');
  const codexHome = path.join(harness.root, 'codex');
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  if (native) {
    if (!CODEX_AUTH_HOME) throw new Error('HEADLESS_REVIEW_CODEX_AUTH_HOME_MISSING');
    const authFile = path.join(CODEX_AUTH_HOME, 'auth.json');
    if (!fs.existsSync(authFile)) throw new Error('HEADLESS_REVIEW_CODEX_AUTH_MISSING');
    safeSymlink(authFile, path.join(codexHome, 'auth.json'));
    safeSymlink(
      path.join(CODEX_AUTH_HOME, 'skills', '.system'),
      path.join(codexHome, 'skills', '.system'),
    );
  } else {
    const baseUrl = LITELLM_BASE_URL.endsWith('/v1') ? LITELLM_BASE_URL : `${LITELLM_BASE_URL}/v1`;
    const configPath = path.join(codexHome, 'config.toml');
    const harnessConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    fs.writeFileSync(
      configPath,
      [
        `model = ${JSON.stringify(session.model)}`,
        'model_provider = "hermes-litellm"',
        `model_reasoning_effort = ${JSON.stringify(HEADLESS_REASONING_EFFORT)}`,
        'model_verbosity = "high"',
        'approval_policy = "never"',
        'sandbox_mode = "workspace-write"',
        '[model_providers.hermes-litellm]',
        'name = "Hermes LiteLLM"',
        `base_url = ${JSON.stringify(baseUrl)}`,
        'env_key = "CODEX_API_KEY"',
        'wire_api = "responses"',
        '[model_providers.hermes-litellm.env_http_headers]',
        '"X-LiteLLM-End-User-ID" = "HERMES_V3_EXECUTION_ID"',
        '[features]',
        'unified_exec = false',
        'multi_agent = false',
        '',
        harnessConfig.trim(),
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
  }
  const env = {
    ...harness.env,
    CODEX_HOME: codexHome,
  };
  if (native) {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    delete env.CODEX_ACCESS_TOKEN;
  } else {
    env.CODEX_API_KEY = LITELLM_API_KEY;
  }

  if (IS_WORKER) {
    const pixelV4EvidenceNote = PIXEL_V4_IMPLEMENTATION_EVIDENCE_PATH
      ? `\n\nPixel V4 controller note: the outer headless adapter, not this Codex sandbox, persists ${PIXEL_V4_IMPLEMENTATION_EVIDENCE_PATH} after validating your committed HEAD, clean workspace, and command evidence. Do NOT attempt to write that controller-owned evidence path yourself. This note overrides any earlier instruction asking you to write the V4 completion-evidence file directly.`
      : '';
    const workerPrompt = `${prompt}\n\nYou are the implementation worker. Work directly in the current repository and complete the requested change, not merely analyze it. Inspect the relevant repository instructions, active plan, code, and tests; preserve existing contracts outside scope; implement the acceptance criteria; run focused verification first and then the appropriate wider checks. Commit the completed change with a concise conventional commit and leave the workspace clean. Do not wait for human confirmation for ordinary implementation choices. If a genuine external blocker remains, report the exact blocker and the evidence you collected.${pixelV4EvidenceNote}`;
    return {
      command: CODEX_BIN,
      args: [
        'exec',
        '--ephemeral',
        '--ignore-rules',
        '--sandbox',
        'workspace-write',
        ...codexWritableArgs(session, harness),
        ...(native ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
        '-c',
        `model_reasoning_effort=${JSON.stringify(HEADLESS_REASONING_EFFORT)}`,
        '--model',
        session.model,
        '--json',
        '-',
      ],
      input: workerPrompt,
      env,
      parse: parseCodexWorkerResult,
      hasIndependentActivity: codexWorkspaceActivity,
    };
  }

  if (IS_PLANNER) {
    const plannerPrompt = `${prompt}\n\nYou are the planning worker. Inspect the repository and its project instructions independently before producing the requested plan or investigation result. Do not modify repository files. Use terminal/MCP inspection to ground the result in current code and contracts. Return the requested planning artifact directly without adding a review verdict.`;
    return {
      command: CODEX_BIN,
      args: [
        'exec',
        '--ephemeral',
        '--ignore-rules',
        '--sandbox',
        'workspace-write',
        ...codexWritableArgs(session, harness),
        ...(native ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
        '-c',
        `model_reasoning_effort=${JSON.stringify(HEADLESS_REASONING_EFFORT)}`,
        '--model',
        session.model,
        '--json',
        '-',
      ],
      input: plannerPrompt,
      env,
      parse: parseCodexWorkerResult,
      hasIndependentActivity: codexIndependentActivity,
    };
  }

  const schemaPath = path.join(sessionDir, 'review-schema.json');
  fs.writeFileSync(schemaPath, JSON.stringify(REVIEW_SCHEMA), { mode: 0o600 });
  const lastMessage = path.join(sessionDir, 'codex-last-message.json');
  const pixelV4EvidenceNote = PIXEL_V4_REVIEW_EVIDENCE_PATH
    ? `\n\nPixel V4 controller note: the outer headless adapter, not this Codex sandbox, persists ${PIXEL_V4_REVIEW_EVIDENCE_PATH} from your structured response. Do NOT attempt to write that controller-owned evidence path yourself, and do not treat inability to write it as a finding or environment failure. This note overrides any earlier instruction asking you to write the V4 completion-evidence file directly.`
    : '';
  const reviewPrompt = `${prompt}\n\nFrozen Git evidence captured by AI Office before the reviewer starts:\n\n${evidence}\n\nBefore returning a verdict, you MUST independently inspect repository files and execute at least one focused verification command using terminal tools. When the output schema exposes a checks field, record the exact focused verification commands you ran, their real exit codes, and concise results. Do not return FAIL merely because verification has not yet been attempted. The frozen evidence is a starting point, not a substitute for independent inspection. Keep tracked repository files unchanged. Verification may create ignored dependency or tool-cache artifacts in the supplied workspace when the sandbox permits it; only use a disposable /tmp copy if a required check truly cannot run without tracked writes. Do not modify tracked snapshot content.${pixelV4EvidenceNote}`;
  return {
    command: CODEX_BIN,
    args: [
      'exec',
      '--ephemeral',
      '--ignore-rules',
      '--sandbox',
      'workspace-write',
      ...codexWritableArgs(session, harness),
      ...(native ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
      '-c',
      `model_reasoning_effort=${JSON.stringify(HEADLESS_REASONING_EFFORT)}`,
      '--model',
      session.model,
      '--output-schema',
      schemaPath,
      '--json',
      '-o',
      lastMessage,
      '-',
    ],
    input: reviewPrompt,
    env,
    parse: (stdout) => parseCodexResult(sessionDir, stdout),
    hasIndependentActivity: codexIndependentActivity,
  };
}

function claudeCommand(session, prompt, evidence) {
  const harness = prepareHarness(session, 'claude');
  const claudeRoot = path.join(harness.root, 'claude');
  const reviewPrompt = `${prompt}\n\nFrozen Git evidence captured by AI Office before the reviewer starts:\n\n${evidence}\n\nBefore returning a verdict, you MUST independently inspect repository files and execute at least one focused verification command using terminal tools. Do not return FAIL merely because verification has not yet been attempted. The frozen evidence is a starting point, not a substitute for independent inspection. Keep tracked repository files unchanged. Verification may create ignored dependency or tool-cache artifacts in the supplied workspace when the sandbox permits it; only use a disposable /tmp copy if a required check truly cannot run without tracked writes. Do not modify tracked snapshot content.`;
  return {
    command: CLAUDE_BIN,
    args: [
      '-p',
      '--mcp-config',
      path.join(claudeRoot, 'mcp.json'),
      '--strict-mcp-config',
      '--add-dir',
      path.join(claudeRoot, 'instructions'),
      '--model',
      session.model,
      '--effort',
      'high',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(REVIEW_SCHEMA),
      '--permission-mode',
      'dontAsk',
      '--disallowed-tools',
      'Edit,Write,NotebookEdit',
    ],
    input: reviewPrompt,
    env: {
      ...harness.env,
      HOME: path.join(claudeRoot, 'home'),
      ANTHROPIC_API_KEY: LITELLM_API_KEY,
      ANTHROPIC_BASE_URL: LITELLM_BASE_URL,
      ANTHROPIC_MODEL: session.model,
      ANTHROPIC_CUSTOM_MODEL_OPTION: session.model,
      CLAUDE_CODE_SUBAGENT_MODEL: session.model,
      ANTHROPIC_CUSTOM_HEADERS: [
        process.env.ANTHROPIC_CUSTOM_HEADERS ?? '',
        process.env.HERMES_V3_EXECUTION_ID
          ? `X-LiteLLM-End-User-ID: ${process.env.HERMES_V3_EXECUTION_ID}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    parse: parseClaudeResult,
  };
}

function buildCommand(session, prompt, evidence) {
  if (DRIVER === 'codex' && HEADLESS_TRANSPORT === 'provider-native') {
    return codexCommand(session, prompt, evidence);
  }
  if (!LITELLM_BASE_URL || !LITELLM_API_KEY) throw new Error('HEADLESS_REVIEW_GATEWAY_MISSING');
  if (DRIVER === 'codex') return codexCommand(session, prompt, evidence);
  if (DRIVER === 'claude') return claudeCommand(session, prompt, evidence);
  throw new Error(`HEADLESS_REVIEW_DRIVER_UNSUPPORTED:${DRIVER || 'unset'}`);
}

function runChild(session, spec) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputOverflow = false;
    const child = spawn(spec.command, spec.args, {
      cwd: session.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    session.child = child;
    child.stdin.on('error', () => {});
    child.stdin.end(spec.input);

    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      if (next.length <= OUTPUT_LIMIT) return next;
      outputOverflow = true;
      child.kill('SIGTERM');
      return next.slice(0, OUTPUT_LIMIT);
    };
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, TIMEOUT_MS);
    timeout.unref();

    const onAbort = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    };
    session.controller.signal.addEventListener('abort', onAbort, { once: true });

    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      session.controller.signal.removeEventListener('abort', onAbort);
      session.child = null;
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        cancelled: session.controller.signal.aborted,
        outputOverflow,
      });
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      session.controller.signal.removeEventListener('abort', onAbort);
      session.child = null;
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        timedOut,
        cancelled: session.controller.signal.aborted,
        outputOverflow,
      });
    });
  });
}

function cancelScheduledProcessExit() {
  if (!idleExitTimer) return;
  clearTimeout(idleExitTimer);
  idleExitTimer = undefined;
}

function scheduleProcessExit(delayMs = IDLE_EXIT_MS) {
  cancelScheduledProcessExit();
  idleExitTimer = setTimeout(() => process.exit(0), delayMs);
  idleExitTimer.unref();
}

class HeadlessReviewAgent {
  constructor() {
    this.sessions = new Map();
  }

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    };
  }

  async newSession(params) {
    cancelScheduledProcessExit();
    const cwd = assertWorkspace(params.cwd);
    const id = crypto.randomUUID();
    this.sessions.set(id, {
      id,
      cwd,
      model: DEFAULT_MODEL,
      controller: new AbortController(),
      child: null,
    });
    return { sessionId: id };
  }

  async setModel(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error('HEADLESS_REVIEW_SESSION_NOT_FOUND');
    if (typeof params.modelId === 'string' && params.modelId.trim()) {
      session.model = params.modelId.trim();
    }
    return {};
  }

  async prompt(params, cx) {
    cancelScheduledProcessExit();
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error('HEADLESS_REVIEW_SESSION_NOT_FOUND');
    session.controller = new AbortController();
    const prompt = promptText(params.prompt);
    if (!prompt) throw new Error('HEADLESS_REVIEW_PROMPT_REQUIRED');

    const toolCallId = crypto.randomUUID();
    const title =
      DRIVER === 'codex'
        ? HEADLESS_TRANSPORT === 'provider-native'
          ? IS_WORKER
            ? 'Codex Business implementation'
            : IS_PLANNER
              ? 'Codex Business planning'
              : 'Codex Business review'
          : 'Codex managed review'
        : 'Claude Code managed review';
    await cx.notify(acp.methods.client.session.update, {
      sessionId: session.id,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId,
        title,
        kind: 'other',
        status: 'pending',
        rawInput: { driver: DRIVER, model: session.model },
      },
    });

    let heartbeat;
    try {
      const evidence = IS_WORKER || IS_PLANNER ? '' : collectEvidence(session.cwd);
      const spec = buildCommand(session, prompt, evidence);
      heartbeat = setInterval(() => {
        void cx
          .notify(acp.methods.client.session.update, {
            sessionId: session.id,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: 'in_progress',
              rawOutput: {
                state: IS_WORKER ? 'implementing' : IS_PLANNER ? 'planning' : 'reviewing',
              },
            },
          })
          .catch(() => {});
      }, HEARTBEAT_MS);
      heartbeat.unref();

      const result = await runChild(session, spec);
      if (result.cancelled) {
        await cx.notify(acp.methods.client.session.update, {
          sessionId: session.id,
          update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' },
        });
        return { stopReason: 'cancelled' };
      }

      if (result.timedOut || result.outputOverflow || result.code !== 0) {
        const reason = result.timedOut
          ? `reviewer timed out after ${Math.round(TIMEOUT_MS / 1000)}s`
          : result.outputOverflow
            ? 'reviewer output exceeded safety limit'
            : `reviewer exited with code ${result.code ?? 'unknown'} (${result.signal ?? 'no-signal'})`;
        const detail = redact(result.stderr).trim();
        await cx.notify(acp.methods.client.session.update, {
          sessionId: session.id,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'failed',
            rawOutput: { error: reason },
          },
        });
        await cx.notify(acp.methods.client.session.update, {
          sessionId: session.id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `${IS_WORKER ? 'IMPLEMENT_TRANSPORT_ERROR' : IS_PLANNER ? 'PLAN_TRANSPORT_ERROR' : 'REVIEW_TRANSPORT_ERROR'}\n${reason}${detail ? `\n${detail}` : ''}`,
            },
          },
        });
        return { stopReason: 'end_turn' };
      }

      if (
        typeof spec.hasIndependentActivity === 'function' &&
        !spec.hasIndependentActivity(result.stdout)
      ) {
        const reason = IS_WORKER
          ? 'worker completed without repository command or file-change activity'
          : IS_PLANNER
            ? 'planner completed without independent repository command activity'
            : 'reviewer completed without independent repository command activity';
        await cx.notify(acp.methods.client.session.update, {
          sessionId: session.id,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'failed',
            rawOutput: { error: reason },
          },
        });
        await cx.notify(acp.methods.client.session.update, {
          sessionId: session.id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `${IS_WORKER ? 'IMPLEMENT_TRANSPORT_ERROR' : IS_PLANNER ? 'PLAN_TRANSPORT_ERROR' : 'REVIEW_TRANSPORT_ERROR'}\n${reason}`,
            },
          },
        });
        return { stopReason: 'end_turn' };
      }

      let parsed = spec.parse(result.stdout);
      let evidenceStdout = result.stdout;
      if (IS_WORKER) {
        try {
          writePixelV4ImplementationEvidence(session, parsed, evidenceStdout);
        } catch (error) {
          if (!isPixelV4ImplementationFinalizationError(error)) throw error;
          const finalizationPrompt = [
            prompt,
            '',
            'Pixel V4 controller finalization retry:',
            '- The first implementation turn returned before deterministic completion verification passed.',
            '- Preserve the intended current workspace changes; do not reset or discard them.',
            '- Inspect the current diff, run the focused checks for the original objective, commit every intended tracked change, and verify git status is clean.',
            '- Do not write completion-evidence.json yourself; the outer adapter will validate the clean committed HEAD and persist it.',
            '- Finish only after the repository is committed and clean.',
          ].join('\n');
          const finalizationSpec = buildCommand(session, finalizationPrompt, '');
          const finalizationResult = await runChild(session, finalizationSpec);
          if (
            finalizationResult.cancelled ||
            finalizationResult.timedOut ||
            finalizationResult.outputOverflow ||
            finalizationResult.code !== 0
          ) {
            const reason = finalizationResult.cancelled
              ? 'worker finalization cancelled'
              : finalizationResult.timedOut
                ? `worker finalization timed out after ${Math.round(TIMEOUT_MS / 1000)}s`
                : finalizationResult.outputOverflow
                  ? 'worker finalization output exceeded safety limit'
                  : `worker finalization exited with code ${finalizationResult.code ?? 'unknown'} (${finalizationResult.signal ?? 'no-signal'})`;
            const detail = redact(finalizationResult.stderr).trim();
            throw new Error(`${reason}${detail ? `: ${detail}` : ''}`);
          }
          if (
            typeof finalizationSpec.hasIndependentActivity === 'function' &&
            !finalizationSpec.hasIndependentActivity(finalizationResult.stdout)
          ) {
            throw new Error(
              'worker finalization completed without repository command or file-change activity',
            );
          }
          parsed = finalizationSpec.parse(finalizationResult.stdout);
          evidenceStdout = `${evidenceStdout}\n${finalizationResult.stdout}`;
          writePixelV4ImplementationEvidence(session, parsed, evidenceStdout);
        }
      } else if (!IS_PLANNER) {
        writePixelV4ReviewEvidence(session, parsed, result.stdout);
      }
      const canonical =
        IS_WORKER || IS_PLANNER ? redact(String(parsed).trim()) : canonicalReview(parsed);
      await cx.notify(acp.methods.client.session.update, {
        sessionId: session.id,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'completed',
          rawOutput: { driver: DRIVER, model: session.model },
        },
      });
      await cx.notify(acp.methods.client.session.update, {
        sessionId: session.id,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: canonical },
        },
      });
      return { stopReason: 'end_turn' };
    } catch (error) {
      const detail = redact(error instanceof Error ? error.message : error);
      await cx.notify(acp.methods.client.session.update, {
        sessionId: session.id,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'failed',
          rawOutput: { error: detail },
        },
      });
      await cx.notify(acp.methods.client.session.update, {
        sessionId: session.id,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `${IS_WORKER ? 'IMPLEMENT_TRANSPORT_ERROR' : IS_PLANNER ? 'PLAN_TRANSPORT_ERROR' : 'REVIEW_TRANSPORT_ERROR'}\n${detail}`,
          },
        },
      });
      return { stopReason: 'end_turn' };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      scheduleProcessExit();
    }
  }

  async cancel(params) {
    this.sessions.get(params.sessionId)?.controller.abort();
  }

  async close(params) {
    const session = this.sessions.get(params.sessionId);
    session?.controller.abort();
    this.sessions.delete(params.sessionId);
    if (this.sessions.size === 0) scheduleProcessExit(1_000);
    return {};
  }
}

fs.mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);
const agent = new HeadlessReviewAgent();
acp
  .agent({
    name: `ai-office-${DRIVER || 'headless'}-${IS_WORKER ? 'worker' : IS_PLANNER ? 'planner' : 'review'}`,
  })
  .onRequest('initialize', (ctx) => agent.initialize(ctx.params))
  .onRequest('session/new', (ctx) => agent.newSession(ctx.params))
  .onRequest('authenticate', () => ({}))
  .onRequest('session/set_mode', () => ({}))
  .onRequest('session/close', (ctx) => agent.close(ctx.params))
  .onRequest('session/delete', (ctx) => agent.close(ctx.params))
  .onRequest('session/prompt', (ctx) => agent.prompt(ctx.params, ctx.client))
  .onNotification('session/cancel', (ctx) => agent.cancel(ctx.params))
  .connect(stream);
