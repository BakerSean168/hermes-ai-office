import assert from 'node:assert/strict';
import test from 'node:test';

import { V4Error } from '../src/v4/domain/errors.js';
import {
  OpenHandsClaudeReviewProvider,
  OpenHandsCodexBusinessReviewProvider,
  OpenHandsCodexBusinessExecutionProvider,
  OpenHandsCodexManagedExecutionProvider,
  OpenHandsCodexManagedReviewProvider,
  OpenHandsDshExecutionProvider,
  OpenHandsExecutionProvider,
  OpenHandsReviewProvider,
  OpenHandsZCodeExecutionProvider,
  createOpenHandsProviderForSelection,
  mapOpenHandsStatus,
} from '../src/v4/adapters/openHandsCoding.js';
import type {
  ProviderLaunchInput,
  ProviderSessionReplacementInput,
} from '../src/v4/orchestration/contracts.js';

const secrets = { sessionApiKey: 'session-secret-value', liteLlmApiKey: 'sk-super-secret-value' };

function launchInput(
  phase: 'IMPLEMENT' | 'IMPLEMENT_FIX' | 'REVIEW' = 'IMPLEMENT',
): ProviderLaunchInput {
  return {
    executionId: 'exec-1',
    planId: 'plan-1',
    projectKey: 'pixel-agents',
    workItemId: 'work-1',
    phase,
    objective: 'Implement the bounded change.',
    acceptanceCriteria: ['tests pass'],
    sourceRevision: 'source-sha',
    route: phase === 'REVIEW' ? 'review-route' : 'implementation-route',
    workspace: {
      executionId: 'exec-1',
      hostPath: '/host/executions/exec-1/repo',
      executionPath: '/workspace/executions/exec-1/repo',
      evidenceHostPath: '/host/executions/exec-1/evidence.json',
      evidenceExecutionPath: '/workspace/executions/exec-1/evidence.json',
      sourceRepositoryPath: '/repos/pixel-agents',
      sourceRevision: 'source-sha',
      createdAt: '2026-09-01T00:00:00.000Z',
    },
  };
}

function options(fetchImpl: typeof fetch) {
  return {
    baseUrl: 'http://openhands.test',
    ...secrets,
    liteLlmBaseUrl: 'http://litellm.test/v1',
    fetchImpl,
    requestTimeoutMs: 5_000,
  };
}

test('OpenHands implementation and review launches use distinct models, tools and safe provenance', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fake = (async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    const body = JSON.parse(String(init.body)) as Record<string, any>;
    return new Response(
      JSON.stringify({
        id: body.tags.role === 'independentreview' ? 'review-session' : 'implementation-session',
        execution_status: 'running',
        workspace: body.workspace,
        tags: body.tags,
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
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
  const implementationBody = JSON.parse(String(implementationRequest.init.body)) as Record<
    string,
    any
  >;
  const reviewBody = JSON.parse(String(reviewRequest.init.body)) as Record<string, any>;
  assert.equal(
    (implementationRequest.init.headers as Record<string, string>)['X-Session-API-Key'],
    secrets.sessionApiKey,
  );
  assert.equal(
    (implementationRequest.init.headers as Record<string, string>).authorization,
    undefined,
  );
  assert.equal(implementationBody.agent.llm.model, 'litellm_proxy/gpt-5.6-luna');
  assert.equal(reviewBody.agent.llm.model, 'litellm_proxy/gpt-5.6-sol');
  assert.deepEqual(
    implementationBody.agent.tools.map((item: { name: string }) => item.name),
    ['terminal', 'file_editor', 'task_tracker'],
  );
  assert.deepEqual(
    reviewBody.agent.tools.map((item: { name: string }) => item.name),
    ['terminal', 'task_tracker'],
  );
  assert.equal(implementationBody.initial_message.run, true);
  assert.equal(
    implementationBody.secrets.HOME.value,
    '/workspace/executions/exec-1/.agent-harness/home',
  );
  assert.equal(
    implementationBody.secrets.XDG_CONFIG_HOME.value,
    '/workspace/executions/exec-1/.agent-harness/xdg',
  );
  assert.equal(implementationBody.secrets.GIT_CONFIG_NOSYSTEM.value, '1');
  assert.equal(implementationBody.secrets.GIT_OPTIONAL_LOCKS.value, '0');
  assert.equal(implementationBody.secrets.GIT_CONFIG_COUNT.value, '4');
  assert.equal(implementationBody.secrets.GIT_CONFIG_KEY_0.value, 'safe.directory');
  assert.equal(
    implementationBody.secrets.GIT_CONFIG_VALUE_0.value,
    '/workspace/executions/exec-1/repo',
  );
  assert.equal(implementationBody.secrets.GIT_CONFIG_KEY_1.value, 'safe.directory');
  assert.equal(implementationBody.secrets.GIT_CONFIG_VALUE_1.value, '/host/executions/exec-1/repo');
  assert.equal(implementationBody.secrets.GIT_CONFIG_KEY_2.value, 'gc.auto');
  assert.equal(implementationBody.secrets.GIT_CONFIG_VALUE_2.value, '0');
  assert.equal(implementationBody.secrets.GIT_CONFIG_KEY_3.value, 'maintenance.auto');
  assert.equal(implementationBody.secrets.GIT_CONFIG_VALUE_3.value, 'false');
  assert.match(
    implementationBody.initial_message.content[0].text,
    /\/workspace\/executions\/exec-1\/repo\/\.pixel-v4-completion-evidence\.json/,
  );
  assert.match(
    implementationBody.initial_message.content[0].text,
    /honor checked-in runtime declarations/,
  );
  assert.match(
    implementationBody.initial_message.content[0].text,
    /immutable\/frozen-lockfile mode/,
  );
  assert.match(implementationBody.initial_message.content[0].text, /never rewrite the lockfile/);
  assert.match(reviewBody.initial_message.content[0].text, /\"phase\":\"REVIEW\"/);
  assert.match(reviewBody.initial_message.content[0].text, /immutable\/frozen-lockfile mode/);
  assert.match(
    reviewBody.initial_message.content[0].text,
    /Use FAIL only for a concrete defect attributable/,
  );
  assert.match(
    reviewBody.initial_message.content[0].text,
    /Use INVALID when the environment or tooling prevents/,
  );
  assert.equal(implementationBody.agent.llm.api_mode, 'chat');
  assert.equal(implementationBody.agent.llm.reasoning_effort, null);
  assert.equal(implementationBody.tags.execution, 'exec1');
  assert.equal(reviewBody.tags.role, 'independentreview');
  assert.equal(JSON.stringify(implementationSnapshot).includes(secrets.sessionApiKey), false);
  assert.equal(JSON.stringify(implementationSnapshot).includes(secrets.liteLlmApiKey), false);
  await assert.rejects(
    () => implementation.launch(launchInput('REVIEW')),
    (error: unknown) =>
      error instanceof V4Error && error.code === 'OPENHANDS_IMPLEMENTATION_PHASE_REQUIRED',
  );
  await assert.rejects(
    () => review.launch(launchInput('IMPLEMENT')),
    (error: unknown) =>
      error instanceof V4Error && error.code === 'OPENHANDS_REVIEW_PHASE_REQUIRED',
  );
});

test('Managed Codex implementation launches ACP with Responses transport and controller-owned V4 evidence', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fake = (async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    const body = JSON.parse(String(init.body)) as Record<string, any>;
    return new Response(
      JSON.stringify({
        id: 'managed-codex-session',
        execution_status: 'running',
        workspace: body.workspace,
        tags: body.tags,
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  const implementation = new OpenHandsCodexManagedExecutionProvider(options(fake));
  const snapshot = await implementation.launch(launchInput('IMPLEMENT'));
  assert.equal(snapshot.provider, 'codex-managed-coding');
  const body = JSON.parse(String(requests[0]!.init.body)) as Record<string, any>;
  assert.equal(body.agent.kind, 'ACPAgent');
  assert.deepEqual(body.agent.acp_command, [
    '/usr/local/bin/node',
    '/opt/hermes-ai-office-tools/headless_review_acp.mjs',
  ]);
  assert.equal(body.agent.acp_model, 'gpt-5.6-luna');
  assert.equal(body.agent.llm, undefined);
  assert.equal(body.secrets.AI_OFFICE_HEADLESS_DRIVER.value, 'codex');
  assert.equal(body.secrets.AI_OFFICE_HEADLESS_ROLE.value, 'worker');
  assert.equal(body.secrets.AI_OFFICE_HEADLESS_TRANSPORT.value, 'litellm-managed');
  assert.equal(body.secrets.AI_OFFICE_HEADLESS_REASONING_EFFORT.value, 'xhigh');
  assert.equal(body.secrets.AI_OFFICE_LITELLM_BASE_URL.value, 'http://litellm.test/v1');
  assert.equal(body.secrets.AI_OFFICE_LITELLM_API_KEY.value, secrets.liteLlmApiKey);
  assert.equal(body.secrets.HERMES_V3_EXECUTION_ID.value, 'exec-1');
  assert.equal(
    body.secrets.PIXEL_V4_IMPLEMENTATION_EVIDENCE_PATH.value,
    '/workspace/executions/exec-1/evidence.json',
  );
  assert.equal(body.secrets.PIXEL_V4_EXECUTION_ID.value, 'exec-1');
  assert.equal(body.secrets.PIXEL_V4_SOURCE_SHA.value, 'source-sha');
  assert.equal(body.secrets.PIXEL_V4_IMPLEMENTATION_PHASE.value, 'IMPLEMENT');
  assert.equal(JSON.stringify(snapshot).includes(secrets.liteLlmApiKey), false);
});

test('Business Codex review launches provider-native ACP with persisted ChatGPT auth and V4 evidence metadata', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fake = (async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    const body = JSON.parse(String(init.body)) as Record<string, any>;
    return new Response(
      JSON.stringify({
        id: 'business-review-session',
        execution_status: 'running',
        workspace: body.workspace,
        tags: body.tags,
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  const review = new OpenHandsCodexBusinessReviewProvider(options(fake));
  const snapshot = await review.launch(launchInput('REVIEW'));
  assert.equal(snapshot.provider, 'codex-business-independent-review');
  assert.equal(review.independentReview, true);
  const body = JSON.parse(String(requests[0]!.init.body)) as Record<string, any>;
  assert.equal(body.agent.kind, 'ACPAgent');
  assert.deepEqual(body.agent.acp_command, [
    '/usr/local/bin/node',
    '/opt/hermes-ai-office-tools/headless_review_acp.mjs',
  ]);
  assert.equal(body.agent.acp_model, 'gpt-5.6-sol');
  assert.equal(body.agent.llm, undefined);
  assert.equal(body.secrets.AI_OFFICE_HEADLESS_TRANSPORT.value, 'provider-native');
  assert.equal(body.secrets.AI_OFFICE_HEADLESS_ROLE.value, 'review');
  assert.equal(body.secrets.AI_OFFICE_CODEX_AUTH_HOME.value, '/openhands-state/codex-business');
  assert.equal(body.secrets.AI_OFFICE_HEADLESS_REASONING_EFFORT.value, 'medium');
  assert.equal(
    body.secrets.PIXEL_V4_REVIEW_EVIDENCE_PATH.value,
    '/workspace/executions/exec-1/evidence.json',
  );
  assert.equal(body.secrets.PIXEL_V4_EXECUTION_ID.value, 'exec-1');
  assert.equal(body.secrets.PIXEL_V4_REVIEWED_SHA.value, 'source-sha');
  assert.equal(JSON.stringify(body).includes(secrets.liteLlmApiKey), false);
});

test('model-native factory resolves selected backend, model and transport without model-name routing', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let nextId = 0;
  const fake = (async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    const body = JSON.parse(String(init.body)) as Record<string, any>;
    return new Response(
      JSON.stringify({
        id: `selected-session-${nextId++}`,
        execution_status: 'running',
        workspace: body.workspace,
        tags: body.tags,
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  const common = options(fake);
  const cases = [
    {
      selection: {
        backend: 'codex-acp',
        model: 'gpt-5.6-luna',
        role: 'IMPLEMENTATION',
        transport: 'LITELLM_MANAGED',
      },
      phase: 'IMPLEMENT',
      expectedProvider: 'codex-managed-coding',
      expectedCommand: [
        '/usr/local/bin/node',
        '/opt/hermes-ai-office-tools/headless_review_acp.mjs',
      ],
      expectedSecrets: {
        AI_OFFICE_HEADLESS_DRIVER: 'codex',
        AI_OFFICE_HEADLESS_TRANSPORT: 'litellm-managed',
        AI_OFFICE_LITELLM_API_KEY: secrets.liteLlmApiKey,
        AI_OFFICE_AGENT_MODEL: 'gpt-5.6-luna',
      },
    },
    {
      selection: {
        backend: 'codex-acp',
        model: 'gpt-5.6-sol',
        role: 'REVIEW',
        transport: 'LITELLM_MANAGED',
      },
      phase: 'REVIEW',
      expectedProvider: 'codex-managed-independent-review',
      expectedCommand: [
        '/usr/local/bin/node',
        '/opt/hermes-ai-office-tools/headless_review_acp.mjs',
      ],
      expectedSecrets: {
        AI_OFFICE_HEADLESS_ROLE: 'review',
        AI_OFFICE_HEADLESS_MODEL: 'gpt-5.6-sol',
      },
    },
    {
      selection: {
        backend: 'codex-acp',
        model: 'gpt-5.6-luna',
        role: 'IMPLEMENTATION',
        transport: 'PROVIDER_NATIVE',
      },
      phase: 'IMPLEMENT',
      expectedProvider: 'codex-business-coding',
      expectedCommand: [
        '/usr/local/bin/node',
        '/opt/hermes-ai-office-tools/headless_review_acp.mjs',
      ],
      expectedSecrets: {
        AI_OFFICE_HEADLESS_TRANSPORT: 'provider-native',
        AI_OFFICE_CODEX_AUTH_HOME: '/openhands-state/codex-business',
      },
    },
    {
      selection: {
        backend: 'dsh-acp',
        model: 'deepseek-v4-flash',
        role: 'IMPLEMENTATION',
        transport: 'LITELLM_MANAGED',
      },
      phase: 'IMPLEMENT',
      expectedProvider: 'dsh-managed-coding',
      expectedCommand: ['/opt/hermes-ai-office-tools/harness_agent_launcher.sh', 'dsh-acp'],
      expectedSecrets: {
        DSH_ACP_MODEL: 'deepseek-v4-flash',
        DEEPSEEK_API_KEY: secrets.liteLlmApiKey,
        DEEPSEEK_BASE_URL: 'http://litellm.test/v1',
        HERMES_V3_EXECUTION_ID: 'exec-1',
        HERMES_V3_WORKSPACE_REF: '/workspace/executions/exec-1/repo',
        GIT_AUTHOR_NAME: 'Pixel Agent',
        GIT_AUTHOR_EMAIL: 'pixel-agent@localhost',
        GIT_COMMITTER_NAME: 'Pixel Agent',
        GIT_COMMITTER_EMAIL: 'pixel-agent@localhost',
        PIXEL_V4_IMPLEMENTATION_EVIDENCE_PATH:
          '/workspace/executions/exec-1/repo/.pixel-v4-completion-evidence.json',
      },
    },
    {
      selection: {
        backend: 'zcode-acp',
        model: 'glm-5.2',
        role: 'IMPLEMENTATION',
        transport: 'LITELLM_MANAGED',
      },
      phase: 'IMPLEMENT',
      expectedProvider: 'zcode-managed-coding',
      expectedCommand: ['/opt/hermes-ai-office-tools/harness_agent_launcher.sh', 'zcode-acp'],
      expectedSecrets: {
        ZCODE_MODEL: 'glm-5.2',
        ZCODE_API_KEY: secrets.liteLlmApiKey,
        ZCODE_BASE_URL: 'http://litellm.test/v1',
        GIT_AUTHOR_NAME: 'Pixel Agent',
        GIT_AUTHOR_EMAIL: 'pixel-agent@localhost',
        GIT_COMMITTER_NAME: 'Pixel Agent',
        GIT_COMMITTER_EMAIL: 'pixel-agent@localhost',
        PIXEL_V4_IMPLEMENTATION_EVIDENCE_PATH:
          '/workspace/executions/exec-1/repo/.pixel-v4-completion-evidence.json',
      },
    },
    {
      selection: {
        backend: 'claude-code-acp',
        model: 'claude-opus-5',
        role: 'REVIEW',
        transport: 'LITELLM_MANAGED',
      },
      phase: 'REVIEW',
      expectedProvider: 'claude-code-independent-review',
      expectedCommand: [
        '/usr/local/bin/node',
        '/opt/hermes-ai-office-tools/headless_review_acp.mjs',
      ],
      expectedSecrets: {
        AI_OFFICE_HEADLESS_DRIVER: 'claude',
        AI_OFFICE_HEADLESS_MODEL: 'claude-opus-5',
        AI_OFFICE_LITELLM_API_KEY: secrets.liteLlmApiKey,
      },
    },
  ] as const;

  for (const item of cases) {
    const provider = createOpenHandsProviderForSelection(common, item.selection);
    const snapshot = await provider.launch(launchInput(item.phase));
    const body = JSON.parse(String(requests.at(-1)!.init.body)) as Record<string, any>;
    assert.equal(snapshot.provider, item.expectedProvider);
    assert.equal(body.agent.kind, 'ACPAgent');
    assert.deepEqual(body.agent.acp_command, item.expectedCommand);
    assert.equal(body.agent.acp_model, item.selection.model);
    for (const [name, value] of Object.entries(item.expectedSecrets))
      assert.equal(body.secrets[name].value, value);
    const prompt = String(body.initial_message.content[0].text);
    if (item.selection.backend === 'dsh-acp' || item.selection.backend === 'zcode-acp') {
      assert.match(prompt, /\.pixel-v4-completion-evidence\.json/);
      assert.match(prompt, /Do not git add or commit it/);
    } else {
      assert.match(prompt, /\/workspace\/executions\/exec-1\/evidence\.json/);
    }
    assert.equal(JSON.stringify(snapshot).includes(secrets.liteLlmApiKey), false);
    assert.equal(JSON.stringify(snapshot).includes(secrets.sessionApiKey), false);
  }
});

test('model-native ACP runtime probe performs a real bounded turn with probe-only secrets', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fake = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const value = String(url);
    requests.push({ url: value, init });
    if (value.endsWith('/api/conversations') && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, any>;
      return new Response(
        JSON.stringify({
          id: 'runtime-probe-session',
          execution_status: 'finished',
          workspace: body.workspace,
          tags: body.tags,
        }),
        { status: 201 },
      );
    }
    if (value.endsWith('/api/conversations/runtime-probe-session/agent_final_response'))
      return new Response(JSON.stringify({ response: 'READY' }), { status: 200 });
    if (value.includes('/api/conversations/runtime-probe-session/events/search'))
      return new Response(JSON.stringify({ items: [{ id: 'probe-event', kind: 'ActionEvent' }] }), {
        status: 200,
      });
    if (value.endsWith('/api/conversations/runtime-probe-session') && init.method === 'DELETE')
      return new Response('', { status: 204 });
    throw new Error('unexpected request ' + value + ' ' + String(init.method));
  }) as typeof fetch;
  const provider = createOpenHandsProviderForSelection(options(fake), {
    backend: 'codex-acp',
    model: 'route-orcai-gpt-5.6-luna',
    role: 'IMPLEMENTATION',
    transport: 'LITELLM_MANAGED',
  });
  const input = launchInput('IMPLEMENT');
  const result = await provider.probeRuntime!({
    probeId: 'runtime-probe-1',
    sourceRevision: input.sourceRevision,
    workspace: { ...input.workspace, executionId: 'runtime-probe-1' },
  });
  assert.equal(result.ready, true);
  assert.equal(result.status, 'SUCCEEDED');
  const create = requests.find(
    (request) => request.url.endsWith('/api/conversations') && request.init.method === 'POST',
  )!;
  const body = JSON.parse(String(create.init.body)) as Record<string, any>;
  assert.equal(body.agent.kind, 'ACPAgent');
  assert.equal(body.agent.acp_model, 'route-orcai-gpt-5.6-luna');
  assert.equal(body.max_iterations, 3);
  assert.equal(body.tags.role, 'runtimeprobe');
  assert.match(String(body.initial_message.content[0].text), /git status --short/);
  assert.equal(body.secrets.AI_OFFICE_HEADLESS_ROLE.value, 'planner');
  assert.equal(body.secrets.AI_OFFICE_HEADLESS_REASONING_EFFORT.value, 'low');
  assert.equal(body.secrets.PIXEL_V4_IMPLEMENTATION_EVIDENCE_PATH, undefined);
  assert.equal(body.secrets.PIXEL_V4_SOURCE_SHA, undefined);
  assert.ok(requests.some((request) => request.init.method === 'DELETE'));
});

test('provider-native Codex does not require LiteLLM credentials and builtin fallback is explicit', async () => {
  const fake = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as Record<string, any>;
    return new Response(
      JSON.stringify({
        id: 'native-no-key',
        execution_status: 'running',
        workspace: body.workspace,
        tags: body.tags,
      }),
      { status: 201 },
    );
  }) as typeof fetch;
  const provider = createOpenHandsProviderForSelection(
    { baseUrl: 'http://openhands.test', sessionApiKey: secrets.sessionApiKey, fetchImpl: fake },
    {
      backend: 'codex-acp',
      model: 'gpt-5.6-sol',
      role: 'REVIEW',
      transport: 'PROVIDER_NATIVE',
    },
  );
  assert.equal(provider instanceof OpenHandsCodexBusinessReviewProvider, true);
  await provider.launch(launchInput('REVIEW'));

  const fallback = createOpenHandsProviderForSelection(options(fake), {
    backend: 'openhands-builtin',
    model: 'unlisted-experimental-model',
    role: 'IMPLEMENTATION',
    transport: 'LITELLM_MANAGED',
  });
  assert.equal(fallback instanceof OpenHandsExecutionProvider, true);
  assert.throws(
    () =>
      createOpenHandsProviderForSelection(options(fake), {
        backend: 'dsh-acp',
        model: 'deepseek-v4-flash',
        role: 'REVIEW',
        transport: 'LITELLM_MANAGED',
      }),
    (error: unknown) => error instanceof V4Error && error.code === 'DSH_REVIEW_UNSUPPORTED',
  );
});

test('OpenHands launch explicitly runs an idle initial conversation before returning', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  let running = false;
  const fake = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const value = String(url);
    calls.push({ url: value, method: String(init.method ?? 'GET') });
    if (value.endsWith('/api/conversations') && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, any>;
      return new Response(
        JSON.stringify({
          id: 'idle-session',
          execution_status: 'idle',
          workspace: body.workspace,
          tags: body.tags,
        }),
        { status: 201 },
      );
    }
    if (value.endsWith('/api/conversations/idle-session/run') && init.method === 'POST') {
      running = true;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (value.endsWith('/api/conversations/idle-session')) {
      return new Response(
        JSON.stringify({ id: 'idle-session', execution_status: running ? 'running' : 'idle' }),
        { status: 200 },
      );
    }
    throw new Error('unexpected request ' + value);
  }) as typeof fetch;
  const provider = new OpenHandsExecutionProvider(options(fake));
  const snapshot = await provider.launch(launchInput('IMPLEMENT'));
  assert.equal(snapshot.status, 'RUNNING');
  assert.deepEqual(
    calls.map((call) => [call.method, call.url.replace('http://openhands.test', '')]),
    [
      ['POST', '/api/conversations'],
      ['POST', '/api/conversations/idle-session/run'],
      ['GET', '/api/conversations/idle-session'],
      ['GET', '/api/conversations/idle-session/events/search?limit=20&sort_order=TIMESTAMP_DESC'],
    ],
  );
});

test('OpenHands launch never interrupts an initial turn that is already running', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const fake = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const value = String(url);
    calls.push({ url: value, method: String(init.method ?? 'GET') });
    if (value.endsWith('/api/conversations') && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, any>;
      return new Response(
        JSON.stringify({
          id: 'race-session',
          execution_status: 'idle',
          workspace: body.workspace,
          tags: body.tags,
        }),
        { status: 201 },
      );
    }
    if (value.endsWith('/api/conversations/race-session/run') && init.method === 'POST') {
      return new Response(JSON.stringify({ detail: 'Conversation already running.' }), {
        status: 409,
      });
    }
    if (value.endsWith('/api/conversations/race-session')) {
      return new Response(JSON.stringify({ id: 'race-session', execution_status: 'running' }), {
        status: 200,
      });
    }
    if (value.endsWith('/api/conversations/race-session/interrupt')) {
      throw new Error('initial active turn must not be interrupted');
    }
    throw new Error('unexpected request ' + value);
  }) as typeof fetch;
  const provider = new OpenHandsExecutionProvider(options(fake));
  const snapshot = await provider.launch(launchInput('IMPLEMENT'));
  assert.equal(snapshot.status, 'RUNNING');
  assert.deepEqual(
    calls.map((call) => [call.method, call.url.replace('http://openhands.test', '')]),
    [
      ['POST', '/api/conversations'],
      ['POST', '/api/conversations/race-session/run'],
      ['GET', '/api/conversations/race-session'],
      ['GET', '/api/conversations/race-session/events/search?limit=20&sort_order=TIMESTAMP_DESC'],
    ],
  );
});

test('OpenHands recovery is paginated, provenance checked and duplicate-safe', async () => {
  let mode: 'single' | 'duplicate' | 'mismatch' = 'single';
  const fake = (async (url: string | URL | Request) => {
    if (!String(url).includes('/api/conversations/search')) throw new Error('unexpected request');
    const matching = {
      id: 'session-1',
      execution_status: 'paused',
      created_at: '2026-09-01T00:00:01.000Z',
      workspace: { working_dir: '/workspace/executions/exec-1/repo' },
      tags: { execution: 'exec1', project: 'pixel-agents', phase: 'implement' },
    };
    if (mode === 'duplicate')
      return new Response(JSON.stringify({ items: [matching, { ...matching, id: 'session-2' }] }), {
        status: 200,
      });
    if (mode === 'mismatch')
      return new Response(
        JSON.stringify({ items: [{ ...matching, workspace: { working_dir: '/wrong' } }] }),
        { status: 200 },
      );
    return new Response(JSON.stringify({ items: [matching] }), { status: 200 });
  }) as typeof fetch;
  const provider = new OpenHandsExecutionProvider(options(fake));
  const input = {
    executionId: 'exec-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    projectKey: 'pixel-agents',
    phase: 'IMPLEMENT' as const,
    expectedWorkspacePath: '/workspace/executions/exec-1/repo',
  };
  assert.equal((await provider.recover(input))?.providerSessionId, 'session-1');
  mode = 'duplicate';
  await assert.rejects(
    () => provider.recover(input),
    (error: unknown) => error instanceof V4Error && error.code === 'OPENHANDS_EXECUTION_DUPLICATE',
  );
  mode = 'mismatch';
  await assert.rejects(
    () => provider.recover(input),
    (error: unknown) =>
      error instanceof V4Error && error.code === 'OPENHANDS_WORKSPACE_PROVENANCE_MISMATCH',
  );
});

test('OpenHands replacement conversation is crash-safe and excluded from initial recovery duplicates', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let replacement: Record<string, any> | undefined;
  const fake = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const value = String(url);
    requests.push({ url: value, init });
    if (value.includes('/api/conversations/search')) {
      return new Response(
        JSON.stringify({
          items: replacement
            ? [
                replacement,
                {
                  id: 'original-session',
                  execution_status: 'paused',
                  created_at: '2026-09-01T00:00:00.000Z',
                  workspace: { working_dir: '/workspace/executions/exec-1/repo' },
                  tags: { execution: 'exec1', project: 'pixel-agents', phase: 'implement' },
                },
              ]
            : [],
        }),
        { status: 200 },
      );
    }
    if (value.endsWith('/api/conversations') && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, any>;
      replacement = {
        id: 'replacement-session',
        execution_status: 'running',
        created_at: '2026-09-01T00:01:00.000Z',
        workspace: body.workspace,
        tags: body.tags,
      };
      return new Response(JSON.stringify(replacement), { status: 201 });
    }
    if (value.endsWith('/api/conversations/replacement-session'))
      return new Response(JSON.stringify(replacement), { status: 200 });
    throw new Error('unexpected request ' + value);
  }) as typeof fetch;
  const provider = new OpenHandsExecutionProvider(options(fake));
  const input: ProviderSessionReplacementInput = {
    ...launchInput('IMPLEMENT'),
    previousProviderSessionId: 'original-session',
    recoveryKey: 'replace:exec-1:original-session',
    instruction: 'Preserve the existing workspace and finish the bounded work.',
  };
  const first = await provider.replace(input);
  const second = await provider.replace(input);
  assert.equal(first.providerSessionId, 'replacement-session');
  assert.equal(second.providerSessionId, 'replacement-session');
  const creates = requests.filter(
    (request) => request.url.endsWith('/api/conversations') && request.init.method === 'POST',
  );
  assert.equal(creates.length, 1);
  const createBody = JSON.parse(String(creates[0]!.init.body)) as Record<string, any>;
  assert.match(String(createBody.tags.recovery), /^repl-[0-9a-f]{40}$/);
  assert.match(createBody.initial_message.content[0].text, /replaces a stalled provider session/);
  assert.match(createBody.initial_message.content[0].text, /Preserve the existing workspace/);
  const recovered = await provider.recover({
    executionId: 'exec-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    projectKey: 'pixel-agents',
    phase: 'IMPLEMENT',
    expectedWorkspacePath: '/workspace/executions/exec-1/repo',
  });
  assert.equal(recovered?.providerSessionId, 'original-session');
});

test('OpenHands progress fingerprint advances only on repository/tool activity, not liveness-only events', async () => {
  let eventId = 'event-1';
  let eventKind = 'ActionEvent';
  const fake = (async (url: string | URL | Request) => {
    const value = String(url);
    if (value.endsWith('/api/conversations/progress-session'))
      return new Response(
        JSON.stringify({
          id: 'progress-session',
          execution_status: 'running',
          updated_at: '2026-09-04T01:00:00.000Z',
        }),
        { status: 200 },
      );
    if (value.includes('/api/conversations/progress-session/events/search'))
      return new Response(
        JSON.stringify({
          items: [
            {
              id: eventId,
              kind: eventKind,
              timestamp:
                eventId === 'event-1' ? '2026-09-04T01:00:01.000Z' : '2026-09-04T01:00:02.000Z',
              content: 'must-not-enter-progress-state',
            },
          ],
        }),
        { status: 200 },
      );
    throw new Error('unexpected request ' + value);
  }) as typeof fetch;
  const provider = new OpenHandsExecutionProvider(options(fake));
  const first = await provider.inspect('progress-session');
  eventId = 'event-2';
  const second = await provider.inspect('progress-session');
  assert.equal(first.status, 'RUNNING');
  assert.equal(typeof first.progressFingerprint, 'string');
  assert.equal(first.progressFingerprint?.length, 64);
  assert.notEqual(first.progressFingerprint, second.progressFingerprint);
  eventKind = 'MessageEvent';
  eventId = 'event-3';
  const messageOnly = await provider.inspect('progress-session');
  eventId = 'event-4';
  const laterMessageOnly = await provider.inspect('progress-session');
  assert.equal(messageOnly.progressFingerprint, laterMessageOnly.progressFingerprint);
  assert.equal(JSON.stringify(first).includes('must-not-enter-progress-state'), false);
});

test('OpenHands inspect, continue and cancel sanitize terminal provider evidence', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  let state: 'error' | 'paused' = 'error';
  const fake = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const value = String(url);
    calls.push({ url: value, method: String(init.method ?? 'GET') });
    if (value.endsWith('/events') && init.method === 'POST')
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    if (value.endsWith('/pause') && init.method === 'POST') {
      state = 'paused';
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (value.endsWith('/agent_final_response'))
      return new Response(JSON.stringify({ response: 'failed without ' + secrets.liteLlmApiKey }), {
        status: 200,
      });
    if (value.includes('/events/search'))
      return new Response(
        JSON.stringify({
          items: [
            {
              kind: 'ConversationErrorEvent',
              code: 'ServiceUnavailableError',
              detail:
                'Authorization: Bearer token-value and ' +
                secrets.sessionApiKey +
                ' ' +
                secrets.liteLlmApiKey,
            },
          ],
        }),
        { status: 200 },
      );
    if (value.endsWith('/api/conversations/session-1'))
      return new Response(JSON.stringify({ id: 'session-1', execution_status: state }), {
        status: 200,
      });
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

test('OpenHands maps finished ACP transport errors to retryable provider failures', async () => {
  const fake = (async (url: string | URL | Request) => {
    const value = String(url);
    if (value.endsWith('/agent_final_response')) {
      return new Response(
        JSON.stringify({
          response:
            'ACP error: api_key=sk-transport-secret\nworker finalization completed without repository command or file-change activity',
        }),
        { status: 200 },
      );
    }
    if (value.endsWith('/api/conversations/session-transport-error')) {
      return new Response(
        JSON.stringify({
          id: 'session-transport-error',
          execution_status: 'finished',
        }),
        { status: 200 },
      );
    }
    if (value.includes('/events/search'))
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    throw new Error('unexpected request ' + value);
  }) as typeof fetch;
  const provider = new OpenHandsCodexManagedExecutionProvider(options(fake));
  const snapshot = await provider.inspect('session-transport-error');
  assert.equal(snapshot.status, 'FAILED');
  assert.equal(snapshot.errorCode, 'ACP error: api_key=[REDACTED]');
  assert.equal(snapshot.retryable, true);
  assert.equal(JSON.stringify(snapshot).includes('sk-transport-secret'), false);
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
      if (runAttempts === 1)
        return new Response(JSON.stringify({ detail: 'still running' }), { status: 409 });
      state = 'running';
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (value.endsWith('/agent_final_response'))
      return new Response(JSON.stringify({ response: '' }), { status: 200 });
    if (value.includes('/events/search'))
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (value.endsWith('/api/conversations/session-stuck'))
      return new Response(JSON.stringify({ id: 'session-stuck', execution_status: state }), {
        status: 200,
      });
    throw new Error('unexpected request ' + value);
  }) as typeof fetch;
  const provider = new OpenHandsExecutionProvider(options(fake));
  const snapshot = await provider.continue('session-stuck', 'Continue the same bounded execution.');
  assert.equal(snapshot.status, 'RUNNING');
  assert.equal(runAttempts, 2);
  assert.ok(calls.some((call) => call.url.endsWith('/interrupt') && call.method === 'POST'));
});

test('OpenHands status and transport failures fail closed', async () => {
  assert.deepEqual(
    [
      'created',
      'queued',
      'running',
      'idle',
      'paused',
      'waiting_for_confirmation',
      'finished',
      'error',
      'stuck',
      'deleting',
      'other',
    ].map(mapOpenHandsStatus),
    [
      'CREATED',
      'QUEUED',
      'RUNNING',
      'PAUSED',
      'PAUSED',
      'WAITING_FOR_CONFIRMATION',
      'SUCCEEDED',
      'FAILED',
      'STUCK',
      'CANCELLED',
      'UNKNOWN',
    ],
  );
  const httpFailure = new OpenHandsExecutionProvider(
    options((async () => new Response('busy', { status: 503 })) as typeof fetch),
  );
  await assert.rejects(
    () => httpFailure.inspect('session'),
    (error: unknown) => error instanceof V4Error && error.code === 'OPENHANDS_HTTP_503',
  );
  const timeout = new OpenHandsExecutionProvider(
    options((async () => {
      const error = new Error('timeout');
      error.name = 'TimeoutError';
      throw error;
    }) as typeof fetch),
  );
  await assert.rejects(
    () => timeout.inspect('session'),
    (error: unknown) => error instanceof V4Error && error.code === 'OPENHANDS_TIMEOUT',
  );
});

test('model-native runtime probe classifies finished ACP transport errors without exposing response text', async () => {
  const fake = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const value = String(url);
    if (value.endsWith('/api/conversations') && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, any>;
      return new Response(
        JSON.stringify({
          id: 'runtime-probe-transport-error',
          execution_status: 'finished',
          workspace: body.workspace,
          tags: body.tags,
        }),
        { status: 201 },
      );
    }
    if (value.endsWith('/api/conversations/runtime-probe-transport-error/agent_final_response'))
      return new Response(JSON.stringify({ response: 'ACP error: Connection closed' }), {
        status: 200,
      });
    if (value.includes('/api/conversations/runtime-probe-transport-error/events/search'))
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (
      value.endsWith('/api/conversations/runtime-probe-transport-error') &&
      init.method === 'DELETE'
    )
      return new Response('', { status: 204 });
    throw new Error('unexpected request ' + value + ' ' + String(init.method));
  }) as typeof fetch;
  const provider = createOpenHandsProviderForSelection(options(fake), {
    backend: 'codex-acp',
    model: 'route-orcai-gpt-5.6-luna',
    role: 'IMPLEMENTATION',
    transport: 'LITELLM_MANAGED',
  });
  const input = launchInput('IMPLEMENT');
  const result = await provider.probeRuntime!({
    probeId: 'runtime-probe-error',
    sourceRevision: input.sourceRevision,
    workspace: { ...input.workspace, executionId: 'runtime-probe-error' },
  });
  assert.equal(result.ready, false);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.errorCode, 'RUNTIME_PROBE_TRANSPORT_ERROR');
  assert.equal('finalResponse' in result, false);
});

test('runtime probe distinguishes a model runtime with no repository tool activity from transport failure', async () => {
  const fake = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const value = String(url);
    if (value.endsWith('/api/conversations') && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, any>;
      return new Response(
        JSON.stringify({
          id: 'runtime-probe-no-tools',
          execution_status: 'finished',
          workspace: body.workspace,
          tags: body.tags,
        }),
        { status: 201 },
      );
    }
    if (value.endsWith('/api/conversations/runtime-probe-no-tools/agent_final_response'))
      return new Response(
        JSON.stringify({
          response:
            'PLAN_TRANSPORT_ERROR\nplanner completed without independent repository command activity',
        }),
        { status: 200 },
      );
    if (value.includes('/api/conversations/runtime-probe-no-tools/events/search'))
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (value.endsWith('/api/conversations/runtime-probe-no-tools') && init.method === 'DELETE')
      return new Response('', { status: 204 });
    throw new Error('unexpected request ' + value + ' ' + String(init.method));
  }) as typeof fetch;
  const provider = createOpenHandsProviderForSelection(options(fake), {
    backend: 'codex-acp',
    model: 'route-orcai-gpt-5.6-luna',
    role: 'IMPLEMENTATION',
    transport: 'LITELLM_MANAGED',
  });
  const input = launchInput('IMPLEMENT');
  const result = await provider.probeRuntime!({
    probeId: 'runtime-probe-no-tools',
    sourceRevision: input.sourceRevision,
    workspace: { ...input.workspace, executionId: 'runtime-probe-no-tools' },
  });
  assert.equal(result.ready, false);
  assert.equal(result.errorCode, 'RUNTIME_PROBE_TOOL_ACTIVITY_MISSING');
});
