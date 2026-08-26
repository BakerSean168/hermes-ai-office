import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AntigravityExecutionHost } from '../src/v3/adapters/antigravity.js';
import { RoutedExecutionHost } from '../src/v3/adapters/routedExecutionHost.js';
import type {
  ExecutionHostCreateInput,
  ExecutionHostPort,
  ExecutionHostSnapshot,
} from '../src/v3/ports.js';

function fakeAgy(directory: string, mode: 'review' | 'wait' = 'review'): string {
  const file = path.join(directory, `fake-agy-${mode}.mjs`);
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2).join(' ');
  if (args.includes('SECRET_OBJECTIVE_MARKER')) process.exit(41);
  const message = JSON.parse(input.trim());
  if (message.event !== 'user' || !String(message.message?.content ?? '').includes('SECRET_OBJECTIVE_MARKER')) process.exit(42);
  console.log(JSON.stringify({ event: 'init', conversation_id: 'fake-conversation' }));
  ${
    mode === 'wait'
      ? `setTimeout(() => {}, 10_000);`
      : `console.log(JSON.stringify({
          event: 'result',
          result: {
            conversation_id: 'fake-conversation',
            status: 'SUCCESS',
            response: 'ignored because structured output is authoritative',
            structured_output: {
              verdict: 'FAIL',
              summary: 'A blocking contract regression remains.',
              findings: [{ severity: 'P1', title: 'Schema drift', evidence: 'src/types/notes.ts changed incompatibly' }]
            },
            num_turns: 1,
            usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 10, total_tokens: 125 }
          }
        }));`
  }
});
`,
    { mode: 0o755 },
  );
  return file;
}

function input(phase: 'VERIFY_REVIEW' | 'IMPLEMENT_FIX', backend: string): ExecutionHostCreateInput {
  return {
    executionId: phase === 'VERIFY_REVIEW' ? 'exec_ant_review' : 'exec_ant_fix',
    projectKey: 'digital-biome',
    phase,
    objective: 'SECRET_OBJECTIVE_MARKER',
    repositoryPath:
      phase === 'VERIFY_REVIEW'
        ? '/workspace/executions/exec_ant_review/repo'
        : '/workspace/executions/exec_ant_fix/repo',
    selection: {
      backend,
      modelClass: phase === 'VERIFY_REVIEW' ? 'gemini-3.1-pro-high' : 'gemini-3.7-flash-high',
      transportMode: 'PROVIDER_NATIVE',
      workspaceMode: phase === 'VERIFY_REVIEW' ? 'review_snapshot' : 'reuse_implementation_workspace',
      sessionPolicy: phase === 'VERIFY_REVIEW' ? 'fresh_required' : 'resume_preferred',
      reasons: [],
    },
    correlationMetadata: { execution_id: 'exec_ant' },
  };
}

async function terminal(host: AntigravityExecutionHost, conversationId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await host.getExecution(conversationId);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('fake Antigravity execution did not terminate');
}

test('Antigravity adapter sends the objective only through stdin and normalizes structured review output', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-host-'));
  const workspaceRoot = path.join(directory, 'workspaces');
  fs.mkdirSync(path.join(workspaceRoot, 'executions', 'exec_ant_review', 'repo'), { recursive: true });
  const host = new AntigravityExecutionHost({
    binary: fakeAgy(directory),
    stateRoot: path.join(directory, 'state'),
    workspaceHostRoot: workspaceRoot,
    workspaceExecutionRoot: '/workspace',
    home: directory,
    printTimeout: '30s',
  });

  const created = await host.createExecution(input('VERIFY_REVIEW', 'antigravity-review'));
  assert.equal(created.status, 'RUNNING');
  assert.match(created.conversationId, /^antigravity:exec_ant_review$/);

  const finished = await terminal(host, created.conversationId);
  assert.equal(finished.status, 'SUCCEEDED');
  assert.equal(
    finished.finalText,
    'FAIL\nA blocking contract regression remains.\n- P1 Schema drift: src/types/notes.ts changed incompatibly',
  );
  assert.equal(finished.usage?.source, 'ANTIGRAVITY_REPORTED');
  assert.equal(finished.usage?.input, 100);
  assert.equal(finished.usage?.cachedInput, 10);
  assert.equal(finished.currentModelId, 'gemini-3.1-pro-high');
});

test('Antigravity adapter cancellation is durable and terminates the detached process group', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-cancel-'));
  const workspaceRoot = path.join(directory, 'workspaces');
  fs.mkdirSync(path.join(workspaceRoot, 'executions', 'exec_ant_fix', 'repo'), { recursive: true });
  const host = new AntigravityExecutionHost({
    binary: fakeAgy(directory, 'wait'),
    stateRoot: path.join(directory, 'state'),
    workspaceHostRoot: workspaceRoot,
    workspaceExecutionRoot: '/workspace',
    home: directory,
  });

  const created = await host.createExecution(input('IMPLEMENT_FIX', 'antigravity-worker'));
  const cancelled = await host.cancelExecution(created.conversationId);
  assert.equal(cancelled.status, 'CANCELLED');
  assert.ok(fs.existsSync(path.join(directory, 'state', 'exec_ant_fix', 'cancelled')));
});

class StubHost implements ExecutionHostPort {
  creates = 0;
  constructor(readonly prefix: string) {}
  async health() {
    return 'OK' as const;
  }
  async createExecution(): Promise<ExecutionHostSnapshot> {
    this.creates += 1;
    return { conversationId: `${this.prefix}:conversation`, status: 'RUNNING' };
  }
  async getExecution(conversationId: string): Promise<ExecutionHostSnapshot> {
    return { conversationId, status: 'RUNNING' };
  }
  async cancelExecution(conversationId: string): Promise<ExecutionHostSnapshot> {
    return { conversationId, status: 'CANCELLED' };
  }
}

test('routed execution host isolates Antigravity backend routing from existing OpenHands routing', async () => {
  const openhands = new StubHost('openhands');
  const antigravity = new StubHost('antigravity');
  const host = new RoutedExecutionHost({
    defaultHost: openhands,
    byBackend: { 'antigravity-review': antigravity },
    byConversationPrefix: { 'antigravity:': antigravity },
  });

  const ant = await host.createExecution(input('VERIFY_REVIEW', 'antigravity-review'));
  assert.equal(antigravity.creates, 1);
  assert.equal(openhands.creates, 0);
  assert.equal((await host.cancelExecution(ant.conversationId)).status, 'CANCELLED');

  const ordinaryInput = input('VERIFY_REVIEW', 'codex-review-headless');
  const ordinary = await host.createExecution(ordinaryInput);
  assert.equal(openhands.creates, 1);
  assert.match(ordinary.conversationId, /^openhands:/);
});
