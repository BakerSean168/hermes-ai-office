import type { DevelopmentPolicy } from './policy.js';
import type {
  DevelopmentExecutionServicePort,
  ExecutionHostPort,
  ModelGatewayPort,
  ObservabilityPort,
} from './ports.js';
import type {
  DevelopmentExecutionSnapshot,
  DevelopmentPhase,
  ExecutionLinkRecord,
  ExecutionSelection,
  ExecutionStatus,
  StartDevelopmentExecutionInput,
} from './types.js';
import { ExecutionLinkRepository } from './correlation.js';
import type { PlanDeliveryPort } from './delivery.js';
import { DurablePlanOrchestrator, type PlanRecoveryMode } from './planOrchestrator.js';
import { PlanRepository, type CreatePlanInput, type DelegatePlanInput } from './plans.js';
import { reviewVerdict } from './reviewVerdict.js';
import type { WorkspaceProvisioningPort } from './workspace.js';

const TERMINAL = new Set<ExecutionStatus>(['SUCCEEDED', 'FAILED', 'STUCK', 'CANCELLED']);
const WRITER_PHASES = new Set<DevelopmentPhase>(['IMPLEMENT', 'IMPLEMENT_FIX']);
const ACTIVE_WRITER_STATUSES = new Set<ExecutionStatus>([
  'STARTING',
  'RUNNING',
  'WAITING_FOR_CONFIRMATION',
]);
const WRITER_LEASE_STATUSES = new Set<ExecutionStatus>([...ACTIVE_WRITER_STATUSES, 'PAUSED']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function objectiveSummary(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function phasePrompt(input: StartDevelopmentExecutionInput): string {
  const criteria = input.context?.acceptanceCriteria?.length
    ? `\nAcceptance criteria:\n${input.context.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`
    : '';
  const previous = input.context?.previousResult?.trim()
    ? `\nPrevious phase result:\n${input.context.previousResult.trim().slice(0, 12_000)}`
    : '';
  const rules: Record<DevelopmentPhase, string[]> = {
    ORCHESTRATE: [
      'Act as the AI Office engineering supervisor for the supplied project objective or active plan.',
      'Keep this supervisor workspace read-only. Use terminal and task_tool_set for bounded repository investigation.',
      'Do not launch coding workers from ORCHESTRATE. Produce the dependency-aware execution graph; the durable Control Plane launches ACP workers, independent review, repair, integration, and delivery after the graph validates.',
      'Put dependency-independent tickets in the same ready batch so the Control Plane may execute them in parallel within configured writer limits.',
      'Keep acceptance criteria observable and repository-grounded. Preserve active-plan constraints and explicitly leave operator/cloud-resource-only work parked when the objective requires it.',
      'Stop and report a blocking decision instead of inventing requirements or bypassing a protected contract.',
    ],
    INVESTIGATE_PLAN: [
      'Investigate the repository and identify evidence-backed root causes.',
      'Do not modify repository files in this phase.',
      'Produce one coherent result containing diagnosis, evidence, risks, and an implementation plan.',
      'Prefer inspecting the real code and configuration over speculation.',
    ],
    IMPLEMENT: [
      'Implement the approved objective in the isolated workspace.',
      'Run focused tests or checks that are proportionate to the change.',
      'Do not silently broaden scope beyond the objective.',
      'Before finishing, commit all intended changes to Git with a meaningful commit message and leave the workspace clean; deterministic batch integration rejects uncommitted changes.',
      'Finish with changed files, validation evidence, and any remaining risk.',
    ],
    IMPLEMENT_FIX: [
      'Address only the review or verification findings supplied in context.',
      'Preserve already-correct implementation work.',
      'Run focused regression checks before finishing.',
      'Before finishing, commit all intended fixes to Git with a meaningful commit message and leave the workspace clean; deterministic batch integration rejects uncommitted changes.',
      'A planning-only or no-op result is not a successful fix: this writer execution must advance Git HEAD with a new commit before review can begin.',
    ],
    VERIFY_REVIEW: [
      'Review the implementation independently and verify behavior from repository evidence.',
      'Perform review directly in this execution; do not delegate VERIFY_REVIEW to nested task subagents.',
      'The first non-empty line of the final result MUST be exactly PASS or FAIL so the control plane can apply the review verdict deterministically.',
      'Use PASS only when the implementation satisfies the supplied acceptance criteria; otherwise use FAIL and report the blocking findings below it.',
      'The supplied review snapshot is intentionally physically read-only and must remain unchanged.',
      'AI Office freezes the implementation workspace at its current HEAD. Committed implementation work therefore stays committed and a clean implementation remains clean in the review snapshot. The original implementation source revision is preserved at refs/ai-office/review-base for comparison. Any dirty files in the snapshot represent genuine uncommitted implementation changes.',
      'Review implementation correctness and locally verifiable acceptance criteria only. Do not fail because the delivery branch, pull request, remote checks, merge, or post-merge verification is not present yet; AI Office performs those delivery gates only after this review passes.',
      'Do not classify read-only permission errors as implementation defects.',
      'If dependency installation, compilation, tests, or build outputs require writes, copy the complete review snapshot to a fresh temporary directory under /tmp, make only that disposable copy writable, run verification there, and discard it afterward.',
      'Before returning a verdict, independently inspect repository evidence and execute at least one focused verification command. Do not return FAIL merely because verification has not yet been attempted. Run setup, dependency installation, tests, typecheck, build, and cleanup as short separate terminal tool invocations; do not combine the whole verification workflow into one long compound shell command.',
      'Use the read-only snapshot as the evidence source and ensure the disposable verification copy represents the same Git-visible implementation working tree.',
      'Report concrete defects with severity and evidence; otherwise explicitly approve.',
    ],
    FINALIZE: [
      'Summarize the completed development run and its verification evidence.',
      'Do not make additional code changes.',
    ],
  };
  return [
    `Hermes development phase: ${input.phase}`,
    `Project: ${input.projectKey}`,
    input.phase === 'ORCHESTRATE' && input.repository.path
      ? `Worker source repository reference: ${input.repository.path}`
      : '',
    '',
    'Objective:',
    input.objective.trim(),
    previous,
    criteria,
    '',
    'Phase rules:',
    ...rules[input.phase].map((rule) => `- ${rule}`),
    '',
    'Return a concise but complete final result suitable for the Hermes Brain to decide the next phase.',
  ]
    .filter(Boolean)
    .join('\n');
}

function selectionFromRecord(record: ExecutionLinkRecord): ExecutionSelection {
  return {
    backend: record.backend,
    modelClass: record.logicalModelClass,
    transportMode: record.transportMode,
    workspaceMode: record.workspaceMode,
    sessionPolicy: record.sessionPolicy,
    reasons: record.selectionReasons,
  };
}

export class UnconfiguredObservability implements ObservabilityPort {
  readonly source = 'UNCONFIGURED' as const;
  async health(): Promise<'UNCONFIGURED'> {
    return 'UNCONFIGURED';
  }
  async getExecutionSummary(): Promise<{ health: 'UNCONFIGURED' }> {
    return { health: 'UNCONFIGURED' };
  }
}

export class DevelopmentExecutionService implements DevelopmentExecutionServicePort {
  readonly #policy: DevelopmentPolicy;
  readonly #links: ExecutionLinkRepository;
  readonly #host: ExecutionHostPort;
  readonly #workspace: WorkspaceProvisioningPort;
  readonly #gateway?: ModelGatewayPort;
  readonly #observability: ObservabilityPort;
  readonly #planOrchestrator: DurablePlanOrchestrator;
  readonly #backendAvailability: Readonly<Record<string, boolean>>;
  #writerAdmissionTail: Promise<void> = Promise.resolve();

  constructor(options: {
    policy: DevelopmentPolicy;
    links: ExecutionLinkRepository;
    host: ExecutionHostPort;
    workspace: WorkspaceProvisioningPort;
    gateway?: ModelGatewayPort;
    observability?: ObservabilityPort;
    plans: PlanRepository;
    delivery?: PlanDeliveryPort;
    backendAvailability?: Readonly<Record<string, boolean>>;
  }) {
    this.#policy = options.policy;
    this.#links = options.links;
    this.#host = options.host;
    this.#workspace = options.workspace;
    this.#gateway = options.gateway;
    this.#observability = options.observability ?? new UnconfiguredObservability();
    this.#planOrchestrator = new DurablePlanOrchestrator({
      repository: options.plans,
      links: options.links,
      workspace: options.workspace,
      delivery: options.delivery,
      executions: this,
    });
    this.#backendAvailability = options.backendAvailability ?? {};
  }

  #requirePreviousImplementation(input: StartDevelopmentExecutionInput): ExecutionLinkRecord {
    const previousExecutionId = input.context?.previousExecutionId?.trim();
    if (!previousExecutionId) throw new Error('PREVIOUS_EXECUTION_REQUIRED');
    const previous = this.#links.get(previousExecutionId);
    if (!previous) throw new Error('PREVIOUS_EXECUTION_NOT_FOUND');
    if (previous.projectKey !== input.projectKey) {
      throw new Error('PREVIOUS_EXECUTION_PROJECT_MISMATCH');
    }
    if (!['IMPLEMENT', 'IMPLEMENT_FIX'].includes(previous.phase)) {
      throw new Error('PREVIOUS_EXECUTION_NOT_IMPLEMENTATION');
    }
    if (previous.statusCache !== 'SUCCEEDED') {
      throw new Error('PREVIOUS_EXECUTION_NOT_REVIEWABLE');
    }
    return previous;
  }

  async #resolveFixLineage(input: StartDevelopmentExecutionInput): Promise<{
    review: ExecutionLinkRecord;
    implementation: ExecutionLinkRecord;
    reviewResult: string;
  }> {
    const reviewExecutionId = input.context?.previousExecutionId?.trim();
    if (!reviewExecutionId) throw new Error('PREVIOUS_EXECUTION_REQUIRED');
    const review = this.#links.get(reviewExecutionId);
    if (!review) throw new Error('PREVIOUS_EXECUTION_NOT_FOUND');
    if (review.projectKey !== input.projectKey) {
      throw new Error('PREVIOUS_EXECUTION_PROJECT_MISMATCH');
    }
    if (review.phase !== 'VERIFY_REVIEW') {
      throw new Error('PREVIOUS_EXECUTION_NOT_REVIEW');
    }
    let reviewResult = review.resultText?.trim() ?? '';
    if (review.statusCache !== 'SUCCEEDED' || !reviewResult) {
      const reviewSnapshot = await this.get(reviewExecutionId);
      if (!reviewSnapshot || reviewSnapshot.status !== 'SUCCEEDED') {
        throw new Error('PREVIOUS_EXECUTION_NOT_FIXABLE');
      }
      reviewResult =
        this.#links.get(reviewExecutionId)?.resultText?.trim() ||
        reviewSnapshot.result?.finalText?.trim() ||
        '';
    }
    const verdict = reviewVerdict(reviewResult);
    if (verdict === 'APPROVED') throw new Error('PREVIOUS_EXECUTION_REVIEW_ALREADY_APPROVED');
    if (verdict === 'UNKNOWN') throw new Error('PREVIOUS_EXECUTION_REVIEW_VERDICT_UNKNOWN');

    const implementationExecutionId = review.previousExecutionId?.trim();
    if (!implementationExecutionId) throw new Error('REVIEW_IMPLEMENTATION_LINK_MISSING');
    const implementation = this.#links.get(implementationExecutionId);
    if (!implementation) throw new Error('REVIEW_IMPLEMENTATION_NOT_FOUND');
    if (implementation.projectKey !== input.projectKey) {
      throw new Error('PREVIOUS_EXECUTION_PROJECT_MISMATCH');
    }
    if (!['IMPLEMENT', 'IMPLEMENT_FIX'].includes(implementation.phase)) {
      throw new Error('REVIEW_IMPLEMENTATION_LINK_INVALID');
    }
    if (implementation.statusCache !== 'SUCCEEDED') {
      throw new Error('PREVIOUS_EXECUTION_NOT_FIXABLE');
    }
    if (!implementation.workspaceRef) throw new Error('PREVIOUS_EXECUTION_WORKSPACE_MISSING');
    return {
      review,
      implementation,
      reviewResult,
    };
  }

  async #withWriterAdmission<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const predecessor = this.#writerAdmissionTail;
    this.#writerAdmissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #reconcileWriterCandidates(): Promise<ExecutionLinkRecord[]> {
    const candidates = this.#links.writerCandidates();
    const reconciled: ExecutionLinkRecord[] = [];
    for (const candidate of candidates) {
      let record = candidate;
      if (record.openhandsConversationId) {
        try {
          const upstream = await this.#host.getExecution(record.openhandsConversationId);
          if (upstream && upstream.status !== record.statusCache) {
            record = this.#links.updateStatus(record.executionId, upstream.status);
          }
        } catch {
          // Fail closed. A temporarily unreachable execution host must not cause us to
          // hand the same mutable workspace to another writer or exceed a known cap.
        }
      }
      if (WRITER_LEASE_STATUSES.has(record.statusCache)) reconciled.push(record);
    }
    return reconciled;
  }

  #enforceWriterAdmission(
    projectKey: string,
    candidates: ExecutionLinkRecord[],
    mutableWorkspaceRef?: string,
  ): void {
    // A PAUSED writer still owns its mutable workspace and may be in the short
    // ACP startup/pause transition before RUNNING. Count every writer lease as
    // admission occupancy so concurrent starts cannot oversubscribe the cap.
    const occupied = candidates.filter((record) => WRITER_LEASE_STATUSES.has(record.statusCache));
    const limits = this.#policy.config.concurrency;
    if (occupied.length >= limits.max_active_writers) {
      throw new Error('WRITER_CONCURRENCY_GLOBAL_LIMIT');
    }
    if (
      occupied.filter((record) => record.projectKey === projectKey).length >=
      limits.max_active_writers_per_project
    ) {
      throw new Error('WRITER_CONCURRENCY_PROJECT_LIMIT');
    }
    if (
      mutableWorkspaceRef &&
      candidates.some(
        (record) =>
          record.workspaceRef === mutableWorkspaceRef &&
          WRITER_LEASE_STATUSES.has(record.statusCache),
      )
    ) {
      throw new Error('WORKSPACE_WRITER_LEASE_CONFLICT');
    }
  }

  async #finalizeDeterministically(
    input: StartDevelopmentExecutionInput,
    record: ExecutionLinkRecord,
  ): Promise<ExecutionLinkRecord> {
    const previousExecutionId = input.context?.previousExecutionId?.trim();
    if (!previousExecutionId) throw new Error('PREVIOUS_EXECUTION_REQUIRED');
    const previousRecord = this.#links.get(previousExecutionId);
    if (!previousRecord) throw new Error('PREVIOUS_EXECUTION_NOT_FOUND');
    if (previousRecord.projectKey !== input.projectKey) {
      throw new Error('PREVIOUS_EXECUTION_PROJECT_MISMATCH');
    }
    if (previousRecord.phase !== 'VERIFY_REVIEW') {
      throw new Error('PREVIOUS_EXECUTION_NOT_REVIEW');
    }
    const previous = await this.get(previousExecutionId);
    if (!previous || previous.status !== 'SUCCEEDED') {
      throw new Error('PREVIOUS_EXECUTION_NOT_FINALIZABLE');
    }
    const evidence = previous.result?.finalText?.trim() || '';
    const verdict = reviewVerdict(evidence);
    if (verdict === 'BLOCKING') throw new Error('PREVIOUS_EXECUTION_REVIEW_BLOCKING');
    if (verdict === 'UNKNOWN') throw new Error('PREVIOUS_EXECUTION_REVIEW_VERDICT_UNKNOWN');

    const finalText = [
      'FINALIZED',
      `Project: ${input.projectKey}`,
      `Review execution: ${previous.executionId}`,
      `Review status: ${previous.status}`,
      '',
      'Review evidence:',
      evidence || '(review completed without textual evidence)',
    ].join('\n');
    return this.#links.completeInternal(record.executionId, finalText);
  }

  async runtimeSummary() {
    const [openhands, gateway, observability] = await Promise.all([
      this.#host.health(),
      this.#gateway?.summary() ??
        Promise.resolve({ health: 'UNCONFIGURED' as const, logicalModels: [] as string[] }),
      this.#observability.health(),
    ]);
    return {
      sourceHealth: {
        openhands,
        litellm: gateway.health,
        observability,
        langfuse: this.#observability.source === 'LANGFUSE' ? observability : 'UNCONFIGURED',
      },
      logicalModels: gateway.logicalModels,
      enabledBackends: Object.entries(this.#policy.config.backends)
        .filter(([name, backend]) => backend.enabled && this.#backendAvailability[name] !== false)
        .map(([name]) => name)
        .sort(),
      concurrency: this.#policy.config.concurrency,
    };
  }

  async start(
    input: StartDevelopmentExecutionInput,
    idempotencyKey: string,
  ): Promise<DevelopmentExecutionSnapshot> {
    if (!idempotencyKey.trim()) throw new Error('IDEMPOTENCY_KEY_REQUIRED');
    if (!input.objective?.trim()) throw new Error('OBJECTIVE_REQUIRED');
    if (!input.projectKey?.trim()) throw new Error('PROJECT_KEY_REQUIRED');
    if (
      ['ORCHESTRATE', 'INVESTIGATE_PLAN', 'IMPLEMENT'].includes(input.phase) &&
      !input.repository?.path
    ) {
      throw new Error('REPOSITORY_PATH_REQUIRED');
    }

    const existing = input.plan
      ? this.#links.findByCommandKey(input.plan.commandKey)
      : this.#links.findByIdempotencyKey(idempotencyKey);
    let fixLineage: {
      review: ExecutionLinkRecord;
      implementation: ExecutionLinkRecord;
      reviewResult: string;
    } | null = null;
    let effectiveInput = input;
    if (!existing && input.phase === 'IMPLEMENT_FIX') {
      fixLineage = await this.#resolveFixLineage(input);
      effectiveInput = {
        ...input,
        context: {
          ...input.context,
          previousResult: fixLineage.reviewResult,
        },
      };
    }

    const selection = this.#policy.select(
      input.phase,
      effectiveInput.override ?? {},
      this.#backendAvailability,
      effectiveInput.hints ?? {},
    );
    const reserve = () =>
      this.#links.reserve({
        idempotencyKey,
        projectKey: input.projectKey,
        phase: input.phase,
        objectiveSummary: objectiveSummary(input.objective),
        selection,
        hermes: input.hermes,
        previousExecutionId: effectiveInput.context?.previousExecutionId,
        plan: effectiveInput.plan,
      });

    let reservation: ReturnType<ExecutionLinkRepository['reserve']>;
    if (existing) {
      reservation = { record: existing, created: false };
    } else if (WRITER_PHASES.has(input.phase)) {
      reservation = await this.#withWriterAdmission(async () => {
        const raced = effectiveInput.plan
          ? this.#links.findByCommandKey(effectiveInput.plan.commandKey)
          : this.#links.findByIdempotencyKey(idempotencyKey);
        if (raced) return { record: raced, created: false };
        const candidates = await this.#reconcileWriterCandidates();
        if (effectiveInput.phase === 'IMPLEMENT_FIX') {
          if (!fixLineage) throw new Error('PREVIOUS_EXECUTION_NOT_FIXABLE');
          this.#enforceWriterAdmission(
            effectiveInput.projectKey,
            candidates,
            fixLineage.implementation.workspaceRef,
          );
        } else {
          this.#enforceWriterAdmission(input.projectKey, candidates);
        }
        const admitted = reserve();
        if (effectiveInput.phase === 'IMPLEMENT_FIX' && fixLineage) {
          const previous = fixLineage.implementation;
          admitted.record = this.#links.attachWorkspace(admitted.record.executionId, {
            workspaceRef: previous.workspaceRef!,
            gitBranch: previous.gitBranch,
            sourceRevision: previous.sourceRevision,
          });
        }
        return admitted;
      });
    } else {
      reservation = reserve();
    }
    let record = reservation.record;

    if (input.phase === 'FINALIZE') {
      if (record.statusCache !== 'SUCCEEDED' || !record.resultText) {
        try {
          record = await this.#finalizeDeterministically(input, record);
        } catch (error) {
          this.#links.updateStatus(record.executionId, 'FAILED');
          throw error;
        }
      }
      return (await this.get(record.executionId))!;
    }

    if (!record.workspaceRef) {
      try {
        let repositoryPath = input.repository.path;
        let baseRevision = input.repository.baseRevision;
        let reviewBaseRevision: string | undefined;

        if (effectiveInput.phase === 'IMPLEMENT_FIX') {
          if (!fixLineage) throw new Error('PREVIOUS_EXECUTION_NOT_FIXABLE');
          const previous = fixLineage.implementation;
          record = this.#links.attachWorkspace(record.executionId, {
            workspaceRef: previous.workspaceRef!,
            gitBranch: previous.gitBranch,
            sourceRevision: previous.sourceRevision,
          });
        } else {
          if (input.phase === 'VERIFY_REVIEW') {
            const previous = this.#requirePreviousImplementation(effectiveInput);
            if (!previous.workspaceRef) throw new Error('PREVIOUS_EXECUTION_WORKSPACE_MISSING');
            repositoryPath = this.#workspace.hostPathForWorkspaceRef(previous.workspaceRef);
            // Freeze the implementation workspace at its current HEAD. Committed worker changes stay
            // committed in the review snapshot; only genuinely uncommitted changes appear dirty.
            // Preserve the original implementation source as a dedicated comparison ref.
            baseRevision = 'HEAD';
            reviewBaseRevision = previous.sourceRevision;
          }
          const provisioned = await this.#workspace.provision({
            executionId: record.executionId,
            repositoryPath,
            baseRevision,
            workspaceMode: record.workspaceMode,
            reviewBaseRevision,
          });
          record = this.#links.attachWorkspace(record.executionId, {
            workspaceRef: provisioned.executionPath,
            gitBranch: provisioned.branch,
            sourceRevision: provisioned.sourceRevision,
          });
        }
      } catch (error) {
        this.#links.updateStatus(record.executionId, 'FAILED');
        throw error;
      }
    }

    if (!record.openhandsConversationId) {
      try {
        if (WRITER_PHASES.has(record.phase)) {
          if (!record.workspaceRef) throw new Error('PREVIOUS_EXECUTION_WORKSPACE_MISSING');
          await this.#workspace.prepareWriterExecution({
            executionId: record.executionId,
            workspaceRef: record.workspaceRef,
          });
        }
        const created = await this.#host.createExecution({
          executionId: record.executionId,
          projectKey: record.projectKey,
          phase: record.phase,
          objective: phasePrompt(effectiveInput),
          repositoryPath: record.workspaceRef!,
          selection: selectionFromRecord(record),
          correlationMetadata: {
            execution_id: record.executionId,
            project_key: record.projectKey,
            phase: record.phase,
            ...(record.hermesProfile ? { hermes_profile: record.hermesProfile } : {}),
            ...(record.hermesSessionId ? { hermes_session_id: record.hermesSessionId } : {}),
            ...(record.hermesTurnId ? { hermes_turn_id: record.hermesTurnId } : {}),
          },
        });
        const hostStartedAt = created.startedAt ? Date.parse(created.startedAt) : Number.NaN;
        record = this.#links.attachOpenHands(
          record.executionId,
          created.conversationId,
          Number.isFinite(hostStartedAt) ? hostStartedAt : undefined,
        );
      } catch (error) {
        this.#links.updateStatus(record.executionId, 'FAILED');
        throw error;
      }
    }

    if (input.await !== false) {
      const timeoutMs = Math.max(1_000, input.timeoutMs ?? 10 * 60_000);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await this.get(record.executionId);
        if (!snapshot) throw new Error('EXECUTION_NOT_FOUND');
        if (TERMINAL.has(snapshot.status)) return snapshot;
        await sleep(2_000);
      }
      throw new Error('EXECUTION_AWAIT_TIMEOUT');
    }
    return (await this.get(record.executionId))!;
  }

  async get(executionId: string): Promise<DevelopmentExecutionSnapshot | null> {
    let record = this.#links.get(executionId);
    if (!record) return null;
    const [openHandsHealth, gatewaySummary, observabilityHealth] = await Promise.all([
      this.#host.health(),
      this.#gateway?.summary() ??
        Promise.resolve({
          health: 'UNCONFIGURED' as const,
          logicalModels: [],
          upstream: undefined,
        }),
      this.#observability.health(),
    ]);
    let hostSnapshot = record.openhandsConversationId
      ? await this.#host.getExecution(record.openhandsConversationId)
      : null;
    // Once the execution host accepts cancellation, product state is monotonic.
    // OpenHands implements cancel through an asynchronous pause primitive, so an
    // immediate follow-up GET may transiently still report RUNNING. Never let
    // that transport race resurrect a cancelled AI Office execution.
    const preserveCancelled = record.statusCache === 'CANCELLED';
    if (hostSnapshot && hostSnapshot.status !== record.statusCache && !preserveCancelled) {
      const observedAt = hostSnapshot.updatedAt ? Date.parse(hostSnapshot.updatedAt) : Number.NaN;
      const observedAtMs = Number.isFinite(observedAt) ? observedAt : undefined;
      if (
        hostSnapshot.status === 'SUCCEEDED' &&
        WRITER_PHASES.has(record.phase) &&
        !TERMINAL.has(record.statusCache)
      ) {
        try {
          if (!record.workspaceRef) throw new Error('PREVIOUS_EXECUTION_WORKSPACE_MISSING');
          await this.#workspace.verifyWriterCompletion({
            executionId: record.executionId,
            workspaceRef: record.workspaceRef,
          });
          record = this.#links.updateStatus(record.executionId, 'SUCCEEDED', observedAtMs);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const code = detail.split(':', 1)[0] || 'WRITER_COMPLETION_INVALID';
          record = this.#links.updateStatus(record.executionId, 'FAILED', observedAtMs);
          record = this.#links.attachFailure(record.executionId, {
            code,
            detail: detail.slice(0, 2_000),
            retryable: false,
          });
        }
      } else {
        record = this.#links.updateStatus(record.executionId, hostSnapshot.status, observedAtMs);
      }
    }
    const effectiveStatus = TERMINAL.has(record.statusCache)
      ? record.statusCache
      : (hostSnapshot?.status ?? record.statusCache);
    const hostFinalText = hostSnapshot?.finalText?.trim();
    if (hostFinalText && TERMINAL.has(effectiveStatus) && !record.resultText) {
      record = this.#links.attachResultText(record.executionId, hostFinalText);
    }
    if (hostSnapshot?.error && TERMINAL.has(effectiveStatus) && !record.errorCode) {
      record = this.#links.attachFailure(record.executionId, hostSnapshot.error);
    }
    const observed = await this.#observability.getExecutionSummary(executionId);
    if (observed.usage || observed.routeUsage) {
      record = this.#links.attachObservation(executionId, observed.usage, observed.routeUsage);
    }
    if (observed.traceId && observed.traceId !== record.langfuseTraceId) {
      record = this.#links.attachLangfuse(executionId, observed.traceId);
    }
    const ended = TERMINAL.has(effectiveStatus);
    const durableUsage = observed.usage ?? record.observedUsage ?? hostSnapshot?.usage ?? null;
    const durableRoutes = observed.routeUsage ?? record.observedRoutes ?? [];
    const lastObservedRoute = observed.lastObservedRoute ?? durableRoutes[0];
    return {
      executionId: record.executionId,
      projectKey: record.projectKey,
      phase: record.phase,
      objectiveSummary: record.objectiveSummary,
      status: effectiveStatus,
      selection: selectionFromRecord(record),
      result:
        record.resultText || hostSnapshot
          ? {
              finalText: record.resultText ?? hostSnapshot?.finalText ?? '',
              workspaceRef: record.workspaceRef,
              git: { branch: record.gitBranch ?? null },
            }
          : null,
      error: record.errorCode
        ? {
            code: record.errorCode,
            ...(record.errorDetail ? { detail: record.errorDetail } : {}),
            retryable: record.errorRetryable === true,
          }
        : null,
      timing: (() => {
        const startedAt = new Date(record.startedAt ?? record.createdAt).toISOString();
        const endedAt = ended
          ? new Date(record.endedAt ?? record.updatedAt).toISOString()
          : undefined;
        const durationMs = ended
          ? Math.max(
              0,
              (record.endedAt ?? record.updatedAt) - (record.startedAt ?? record.createdAt),
            )
          : undefined;
        return { startedAt, endedAt, durationMs };
      })(),
      usage: durableUsage,
      refs: {
        openhandsConversationId: record.openhandsConversationId,
        langfuseTraceId: record.langfuseTraceId ?? observed.traceId,
        upstream: {
          openhands: hostSnapshot?.upstream,
          gateway: gatewaySummary.upstream,
          route: lastObservedRoute,
          routeUsage: durableRoutes,
        },
      },
      sourceHealth: {
        openhands: openHandsHealth,
        litellm: gatewaySummary.health,
        observability: observabilityHealth,
        langfuse: this.#observability.source === 'LANGFUSE' ? observabilityHealth : 'UNCONFIGURED',
      },
    };
  }

  createPlan(input: CreatePlanInput, commandKey: string) {
    return this.#planOrchestrator.createPlan(input, commandKey);
  }

  delegatePlan(input: DelegatePlanInput, commandKey: string) {
    return this.#planOrchestrator.delegatePlan(input, commandKey);
  }

  getPlan(planId: string, hydrateExecutions = false) {
    return this.#planOrchestrator.getPlan(planId, hydrateExecutions);
  }

  listPlans(limit?: number) {
    return this.#planOrchestrator.listPlans(limit);
  }

  cancelPlan(planId: string) {
    return this.#planOrchestrator.cancelPlan(planId);
  }

  reconcilePlans(planId?: string, recoverBlocked = false, recoveryMode: PlanRecoveryMode = 'AUTO') {
    return this.#planOrchestrator.reconcilePlans(planId, recoverBlocked, recoveryMode);
  }

  async cancel(executionId: string): Promise<DevelopmentExecutionSnapshot | null> {
    const record = this.#links.get(executionId);
    if (!record) return null;
    if (record.openhandsConversationId) {
      await this.#host.cancelExecution(record.openhandsConversationId);
      this.#links.updateStatus(executionId, 'CANCELLED');
    } else {
      this.#links.updateStatus(executionId, 'CANCELLED');
    }
    return this.get(executionId);
  }

  async list(
    input: { projectKey?: string; limit?: number; offset?: number; hydrate?: boolean } = {},
  ) {
    const records = this.#links.list(input);
    const items = [];
    for (const record of records) {
      if (
        record.openhandsConversationId &&
        (!TERMINAL.has(record.statusCache) || input.hydrate === true)
      ) {
        try {
          const snapshot = await this.get(record.executionId);
          if (snapshot) {
            items.push({
              executionId: snapshot.executionId,
              projectKey: snapshot.projectKey,
              phase: snapshot.phase,
              objectiveSummary: snapshot.objectiveSummary,
              status: snapshot.status,
              selection: snapshot.selection,
              previousExecutionId: record.previousExecutionId ?? null,
              createdAt: new Date(record.createdAt).toISOString(),
              updatedAt: new Date(
                this.#links.get(record.executionId)?.updatedAt ?? record.updatedAt,
              ).toISOString(),
              timing: snapshot.timing,
              usage: snapshot.usage,
              sourceHealth: snapshot.sourceHealth,
              refs: snapshot.refs,
            });
            continue;
          }
        } catch {
          // Listing is a recovery surface. If OpenHands is temporarily unavailable,
          // return the last durable correlation status rather than dropping the item.
        }
      }
      items.push({
        executionId: record.executionId,
        projectKey: record.projectKey,
        phase: record.phase,
        objectiveSummary: record.objectiveSummary,
        status: record.statusCache,
        selection: selectionFromRecord(record),
        previousExecutionId: record.previousExecutionId ?? null,
        createdAt: new Date(record.createdAt).toISOString(),
        updatedAt: new Date(record.updatedAt).toISOString(),
        timing: {
          startedAt: new Date(record.startedAt ?? record.createdAt).toISOString(),
          ...(record.endedAt
            ? {
                endedAt: new Date(record.endedAt).toISOString(),
                durationMs: Math.max(0, record.endedAt - (record.startedAt ?? record.createdAt)),
              }
            : {}),
        },
        usage: record.observedUsage ?? null,
        refs: {
          openhandsConversationId: record.openhandsConversationId,
          langfuseTraceId: record.langfuseTraceId,
          upstream: {
            route: record.observedRoutes?.[0],
            routeUsage: record.observedRoutes ?? [],
          },
        },
      });
    }
    return items;
  }
}
