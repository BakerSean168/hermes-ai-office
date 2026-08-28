import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { EnvFileValueProvider, OpenHandsExecutionHost } from '../src/v3/adapters/openHands.js';
import { DevelopmentPolicy } from '../src/v3/policy.js';

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('missing address'));
      else resolve(address.port);
    });
  });
}

const here = path.dirname(fileURLToPath(import.meta.url));
const policy = DevelopmentPolicy.fromFile(path.resolve(here, '../config/development-policy.yaml'));

test('OpenHands V3 adapter creates a correlated managed execution and normalizes usage', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openhands-v3-'));
  const envFile = path.join(directory, 'openhands.env');
  fs.writeFileSync(
    envFile,
    'SESSION_API_KEY=session-secret\nLITELLM_V3_KEY=virtual-secret\nLITELLM_V3_BASE_URL=http://127.0.0.1:4000\n',
  );
  let status = 'running';
  let createBody: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    if (request.headers['x-session-api-key'] !== 'session-secret') {
      response.writeHead(401).end('{}');
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health') {
      response.end('{"status":"ok"}');
      return;
    }
    if (request.url === '/api/conversations' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        createBody = JSON.parse(body);
        response.end(
          JSON.stringify({
            id: '11111111-1111-4111-8111-111111111111',
            execution_status: status,
            created_at: '2026-08-21T15:00:00Z',
            updated_at: '2026-08-21T15:00:01Z',
            stats: {},
          }),
        );
      });
      return;
    }
    if (request.url?.endsWith('/pause') && request.method === 'POST') {
      status = 'paused';
      response.end('{"success":true}');
      return;
    }
    if (request.url?.endsWith('/agent_final_response')) {
      response.end('{"response":"PLAN_OK"}');
      return;
    }
    if (request.url?.includes('/events/search')) {
      assert.doesNotMatch(request.url, /[?&]kind=/);
      response.end(
        JSON.stringify({
          items: [
            { kind: 'ConversationStateUpdateEvent', key: 'execution_status', value: 'error' },
            {
              kind: 'ConversationErrorEvent',
              code: 'LLMServiceUnavailableError',
              detail: 'Error code: 503 - No available channel for model',
            },
          ],
        }),
      );
      return;
    }
    if (request.url?.startsWith('/api/conversations/')) {
      status = status === 'paused' || status === 'error' ? status : 'finished';
      response.end(
        JSON.stringify({
          id: '11111111-1111-4111-8111-111111111111',
          execution_status: status,
          created_at: '2026-08-21T15:00:00Z',
          updated_at: '2026-08-21T15:00:10Z',
          stats: {
            usage_to_metrics: {
              default: {
                accumulated_cost: 0.12,
                accumulated_token_usage: {
                  prompt_tokens: 100,
                  completion_tokens: 20,
                  cache_read_tokens: 10,
                  cache_write_tokens: 3,
                  reasoning_tokens: 5,
                },
                token_usages: [{}, {}],
              },
            },
          },
        }),
      );
      return;
    }
    response.writeHead(404).end('{}');
  });
  const port = await listen(server);
  const host = new OpenHandsExecutionHost({
    baseUrl: `http://127.0.0.1:${port}`,
    secrets: new EnvFileValueProvider(envFile),
    policy,
  });

  try {
    const created = await host.createExecution({
      executionId: 'exec_1',
      projectKey: 'pixel-agents',
      phase: 'INVESTIGATE_PLAN',
      objective: 'Investigate the issue.',
      repositoryPath: '/workspace/executions/exec_1/repo',
      selection: {
        backend: 'openhands-builtin',
        modelClass: 'planning-premium',
        transportMode: 'LITELLM_MANAGED',
        workspaceMode: 'read_oriented',
        sessionPolicy: 'fresh',
        reasons: [],
      },
      correlationMetadata: { execution_id: 'exec_1', phase: 'INVESTIGATE_PLAN' },
    });
    assert.equal(created.status, 'RUNNING');
    const body = createBody as any;
    assert.equal(body.agent.kind, 'Agent');
    assert.equal(body.agent.llm.model, 'litellm_proxy/planning-premium');
    assert.equal(body.agent.llm.base_url, 'http://127.0.0.1:4000');
    assert.equal(body.agent.llm.api_key, 'virtual-secret');
    assert.equal(body.agent.llm.api_mode, 'chat');
    assert.equal(body.agent.llm.reasoning_effort, null);
    assert.deepEqual(body.agent.llm.litellm_extra_body, { user: 'exec_1' });
    assert.deepEqual(
      body.agent.tools.map((tool: any) => tool.name),
      ['terminal', 'file_editor', 'task_tracker', 'task_tool_set'],
    );
    assert.deepEqual(body.tool_module_qualnames, {
      terminal: 'openhands.tools.terminal.definition',
      file_editor: 'openhands.tools.file_editor.definition',
      task_tracker: 'openhands.tools.task_tracker.definition',
      task_tool_set: 'openhands.tools.task.definition',
    });
    assert.equal(body.workspace.working_dir, '/workspace/executions/exec_1/repo');
    assert.equal(body.observability_metadata.execution_id, 'exec_1');
    assert.deepEqual(body.secrets.CI, { kind: 'StaticSecret', value: '1' });
    assert.deepEqual(body.secrets.NX_TUI, { kind: 'StaticSecret', value: 'false' });

    await host.createExecution({
      executionId: 'exec_supervisor_1',
      projectKey: 'pixel-agents',
      phase: 'ORCHESTRATE',
      objective: 'Supervise the active plan.',
      repositoryPath: '/workspace/executions/exec_supervisor_1/repo',
      selection: {
        backend: 'openhands-builtin',
        modelClass: 'planning-premium',
        transportMode: 'LITELLM_MANAGED',
        workspaceMode: 'read_oriented',
        sessionPolicy: 'fresh',
        reasons: [],
      },
      correlationMetadata: { execution_id: 'exec_supervisor_1', phase: 'ORCHESTRATE' },
    });
    const supervisorBody = createBody as any;
    assert.deepEqual(
      supervisorBody.agent.tools.map((tool: any) => tool.name),
      ['terminal', 'file_editor', 'task_tracker', 'task_tool_set'],
    );
    assert.equal(supervisorBody.tool_module_qualnames.ai_office_worker, undefined);

    await host.createExecution({
      executionId: 'exec_review_builtin_1',
      projectKey: 'pixel-agents',
      phase: 'VERIFY_REVIEW',
      objective: 'Review directly without nested subagents.',
      repositoryPath: '/workspace/executions/exec_review_builtin_1/repo',
      selection: {
        backend: 'openhands-builtin',
        modelClass: 'gpt-5.6-sol',
        transportMode: 'LITELLM_MANAGED',
        workspaceMode: 'review_snapshot',
        sessionPolicy: 'fresh_required',
        reasons: [],
      },
      correlationMetadata: { execution_id: 'exec_review_builtin_1', phase: 'VERIFY_REVIEW' },
    });
    const builtinReviewBody = createBody as any;
    assert.deepEqual(
      builtinReviewBody.agent.tools.map((tool: any) => tool.name),
      ['terminal', 'file_editor', 'task_tracker'],
    );
    assert.deepEqual(builtinReviewBody.tool_module_qualnames, {
      terminal: 'openhands.tools.terminal.definition',
      file_editor: 'openhands.tools.file_editor.definition',
      task_tracker: 'openhands.tools.task_tracker.definition',
    });

    const acpCreated = await host.createExecution({
      executionId: 'exec_acp_1',
      projectKey: 'pixel-agents',
      phase: 'IMPLEMENT',
      objective: 'Implement the bounded change.',
      repositoryPath: '/workspace/executions/exec_acp_1/repo',
      selection: {
        backend: 'opencode-acp',
        modelClass: 'implementation-efficient',
        transportMode: 'LITELLM_MANAGED',
        workspaceMode: 'isolated_write',
        sessionPolicy: 'fresh',
        reasons: [],
      },
      correlationMetadata: { execution_id: 'exec_acp_1', phase: 'IMPLEMENT' },
    });
    assert.equal(acpCreated.status, 'RUNNING');
    const acpBody = createBody as any;
    assert.equal(acpBody.agent.kind, 'ACPAgent');
    assert.deepEqual(acpBody.agent.acp_command, [
      '/opt/hermes-ai-office-tools/harness_agent_launcher.sh',
      'opencode',
      'acp',
    ]);
    assert.equal(acpBody.agent.acp_model, 'litellm-v3/implementation-efficient');
    assert.deepEqual(acpBody.secrets.HERMES_V3_EXECUTION_ID, {
      kind: 'StaticSecret',
      value: 'exec_acp_1',
    });
    assert.deepEqual(acpBody.secrets.LITELLM_V3_KEY, {
      kind: 'StaticSecret',
      value: 'virtual-secret',
    });
    assert.deepEqual(acpBody.secrets.LITELLM_V3_OPENAI_BASE_URL, {
      kind: 'StaticSecret',
      value: 'http://127.0.0.1:4000/v1',
    });

    await host.createExecution({
      executionId: 'exec_codex_business_planner_1',
      projectKey: 'pixel-agents',
      phase: 'INVESTIGATE_PLAN',
      objective: 'Plan with authenticated Business Codex.',
      repositoryPath: '/workspace/executions/exec_codex_business_planner_1/repo',
      selection: {
        backend: 'codex-business-planner-headless',
        modelClass: 'gpt-5.6-sol',
        transportMode: 'PROVIDER_NATIVE',
        workspaceMode: 'read_oriented',
        sessionPolicy: 'fresh',
        reasons: [],
      },
      correlationMetadata: {
        execution_id: 'exec_codex_business_planner_1',
        phase: 'INVESTIGATE_PLAN',
      },
    });
    const codexBusinessPlannerBody = createBody as any;
    assert.equal(codexBusinessPlannerBody.agent.acp_server, 'custom');
    assert.equal(codexBusinessPlannerBody.agent.acp_model, 'gpt-5.6-sol');
    assert.equal(codexBusinessPlannerBody.secrets.AI_OFFICE_HEADLESS_ROLE.value, 'planner');
    assert.equal(codexBusinessPlannerBody.secrets.AI_OFFICE_HEADLESS_MODEL.value, 'gpt-5.6-sol');
    assert.equal(
      codexBusinessPlannerBody.secrets.AI_OFFICE_HEADLESS_REASONING_EFFORT.value,
      'medium',
    );
    assert.equal(
      codexBusinessPlannerBody.secrets.AI_OFFICE_HEADLESS_TRANSPORT.value,
      'provider-native',
    );

    await host.createExecution({
      executionId: 'exec_codex_business_headless_1',
      projectKey: 'pixel-agents',
      phase: 'VERIFY_REVIEW',
      objective: 'Review with authenticated Business Codex.',
      repositoryPath: '/workspace/executions/exec_codex_business_headless_1/repo',
      selection: {
        backend: 'codex-business-review-headless',
        modelClass: 'gpt-5.6-sol',
        transportMode: 'PROVIDER_NATIVE',
        workspaceMode: 'review_snapshot',
        sessionPolicy: 'fresh_required',
        reasons: [],
      },
      correlationMetadata: {
        execution_id: 'exec_codex_business_headless_1',
        phase: 'VERIFY_REVIEW',
      },
    });
    const codexBusinessBody = createBody as any;
    assert.equal(codexBusinessBody.agent.acp_server, 'custom');
    assert.equal(codexBusinessBody.agent.acp_model, 'gpt-5.6-sol');
    assert.deepEqual(codexBusinessBody.agent.acp_command, [
      '/usr/local/bin/node',
      '/opt/hermes-ai-office-tools/headless_review_acp.mjs',
    ]);
    assert.equal(codexBusinessBody.secrets.AI_OFFICE_HEADLESS_DRIVER.value, 'codex');
    assert.equal(codexBusinessBody.secrets.AI_OFFICE_HEADLESS_TRANSPORT.value, 'provider-native');
    assert.equal(codexBusinessBody.secrets.AI_OFFICE_HEADLESS_MODEL.value, 'gpt-5.6-sol');
    assert.equal(codexBusinessBody.secrets.AI_OFFICE_HEADLESS_REASONING_EFFORT.value, 'medium');
    assert.equal(
      codexBusinessBody.secrets.AI_OFFICE_CODEX_AUTH_HOME.value,
      '/openhands-state/codex-business',
    );
    assert.equal(codexBusinessBody.secrets.AI_OFFICE_LITELLM_BASE_URL, undefined);
    assert.equal(codexBusinessBody.secrets.AI_OFFICE_LITELLM_API_KEY, undefined);
    assert.equal(codexBusinessBody.secrets.CODEX_API_KEY, undefined);

    await host.createExecution({
      executionId: 'exec_codex_business_worker_1',
      projectKey: 'pixel-agents',
      phase: 'IMPLEMENT',
      objective: 'Implement with authenticated Business Codex.',
      repositoryPath: '/workspace/executions/exec_codex_business_worker_1/repo',
      selection: {
        backend: 'codex-business-worker-headless',
        modelClass: 'gpt-5.6-luna',
        transportMode: 'PROVIDER_NATIVE',
        workspaceMode: 'isolated_write',
        sessionPolicy: 'fresh',
        reasons: [],
      },
      correlationMetadata: {
        execution_id: 'exec_codex_business_worker_1',
        phase: 'IMPLEMENT',
      },
    });
    const codexBusinessWorkerBody = createBody as any;
    assert.equal(codexBusinessWorkerBody.agent.acp_server, 'custom');
    assert.equal(codexBusinessWorkerBody.agent.acp_model, 'gpt-5.6-luna');
    assert.deepEqual(codexBusinessWorkerBody.agent.acp_command, [
      '/usr/local/bin/node',
      '/opt/hermes-ai-office-tools/headless_review_acp.mjs',
    ]);
    assert.equal(codexBusinessWorkerBody.secrets.AI_OFFICE_HEADLESS_DRIVER.value, 'codex');
    assert.equal(codexBusinessWorkerBody.secrets.AI_OFFICE_HEADLESS_ROLE.value, 'worker');
    assert.equal(
      codexBusinessWorkerBody.secrets.AI_OFFICE_HEADLESS_TRANSPORT.value,
      'provider-native',
    );
    assert.equal(codexBusinessWorkerBody.secrets.AI_OFFICE_HEADLESS_MODEL.value, 'gpt-5.6-luna');
    assert.equal(
      codexBusinessWorkerBody.secrets.AI_OFFICE_HEADLESS_REASONING_EFFORT.value,
      'xhigh',
    );
    assert.equal(
      codexBusinessWorkerBody.secrets.AI_OFFICE_CODEX_AUTH_HOME.value,
      '/openhands-state/codex-business',
    );
    assert.equal(codexBusinessWorkerBody.secrets.AI_OFFICE_LITELLM_BASE_URL, undefined);
    assert.equal(codexBusinessWorkerBody.secrets.AI_OFFICE_LITELLM_API_KEY, undefined);
    assert.equal(codexBusinessWorkerBody.secrets.CODEX_API_KEY, undefined);

    await host.createExecution({
      executionId: 'exec_codex_headless_1',
      projectKey: 'pixel-agents',
      phase: 'VERIFY_REVIEW',
      objective: 'Review with headless Codex.',
      repositoryPath: '/workspace/executions/exec_codex_headless_1/repo',
      selection: {
        backend: 'codex-review-headless',
        modelClass: 'gpt-5.6-sol',
        transportMode: 'LITELLM_MANAGED',
        workspaceMode: 'review_snapshot',
        sessionPolicy: 'fresh_required',
        reasons: [],
      },
      correlationMetadata: {
        execution_id: 'exec_codex_headless_1',
        phase: 'VERIFY_REVIEW',
      },
    });
    const codexHeadlessBody = createBody as any;
    assert.equal(codexHeadlessBody.agent.acp_server, 'custom');
    assert.equal(codexHeadlessBody.agent.acp_model, 'gpt-5.6-sol');
    assert.deepEqual(codexHeadlessBody.agent.acp_command, [
      '/usr/local/bin/node',
      '/opt/hermes-ai-office-tools/headless_review_acp.mjs',
    ]);
    assert.equal(codexHeadlessBody.secrets.AI_OFFICE_HEADLESS_MODEL.value, 'gpt-5.6-sol');
    assert.equal(
      codexHeadlessBody.secrets.AI_OFFICE_LITELLM_BASE_URL.value,
      'http://127.0.0.1:4000',
    );
    assert.equal(codexHeadlessBody.secrets.AI_OFFICE_LITELLM_API_KEY.value, 'virtual-secret');
    assert.equal(codexHeadlessBody.secrets.AI_OFFICE_HEADLESS_DRIVER.value, 'codex');
    assert.equal(
      codexHeadlessBody.secrets.AI_OFFICE_CODEX_BIN.value,
      '/openhands-state/tooling/node_modules/.bin/codex',
    );

    await host.createExecution({
      executionId: 'exec_claude_headless_1',
      projectKey: 'pixel-agents',
      phase: 'VERIFY_REVIEW',
      objective: 'Review with headless Claude Code.',
      repositoryPath: '/workspace/executions/exec_claude_headless_1/repo',
      selection: {
        backend: 'claude-code-review-headless',
        modelClass: 'gpt-5.6-sol',
        transportMode: 'LITELLM_MANAGED',
        workspaceMode: 'review_snapshot',
        sessionPolicy: 'fresh_required',
        reasons: [],
      },
      correlationMetadata: {
        execution_id: 'exec_claude_headless_1',
        phase: 'VERIFY_REVIEW',
      },
    });
    const claudeHeadlessBody = createBody as any;
    assert.equal(claudeHeadlessBody.agent.acp_server, 'custom');
    assert.equal(claudeHeadlessBody.agent.acp_model, 'gpt-5.6-sol');
    assert.deepEqual(claudeHeadlessBody.agent.acp_command, [
      '/usr/local/bin/node',
      '/opt/hermes-ai-office-tools/headless_review_acp.mjs',
    ]);
    assert.equal(claudeHeadlessBody.secrets.AI_OFFICE_HEADLESS_DRIVER.value, 'claude');
    assert.equal(
      claudeHeadlessBody.secrets.AI_OFFICE_CLAUDE_BIN.value,
      '/openhands-state/tooling/node_modules/.bin/claude',
    );
    assert.equal(claudeHeadlessBody.secrets.AI_OFFICE_LITELLM_API_KEY.value, 'virtual-secret');

    await host.createExecution({
      executionId: 'exec_codex_1',
      projectKey: 'pixel-agents',
      phase: 'VERIFY_REVIEW',
      objective: 'Review with Codex.',
      repositoryPath: '/workspace/executions/exec_codex_1/repo',
      selection: {
        backend: 'codex-acp',
        modelClass: 'review-premium',
        transportMode: 'LITELLM_MANAGED',
        workspaceMode: 'review_snapshot',
        sessionPolicy: 'fresh_required',
        reasons: [],
      },
      correlationMetadata: { execution_id: 'exec_codex_1', phase: 'VERIFY_REVIEW' },
    });
    const codexBody = createBody as any;
    assert.equal(codexBody.agent.acp_server, 'codex');
    assert.equal(codexBody.agent.acp_model, 'review-premium');
    assert.equal(codexBody.secrets.CODEX_API_KEY.value, 'virtual-secret');
    assert.equal(codexBody.secrets.MODEL_PROVIDER.value, 'hermes-litellm');
    assert.equal(codexBody.secrets.NO_BROWSER.value, '1');
    const codexConfig = JSON.parse(codexBody.secrets.CODEX_CONFIG.value);
    assert.equal(codexConfig.model, 'review-premium');
    assert.equal(codexConfig.model_provider, 'hermes-litellm');
    assert.deepEqual(codexConfig.agents, { enabled: false });
    assert.deepEqual(codexConfig.features, {
      multi_agent: false,
      multi_agent_v2: { enabled: false },
    });
    assert.deepEqual(codexConfig.model_providers['hermes-litellm'], {
      name: 'Hermes LiteLLM',
      base_url: 'http://127.0.0.1:4000/v1',
      env_key: 'CODEX_API_KEY',
      wire_api: 'responses',
    });

    await host.createExecution({
      executionId: 'exec_codex_luna_1',
      projectKey: 'pixel-agents',
      phase: 'IMPLEMENT',
      objective: 'Implement with managed Codex Luna.',
      repositoryPath: '/workspace/executions/exec_codex_luna_1/repo',
      selection: {
        backend: 'codex-acp',
        modelClass: 'implementation-efficient',
        transportMode: 'LITELLM_MANAGED',
        workspaceMode: 'isolated_write',
        sessionPolicy: 'fresh',
        reasons: [],
      },
      correlationMetadata: { execution_id: 'exec_codex_luna_1', phase: 'IMPLEMENT' },
    });
    const codexLunaBody = createBody as any;
    assert.equal(codexLunaBody.agent.acp_model, 'gpt-5.6-luna');
    const codexLunaConfig = JSON.parse(codexLunaBody.secrets.CODEX_CONFIG.value);
    assert.equal(codexLunaConfig.model, 'gpt-5.6-luna');
    assert.equal(codexLunaConfig.model_reasoning_effort, 'xhigh');

    await host.createExecution({
      executionId: 'exec_claude_1',
      projectKey: 'pixel-agents',
      phase: 'VERIFY_REVIEW',
      objective: 'Review with Claude Code.',
      repositoryPath: '/workspace/executions/exec_claude_1/repo',
      selection: {
        backend: 'claude-code-acp',
        modelClass: 'review-premium',
        transportMode: 'LITELLM_MANAGED',
        workspaceMode: 'review_snapshot',
        sessionPolicy: 'fresh_required',
        reasons: [],
      },
      correlationMetadata: { execution_id: 'exec_claude_1', phase: 'VERIFY_REVIEW' },
    });
    const claudeBody = createBody as any;
    assert.equal(claudeBody.agent.acp_server, 'claude-code');
    assert.equal(claudeBody.agent.acp_model, 'review-premium');
    assert.equal(claudeBody.secrets.ANTHROPIC_API_KEY.value, 'virtual-secret');
    assert.equal(claudeBody.secrets.ANTHROPIC_BASE_URL.value, 'http://127.0.0.1:4000');
    assert.equal(claudeBody.secrets.ANTHROPIC_CUSTOM_MODEL_OPTION.value, 'review-premium');

    await host.createExecution({
      executionId: 'exec_dsh_1',
      projectKey: 'pixel-agents',
      phase: 'IMPLEMENT',
      objective: 'Implement with DSH.',
      repositoryPath: '/workspace/executions/exec_dsh_1/repo',
      selection: {
        backend: 'dsh-acp',
        modelClass: 'implementation-efficient',
        transportMode: 'LITELLM_MANAGED',
        workspaceMode: 'isolated_write',
        sessionPolicy: 'fresh',
        reasons: [],
      },
      correlationMetadata: { execution_id: 'exec_dsh_1', phase: 'IMPLEMENT' },
    });
    const dshBody = createBody as any;
    assert.equal(dshBody.agent.acp_model, 'implementation-efficient');
    assert.equal(dshBody.secrets.DEEPSEEK_API_KEY.value, 'virtual-secret');
    assert.equal(dshBody.secrets.DEEPSEEK_BASE_URL.value, 'http://127.0.0.1:4000/v1');
    assert.equal(dshBody.secrets.DSH_ACP_MODEL.value, 'implementation-efficient');
    assert.equal(dshBody.secrets.DSH_HOME.value, '/openhands-state/dsh');
    assert.equal(dshBody.secrets.DSH_BIN.value, '/openhands-state/dsh-cli/node_modules/.bin/dsh');

    const completed = await host.getExecution(created.conversationId);
    assert.equal(completed.status, 'SUCCEEDED');
    assert.equal(completed.finalText, 'PLAN_OK');
    assert.deepEqual(completed.usage, {
      source: 'OPENHANDS_REPORTED',
      input: 100,
      output: 20,
      cachedInput: 10,
      cacheWrite: 3,
      reasoningOutput: 5,
      costUsd: 0.12,
      calls: 2,
    });

    status = 'error';
    const failed = await host.getExecution(created.conversationId);
    assert.equal(failed.status, 'FAILED');
    assert.deepEqual(failed.error, {
      code: 'LLMServiceUnavailableError',
      detail: 'Error code: 503 - No available channel for model',
      retryable: true,
    });

    const connectionClosedServer = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url?.includes('/events/search')) {
        response.end(
          JSON.stringify({
            items: [
              { kind: 'ConversationStateUpdateEvent', key: 'execution_status', value: 'error' },
              { kind: 'ConversationErrorEvent', code: 'ACPInitError', detail: 'Connection closed' },
            ],
          }),
        );
        return;
      }
      if (request.url?.startsWith('/api/conversations/')) {
        response.end(JSON.stringify({ id: created.conversationId, execution_status: 'error' }));
        return;
      }
      response.writeHead(404).end('{}');
    });
    const connectionPort = await listen(connectionClosedServer);
    try {
      const connectionHost = new OpenHandsExecutionHost({
        baseUrl: `http://127.0.0.1:${connectionPort}`,
        secrets: new EnvFileValueProvider(envFile),
        policy,
      });
      const connectionFailure = await connectionHost.getExecution(created.conversationId);
      assert.deepEqual(connectionFailure.error, {
        code: 'ACPInitError',
        detail: 'Connection closed',
        retryable: true,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        connectionClosedServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
