import fs from 'node:fs';

import type {
  BackendPolicyConfig,
  DevelopmentPolicy,
  ManagedEnvironmentSource,
} from '../policy.js';
import type {
  ExecutionHostCreateInput,
  ExecutionHostPort,
  ExecutionHostSnapshot,
} from '../ports.js';
import type { ExecutionFailure, ExecutionStatus, UsageSummary } from '../types.js';

interface JsonRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapStatus(value: unknown): ExecutionStatus {
  switch (String(value ?? '').toLowerCase()) {
    case 'running':
      return 'RUNNING';
    case 'paused':
      return 'PAUSED';
    case 'waiting_for_confirmation':
      return 'WAITING_FOR_CONFIRMATION';
    case 'finished':
      return 'SUCCEEDED';
    case 'error':
      return 'FAILED';
    case 'stuck':
      return 'STUCK';
    case 'deleting':
      return 'CANCELLED';
    case 'idle':
      return 'PAUSED';
    default:
      return 'UNKNOWN';
  }
}

function executionFailure(value: unknown): ExecutionFailure | undefined {
  const event = asRecord(value);
  const code = typeof event.code === 'string' ? event.code.trim() : '';
  if (!code) return undefined;
  const detail =
    typeof event.detail === 'string'
      ? event.detail
          .trim()
          .replace(/(authorization\s*:\s*bearer\s+)[^\s'",}]+/gi, '$1[REDACTED]')
          .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
          .slice(0, 2_000)
      : '';
  const failureText = `${code} ${detail}`;
  const retryable =
    /(?:ServiceUnavailable|RateLimit|Timeout|Connection|InternalServer)/i.test(failureText) ||
    /(?:HTTP\s*429|HTTP\s*5\d\d|Error code:\s*(?:429|5\d\d)|No available channel)/i.test(
      failureText,
    );
  return { code, ...(detail ? { detail } : {}), retryable };
}

function usageFromConversation(payload: JsonRecord): UsageSummary | null {
  const stats = asRecord(payload.stats);
  const usageToMetrics = asRecord(stats.usage_to_metrics);
  const buckets = Object.values(usageToMetrics).map(asRecord);
  if (buckets.length === 0) return null;
  let input = 0;
  let output = 0;
  let cachedInput = 0;
  let cacheWrite = 0;
  let reasoningOutput = 0;
  let costUsd = 0;
  let calls = 0;
  for (const bucket of buckets) {
    const tokenUsage = asRecord(bucket.accumulated_token_usage);
    input += number(tokenUsage.prompt_tokens);
    output += number(tokenUsage.completion_tokens);
    cachedInput += number(tokenUsage.cache_read_tokens);
    cacheWrite += number(tokenUsage.cache_write_tokens);
    reasoningOutput += number(tokenUsage.reasoning_tokens);
    costUsd += number(bucket.accumulated_cost);
    calls += Array.isArray(bucket.token_usages) ? bucket.token_usages.length : 0;
  }
  return {
    source: 'OPENHANDS_REPORTED',
    input,
    output,
    cachedInput,
    cacheWrite,
    reasoningOutput,
    costUsd,
    calls,
  };
}

export class EnvFileValueProvider {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  read(key: string): string {
    const text = fs.readFileSync(this.#path, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.trimStart().startsWith('#')) continue;
      const index = line.indexOf('=');
      if (index <= 0 || line.slice(0, index).trim() !== key) continue;
      const value = line.slice(index + 1).trim();
      if (!value) throw new Error(`EMPTY_SECRET:${key}`);
      return value;
    }
    throw new Error(`MISSING_SECRET:${key}`);
  }
}

export interface OpenHandsExecutionHostOptions {
  baseUrl: string;
  secrets: EnvFileValueProvider;
  policy: DevelopmentPolicy;
  sessionApiKeyName?: string;
  liteLlmKeyName?: string;
  liteLlmBaseUrlName?: string;
  requestTimeoutMs?: number;
}

export class OpenHandsExecutionHost implements ExecutionHostPort {
  readonly #baseUrl: string;
  readonly #secrets: EnvFileValueProvider;
  readonly #policy: DevelopmentPolicy;
  readonly #sessionApiKeyName: string;
  readonly #liteLlmKeyName: string;
  readonly #liteLlmBaseUrlName: string;
  readonly #requestTimeoutMs: number;

  constructor(options: OpenHandsExecutionHostOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#secrets = options.secrets;
    this.#policy = options.policy;
    this.#sessionApiKeyName = options.sessionApiKeyName ?? 'SESSION_API_KEY';
    this.#liteLlmKeyName = options.liteLlmKeyName ?? 'LITELLM_V3_KEY';
    this.#liteLlmBaseUrlName = options.liteLlmBaseUrlName ?? 'LITELLM_V3_BASE_URL';
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        'X-Session-API-Key': this.#secrets.read(this.#sessionApiKeyName),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(this.#requestTimeoutMs),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`OPENHANDS_HTTP_${response.status}:${text.slice(0, 300)}`);
    }
    return response;
  }

  async #json(path: string, init: RequestInit = {}): Promise<JsonRecord> {
    return asRecord(await (await this.#request(path, init)).json());
  }

  async health(): Promise<'OK' | 'DEGRADED' | 'UNAVAILABLE'> {
    try {
      const response = await this.#request('/health');
      return response.ok ? 'OK' : 'DEGRADED';
    } catch {
      return 'UNAVAILABLE';
    }
  }

  #builtInTools(input: ExecutionHostCreateInput): JsonRecord[] {
    const tools = [{ name: 'terminal' }, { name: 'file_editor' }, { name: 'task_tracker' }];
    if (['INVESTIGATE_PLAN', 'ORCHESTRATE'].includes(input.phase)) {
      tools.push({ name: 'task_tool_set' });
    }
    return tools;
  }

  #toolModuleQualnames(input: ExecutionHostCreateInput): Record<string, string> {
    const modules: Record<string, string> = {
      terminal: 'openhands.tools.terminal.definition',
      file_editor: 'openhands.tools.file_editor.definition',
      task_tracker: 'openhands.tools.task_tracker.definition',
    };
    if (['INVESTIGATE_PLAN', 'ORCHESTRATE'].includes(input.phase)) {
      modules.task_tool_set = 'openhands.tools.task.definition';
    }
    return modules;
  }

  #managedValue(source: ManagedEnvironmentSource, input: ExecutionHostCreateInput): string {
    const baseUrl = this.#secrets.read(this.#liteLlmBaseUrlName).replace(/\/$/, '');
    const backend = this.#policy.backend(input.selection.backend);
    const managedModel =
      backend?.managed_model_overrides?.[input.selection.modelClass] ?? input.selection.modelClass;
    switch (source) {
      case 'litellm_api_key':
        return this.#secrets.read(this.#liteLlmKeyName);
      case 'litellm_base_url':
        return baseUrl;
      case 'litellm_base_url_v1':
        return baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
      case 'logical_model':
        return managedModel;
      case 'execution_id':
        return input.executionId;
      case 'codex_config':
        return JSON.stringify({
          model: managedModel,
          ...(backend?.managed_reasoning_effort_overrides?.[input.selection.modelClass]
            ? {
                model_reasoning_effort:
                  backend.managed_reasoning_effort_overrides[input.selection.modelClass],
              }
            : {}),
          model_provider: 'hermes-litellm',
          // AI Office owns project-level delegation. Disable Codex's nested
          // multi-agent namespace so its Responses tool schema stays portable
          // through LiteLLM and we do not create a second orchestration layer.
          agents: { enabled: false },
          features: {
            multi_agent: false,
            multi_agent_v2: { enabled: false },
          },
          model_providers: {
            'hermes-litellm': {
              name: 'Hermes LiteLLM',
              base_url: baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`,
              env_key: 'CODEX_API_KEY',
              wire_api: 'responses',
            },
          },
        });
    }
  }

  #executionSecrets(input: ExecutionHostCreateInput): JsonRecord | undefined {
    const backend = this.#policy.backend(input.selection.backend);
    if (!backend) return undefined;
    const values: Record<string, JsonRecord> = {
      // Execution hosts allocate a PTY for tool compatibility. Explicitly keep
      // test runners in automation mode so completed commands cannot strand an
      // execution in an interactive TUI (for example Nx's terminal UI).
      CI: { kind: 'StaticSecret', value: '1' },
      NX_TUI: { kind: 'StaticSecret', value: 'false' },
    };
    if (input.selection.transportMode === 'LITELLM_MANAGED') {
      for (const [name, source] of Object.entries(backend.managed_env ?? {})) {
        values[name] = { kind: 'StaticSecret', value: this.#managedValue(source, input) };
      }
    }
    for (const [name, value] of Object.entries(backend.static_env ?? {})) {
      values[name] = { kind: 'StaticSecret', value };
    }
    return Object.keys(values).length ? values : undefined;
  }

  #agentConfig(input: ExecutionHostCreateInput): JsonRecord {
    const backend = this.#policy.backend(input.selection.backend);
    if (!backend?.enabled) throw new Error('EXECUTION_BACKEND_UNAVAILABLE');
    if (backend.kind === 'openhands') {
      if (input.selection.transportMode !== 'LITELLM_MANAGED') {
        throw new Error('OPENHANDS_BUILTIN_REQUIRES_MANAGED_TRANSPORT');
      }
      return {
        kind: 'Agent',
        llm: {
          model: `litellm_proxy/${input.selection.modelClass}`,
          api_key: this.#secrets.read(this.#liteLlmKeyName),
          base_url: this.#secrets.read(this.#liteLlmBaseUrlName),
          // OpenHands defaults reasoning_effort to "high". LiteLLM 1.92.x
          // intentionally bridges GPT-5.4+ chat requests with tools+reasoning_effort
          // to the Responses API. Some OpenAI-compatible relay deployments expose
          // Chat Completions correctly but return incomplete Responses objects, so
          // managed relay aliases explicitly stay on the chat contract and omit the
          // reasoning control hint. This is transport compatibility, not a quality policy.
          api_mode: 'chat',
          reasoning_effort: null,
          // LiteLLM persists the OpenAI-compatible `user` field as spend-log
          // `end_user`. Use the stable V3 execution ID for exact, per-execution
          // usage/physical-route correlation without copying prompts or guessing
          // by timestamps.
          litellm_extra_body: { user: input.executionId },
          num_retries: 1,
          timeout: 300,
        },
        tools: this.#builtInTools(input),
      };
    }
    if (backend.kind === 'acp') return this.#acpAgentConfig(backend, input);
    throw new Error('EXECUTION_BACKEND_NOT_IMPLEMENTED');
  }

  #acpAgentConfig(backend: BackendPolicyConfig, input: ExecutionHostCreateInput): JsonRecord {
    if (!backend.command?.length) throw new Error('ACP_COMMAND_REQUIRED');
    const config: JsonRecord = {
      kind: 'ACPAgent',
      acp_command: backend.command,
      acp_server: backend.acp_server ?? 'custom',
      acp_prompt_timeout: 1800,
      acp_startup_timeout: 90,
    };
    if (input.selection.transportMode === 'LITELLM_MANAGED') {
      if (backend.managed_model_prefix == null && !backend.managed_env) {
        // Never assume how an arbitrary ACP server consumes a managed model gateway.
        // The backend must opt in with a probed logical-model prefix or explicit
        // managed environment mapping.
        throw new Error('ACP_MANAGED_TRANSPORT_NOT_MATERIALIZED');
      }
      const managedModel =
        backend.managed_model_overrides?.[input.selection.modelClass] ?? input.selection.modelClass;
      config.acp_model = `${backend.managed_model_prefix ?? ''}${managedModel}`;
    } else if (input.selection.transportMode === 'PROVIDER_NATIVE') {
      config.acp_model = input.selection.modelClass;
    }
    return config;
  }

  async createExecution(input: ExecutionHostCreateInput): Promise<ExecutionHostSnapshot> {
    const payload = await this.#json('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({
        workspace: { kind: 'LocalWorkspace', working_dir: input.repositoryPath },
        agent: this.#agentConfig(input),
        tool_module_qualnames: this.#toolModuleQualnames(input),
        initial_message: {
          role: 'user',
          content: [{ type: 'text', text: input.objective }],
          run: true,
        },
        max_iterations: 500,
        stuck_detection: true,
        autotitle: false,
        tags: {
          execution: input.executionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 128),
          project: input.projectKey.replace(/[^a-zA-Z0-9]/g, '').slice(0, 128),
          phase: input.phase.toLowerCase().replace(/_/g, ''),
        },
        ...(this.#executionSecrets(input) ? { secrets: this.#executionSecrets(input) } : {}),
        observability_metadata: input.correlationMetadata,
        observability_tags: ['hermes-ai-office-v3', input.phase.toLowerCase()],
      }),
    });
    const conversationId = String(payload.id ?? '');
    if (!conversationId) throw new Error('OPENHANDS_CONVERSATION_ID_MISSING');
    return this.#snapshot(payload, conversationId);
  }

  async #snapshot(payload: JsonRecord, conversationId: string): Promise<ExecutionHostSnapshot> {
    const status = mapStatus(payload.execution_status);
    let finalText: string | undefined;
    let error: ExecutionFailure | undefined;
    if (['SUCCEEDED', 'FAILED', 'STUCK'].includes(status)) {
      try {
        const result = await this.#json(
          `/api/conversations/${encodeURIComponent(conversationId)}/agent_final_response`,
        );
        if (typeof result.response === 'string') finalText = result.response;
      } catch {
        // The lifecycle state remains authoritative even when final-response fetch is unavailable.
      }
    }
    if (status === 'FAILED' || status === 'STUCK') {
      try {
        const events = await this.#json(
          `/api/conversations/${encodeURIComponent(conversationId)}/events/search?limit=20&sort_order=TIMESTAMP_DESC`,
        );
        const items = Array.isArray(events.items) ? events.items : [];
        error = executionFailure(
          items.find((item) => asRecord(item).kind === 'ConversationErrorEvent'),
        );
      } catch {
        // Keep the terminal host state even when diagnostic event retrieval is unavailable.
      }
    }
    return {
      conversationId,
      status,
      finalText,
      error,
      startedAt: typeof payload.created_at === 'string' ? payload.created_at : undefined,
      updatedAt: typeof payload.updated_at === 'string' ? payload.updated_at : undefined,
      usage: usageFromConversation(payload),
      currentModelId:
        typeof payload.current_model_id === 'string' ? payload.current_model_id : null,
      upstream: {
        executionStatus: payload.execution_status,
        availableModels: payload.available_models,
        error,
      },
    };
  }

  async getExecution(conversationId: string): Promise<ExecutionHostSnapshot> {
    const payload = await this.#json(`/api/conversations/${encodeURIComponent(conversationId)}`);
    return this.#snapshot(payload, conversationId);
  }

  async cancelExecution(conversationId: string): Promise<ExecutionHostSnapshot> {
    await this.#request(`/api/conversations/${encodeURIComponent(conversationId)}/pause`, {
      method: 'POST',
    });
    return this.getExecution(conversationId);
  }

  async continueExecution(conversationId: string, message: string): Promise<ExecutionHostSnapshot> {
    await this.#request(`/api/conversations/${encodeURIComponent(conversationId)}/events`, {
      method: 'POST',
      body: JSON.stringify({
        role: 'user',
        content: [{ type: 'text', text: message }],
        run: true,
      }),
    });
    return this.getExecution(conversationId);
  }
}
