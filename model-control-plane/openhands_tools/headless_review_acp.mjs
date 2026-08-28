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
const HARNESS_PROFILE = process.env.AI_OFFICE_HARNESS_PROFILE ?? 'openhands';
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
const EXIT_GRACE_MS = 5_000;
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const EVIDENCE_LIMIT = 768 * 1024;
const UNTRACKED_FILE_LIMIT = 128 * 1024;
const MAX_UNTRACKED_FILES = 80;

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
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
  },
  required: ['verdict', 'summary', 'findings'],
  additionalProperties: false,
};

function redact(value) {
  let text = String(value ?? '');
  if (LITELLM_API_KEY) text = text.split(LITELLM_API_KEY).join('<secret-hidden>');
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
  const executionRoot = path.dirname(session.cwd);
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
  return `${combined.slice(0, EVIDENCE_LIMIT)}\n\n[EVIDENCE TRUNCATED AT ${EVIDENCE_LIMIT} CHARACTERS; inspect the physically read-only snapshot for additional context.]`;
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
  if (verdict !== 'PASS' && verdict !== 'FAIL') {
    throw new Error('HEADLESS_REVIEW_VERDICT_INVALID');
  }
  const summary = typeof value.summary === 'string' ? value.summary.trim() : '';
  const findings = Array.isArray(value.findings) ? value.findings : [];
  const lines = [
    verdict,
    summary || (verdict === 'PASS' ? 'No blocking findings.' : 'Blocking findings exist.'),
  ];
  if (findings.length) {
    lines.push('', 'Findings:');
    for (const finding of findings) {
      if (!finding || typeof finding !== 'object') continue;
      const severity = ['P0', 'P1', 'P2', 'P3'].includes(finding.severity)
        ? finding.severity
        : 'P2';
      const title = typeof finding.title === 'string' ? finding.title.trim() : 'Finding';
      const evidence = typeof finding.evidence === 'string' ? finding.evidence.trim() : '';
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
    const workerPrompt = `${prompt}\n\nYou are the implementation worker. Work directly in the current repository and complete the requested change, not merely analyze it. Inspect the relevant repository instructions, active plan, code, and tests; preserve existing contracts outside scope; implement the acceptance criteria; run focused verification first and then the appropriate wider checks. Commit the completed change with a concise conventional commit and leave the workspace clean. Do not wait for human confirmation for ordinary implementation choices. If a genuine external blocker remains, report the exact blocker and the evidence you collected.`;
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
  const reviewPrompt = `${prompt}\n\nFrozen Git evidence captured by AI Office before the reviewer starts:\n\n${evidence}\n\nBefore returning a verdict, you MUST independently inspect repository files and execute at least one focused verification command using terminal tools. Do not return FAIL merely because verification has not yet been attempted. The frozen evidence is a starting point, not a substitute for independent inspection. The snapshot is physically read-only; if verification needs writes, copy it to a fresh directory under /tmp and test that disposable copy. Do not modify the snapshot.`;
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
  const reviewPrompt = `${prompt}\n\nFrozen Git evidence captured by AI Office before the reviewer starts:\n\n${evidence}\n\nBefore returning a verdict, you MUST independently inspect repository files and execute at least one focused verification command using terminal tools. Do not return FAIL merely because verification has not yet been attempted. The frozen evidence is a starting point, not a substitute for independent inspection. The snapshot is physically read-only; if verification needs writes, copy it to a fresh directory under /tmp and test that disposable copy. Do not modify the snapshot.`;
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

function scheduleProcessExit() {
  const timer = setTimeout(() => process.exit(0), EXIT_GRACE_MS);
  timer.unref();
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
              rawOutput: { state: IS_WORKER ? 'implementing' : IS_PLANNER ? 'planning' : 'reviewing' },
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

      const canonical = IS_WORKER || IS_PLANNER
        ? String(spec.parse(result.stdout)).trim()
        : canonicalReview(spec.parse(result.stdout));
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
    return {};
  }
}

fs.mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);
const agent = new HeadlessReviewAgent();
acp
  .agent({ name: `ai-office-${DRIVER || 'headless'}-${IS_WORKER ? 'worker' : IS_PLANNER ? 'planner' : 'review'}` })
  .onRequest('initialize', (ctx) => agent.initialize(ctx.params))
  .onRequest('session/new', (ctx) => agent.newSession(ctx.params))
  .onRequest('authenticate', () => ({}))
  .onRequest('session/set_mode', () => ({}))
  .onRequest('session/close', (ctx) => agent.close(ctx.params))
  .onRequest('session/delete', (ctx) => agent.close(ctx.params))
  .onRequest('session/prompt', (ctx) => agent.prompt(ctx.params, ctx.client))
  .onNotification('session/cancel', (ctx) => agent.cancel(ctx.params))
  .connect(stream);
