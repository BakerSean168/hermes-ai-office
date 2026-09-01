import assert from 'node:assert/strict';
import test from 'node:test';

import { V4Error } from '../src/v4/domain/errors.js';
import { OpenHandsExecutionProvider, OpenHandsReviewProvider, mapOpenHandsStatus } from '../src/v4/adapters/openHandsCoding.js';
import type { ProviderLaunchInput } from '../src/v4/orchestration/contracts.js';

const secrets = { sessionApiKey: 'session-secret-value', liteLlmApiKey: 'sk-super-secret-value' };

function launchInput(phase: 'IMPLEMENT' | 'IMPLEMENT_FIX' | 'REVIEW' = 'IMPLEMENT'): ProviderLaunchInput {
  return {
    executionId: 'exec-1', planId: 'plan-1', projectKey: 'pixel-agents', workItemId: 'work-1', phase,
    objective: 'Implement the bounded change.', acceptanceCriteria: ['tests pass'], sourceRevision: 'source-sha',
    route: phase === 'REVIEW' ? 'review-route' : 'implementation-route',
    workspace: {
      executionId: 'exec-1', hostPath: '/host/executions/exec-1/repo', executionPath: '/workspace/executions/exec-1/repo',
      evidenceHostPath: '/host/executions/exec-1/evidence.json', evidenceExecutionPath: '/workspace/executions/exec-1/evidence.json',
      sourceRepositoryPath: '/repos/pixel-agents', sourceRevision: 'source-sha', createdAt: '2026-09-01T00:00:00.000Z',
    },
  };
}

function options(fetchImpl: typeof fetch) {
  return { baseUrl: 'http://openhands.test', ...secrets, liteLlmBaseUrl: 'http://litellm.test/v1', fetchImpl, requestTimeoutMs: 5_000 };
}

test('OpenHands implementation and review launches use distinct models, tools and safe provenance', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fake = (async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    const body = JSON.parse(String(init.body)) as Record<string, any>;
    return new Response(JSON.stringify({
      id: body.tags.role === 'independentreview' ? 'review-session' : 'implementation-session',
      execution_status: 'running', workspace: body.workspace, tags: body.tags,
    }), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const implementation = new OpenHandsExecutionProvider(options(fake));
  const review = new OpenHandsReviewProvider(options(fake));
  const implementationSnapshot = await implementation.launch(launchInput('IMPLEMENT'));
  const reviewSnapshot = await review.launch(launchInput('REVIEW'));
  assert.equal(implementationSnapshot.provider, 'openhands-coding');
  assert.equal(reviewSnapshot.provider, 'openhands-independent-review');
  assert.equal(review.independentReview, true);
  const implementationRequest = requests[0]!;
  const reviewRequest = requests[1]!;
  const implementationBody = JSON.parse(String(implementationRequest.init.body)) as Record<string, any>;
  const reviewBody = JSON.parse(String(reviewRequest.init.body)) as Record<string, any>;
  assert.equal((implementationRequest.init.headers as Record<string, string>)['X-Session-API-Key'], secrets.sessionApiKey);
  assert.equal((implementationRequest.init.headers as Record<string, string>).authorization, undefined);
  assert.equal(implementationBody.agent.llm.model, 'litellm_proxy/gpt-5.6-luna');
  assert.equal(reviewBody.agent.llm.model, 'litellm_proxy/gpt-5.6-sol');
  assert.deepEqual(implementationBody.agent.tools.map((item: { name: string }) => item.name), ['terminal', 'file_editor', 'task_tracker']);
  assert.deepEqual(reviewBody.agent.tools.map((item: { name: string }) => item.name), ['terminal', 'task_tracker']);
  assert.equal(implementationBody.initial_message.run, true);
  assert.match(implementationBody.initial_message.content[0].text, /\/workspace\/executions\/exec-1\/evidence\.json/);
  assert.match(implementationBody.initial_message.content[0].text, /honor checked-in runtime declarations/);
  assert.match(implementationBody.initial_message.content[0].text, /immutable\/frozen-lockfile mode/);
  assert.match(implementationBody.initial_message.content[0].text, /never rewrite the lockfile/);
  assert.match(reviewBody.initial_message.content[0].text, /\"phase\":\"REVIEW\"/);
  assert.equal(implementationBody.agent.llm.api_mode, 'chat');
  assert.equal(implementationBody.agent.llm.reasoning_effort, null);
  assert.equal(implementationBody.tags.execution, 'exec1');
  assert.equal(reviewBody.tags.role, 'independentreview');
  assert.equal(JSON.stringify(implementationSnapshot).includes(secrets.sessionApiKey), false);
  assert.equal(JSON.stringify(implementationSnapshot).includes(secrets.liteLlmApiKey), false);
  await assert.rejects(() => implementation.launch(launchInput('REVIEW')), (error: unknown) => error instanceof V4Error && error.code === 'OPENHANDS_IMPLEMENTATION_PHASE_REQUIRED');
  await assert.rejects(() => review.launch(launchInput('IMPLEMENT')), (error: unknown) => error instanceof V4Error && error.code === 'OPENHANDS_REVIEW_PHASE_REQUIRED');
});

test('OpenHands launch explicitly runs an idle initial conversation before returning', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  let running = false;
  const fake = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const value = String(url);
    calls.push({ url: value, method: String(init.method ?? 'GET') });
    if (value.endsWith('/api/conversations') && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, any>;
      return new Response(JSON.stringify({ id: 'idle-session', execution_status: 'idle', workspace: body.workspace, tags: body.tags }), { status: 201 });
    }
    if (value.endsWith('/api/conversations/idle-session/run') && init.method === 'POST') {
      running = true;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (value.endsWith('/api/conversations/idle-session')) {
      return new Response(JSON.stringify({ id: 'idle-session', execution_status: running ? 'running' : 'idle' }), { status: 200 });
    }
    throw new Error('unexpected request ' + value);
  }) as typeof fetch;
  const provider = new OpenHandsExecutionProvider(options(fake));
  const snapshot = await provider.launch(launchInput('IMPLEMENT'));
  assert.equal(snapshot.status, 'RUNNING');
  assert.deepEqual(calls.map((call) => [call.method, call.url.replace('http://openhands.test', '')]), [
    ['POST', '/api/conversations'],
    ['POST', '/api/conversations/idle-session/run'],
    ['GET', '/api/conversations/idle-session'],
  ]);
});

test('OpenHands recovery is paginated, provenance checked and duplicate-safe', async () => {
  let mode: 'single' | 'duplicate' | 'mismatch' = 'single';
  const fake = (async (url: string | URL | Request) => {
    if (!String(url).includes('/api/conversations/search')) throw new Error('unexpected request');
    const matching = {
      id: 'session-1', execution_status: 'paused', created_at: '2026-09-01T00:00:01.000Z',
      workspace: { working_dir: '/workspace/executions/exec-1/repo' },
      tags: { execution: 'exec1', project: 'pixel-agents', phase: 'implement' },
    };
    if (mode === 'duplicate') return new Response(JSON.stringify({ items: [matching, { ...matching, id: 'session-2' }] }), { status: 200 });
    if (mode === 'mismatch') return new Response(JSON.stringify({ items: [{ ...matching, workspace: { working_dir: '/wrong' } }] }), { status: 200 });
    return new Response(JSON.stringify({ items: [matching] }), { status: 200 });
  }) as typeof fetch;
  const provider = new OpenHandsExecutionProvider(options(fake));
  const input = {
    executionId: 'exec-1', createdAt: '2026-09-01T00:00:00.000Z', projectKey: 'pixel-agents', phase: 'IMPLEMENT' as const,
    expectedWorkspacePath: '/workspace/executions/exec-1/repo',
  };
  assert.equal((await provider.recover(input))?.providerSessionId, 'session-1');
  mode = 'duplicate';
  await assert.rejects(() => provider.recover(input), (error: unknown) => error instanceof V4Error && error.code === 'OPENHANDS_EXECUTION_DUPLICATE');
  mode = 'mismatch';
  await assert.rejects(() => provider.recover(input), (error: unknown) => error instanceof V4Error && error.code === 'OPENHANDS_WORKSPACE_PROVENANCE_MISMATCH');
});

test('OpenHands inspect, continue and cancel sanitize terminal provider evidence', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  let state: 'error' | 'paused' = 'error';
  const fake = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const value = String(url);
    calls.push({ url: value, method: String(init.method ?? 'GET') });
    if (value.endsWith('/events') && init.method === 'POST') return new Response(JSON.stringify({ success: true }), { status: 200 });
    if (value.endsWith('/pause') && init.method === 'POST') { state = 'paused'; return new Response(JSON.stringify({ success: true }), { status: 200 }); }
    if (value.endsWith('/agent_final_response')) return new Response(JSON.stringify({ response: 'failed without ' + secrets.liteLlmApiKey }), { status: 200 });
    if (value.includes('/events/search')) return new Response(JSON.stringify({ items: [{ kind: 'ConversationErrorEvent', code: 'ServiceUnavailableError', detail: 'Authorization: Bearer token-value and ' + secrets.sessionApiKey + ' ' + secrets.liteLlmApiKey }] }), { status: 200 });
    if (value.endsWith('/api/conversations/session-1')) return new Response(JSON.stringify({ id: 'session-1', execution_status: state }), { status: 200 });
    throw new Error('unexpected request ' + value);
  }) as typeof fetch;
  const provider = new OpenHandsExecutionProvider(options(fake));
  const failed = await provider.inspect('session-1');
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.retryable, true);
  assert.ok(failed.errorCode?.includes('ServiceUnavailableError'));
  assert.equal(JSON.stringify(failed).includes(secrets.sessionApiKey), false);
  assert.equal(JSON.stringify(failed).includes(secrets.liteLlmApiKey), false);
  assert.equal(JSON.stringify(failed).includes('token-value'), false);
  await provider.continue('session-1', 'Continue the same bounded execution.');
  const cancelled = await provider.cancel('session-1');
  assert.equal(cancelled.status, 'PAUSED');
  assert.ok(calls.some((call) => call.url.endsWith('/events') && call.method === 'POST'));
  assert.ok(calls.some((call) => call.url.endsWith('/pause') && call.method === 'POST'));
});

test('OpenHands paused continuation explicitly runs and recovers a stale in-flight task with interrupt', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  let state: 'paused' | 'running' = 'paused';
  let runAttempts = 0;
  const fake = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const value = String(url);
    calls.push({ url: value, method: String(init.method ?? 'GET') });
    if (value.endsWith('/events') && init.method === 'POST')
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    if (value.endsWith('/interrupt') && init.method === 'POST') {
      state = 'paused';
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (value.endsWith('/run') && init.method === 'POST') {
      runAttempts += 1;
      if (runAttempts === 1) return new Response(JSON.stringify({ detail: 'still running' }), { status: 409 });
      state = 'running';
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (value.endsWith('/agent_final_response')) return new Response(JSON.stringify({ response: '' }), { status: 200 });
    if (value.includes('/events/search')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (value.endsWith('/api/conversations/session-stuck'))
      return new Response(JSON.stringify({ id: 'session-stuck', execution_status: state }), { status: 200 });
    throw new Error('unexpected request ' + value);
  }) as typeof fetch;
  const provider = new OpenHandsExecutionProvider(options(fake));
  const snapshot = await provider.continue('session-stuck', 'Continue the same bounded execution.');
  assert.equal(snapshot.status, 'RUNNING');
  assert.equal(runAttempts, 2);
  assert.ok(calls.some((call) => call.url.endsWith('/interrupt') && call.method === 'POST'));
});

test('OpenHands status and transport failures fail closed', async () => {
  assert.deepEqual([
    'created', 'queued', 'running', 'idle', 'paused', 'waiting_for_confirmation', 'finished', 'error', 'stuck', 'deleting', 'other',
  ].map(mapOpenHandsStatus), [
    'CREATED', 'QUEUED', 'RUNNING', 'PAUSED', 'PAUSED', 'WAITING_FOR_CONFIRMATION', 'SUCCEEDED', 'FAILED', 'STUCK', 'CANCELLED', 'UNKNOWN',
  ]);
  const httpFailure = new OpenHandsExecutionProvider(options((async () => new Response('busy', { status: 503 })) as typeof fetch));
  await assert.rejects(() => httpFailure.inspect('session'), (error: unknown) => error instanceof V4Error && error.code === 'OPENHANDS_HTTP_503');
  const timeout = new OpenHandsExecutionProvider(options((async () => { const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; }) as typeof fetch));
  await assert.rejects(() => timeout.inspect('session'), (error: unknown) => error instanceof V4Error && error.code === 'OPENHANDS_TIMEOUT');
});
