import { V4Error, failClosed } from '../domain/errors.js';
import type {
  ExecutionPhase,
  ExecutionProviderPort,
  ProviderLaunchInput,
  ProviderRecoveryInput,
  ProviderSessionSnapshot,
  ProviderSessionStatus,
  ReviewProviderPort,
} from '../orchestration/contracts.js';

interface JsonRecord {
  [key: string]: unknown;
}

export interface OpenHandsProviderOptions {
  baseUrl: string;
  sessionApiKey: string;
  liteLlmApiKey: string;
  liteLlmBaseUrl: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  llmTimeoutSeconds?: number;
  maxIterations?: number;
  implementationModel?: string;
  reviewModel?: string;
}

interface NormalizedOptions {
  baseUrl: string;
  sessionApiKey: string;
  liteLlmApiKey: string;
  liteLlmBaseUrl: string;
  fetchImpl: typeof fetch;
  requestTimeoutMs: number;
  llmTimeoutSeconds: number;
  maxIterations: number;
  implementationModel: string;
  reviewModel: string;
}

const TERMINAL_STATUSES = new Set<ProviderSessionStatus>(['SUCCEEDED', 'FAILED', 'STUCK', 'CANCELLED']);
const MAX_ERROR_TEXT = 2_000;
const MAX_FINAL_TEXT = 64_000;
const MAX_INSTRUCTION_TEXT = 32_000;
const MAX_RECOVERY_PAGES = 100;

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function normalizeOptions(options: OpenHandsProviderOptions): NormalizedOptions {
  failClosed(options.baseUrl.trim().length > 0, 'OPENHANDS_BASE_URL_REQUIRED');
  failClosed(options.sessionApiKey.length > 0, 'OPENHANDS_SESSION_KEY_REQUIRED');
  failClosed(options.liteLlmApiKey.length > 0, 'OPENHANDS_LITELLM_KEY_REQUIRED');
  failClosed(options.liteLlmBaseUrl.trim().length > 0, 'OPENHANDS_LITELLM_URL_REQUIRED');
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const llmTimeoutSeconds = options.llmTimeoutSeconds ?? 600;
  const maxIterations = options.maxIterations ?? 500;
  failClosed(Number.isInteger(requestTimeoutMs) && requestTimeoutMs >= 1_000 && requestTimeoutMs <= 120_000, 'OPENHANDS_TIMEOUT_INVALID');
  failClosed(Number.isInteger(llmTimeoutSeconds) && llmTimeoutSeconds >= 30 && llmTimeoutSeconds <= 1_800, 'OPENHANDS_LLM_TIMEOUT_INVALID');
  failClosed(Number.isInteger(maxIterations) && maxIterations >= 1 && maxIterations <= 1_000, 'OPENHANDS_ITERATION_LIMIT_INVALID');
  const implementationModel = (options.implementationModel ?? 'gpt-5.6-luna').trim();
  const reviewModel = (options.reviewModel ?? 'gpt-5.6-sol').trim();
  failClosed(implementationModel.length > 0 && reviewModel.length > 0, 'OPENHANDS_MODEL_REQUIRED');
  return {
    baseUrl: options.baseUrl.replace(/\/$/, ''),
    sessionApiKey: options.sessionApiKey,
    liteLlmApiKey: options.liteLlmApiKey,
    liteLlmBaseUrl: options.liteLlmBaseUrl.replace(/\/$/, ''),
    fetchImpl: options.fetchImpl ?? fetch,
    requestTimeoutMs,
    llmTimeoutSeconds,
    maxIterations,
    implementationModel,
    reviewModel,
  };
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text.slice(0, maximum) : undefined;
}

function tagValue(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 128);
  if (!normalized) throw new V4Error('OPENHANDS_TAG_INVALID');
  return normalized;
}

function executionTag(executionId: string): string {
  const normalized = executionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 128);
  if (!normalized) throw new V4Error('OPENHANDS_EXECUTION_TAG_INVALID');
  return normalized;
}

export function mapOpenHandsStatus(value: unknown): ProviderSessionStatus {
  switch (String(value ?? '').toLowerCase()) {
    case 'created': return 'CREATED';
    case 'queued': return 'QUEUED';
    case 'running': return 'RUNNING';
    case 'idle':
    case 'paused': return 'PAUSED';
    case 'waiting_for_confirmation': return 'WAITING_FOR_CONFIRMATION';
    case 'finished': return 'SUCCEEDED';
    case 'error': return 'FAILED';
    case 'stuck': return 'STUCK';
    case 'deleting':
    case 'cancelled': return 'CANCELLED';
    default: return 'UNKNOWN';
  }
}

function retryableFailure(code: string, detail: string): boolean {
  return /(?:timeout|connection|rate.?limit|service.?unavailable|internal.?server|http[_ ]?(?:429|5\d\d)|\b429\b|\b5\d\d\b)/i.test(code + ' ' + detail);
}

function phasePrompt(input: ProviderLaunchInput): string {
  const acceptance = input.acceptanceCriteria.length
    ? ['Acceptance criteria:', ...input.acceptanceCriteria.map((item) => '- ' + item.trim())]
    : [];
  const findings = input.reviewFindings?.length
    ? ['Review findings to repair:', ...input.reviewFindings.map((item) => '- ' + item.trim())]
    : [];
  const evidenceTemplate = input.phase === 'REVIEW'
    ? JSON.stringify({
        version: 1,
        executionId: input.executionId,
        phase: 'REVIEW',
        reviewedSha: input.sourceRevision,
        verdict: 'PASS|FAIL|INVALID',
        findings: ['concrete finding when not PASS'],
        checks: [{ command: 'exact command', status: 'PASS|FAIL|SKIP', exitCode: 0, summary: 'bounded result' }],
        summary: 'bounded review summary',
      })
    : JSON.stringify({
        version: 1,
        executionId: input.executionId,
        phase: input.phase,
        sourceRevision: input.sourceRevision,
        resultRevision: '<exact git HEAD after commit>',
        summary: 'bounded implementation summary',
        tests: [{ command: 'exact command', status: 'PASS|FAIL|SKIP', exitCode: 0, summary: 'bounded result' }],
      });
  const rules = input.phase === 'REVIEW'
    ? [
        'Perform an independent review of the exact supplied revision.',
        'Do not edit repository files or delegate the review.',
        'The first non-empty line of the final response must be exactly PASS, FAIL, or INVALID.',
        'Use PASS only when the exact revision satisfies every acceptance criterion.',
        'Before finishing, atomically write one JSON object to ' + input.workspace.evidenceExecutionPath + ' using this schema: ' + evidenceTemplate,
      ]
    : [
        'Implement the bounded objective in the supplied isolated workspace.',
        'Do not broaden scope, access credentials, merge, deploy, or modify remotes.',
        'Run focused checks, commit every intended change, and leave the workspace clean.',
        'A no-op or planning-only response is not successful implementation.',
        'Before finishing, atomically write one JSON object outside the Git repository at ' + input.workspace.evidenceExecutionPath + ' using this schema: ' + evidenceTemplate,
      ];
  const text = [
    'Pixel Agent V4 execution phase: ' + input.phase,
    'Execution: ' + input.executionId,
    'Plan: ' + input.planId,
    'Project: ' + input.projectKey,
    'Source revision: ' + input.sourceRevision,
    input.baselineRevision ? 'Baseline revision: ' + input.baselineRevision : '',
    '',
    'Objective:',
    input.objective.trim(),
    '',
    ...acceptance,
    ...findings,
    '',
    'Execution rules:',
    ...rules.map((rule) => '- ' + rule),
  ].filter(Boolean).join('\n');
  if (Buffer.byteLength(text, 'utf8') > MAX_INSTRUCTION_TEXT) throw new V4Error('OPENHANDS_INSTRUCTION_TOO_LARGE');
  return text;
}

abstract class OpenHandsProviderBase implements ExecutionProviderPort {
  abstract readonly provider: string;
  protected abstract readonly mode: 'IMPLEMENTATION' | 'REVIEW';
  readonly options: NormalizedOptions;

  constructor(options: OpenHandsProviderOptions) {
    this.options = normalizeOptions(options);
  }

  async launch(input: ProviderLaunchInput): Promise<ProviderSessionSnapshot> {
    this.validatePhase(input.phase);
    failClosed(input.executionId.trim().length > 0, 'EXECUTION_ID_REQUIRED');
    failClosed(input.planId.trim().length > 0, 'PLAN_ID_REQUIRED');
    failClosed(input.projectKey.trim().length > 0, 'PROJECT_KEY_REQUIRED');
    failClosed(input.sourceRevision.trim().length > 0, 'EXECUTION_SOURCE_REVISION_REQUIRED');
    failClosed(input.workspace.executionId === input.executionId, 'OPENHANDS_WORKSPACE_EXECUTION_MISMATCH');
    failClosed(input.workspace.sourceRevision === input.sourceRevision, 'OPENHANDS_WORKSPACE_REVISION_MISMATCH');
    failClosed(input.workspace.executionPath.trim().length > 0, 'OPENHANDS_WORKSPACE_REQUIRED');

    const tools = this.mode === 'REVIEW'
      ? [{ name: 'terminal' }, { name: 'task_tracker' }]
      : [{ name: 'terminal' }, { name: 'file_editor' }, { name: 'task_tracker' }];
    const toolModuleQualnames = Object.fromEntries(tools.map((tool) => [
      tool.name,
      tool.name === 'terminal'
        ? 'openhands.tools.terminal.definition'
        : tool.name === 'file_editor'
          ? 'openhands.tools.file_editor.definition'
          : 'openhands.tools.task_tracker.definition',
    ]));
    const model = this.mode === 'REVIEW' ? this.options.reviewModel : this.options.implementationModel;
    const payload = {
      workspace: { kind: 'LocalWorkspace', working_dir: input.workspace.executionPath },
      confirmation_policy: { kind: 'NeverConfirm' },
      agent: {
        kind: 'Agent',
        llm: {
          model: 'litellm_proxy/' + model,
          api_key: this.options.liteLlmApiKey,
          base_url: this.options.liteLlmBaseUrl,
          api_mode: 'chat',
          reasoning_effort: null,
          num_retries: 1,
          timeout: this.options.llmTimeoutSeconds,
          litellm_extra_body: { user: input.executionId },
        },
        tools,
        include_default_tools: ['FinishTool', 'ThinkTool'],
        agent_context: {
          load_project_skills: true,
          load_user_skills: false,
          load_public_skills: false,
          system_message_suffix: this.mode === 'REVIEW'
            ? 'You are an independent read-only reviewer. Never edit files and never ask the user questions.'
            : 'You are a bounded implementation worker. Never ask the user questions; implement, test, commit, and finish.',
        },
      },
      tool_module_qualnames: toolModuleQualnames,
      initial_message: { role: 'user', content: [{ type: 'text', text: phasePrompt(input) }], run: true },
      max_iterations: this.options.maxIterations,
      stuck_detection: true,
      autotitle: false,
      tags: {
        execution: executionTag(input.executionId),
        project: tagValue(input.projectKey),
        phase: input.phase.toLowerCase().replace(/_/g, ''),
        plan: tagValue(input.planId),
        ...(input.workItemId ? { workitem: tagValue(input.workItemId) } : {}),
        role: this.mode === 'REVIEW' ? 'independentreview' : 'implementation',
      },
      secrets: {
        CI: { kind: 'StaticSecret', value: '1' },
        NX_TUI: { kind: 'StaticSecret', value: 'false' },
      },
      observability_metadata: {
        executionId: input.executionId,
        planId: input.planId,
        projectKey: input.projectKey,
        phase: input.phase,
      },
      observability_tags: ['pixel-v4', input.phase.toLowerCase()],
    };
    const response = await this.json('/api/conversations', { method: 'POST', body: JSON.stringify(payload) });
    const conversationId = boundedText(response.id ?? response.conversation_id, 200);
    if (!conversationId) throw new V4Error('OPENHANDS_CONVERSATION_ID_MISSING');
    this.validateConversation(response, {
      executionId: input.executionId,
      projectKey: input.projectKey,
      phase: input.phase,
      expectedWorkspacePath: input.workspace.executionPath,
    });
    const initial = await this.snapshot(response, conversationId);
    if (initial.status === 'PAUSED') {
      await this.request('/api/conversations/' + encodeURIComponent(conversationId) + '/run', { method: 'POST' });
      return await this.inspect(conversationId);
    }
    return initial;
  }

  async recover(input: ProviderRecoveryInput): Promise<ProviderSessionSnapshot | undefined> {
    failClosed(input.executionId.trim().length > 0, 'EXECUTION_ID_REQUIRED');
    const expectedTag = executionTag(input.executionId);
    const matches = new Map<string, JsonRecord>();
    let pageId: string | undefined;
    const createdAt = Date.parse(input.createdAt);
    failClosed(Number.isFinite(createdAt), 'EXECUTION_CREATED_AT_INVALID');
    for (let page = 0; page < MAX_RECOVERY_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: '100', sort_order: 'CREATED_AT_DESC' });
      if (pageId) query.set('page_id', pageId);
      const payload = await this.json('/api/conversations/search?' + query.toString());
      const items = Array.isArray(payload.items) ? payload.items : [];
      for (const item of items) {
        const conversation = record(item);
        const id = boundedText(conversation.id, 200);
        const tags = record(conversation.tags);
        if (!id || tags.execution !== expectedTag) continue;
        this.validateConversation(conversation, input);
        matches.set(id, conversation);
        if (matches.size > 1) throw new V4Error('OPENHANDS_EXECUTION_DUPLICATE');
      }
      const next = boundedText(payload.next_page_id, 2_000);
      const times = items.map((item) => Date.parse(String(record(item).created_at ?? ''))).filter(Number.isFinite);
      if (!next || (times.length > 0 && Math.min(...times) < createdAt - 60_000)) break;
      pageId = next;
    }
    const match = [...matches.entries()][0];
    return match ? await this.snapshot(match[1], match[0]) : undefined;
  }

  async inspect(providerSessionId: string): Promise<ProviderSessionSnapshot> {
    failClosed(providerSessionId.trim().length > 0, 'PROVIDER_SESSION_ID_REQUIRED');
    const payload = await this.json('/api/conversations/' + encodeURIComponent(providerSessionId));
    return await this.snapshot(payload, providerSessionId);
  }

  async continue(providerSessionId: string, instruction: string): Promise<ProviderSessionSnapshot> {
    failClosed(providerSessionId.trim().length > 0, 'PROVIDER_SESSION_ID_REQUIRED');
    failClosed(instruction.trim().length > 0, 'OPENHANDS_CONTINUE_INSTRUCTION_REQUIRED');
    if (Buffer.byteLength(instruction, 'utf8') > MAX_INSTRUCTION_TEXT) throw new V4Error('OPENHANDS_INSTRUCTION_TOO_LARGE');
    await this.request('/api/conversations/' + encodeURIComponent(providerSessionId) + '/events', {
      method: 'POST',
      body: JSON.stringify({ role: 'user', content: [{ type: 'text', text: instruction }], run: true }),
    });
    return await this.inspect(providerSessionId);
  }

  async cancel(providerSessionId: string): Promise<ProviderSessionSnapshot> {
    failClosed(providerSessionId.trim().length > 0, 'PROVIDER_SESSION_ID_REQUIRED');
    await this.request('/api/conversations/' + encodeURIComponent(providerSessionId) + '/pause', { method: 'POST' });
    return await this.inspect(providerSessionId);
  }

  protected validatePhase(phase: ExecutionPhase): void {
    if (this.mode === 'REVIEW' && phase !== 'REVIEW') throw new V4Error('OPENHANDS_REVIEW_PHASE_REQUIRED');
    if (this.mode === 'IMPLEMENTATION' && phase === 'REVIEW') throw new V4Error('OPENHANDS_IMPLEMENTATION_PHASE_REQUIRED');
  }

  private validateConversation(conversation: JsonRecord, input: Pick<ProviderRecoveryInput, 'executionId' | 'projectKey' | 'phase' | 'expectedWorkspacePath'>): void {
    const tags = record(conversation.tags);
    if (tags.execution !== undefined && tags.execution !== executionTag(input.executionId)) throw new V4Error('OPENHANDS_EXECUTION_PROVENANCE_MISMATCH');
    if (input.projectKey && tags.project !== undefined && tags.project !== tagValue(input.projectKey)) throw new V4Error('OPENHANDS_EXECUTION_PROVENANCE_MISMATCH');
    if (input.phase && tags.phase !== undefined && tags.phase !== input.phase.toLowerCase().replace(/_/g, '')) throw new V4Error('OPENHANDS_EXECUTION_PROVENANCE_MISMATCH');
    const workspace = record(conversation.workspace);
    if (input.expectedWorkspacePath && workspace.working_dir !== undefined && workspace.working_dir !== input.expectedWorkspacePath) {
      throw new V4Error('OPENHANDS_WORKSPACE_PROVENANCE_MISMATCH');
    }
  }

  private async snapshot(payload: JsonRecord, conversationId: string): Promise<ProviderSessionSnapshot> {
    const status = mapOpenHandsStatus(payload.execution_status);
    let finalResponse: string | undefined;
    let errorCode: string | undefined;
    let retryable: boolean | undefined;
    if (TERMINAL_STATUSES.has(status)) {
      try {
        const result = await this.json('/api/conversations/' + encodeURIComponent(conversationId) + '/agent_final_response');
        finalResponse = this.sanitize(boundedText(result.response, MAX_FINAL_TEXT), MAX_FINAL_TEXT);
      } catch (error) {
        if (!(error instanceof V4Error) || !error.code.startsWith('OPENHANDS_HTTP_')) throw error;
      }
    }
    if (status === 'FAILED' || status === 'STUCK') {
      try {
        const events = await this.json('/api/conversations/' + encodeURIComponent(conversationId) + '/events/search?limit=20&sort_order=TIMESTAMP_DESC');
        const items = Array.isArray(events.items) ? events.items : [];
        const raw = items.map(record).find((item) => ['ConversationErrorEvent', 'ServerErrorEvent', 'AgentErrorEvent'].includes(String(item.kind ?? '')));
        if (raw) {
          const code = boundedText(raw.code ?? raw.kind, 200) ?? 'OPENHANDS_PROVIDER_FAILURE';
          const detail = this.sanitize(boundedText(raw.detail ?? raw.error, MAX_ERROR_TEXT), MAX_ERROR_TEXT) ?? '';
          errorCode = detail ? (code + ':' + detail).slice(0, MAX_ERROR_TEXT) : code;
          retryable = retryableFailure(code, detail);
        }
      } catch (error) {
        if (!(error instanceof V4Error) || !error.code.startsWith('OPENHANDS_HTTP_')) throw error;
      }
    }
    return {
      provider: this.provider,
      providerSessionId: conversationId,
      status,
      ...(finalResponse ? { finalResponse } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(retryable === undefined ? {} : { retryable }),
      observedAt: new Date().toISOString(),
    };
  }

  private sanitize(value: string | undefined, maximum: number): string | undefined {
    if (!value) return undefined;
    let sanitized = value;
    for (const secret of [this.options.sessionApiKey, this.options.liteLlmApiKey]) {
      if (secret) sanitized = sanitized.split(secret).join('[REDACTED]');
    }
    return sanitized
      .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s'",}]+/gi, '$1[REDACTED]')
      .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
      .slice(0, maximum);
  }

  private async json(path: string, init: RequestInit = {}): Promise<JsonRecord> {
    const response = await this.request(path, init);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new V4Error('OPENHANDS_RESPONSE_INVALID', 'OpenHands returned invalid JSON.', error);
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new V4Error('OPENHANDS_RESPONSE_INVALID');
    return payload as JsonRecord;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      const response = await this.options.fetchImpl(this.options.baseUrl + path, {
        ...init,
        headers: {
          'X-Session-API-Key': this.options.sessionApiKey,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
        signal: init.signal ?? AbortSignal.timeout(this.options.requestTimeoutMs),
      });
      if (!response.ok) throw new V4Error('OPENHANDS_HTTP_' + response.status, 'OpenHands request failed with HTTP ' + response.status + '.');
      return response;
    } catch (error) {
      if (error instanceof V4Error) throw error;
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw new V4Error('OPENHANDS_TIMEOUT');
      throw new V4Error('OPENHANDS_UNAVAILABLE', 'OpenHands request failed.');
    }
  }
}

export class OpenHandsExecutionProvider extends OpenHandsProviderBase {
  readonly provider = 'openhands-coding';
  protected readonly mode = 'IMPLEMENTATION' as const;
}

export class OpenHandsReviewProvider extends OpenHandsProviderBase implements ReviewProviderPort {
  readonly provider = 'openhands-independent-review';
  readonly independentReview = true as const;
  protected readonly mode = 'REVIEW' as const;
}

export function createOpenHandsProviders(options: OpenHandsProviderOptions): {
  execution: OpenHandsExecutionProvider;
  review: OpenHandsReviewProvider;
} {
  return { execution: new OpenHandsExecutionProvider(options), review: new OpenHandsReviewProvider(options) };
}
