import { createHash } from 'node:crypto';
import path from 'node:path';
import { V4Error, failClosed } from '../domain/errors.js';
import { REPOSITORY_COMPLETION_EVIDENCE_FILE } from '../orchestration/contracts.js';
import type {
  ExecutionPhase,
  ExecutionProviderPort,
  ProviderLaunchInput,
  ProviderRecoveryInput,
  ProviderRuntimeProbeInput,
  ProviderRuntimeProbeResult,
  ProviderSessionReplacementInput,
  ProviderSessionSnapshot,
  ProviderSessionStatus,
  ReviewProviderPort,
} from '../orchestration/contracts.js';

interface JsonRecord {
  [key: string]: unknown;
}

interface ConversationCreateOptions {
  maxIterations?: number;
  secrets?: JsonRecord;
  roleTag?: string;
}

export interface OpenHandsProviderOptions {
  baseUrl: string;
  sessionApiKey: string;
  liteLlmApiKey?: string;
  liteLlmBaseUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  llmTimeoutSeconds?: number;
  maxIterations?: number;
  implementationModel?: string;
  reviewModel?: string;
}

export interface CodexManagedExecutionOptions {
  command?: string[];
  acpServer?: string;
  codexBin?: string;
  workspaceRoot?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  promptTimeoutSeconds?: number;
  startupTimeoutSeconds?: number;
}

export interface CodexBusinessReviewOptions {
  command?: string[];
  acpServer?: string;
  authHome?: string;
  codexBin?: string;
  workspaceRoot?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  promptTimeoutSeconds?: number;
  startupTimeoutSeconds?: number;
}

export interface AcpBackendOptions {
  command?: string[];
  acpServer?: string;
  workspaceRoot?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  promptTimeoutSeconds?: number;
  startupTimeoutSeconds?: number;
}

export interface ClaudeReviewOptions extends AcpBackendOptions {
  claudeBin?: string;
}

export const OPENHANDS_AGENT_BACKENDS = [
  'codex-acp',
  'dsh-acp',
  'zcode-acp',
  'claude-code-acp',
  'openhands-builtin',
] as const;
export type OpenHandsAgentBackend = (typeof OPENHANDS_AGENT_BACKENDS)[number];

export const OPENHANDS_PROVIDER_TRANSPORTS = ['LITELLM_MANAGED', 'PROVIDER_NATIVE'] as const;
export type OpenHandsProviderTransport = (typeof OPENHANDS_PROVIDER_TRANSPORTS)[number];

export type OpenHandsProviderRole = 'IMPLEMENTATION' | 'REVIEW';
export type OpenHandsProviderCapability = 'IMPLEMENTATION' | 'REASONING';

/**
 * This is deliberately a complete selected profile, not a model-name hint.
 * Callers can hydrate it from durable routing data without making this adapter
 * infer an agent from a model string.
 */
export interface OpenHandsProviderSelection {
  backend: OpenHandsAgentBackend;
  model: string;
  transport: OpenHandsProviderTransport;
  /** Persisted selections may carry role, phase, or capability depending on schema version. */
  role?: OpenHandsProviderRole;
  phase?: ExecutionPhase;
  capability?: OpenHandsProviderCapability;
  resourceId?: string;
}

export interface OpenHandsProviderFactoryOptions extends OpenHandsProviderOptions {
  codex?: CodexManagedExecutionOptions;
  businessCodex?: CodexBusinessReviewOptions;
  business?: CodexBusinessReviewOptions;
  dsh?: AcpBackendOptions;
  zcode?: AcpBackendOptions;
  claude?: ClaudeReviewOptions;
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

const TERMINAL_STATUSES = new Set<ProviderSessionStatus>([
  'SUCCEEDED',
  'FAILED',
  'STUCK',
  'CANCELLED',
]);
const MAX_ERROR_TEXT = 2_000;
const MAX_FINAL_TEXT = 64_000;
const MAX_INSTRUCTION_TEXT = 32_000;
const MAX_RECOVERY_PAGES = 100;

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function modelName(value: string, code = 'OPENHANDS_MODEL_INVALID'): string {
  const model = value.trim();
  failClosed(model.length > 0 && model.length <= 200 && !/[\u0000-\u001f\u007f]/.test(model), code);
  return model;
}

function normalizeOptions(
  options: OpenHandsProviderOptions,
  requiresLiteLlm = true,
): NormalizedOptions {
  failClosed(options.baseUrl.trim().length > 0, 'OPENHANDS_BASE_URL_REQUIRED');
  failClosed(options.sessionApiKey.length > 0, 'OPENHANDS_SESSION_KEY_REQUIRED');
  const liteLlmApiKey = options.liteLlmApiKey ?? '';
  const liteLlmBaseUrl = options.liteLlmBaseUrl ?? '';
  if (requiresLiteLlm) {
    failClosed(liteLlmApiKey.length > 0, 'OPENHANDS_LITELLM_KEY_REQUIRED');
    failClosed(liteLlmBaseUrl.trim().length > 0, 'OPENHANDS_LITELLM_URL_REQUIRED');
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const llmTimeoutSeconds = options.llmTimeoutSeconds ?? 600;
  const maxIterations = options.maxIterations ?? 500;
  failClosed(
    Number.isInteger(requestTimeoutMs) && requestTimeoutMs >= 1_000 && requestTimeoutMs <= 120_000,
    'OPENHANDS_TIMEOUT_INVALID',
  );
  failClosed(
    Number.isInteger(llmTimeoutSeconds) && llmTimeoutSeconds >= 30 && llmTimeoutSeconds <= 1_800,
    'OPENHANDS_LLM_TIMEOUT_INVALID',
  );
  failClosed(
    Number.isInteger(maxIterations) && maxIterations >= 1 && maxIterations <= 1_000,
    'OPENHANDS_ITERATION_LIMIT_INVALID',
  );
  const implementationModel = modelName(
    options.implementationModel ?? 'gpt-5.6-luna',
    'OPENHANDS_MODEL_REQUIRED',
  );
  const reviewModel = modelName(options.reviewModel ?? 'gpt-5.6-sol', 'OPENHANDS_MODEL_REQUIRED');
  return {
    baseUrl: options.baseUrl.replace(/\/$/, ''),
    sessionApiKey: options.sessionApiKey,
    liteLlmApiKey,
    liteLlmBaseUrl: liteLlmBaseUrl.replace(/\/$/, ''),
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

function recoveryTag(recoveryKey: string): string {
  failClosed(
    recoveryKey.trim().length > 0 && recoveryKey.length <= 1_000,
    'OPENHANDS_RECOVERY_KEY_INVALID',
  );
  return 'repl-' + createHash('sha256').update(recoveryKey).digest('hex').slice(0, 40);
}

export function mapOpenHandsStatus(value: unknown): ProviderSessionStatus {
  switch (String(value ?? '').toLowerCase()) {
    case 'created':
      return 'CREATED';
    case 'queued':
      return 'QUEUED';
    case 'running':
      return 'RUNNING';
    case 'idle':
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
    case 'cancelled':
      return 'CANCELLED';
    default:
      return 'UNKNOWN';
  }
}

/** OpenHands can report a failed ACP child as a superficially successful turn. */
export function isOpenHandsTransportFailure(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trimStart();
  return /^(?:(?:IMPLEMENT|IMPLEMENT_FIX|REVIEW|PLAN)_TRANSPORT_ERROR\b|TRANSPORT_ERROR\b|ACP(?:[_ -](?:ERROR|FAILURE))?\b|AGENT[_ -]?CLIENT[_ -]?PROTOCOL(?:[_ -](?:ERROR|FAILURE))?\b)/i.test(
    text,
  );
}

function retryableFailure(code: string, detail: string): boolean {
  return /(?:timeout|connection|rate.?limit|service.?unavailable|internal.?server|authentication|invalid api key|unauthorized|forbidden|no deployments available|http[_ ]?(?:401|403|429|5\d\d)|\b(?:401|403|429|5\d\d)\b)/i.test(
    code + ' ' + detail,
  );
}

function phasePrompt(
  input: ProviderLaunchInput,
  evidencePath = input.workspace.evidenceExecutionPath,
): string {
  const acceptance = input.acceptanceCriteria.length
    ? ['Acceptance criteria:', ...input.acceptanceCriteria.map((item) => '- ' + item.trim())]
    : [];
  const findings = input.reviewFindings?.length
    ? ['Review findings to repair:', ...input.reviewFindings.map((item) => '- ' + item.trim())]
    : [];
  const evidenceTemplate =
    input.phase === 'REVIEW'
      ? JSON.stringify({
          version: 1,
          executionId: input.executionId,
          phase: 'REVIEW',
          reviewedSha: input.sourceRevision,
          verdict: 'PASS|FAIL|INVALID',
          findings: ['concrete finding when not PASS'],
          checks: [
            {
              command: 'exact command',
              status: 'PASS|FAIL|SKIP',
              exitCode: 0,
              summary: 'bounded result',
            },
          ],
          summary: 'bounded review summary',
        })
      : JSON.stringify({
          version: 1,
          executionId: input.executionId,
          phase: input.phase,
          sourceRevision: input.sourceRevision,
          resultRevision: '<exact git HEAD after commit or unchanged source HEAD>',
          outcome: 'CHANGED|SATISFIED',
          summary: 'bounded implementation summary',
          tests: [
            {
              command: 'exact command',
              status: 'PASS|FAIL|SKIP',
              exitCode: 0,
              summary: 'bounded result',
            },
          ],
        });
  const repositoryEvidenceStaging = evidencePath !== input.workspace.evidenceExecutionPath;
  const evidenceStagingRule = repositoryEvidenceStaging
    ? 'The evidence path is a controller-owned staging file inside the Git workspace. Do not git add or commit it. Write it as your final filesystem action; it may be the only untracked residue when you finish, and Pixel will validate, promote, and remove it before the clean-tree gate.'
    : undefined;
  const rules =
    input.phase === 'REVIEW'
      ? [
          'Perform an independent review of the exact supplied revision.',
          'Do not edit tracked repository files or delegate the review. The workspace is writable only so checks may create ignored dependency and tool-cache artifacts.',
          'Before running project commands, honor checked-in runtime declarations such as .node-version, .nvmrc, packageManager, and engines; never weaken them to fit the worker image.',
          'If dependencies are missing, bootstrap only from the checked-in lockfile with the declared package manager and an immutable/frozen-lockfile mode; never rewrite the lockfile as an environment workaround.',
          'Leave the exact supplied git HEAD unchanged and leave no tracked or non-ignored workspace changes.',
          'Use FAIL only for a concrete defect attributable to the exact reviewed revision. Use INVALID when the environment or tooling prevents a conclusive review.',
          'The first non-empty line of the final response must be exactly PASS, FAIL, or INVALID.',
          'Use PASS only when the exact revision satisfies every acceptance criterion.',
          'Before finishing, atomically write one JSON object to ' +
            evidencePath +
            ' using this schema: ' +
            evidenceTemplate,
          ...(evidenceStagingRule ? [evidenceStagingRule] : []),
        ]
      : [
          'Implement the bounded objective in the supplied isolated workspace.',
          'Do not broaden scope, access credentials, merge, deploy, or modify remotes.',
          'Before running project commands, honor checked-in runtime declarations such as .node-version, .nvmrc, packageManager, and engines; never weaken them to fit the worker image.',
          'If a JavaScript workspace has no installed dependencies, bootstrap only from its checked-in lockfile with the declared package manager and an immutable/frozen-lockfile mode; never rewrite the lockfile as an environment workaround.',
          'If tracked changes are required, set outcome=CHANGED, run focused checks, commit every intended change, and leave the workspace clean.',
          'If the supplied exact source revision already satisfies the entire bounded objective, do not manufacture a commit. Verify every acceptance criterion with focused checks, keep exact HEAD and a clean tree, and set outcome=SATISFIED. This path is still subject to independent review.',
          'A planning-only response or an unverified no-op is not successful implementation.',
          'Before finishing, atomically write one JSON object to ' +
            evidencePath +
            ' using this schema: ' +
            evidenceTemplate,
          ...(evidenceStagingRule ? [evidenceStagingRule] : []),
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
  ]
    .filter(Boolean)
    .join('\n');
  if (Buffer.byteLength(text, 'utf8') > MAX_INSTRUCTION_TEXT)
    throw new V4Error('OPENHANDS_INSTRUCTION_TOO_LARGE');
  return text;
}

abstract class OpenHandsProviderBase implements ExecutionProviderPort {
  abstract readonly provider: string;
  protected abstract readonly mode: 'IMPLEMENTATION' | 'REVIEW';
  readonly options: NormalizedOptions;

  constructor(options: OpenHandsProviderOptions, requiresLiteLlm = true) {
    this.options = normalizeOptions(options, requiresLiteLlm);
  }

  protected evidencePath(input: ProviderLaunchInput): string {
    return path.posix.join(input.workspace.executionPath, REPOSITORY_COMPLETION_EVIDENCE_FILE);
  }

  async launch(input: ProviderLaunchInput): Promise<ProviderSessionSnapshot> {
    this.validateLaunchInput(input);
    return await this.createConversation(input, phasePrompt(input, this.evidencePath(input)));
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
        if (!id || tags.execution !== expectedTag || tags.recovery !== undefined) continue;
        this.validateConversation(conversation, input);
        matches.set(id, conversation);
        if (matches.size > 1) throw new V4Error('OPENHANDS_EXECUTION_DUPLICATE');
      }
      const next = boundedText(payload.next_page_id, 2_000);
      const times = items
        .map((item) => Date.parse(String(record(item).created_at ?? '')))
        .filter(Number.isFinite);
      if (!next || (times.length > 0 && Math.min(...times) < createdAt - 60_000)) break;
      pageId = next;
    }
    const match = [...matches.entries()][0];
    return match ? await this.snapshot(match[1], match[0]) : undefined;
  }

  async replace(input: ProviderSessionReplacementInput): Promise<ProviderSessionSnapshot> {
    this.validateLaunchInput(input);
    failClosed(
      input.previousProviderSessionId.trim().length > 0 &&
        input.previousProviderSessionId.length <= 200,
      'EXPECTED_PROVIDER_SESSION_ID_REQUIRED',
    );
    failClosed(input.instruction.trim().length > 0, 'OPENHANDS_REPLACEMENT_INSTRUCTION_REQUIRED');
    const tag = recoveryTag(input.recoveryKey);
    const existing = await this.findReplacement(input, tag);
    if (existing) return await this.ensureRunning(existing.providerSessionId, existing);
    const text = [
      phasePrompt(input),
      '',
      'Provider session recovery:',
      '- This conversation replaces a stalled provider session for the same durable execution.',
      '- Preserve all intended existing workspace changes and continue from the current workspace state.',
      '- Do not reset, discard, or duplicate already completed work.',
      input.instruction.trim(),
    ].join('\n');
    if (Buffer.byteLength(text, 'utf8') > MAX_INSTRUCTION_TEXT)
      throw new V4Error('OPENHANDS_INSTRUCTION_TOO_LARGE');
    return await this.createConversation(input, text, { recovery: tag });
  }

  async inspect(providerSessionId: string): Promise<ProviderSessionSnapshot> {
    failClosed(providerSessionId.trim().length > 0, 'PROVIDER_SESSION_ID_REQUIRED');
    const payload = await this.json('/api/conversations/' + encodeURIComponent(providerSessionId));
    return await this.snapshot(payload, providerSessionId);
  }

  async continue(providerSessionId: string, instruction: string): Promise<ProviderSessionSnapshot> {
    failClosed(providerSessionId.trim().length > 0, 'PROVIDER_SESSION_ID_REQUIRED');
    failClosed(instruction.trim().length > 0, 'OPENHANDS_CONTINUE_INSTRUCTION_REQUIRED');
    if (Buffer.byteLength(instruction, 'utf8') > MAX_INSTRUCTION_TEXT)
      throw new V4Error('OPENHANDS_INSTRUCTION_TOO_LARGE');
    await this.request('/api/conversations/' + encodeURIComponent(providerSessionId) + '/events', {
      method: 'POST',
      body: JSON.stringify({
        role: 'user',
        content: [{ type: 'text', text: instruction }],
        run: true,
      }),
    });
    const snapshot = await this.inspect(providerSessionId);
    return await this.ensureRunning(providerSessionId, snapshot);
  }

  async interrupt(providerSessionId: string): Promise<ProviderSessionSnapshot> {
    failClosed(providerSessionId.trim().length > 0, 'PROVIDER_SESSION_ID_REQUIRED');
    await this.request(
      '/api/conversations/' + encodeURIComponent(providerSessionId) + '/interrupt',
      { method: 'POST' },
    );
    return await this.inspect(providerSessionId);
  }

  async cancel(providerSessionId: string): Promise<ProviderSessionSnapshot> {
    failClosed(providerSessionId.trim().length > 0, 'PROVIDER_SESSION_ID_REQUIRED');
    await this.request('/api/conversations/' + encodeURIComponent(providerSessionId) + '/pause', {
      method: 'POST',
    });
    return await this.inspect(providerSessionId);
  }

  protected conversationAgent(
    input: ProviderLaunchInput,
    tools: Array<{ name: string }>,
  ): JsonRecord {
    const model =
      this.mode === 'REVIEW' ? this.options.reviewModel : this.options.implementationModel;
    return {
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
        system_message_suffix:
          this.mode === 'REVIEW'
            ? 'You are an independent read-only reviewer. Never edit files and never ask the user questions.'
            : 'You are a bounded implementation worker. Never ask the user questions; implement, test, commit, and finish.',
      },
    };
  }

  protected conversationSecrets(input: ProviderLaunchInput): JsonRecord {
    return {
      CI: { kind: 'StaticSecret', value: '1' },
      NX_TUI: { kind: 'StaticSecret', value: 'false' },
      HOME: {
        kind: 'StaticSecret',
        value: path.posix.join(
          path.posix.dirname(input.workspace.executionPath),
          '.agent-harness/home',
        ),
      },
      XDG_CONFIG_HOME: {
        kind: 'StaticSecret',
        value: path.posix.join(
          path.posix.dirname(input.workspace.executionPath),
          '.agent-harness/xdg',
        ),
      },
      GIT_CONFIG_NOSYSTEM: { kind: 'StaticSecret', value: '1' },
      GIT_OPTIONAL_LOCKS: { kind: 'StaticSecret', value: '0' },
      GIT_CONFIG_COUNT: { kind: 'StaticSecret', value: '4' },
      GIT_CONFIG_KEY_0: { kind: 'StaticSecret', value: 'safe.directory' },
      GIT_CONFIG_VALUE_0: { kind: 'StaticSecret', value: input.workspace.executionPath },
      GIT_CONFIG_KEY_1: { kind: 'StaticSecret', value: 'safe.directory' },
      GIT_CONFIG_VALUE_1: { kind: 'StaticSecret', value: input.workspace.hostPath },
      GIT_CONFIG_KEY_2: { kind: 'StaticSecret', value: 'gc.auto' },
      GIT_CONFIG_VALUE_2: { kind: 'StaticSecret', value: '0' },
      GIT_CONFIG_KEY_3: { kind: 'StaticSecret', value: 'maintenance.auto' },
      GIT_CONFIG_VALUE_3: { kind: 'StaticSecret', value: 'false' },
    };
  }

  private validateLaunchInput(input: ProviderLaunchInput): void {
    this.validatePhase(input.phase);
    failClosed(input.executionId.trim().length > 0, 'EXECUTION_ID_REQUIRED');
    failClosed(input.planId.trim().length > 0, 'PLAN_ID_REQUIRED');
    failClosed(input.projectKey.trim().length > 0, 'PROJECT_KEY_REQUIRED');
    failClosed(input.sourceRevision.trim().length > 0, 'EXECUTION_SOURCE_REVISION_REQUIRED');
    failClosed(
      input.workspace.executionId === input.executionId,
      'OPENHANDS_WORKSPACE_EXECUTION_MISMATCH',
    );
    failClosed(
      input.workspace.sourceRevision === input.sourceRevision,
      'OPENHANDS_WORKSPACE_REVISION_MISMATCH',
    );
    failClosed(input.workspace.executionPath.trim().length > 0, 'OPENHANDS_WORKSPACE_REQUIRED');
  }

  protected async createConversation(
    input: ProviderLaunchInput,
    initialText: string,
    extraTags: Record<string, string> = {},
    options: ConversationCreateOptions = {},
  ): Promise<ProviderSessionSnapshot> {
    const tools =
      this.mode === 'REVIEW'
        ? [{ name: 'terminal' }, { name: 'task_tracker' }]
        : [{ name: 'terminal' }, { name: 'file_editor' }, { name: 'task_tracker' }];
    const toolModuleQualnames = Object.fromEntries(
      tools.map((tool) => [
        tool.name,
        tool.name === 'terminal'
          ? 'openhands.tools.terminal.definition'
          : tool.name === 'file_editor'
            ? 'openhands.tools.file_editor.definition'
            : 'openhands.tools.task_tracker.definition',
      ]),
    );
    const payload = {
      workspace: { kind: 'LocalWorkspace', working_dir: input.workspace.executionPath },
      confirmation_policy: { kind: 'NeverConfirm' },
      agent: this.conversationAgent(input, tools),
      tool_module_qualnames: toolModuleQualnames,
      initial_message: { role: 'user', content: [{ type: 'text', text: initialText }], run: true },
      max_iterations: options.maxIterations ?? this.options.maxIterations,
      stuck_detection: true,
      autotitle: false,
      tags: {
        execution: executionTag(input.executionId),
        project: tagValue(input.projectKey),
        phase: input.phase.toLowerCase().replace(/_/g, ''),
        plan: tagValue(input.planId),
        ...(input.workItemId ? { workitem: tagValue(input.workItemId) } : {}),
        role: options.roleTag ?? (this.mode === 'REVIEW' ? 'independentreview' : 'implementation'),
        ...extraTags,
      },
      secrets: options.secrets ?? this.conversationSecrets(input),
      observability_metadata: {
        executionId: input.executionId,
        planId: input.planId,
        projectKey: input.projectKey,
        phase: input.phase,
      },
      observability_tags: ['pixel-v4', input.phase.toLowerCase()],
    };
    const response = await this.json('/api/conversations', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const conversationId = boundedText(response.id ?? response.conversation_id, 200);
    if (!conversationId) throw new V4Error('OPENHANDS_CONVERSATION_ID_MISSING');
    this.validateConversation(response, {
      executionId: input.executionId,
      projectKey: input.projectKey,
      phase: input.phase,
      expectedWorkspacePath: input.workspace.executionPath,
    });
    const initial = await this.snapshot(response, conversationId, false);
    return await this.ensureRunning(conversationId, initial);
  }

  protected async deleteConversation(providerSessionId: string): Promise<void> {
    await this.request('/api/conversations/' + encodeURIComponent(providerSessionId), {
      method: 'DELETE',
    });
  }

  private async findReplacement(
    input: ProviderSessionReplacementInput,
    tag: string,
  ): Promise<ProviderSessionSnapshot | undefined> {
    const matches = new Map<string, JsonRecord>();
    let pageId: string | undefined;
    for (let page = 0; page < MAX_RECOVERY_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: '100', sort_order: 'CREATED_AT_DESC' });
      if (pageId) query.set('page_id', pageId);
      const payload = await this.json('/api/conversations/search?' + query.toString());
      const items = Array.isArray(payload.items) ? payload.items : [];
      for (const item of items) {
        const conversation = record(item);
        const id = boundedText(conversation.id, 200);
        const tags = record(conversation.tags);
        if (!id || tags.recovery !== tag) continue;
        this.validateConversation(conversation, {
          executionId: input.executionId,
          projectKey: input.projectKey,
          phase: input.phase,
          expectedWorkspacePath: input.workspace.executionPath,
        });
        matches.set(id, conversation);
        if (matches.size > 1) throw new V4Error('OPENHANDS_REPLACEMENT_DUPLICATE');
      }
      const next = boundedText(payload.next_page_id, 2_000);
      if (!next) break;
      pageId = next;
    }
    const match = [...matches.entries()][0];
    return match ? await this.snapshot(match[1], match[0]) : undefined;
  }

  private async ensureRunning(
    providerSessionId: string,
    snapshot: ProviderSessionSnapshot,
  ): Promise<ProviderSessionSnapshot> {
    if (snapshot.status !== 'PAUSED') return snapshot;
    try {
      await this.request('/api/conversations/' + encodeURIComponent(providerSessionId) + '/run', {
        method: 'POST',
      });
    } catch (error) {
      if (!(error instanceof V4Error) || error.code !== 'OPENHANDS_HTTP_409') throw error;
      const concurrent = await this.inspect(providerSessionId);
      if (
        concurrent.status === 'RUNNING' ||
        concurrent.status === 'WAITING_FOR_CONFIRMATION' ||
        TERMINAL_STATUSES.has(concurrent.status)
      ) {
        return concurrent;
      }
      if (concurrent.status !== 'PAUSED') throw error;
      await this.request(
        '/api/conversations/' + encodeURIComponent(providerSessionId) + '/interrupt',
        { method: 'POST' },
      );
      await this.request('/api/conversations/' + encodeURIComponent(providerSessionId) + '/run', {
        method: 'POST',
      });
    }
    return await this.inspect(providerSessionId);
  }

  protected validatePhase(phase: ExecutionPhase): void {
    if (this.mode === 'REVIEW' && phase !== 'REVIEW')
      throw new V4Error('OPENHANDS_REVIEW_PHASE_REQUIRED');
    if (this.mode === 'IMPLEMENTATION' && phase === 'REVIEW')
      throw new V4Error('OPENHANDS_IMPLEMENTATION_PHASE_REQUIRED');
  }

  private validateConversation(
    conversation: JsonRecord,
    input: Pick<
      ProviderRecoveryInput,
      'executionId' | 'projectKey' | 'phase' | 'expectedWorkspacePath'
    >,
  ): void {
    const tags = record(conversation.tags);
    if (tags.execution !== undefined && tags.execution !== executionTag(input.executionId))
      throw new V4Error('OPENHANDS_EXECUTION_PROVENANCE_MISMATCH');
    if (
      input.projectKey &&
      tags.project !== undefined &&
      tags.project !== tagValue(input.projectKey)
    )
      throw new V4Error('OPENHANDS_EXECUTION_PROVENANCE_MISMATCH');
    if (
      input.phase &&
      tags.phase !== undefined &&
      tags.phase !== input.phase.toLowerCase().replace(/_/g, '')
    )
      throw new V4Error('OPENHANDS_EXECUTION_PROVENANCE_MISMATCH');
    const workspace = record(conversation.workspace);
    if (
      input.expectedWorkspacePath &&
      workspace.working_dir !== undefined &&
      workspace.working_dir !== input.expectedWorkspacePath
    ) {
      throw new V4Error('OPENHANDS_WORKSPACE_PROVENANCE_MISMATCH');
    }
  }

  private async snapshot(
    payload: JsonRecord,
    conversationId: string,
    includeProgress = true,
  ): Promise<ProviderSessionSnapshot> {
    let status = mapOpenHandsStatus(payload.execution_status);
    let finalResponse: string | undefined;
    let errorCode: string | undefined;
    let retryable: boolean | undefined;
    if (TERMINAL_STATUSES.has(status)) {
      try {
        const result = await this.json(
          '/api/conversations/' + encodeURIComponent(conversationId) + '/agent_final_response',
        );
        finalResponse = this.sanitize(boundedText(result.response, MAX_FINAL_TEXT), MAX_FINAL_TEXT);
        if (
          status === 'SUCCEEDED' &&
          finalResponse !== undefined &&
          isOpenHandsTransportFailure(finalResponse)
        ) {
          status = 'FAILED';
          const firstLine = finalResponse.split(/\r?\n/, 1)[0] ?? 'ACP_TRANSPORT_ERROR';
          errorCode = this.sanitize(firstLine, 200) ?? 'ACP_TRANSPORT_ERROR';
          retryable = true;
        }
      } catch (error) {
        if (!(error instanceof V4Error) || !error.code.startsWith('OPENHANDS_HTTP_')) throw error;
      }
    }
    if (status === 'FAILED' || status === 'STUCK') {
      try {
        const events = await this.json(
          '/api/conversations/' +
            encodeURIComponent(conversationId) +
            '/events/search?limit=20&sort_order=TIMESTAMP_DESC',
        );
        const items = Array.isArray(events.items) ? events.items : [];
        const raw = items
          .map(record)
          .find((item) =>
            ['ConversationErrorEvent', 'ServerErrorEvent', 'AgentErrorEvent'].includes(
              String(item.kind ?? ''),
            ),
          );
        if (raw) {
          const code =
            this.sanitize(boundedText(raw.code ?? raw.kind, 200), 200) ??
            'OPENHANDS_PROVIDER_FAILURE';
          const detail =
            this.sanitize(boundedText(raw.detail ?? raw.error, MAX_ERROR_TEXT), MAX_ERROR_TEXT) ??
            '';
          errorCode = detail ? (code + ':' + detail).slice(0, MAX_ERROR_TEXT) : code;
          retryable = retryableFailure(code, detail);
        }
      } catch (error) {
        if (!(error instanceof V4Error) || !error.code.startsWith('OPENHANDS_HTTP_')) throw error;
      }
    }
    const progressFingerprint = includeProgress
      ? await this.providerProgressFingerprint(payload, conversationId, status)
      : undefined;
    return {
      provider: this.provider,
      providerSessionId: conversationId,
      status,
      ...(finalResponse ? { finalResponse } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(retryable === undefined ? {} : { retryable }),
      ...(progressFingerprint ? { progressFingerprint } : {}),
      observedAt: new Date().toISOString(),
    };
  }

  private async providerProgressFingerprint(
    conversation: JsonRecord,
    conversationId: string,
    status: ProviderSessionStatus,
  ): Promise<string> {
    let latest: JsonRecord = {};
    try {
      const events = await this.json(
        '/api/conversations/' +
          encodeURIComponent(conversationId) +
          '/events/search?limit=1&sort_order=TIMESTAMP_DESC',
      );
      const items = Array.isArray(events.items) ? events.items : [];
      latest = items.length > 0 ? record(items[0]) : {};
    } catch {
      // Progress telemetry is advisory. Provider status inspection remains the
      // authoritative liveness path when an older OpenHands lacks event search.
    }
    const safeCursor = {
      status,
      conversationUpdatedAt: boundedText(
        conversation.updated_at ?? conversation.updatedAt ?? conversation.last_updated_at,
        200,
      ),
      eventId: boundedText(latest.id ?? latest.event_id, 300),
      eventKind: boundedText(latest.kind, 200),
      eventTimestamp: boundedText(latest.timestamp ?? latest.created_at ?? latest.updated_at, 200),
    };
    return createHash('sha256').update(JSON.stringify(safeCursor)).digest('hex');
  }

  private sanitize(value: string | undefined, maximum: number): string | undefined {
    if (!value) return undefined;
    let sanitized = value;
    for (const secret of [this.options.sessionApiKey, this.options.liteLlmApiKey]) {
      if (secret) sanitized = sanitized.split(secret).join('[REDACTED]');
    }
    return sanitized
      .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s'",}]+/gi, '$1[REDACTED]')
      .replace(
        /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
        '$1[REDACTED]',
      )
      .replace(/\b(?:sk|sess|key|token)-[A-Za-z0-9_.:/_-]{8,}\b/g, '[REDACTED]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
      .slice(0, maximum);
  }

  private async json(path: string, init: RequestInit = {}): Promise<JsonRecord> {
    const response = await this.request(path, init);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new V4Error('OPENHANDS_RESPONSE_INVALID', 'OpenHands returned invalid JSON.');
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
      throw new V4Error('OPENHANDS_RESPONSE_INVALID');
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
      if (!response.ok)
        throw new V4Error(
          'OPENHANDS_HTTP_' + response.status,
          'OpenHands request failed with HTTP ' + response.status + '.',
        );
      return response;
    } catch (error) {
      if (error instanceof V4Error) {
        throw new V4Error(error.code, this.sanitize(error.message, MAX_ERROR_TEXT) ?? error.code);
      }
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
        throw new V4Error('OPENHANDS_TIMEOUT');
      throw new V4Error('OPENHANDS_UNAVAILABLE', 'OpenHands request failed.');
    }
  }
}

export class OpenHandsExecutionProvider extends OpenHandsProviderBase {
  readonly provider = 'openhands-coding';
  protected readonly mode = 'IMPLEMENTATION' as const;
}

interface ResolvedAcpBackendOptions {
  command: string[];
  acpServer: string;
  workspaceRoot: string;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  promptTimeoutSeconds: number;
  startupTimeoutSeconds: number;
}

function resolveAcpBackendOptions(
  input: AcpBackendOptions,
  defaults: {
    command: string[];
    reasoningEffort: ResolvedAcpBackendOptions['reasoningEffort'];
    promptTimeoutSeconds: number;
  },
  codePrefix: string,
): ResolvedAcpBackendOptions {
  const command = input.command ?? defaults.command;
  failClosed(
    command.length > 0 &&
      command.every((item) => item.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(item)),
    codePrefix + '_COMMAND_REQUIRED',
  );
  const promptTimeoutSeconds = input.promptTimeoutSeconds ?? defaults.promptTimeoutSeconds;
  const startupTimeoutSeconds = input.startupTimeoutSeconds ?? 90;
  failClosed(
    Number.isInteger(promptTimeoutSeconds) &&
      promptTimeoutSeconds >= 30 &&
      promptTimeoutSeconds <= 1_800,
    codePrefix + '_TIMEOUT_INVALID',
  );
  failClosed(
    Number.isInteger(startupTimeoutSeconds) &&
      startupTimeoutSeconds >= 10 &&
      startupTimeoutSeconds <= 300,
    codePrefix + '_STARTUP_TIMEOUT_INVALID',
  );
  const workspaceRoot = input.workspaceRoot ?? '/workspace';
  failClosed(
    workspaceRoot.trim().length > 0 &&
      pathIsAbsolute(workspaceRoot) &&
      !/[\u0000-\u001f\u007f]/.test(workspaceRoot),
    codePrefix + '_WORKSPACE_ROOT_INVALID',
  );
  return {
    command,
    acpServer: input.acpServer ?? 'custom',
    workspaceRoot,
    reasoningEffort: input.reasoningEffort ?? defaults.reasoningEffort,
    promptTimeoutSeconds,
    startupTimeoutSeconds,
  };
}

function authHome(value: string | undefined, code: string): string {
  const home = (value ?? '/openhands-state/codex-business').trim();
  failClosed(home.length > 0 && pathIsAbsolute(home) && !/[\u0000-\u001f\u007f]/.test(home), code);
  return home;
}

function pathIsAbsolute(value: string): boolean {
  return value.startsWith('/');
}

function executablePath(value: string, code: string): string {
  const executable = value.trim();
  failClosed(
    executable.length > 0 &&
      pathIsAbsolute(executable) &&
      !/[\u0000-\u001f\u007f]/.test(executable),
    code,
  );
  return executable;
}

type AcpDriver = 'codex' | 'dsh' | 'zcode' | 'claude';
type AcpTransport = 'litellm-managed' | 'provider-native';

interface ModelNativeAcpConfig {
  provider: string;
  mode: 'IMPLEMENTATION' | 'REVIEW';
  model: string;
  driver: AcpDriver;
  transport: AcpTransport;
  acp: ResolvedAcpBackendOptions;
  authHome?: string;
  binary?: string;
}

class OpenHandsModelNativeAcpProvider extends OpenHandsProviderBase {
  readonly provider: string;
  protected readonly mode: 'IMPLEMENTATION' | 'REVIEW';
  readonly selectedModel: string;
  readonly transport: AcpTransport;
  readonly acp: ResolvedAcpBackendOptions;
  readonly driver: AcpDriver;
  readonly authHome?: string;
  readonly binary?: string;

  constructor(options: OpenHandsProviderOptions, config: ModelNativeAcpConfig) {
    super(options, config.transport !== 'provider-native');
    this.provider = config.provider;
    this.mode = config.mode;
    this.selectedModel = modelName(config.model);
    this.transport = config.transport;
    this.acp = config.acp;
    this.driver = config.driver;
    this.authHome = config.authHome;
    this.binary = config.binary;
  }

  async probeRuntime(input: ProviderRuntimeProbeInput): Promise<ProviderRuntimeProbeResult> {
    failClosed(input.probeId.trim().length > 0, 'RUNTIME_PROBE_ID_REQUIRED');
    failClosed(input.sourceRevision.trim().length > 0, 'RUNTIME_PROBE_REVISION_REQUIRED');
    const phase: ExecutionPhase = this.mode === 'REVIEW' ? 'REVIEW' : 'IMPLEMENT';
    const launchInput: ProviderLaunchInput = {
      executionId: input.probeId,
      planId: 'runtime-admission',
      projectKey: 'pixel-runtime-admission',
      phase,
      objective: 'Verify model-native ACP runtime admission without product changes.',
      acceptanceCriteria: ['Run git status --short without editing files', 'Reply READY'],
      sourceRevision: input.sourceRevision,
      route: 'runtime-admission',
      workspace: input.workspace,
    };
    const secrets = this.runtimeProbeSecrets(launchInput);
    const prompt = [
      'Pixel runtime admission probe.',
      'Do not modify, create, delete, stage, or commit repository files.',
      'Run exactly one harmless repository inspection command: git status --short.',
      'Then reply with READY and nothing else.',
    ].join('\n');
    let providerSessionId = '';
    try {
      let snapshot = await this.createConversation(
        launchInput,
        prompt,
        { runtimeprobe: tagValue(input.probeId) },
        { maxIterations: 1, secrets, roleTag: 'runtimeprobe' },
      );
      providerSessionId = snapshot.providerSessionId;
      const deadline = Date.now() + Math.min(90_000, (this.acp.startupTimeoutSeconds + 60) * 1000);
      while (!TERMINAL_STATUSES.has(snapshot.status) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        snapshot = await this.inspect(providerSessionId);
      }
      const response = snapshot.finalResponse?.trim() ?? '';
      const ready =
        snapshot.status === 'SUCCEEDED' &&
        /(?:^|\b)READY(?:\b|$)/i.test(response) &&
        !/TRANSPORT_ERROR|ACP error|runtime error/i.test(response);
      return {
        provider: this.provider,
        providerSessionId,
        status: snapshot.status,
        ready,
        observedAt: snapshot.observedAt,
      };
    } finally {
      if (providerSessionId) {
        try {
          const current = await this.inspect(providerSessionId);
          if (!TERMINAL_STATUSES.has(current.status)) await this.interrupt(providerSessionId);
        } catch {
          // The disposable probe is already unusable; deletion below remains best effort.
        }
        try {
          await this.deleteConversation(providerSessionId);
        } catch {
          // OpenHands idle eviction is the fallback cleanup path.
        }
      }
    }
  }

  private runtimeProbeSecrets(input: ProviderLaunchInput): JsonRecord {
    const secrets = { ...this.conversationSecrets(input) };
    for (const key of [
      'PIXEL_V4_IMPLEMENTATION_EVIDENCE_PATH',
      'PIXEL_V4_REVIEW_EVIDENCE_PATH',
      'PIXEL_V4_SOURCE_SHA',
      'PIXEL_V4_REVIEWED_SHA',
      'PIXEL_V4_IMPLEMENTATION_PHASE',
    ])
      delete secrets[key];
    if (this.driver === 'codex' || this.driver === 'claude') {
      secrets.AI_OFFICE_HEADLESS_ROLE = { kind: 'StaticSecret', value: 'planner' };
      secrets.AI_OFFICE_HEADLESS_REASONING_EFFORT = { kind: 'StaticSecret', value: 'low' };
      secrets.AI_OFFICE_HEADLESS_TIMEOUT_SECONDS = { kind: 'StaticSecret', value: '60' };
    }
    return secrets;
  }

  protected override evidencePath(input: ProviderLaunchInput): string {
    return this.driver === 'codex' || this.driver === 'claude'
      ? input.workspace.evidenceExecutionPath
      : super.evidencePath(input);
  }

  protected override conversationAgent(
    _input: ProviderLaunchInput,
    _tools: Array<{ name: string }>,
  ): JsonRecord {
    return {
      kind: 'ACPAgent',
      acp_command: this.acp.command,
      acp_server: this.acp.acpServer,
      acp_prompt_timeout: this.acp.promptTimeoutSeconds,
      acp_startup_timeout: this.acp.startupTimeoutSeconds,
      acp_model: this.selectedModel,
    };
  }

  protected override conversationSecrets(input: ProviderLaunchInput): JsonRecord {
    const secrets: JsonRecord = {
      ...super.conversationSecrets(input),
      AI_OFFICE_AGENT_BACKEND: { kind: 'StaticSecret', value: this.driver + '-acp' },
      AI_OFFICE_AGENT_TRANSPORT: { kind: 'StaticSecret', value: this.transport },
      AI_OFFICE_AGENT_MODEL: { kind: 'StaticSecret', value: this.selectedModel },
      AI_OFFICE_WORKSPACE_ROOT: {
        kind: 'StaticSecret',
        value: this.acp.workspaceRoot,
      },
      HERMES_V3_EXECUTION_ID: { kind: 'StaticSecret', value: input.executionId },
      HERMES_V3_WORKSPACE_REF: {
        kind: 'StaticSecret',
        value: input.workspace.executionPath,
      },
    };

    if (this.driver === 'codex' || this.driver === 'claude') {
      secrets.AI_OFFICE_HEADLESS_DRIVER = { kind: 'StaticSecret', value: this.driver };
      secrets.AI_OFFICE_HEADLESS_ROLE = {
        kind: 'StaticSecret',
        value: this.mode === 'IMPLEMENTATION' ? 'worker' : 'review',
      };
      secrets.AI_OFFICE_HEADLESS_TRANSPORT = {
        kind: 'StaticSecret',
        value: this.transport,
      };
      secrets.AI_OFFICE_HEADLESS_MODEL = {
        kind: 'StaticSecret',
        value: this.selectedModel,
      };
      secrets.AI_OFFICE_HEADLESS_REASONING_EFFORT = {
        kind: 'StaticSecret',
        value: this.acp.reasoningEffort,
      };
      secrets.AI_OFFICE_HEADLESS_TIMEOUT_SECONDS = {
        kind: 'StaticSecret',
        value: String(this.acp.promptTimeoutSeconds),
      };
      if (this.binary) {
        secrets[this.driver === 'codex' ? 'AI_OFFICE_CODEX_BIN' : 'AI_OFFICE_CLAUDE_BIN'] = {
          kind: 'StaticSecret',
          value: this.binary,
        };
      }
    }

    if (this.transport === 'litellm-managed') {
      secrets.LITELLM_V3_KEY = {
        kind: 'StaticSecret',
        value: this.options.liteLlmApiKey,
      };
      secrets.LITELLM_V3_BASE_URL = {
        kind: 'StaticSecret',
        value: this.options.liteLlmBaseUrl,
      };
      secrets.AI_OFFICE_LITELLM_BASE_URL = {
        kind: 'StaticSecret',
        value: this.options.liteLlmBaseUrl,
      };
      secrets.AI_OFFICE_LITELLM_API_KEY = {
        kind: 'StaticSecret',
        value: this.options.liteLlmApiKey,
      };
    } else if (this.authHome) {
      secrets.AI_OFFICE_CODEX_AUTH_HOME = {
        kind: 'StaticSecret',
        value: this.authHome,
      };
    }

    if (this.driver === 'dsh') {
      secrets.DEEPSEEK_API_KEY = {
        kind: 'StaticSecret',
        value: this.options.liteLlmApiKey,
      };
      secrets.DEEPSEEK_BASE_URL = {
        kind: 'StaticSecret',
        value: this.options.liteLlmBaseUrl,
      };
      secrets.DSH_ACP_MODEL = { kind: 'StaticSecret', value: this.selectedModel };
      secrets.AI_OFFICE_HEADLESS_REASONING_EFFORT = {
        kind: 'StaticSecret',
        value: this.acp.reasoningEffort,
      };
    }
    if (this.driver === 'zcode') {
      secrets.ZCODE_API_KEY = {
        kind: 'StaticSecret',
        value: this.options.liteLlmApiKey,
      };
      secrets.ZCODE_BASE_URL = {
        kind: 'StaticSecret',
        value: this.options.liteLlmBaseUrl,
      };
      secrets.ZCODE_MODEL = { kind: 'StaticSecret', value: this.selectedModel };
    }

    if (this.mode === 'IMPLEMENTATION') {
      // Implementation agents commit inside isolated execution workspaces. Use
      // process-scoped identity so commits never depend on mutable host/global
      // git config and review sessions remain unable to inherit an author role.
      secrets.GIT_AUTHOR_NAME = { kind: 'StaticSecret', value: 'Pixel Agent' };
      secrets.GIT_AUTHOR_EMAIL = { kind: 'StaticSecret', value: 'pixel-agent@localhost' };
      secrets.GIT_COMMITTER_NAME = { kind: 'StaticSecret', value: 'Pixel Agent' };
      secrets.GIT_COMMITTER_EMAIL = { kind: 'StaticSecret', value: 'pixel-agent@localhost' };
      secrets.PIXEL_V4_IMPLEMENTATION_EVIDENCE_PATH = {
        kind: 'StaticSecret',
        value: this.evidencePath(input),
      };
      secrets.PIXEL_V4_SOURCE_SHA = { kind: 'StaticSecret', value: input.sourceRevision };
      secrets.PIXEL_V4_IMPLEMENTATION_PHASE = { kind: 'StaticSecret', value: input.phase };
    } else {
      secrets.PIXEL_V4_REVIEW_EVIDENCE_PATH = {
        kind: 'StaticSecret',
        value: this.evidencePath(input),
      };
      secrets.PIXEL_V4_REVIEWED_SHA = { kind: 'StaticSecret', value: input.sourceRevision };
    }
    secrets.PIXEL_V4_EXECUTION_ID = { kind: 'StaticSecret', value: input.executionId };
    return secrets;
  }
}

export class OpenHandsReviewProvider extends OpenHandsProviderBase implements ReviewProviderPort {
  readonly provider = 'openhands-independent-review';
  readonly independentReview = true as const;
  protected readonly mode = 'REVIEW' as const;
}

const HEADLESS_COMMAND = [
  '/usr/local/bin/node',
  '/opt/hermes-ai-office-tools/headless_review_acp.mjs',
];
const HARNESS_LAUNCHER = '/opt/hermes-ai-office-tools/harness_agent_launcher.sh';

function modelForRole(options: OpenHandsProviderOptions, role: OpenHandsProviderRole): string {
  return role === 'IMPLEMENTATION'
    ? (options.implementationModel ?? 'gpt-5.6-luna')
    : (options.reviewModel ?? 'gpt-5.6-sol');
}

function codexConfig(
  input: CodexManagedExecutionOptions | CodexBusinessReviewOptions,
  role: OpenHandsProviderRole,
  prefix: string,
): ResolvedAcpBackendOptions {
  return resolveAcpBackendOptions(
    input,
    {
      command: HEADLESS_COMMAND,
      reasoningEffort: role === 'IMPLEMENTATION' ? 'xhigh' : 'medium',
      promptTimeoutSeconds: role === 'IMPLEMENTATION' ? 1_800 : 1_200,
    },
    prefix,
  );
}

export class OpenHandsCodexManagedExecutionProvider extends OpenHandsModelNativeAcpProvider {
  readonly codex: Required<CodexManagedExecutionOptions>;

  constructor(options: OpenHandsProviderOptions, codex: CodexManagedExecutionOptions = {}) {
    const resolved = codexConfig(codex, 'IMPLEMENTATION', 'CODEX_MANAGED');
    super(options, {
      provider: 'codex-managed-coding',
      mode: 'IMPLEMENTATION',
      model: modelForRole(options, 'IMPLEMENTATION'),
      driver: 'codex',
      transport: 'litellm-managed',
      acp: resolved,
      binary: executablePath(
        codex.codexBin ?? '/openhands-state/tooling/node_modules/.bin/codex',
        'CODEX_MANAGED_CODEX_BIN_INVALID',
      ),
    });
    this.codex = {
      ...resolved,
      codexBin: executablePath(
        codex.codexBin ?? '/openhands-state/tooling/node_modules/.bin/codex',
        'CODEX_MANAGED_CODEX_BIN_INVALID',
      ),
    };
  }
}

export class OpenHandsCodexManagedReviewProvider
  extends OpenHandsModelNativeAcpProvider
  implements ReviewProviderPort
{
  readonly independentReview = true as const;
  readonly codex: Required<CodexManagedExecutionOptions>;

  constructor(options: OpenHandsProviderOptions, codex: CodexManagedExecutionOptions = {}) {
    const resolved = codexConfig(codex, 'REVIEW', 'CODEX_MANAGED');
    super(options, {
      provider: 'codex-managed-independent-review',
      mode: 'REVIEW',
      model: modelForRole(options, 'REVIEW'),
      driver: 'codex',
      transport: 'litellm-managed',
      acp: resolved,
      binary: executablePath(
        codex.codexBin ?? '/openhands-state/tooling/node_modules/.bin/codex',
        'CODEX_MANAGED_CODEX_BIN_INVALID',
      ),
    });
    this.codex = {
      ...resolved,
      codexBin: executablePath(
        codex.codexBin ?? '/openhands-state/tooling/node_modules/.bin/codex',
        'CODEX_MANAGED_CODEX_BIN_INVALID',
      ),
    };
  }
}

function businessConfig(
  input: CodexBusinessReviewOptions,
  role: OpenHandsProviderRole,
): { acp: ResolvedAcpBackendOptions; authHome: string; codexBin: string } {
  return {
    acp: codexConfig(input, role, 'CODEX_BUSINESS'),
    authHome: authHome(input.authHome, 'CODEX_BUSINESS_AUTH_HOME_INVALID'),
    codexBin: executablePath(
      input.codexBin ?? '/openhands-state/tooling/node_modules/.bin/codex',
      'CODEX_BUSINESS_CODEX_BIN_INVALID',
    ),
  };
}

export class OpenHandsCodexBusinessExecutionProvider extends OpenHandsModelNativeAcpProvider {
  readonly business: Required<CodexBusinessReviewOptions>;

  constructor(options: OpenHandsProviderOptions, business: CodexBusinessReviewOptions = {}) {
    const resolved = businessConfig(business, 'IMPLEMENTATION');
    super(options, {
      provider: 'codex-business-coding',
      mode: 'IMPLEMENTATION',
      model: modelForRole(options, 'IMPLEMENTATION'),
      driver: 'codex',
      transport: 'provider-native',
      acp: resolved.acp,
      authHome: resolved.authHome,
      binary: resolved.codexBin,
    });
    this.business = { ...resolved.acp, authHome: resolved.authHome, codexBin: resolved.codexBin };
  }
}

export class OpenHandsCodexBusinessReviewProvider
  extends OpenHandsModelNativeAcpProvider
  implements ReviewProviderPort
{
  readonly independentReview = true as const;
  readonly business: Required<CodexBusinessReviewOptions>;

  constructor(options: OpenHandsProviderOptions, business: CodexBusinessReviewOptions = {}) {
    const resolved = businessConfig(business, 'REVIEW');
    super(options, {
      provider: 'codex-business-independent-review',
      mode: 'REVIEW',
      model: modelForRole(options, 'REVIEW'),
      driver: 'codex',
      transport: 'provider-native',
      acp: resolved.acp,
      authHome: resolved.authHome,
      binary: resolved.codexBin,
    });
    this.business = { ...resolved.acp, authHome: resolved.authHome, codexBin: resolved.codexBin };
  }
}

export class OpenHandsDshExecutionProvider extends OpenHandsModelNativeAcpProvider {
  constructor(options: OpenHandsProviderOptions, dsh: AcpBackendOptions = {}) {
    super(options, {
      provider: 'dsh-managed-coding',
      mode: 'IMPLEMENTATION',
      model: modelForRole(options, 'IMPLEMENTATION'),
      driver: 'dsh',
      transport: 'litellm-managed',
      acp: resolveAcpBackendOptions(
        dsh,
        {
          command: [HARNESS_LAUNCHER, 'dsh-acp'],
          reasoningEffort: 'xhigh',
          promptTimeoutSeconds: 1_800,
        },
        'DSH_ACP',
      ),
    });
  }
}

export const OpenHandsDSHExecutionProvider = OpenHandsDshExecutionProvider;

export class OpenHandsZCodeExecutionProvider extends OpenHandsModelNativeAcpProvider {
  constructor(options: OpenHandsProviderOptions, zcode: AcpBackendOptions = {}) {
    super(options, {
      provider: 'zcode-managed-coding',
      mode: 'IMPLEMENTATION',
      model: modelForRole(options, 'IMPLEMENTATION'),
      driver: 'zcode',
      transport: 'litellm-managed',
      acp: resolveAcpBackendOptions(
        zcode,
        {
          command: [HARNESS_LAUNCHER, 'zcode-acp'],
          reasoningEffort: 'high',
          promptTimeoutSeconds: 1_800,
        },
        'ZCODE_ACP',
      ),
    });
  }
}

export const OpenHandsZCODEExecutionProvider = OpenHandsZCodeExecutionProvider;

export class OpenHandsClaudeReviewProvider
  extends OpenHandsModelNativeAcpProvider
  implements ReviewProviderPort
{
  readonly independentReview = true as const;
  readonly claude: Required<ClaudeReviewOptions>;

  constructor(options: OpenHandsProviderOptions, claude: ClaudeReviewOptions = {}) {
    const resolved = resolveAcpBackendOptions(
      claude,
      { command: HEADLESS_COMMAND, reasoningEffort: 'high', promptTimeoutSeconds: 1_200 },
      'CLAUDE_REVIEW',
    );
    const claudeBin = executablePath(
      claude.claudeBin ?? '/openhands-state/tooling/node_modules/.bin/claude',
      'CLAUDE_REVIEW_CLAUDE_BIN_INVALID',
    );
    super(options, {
      provider: 'claude-code-independent-review',
      mode: 'REVIEW',
      model: modelForRole(options, 'REVIEW'),
      driver: 'claude',
      transport: 'litellm-managed',
      acp: resolved,
      binary: claudeBin,
    });
    this.claude = {
      ...resolved,
      claudeBin,
    };
  }
}

function selectionRole(selection: OpenHandsProviderSelection): OpenHandsProviderRole {
  if (selection.role !== undefined)
    failClosed(
      selection.role === 'IMPLEMENTATION' || selection.role === 'REVIEW',
      'OPENHANDS_SELECTION_ROLE_INVALID',
    );
  if (selection.phase !== undefined)
    failClosed(
      selection.phase === 'IMPLEMENT' ||
        selection.phase === 'IMPLEMENT_FIX' ||
        selection.phase === 'REVIEW',
      'OPENHANDS_SELECTION_PHASE_INVALID',
    );
  if (selection.capability !== undefined)
    failClosed(
      selection.capability === 'IMPLEMENTATION' || selection.capability === 'REASONING',
      'OPENHANDS_SELECTION_CAPABILITY_INVALID',
    );
  const candidates = [
    selection.role,
    selection.phase === undefined
      ? undefined
      : selection.phase === 'REVIEW'
        ? ('REVIEW' as const)
        : ('IMPLEMENTATION' as const),
    selection.capability === undefined
      ? undefined
      : selection.capability === 'REASONING'
        ? ('REVIEW' as const)
        : ('IMPLEMENTATION' as const),
  ].filter((value): value is OpenHandsProviderRole => value !== undefined);
  failClosed(candidates.length > 0, 'OPENHANDS_SELECTION_ROLE_REQUIRED');
  const role = candidates[0]!;
  failClosed(
    candidates.every((candidate) => candidate === role),
    'OPENHANDS_SELECTION_ROLE_CONFLICT',
  );
  return role;
}

export function createOpenHandsProviderForSelection(
  options: OpenHandsProviderFactoryOptions,
  selection: OpenHandsProviderSelection,
): ExecutionProviderPort {
  const model = modelName(selection.model, 'OPENHANDS_SELECTION_MODEL_INVALID');
  const role = selectionRole(selection);
  failClosed(
    selection.transport === 'LITELLM_MANAGED' || selection.transport === 'PROVIDER_NATIVE',
    'OPENHANDS_SELECTION_TRANSPORT_INVALID',
  );
  const providerOptions: OpenHandsProviderOptions = {
    ...options,
    ...(role === 'IMPLEMENTATION' ? { implementationModel: model } : { reviewModel: model }),
  };
  switch (selection.backend) {
    case 'codex-acp':
      if (selection.transport === 'LITELLM_MANAGED') {
        return role === 'IMPLEMENTATION'
          ? new OpenHandsCodexManagedExecutionProvider(providerOptions, options.codex)
          : new OpenHandsCodexManagedReviewProvider(providerOptions, options.codex);
      }
      return role === 'IMPLEMENTATION'
        ? new OpenHandsCodexBusinessExecutionProvider(
            providerOptions,
            options.businessCodex ?? options.business,
          )
        : new OpenHandsCodexBusinessReviewProvider(
            providerOptions,
            options.businessCodex ?? options.business,
          );
    case 'dsh-acp':
      failClosed(selection.transport === 'LITELLM_MANAGED', 'DSH_PROVIDER_NATIVE_UNSUPPORTED');
      failClosed(role === 'IMPLEMENTATION', 'DSH_REVIEW_UNSUPPORTED');
      return new OpenHandsDshExecutionProvider(providerOptions, options.dsh);
    case 'zcode-acp':
      failClosed(selection.transport === 'LITELLM_MANAGED', 'ZCODE_PROVIDER_NATIVE_UNSUPPORTED');
      failClosed(role === 'IMPLEMENTATION', 'ZCODE_REVIEW_UNSUPPORTED');
      return new OpenHandsZCodeExecutionProvider(providerOptions, options.zcode);
    case 'claude-code-acp':
      failClosed(selection.transport === 'LITELLM_MANAGED', 'CLAUDE_PROVIDER_NATIVE_UNSUPPORTED');
      failClosed(role === 'REVIEW', 'CLAUDE_IMPLEMENTATION_UNSUPPORTED');
      return new OpenHandsClaudeReviewProvider(providerOptions, options.claude);
    case 'openhands-builtin':
      failClosed(
        selection.transport === 'LITELLM_MANAGED',
        'OPENHANDS_BUILTIN_PROVIDER_NATIVE_UNSUPPORTED',
      );
      return role === 'IMPLEMENTATION'
        ? new OpenHandsExecutionProvider(providerOptions)
        : new OpenHandsReviewProvider(providerOptions);
    default:
      throw new V4Error('OPENHANDS_BACKEND_UNSUPPORTED');
  }
}

export function createOpenHandsProviderFactory(
  options: OpenHandsProviderFactoryOptions,
): (selection: OpenHandsProviderSelection) => ExecutionProviderPort {
  return (selection) => createOpenHandsProviderForSelection(options, selection);
}

export const createOpenHandsProvider = createOpenHandsProviderForSelection;

export function createOpenHandsProviders(options: OpenHandsProviderOptions): {
  execution: OpenHandsExecutionProvider;
  review: OpenHandsReviewProvider;
} {
  // Compatibility-only pair. New callers must use createOpenHandsProviderForSelection
  // so a known model affinity cannot silently fall back to OpenHands' generic Agent.
  return {
    execution: new OpenHandsExecutionProvider(options),
    review: new OpenHandsReviewProvider(options),
  };
}
