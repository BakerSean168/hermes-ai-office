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
import { PlanRepository, type CreatePlanInput, type WorkItemRecord } from './plans.js';
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
      'Keep this supervisor workspace read-only. Use task_tool_set for bounded investigation and ai_office_worker for coding-agent executions.',
      'The Worker source repository reference is a host path for ai_office_worker launches; do not try to open that host path from the supervisor container. Inspect the current mounted workspace instead.',
      'Launch independent IMPLEMENT workers only for dependency-independent tickets; the control plane enforces workspace isolation and writer concurrency.',
      'Prefer OpenCode or DSH workers for implementation. Use Codex or Claude Code for premium planning/review only when the runtime summary reports that backend enabled.',
      'For every implementation, launch an independent VERIFY_REVIEW against that implementation execution; on FAIL launch IMPLEMENT_FIX and review again.',
      'A review is usable only when its final result begins with strict PASS or FAIL. If a premium ACP reviewer times out, is cancelled/stuck/failed, or returns no strict verdict, cancel it if still active and retry VERIFY_REVIEW with openhands-builtin. Never treat transport completion as review approval.',
      'Do not claim that FINALIZE merges code. FINALIZE currently records a verified logical completion only; report integration as pending unless a separate integration mechanism proves it happened.',
      'Stop and report a blocking decision instead of bypassing a protected contract, review gate, writer lease, or failed verification.',
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
    ],
    VERIFY_REVIEW: [
      'Review the implementation independently and verify behavior from repository evidence.',
      'The first non-empty line of the final result MUST be exactly PASS or FAIL so the control plane can apply the review verdict deterministically.',
      'Use PASS only when the implementation satisfies the supplied acceptance criteria; otherwise use FAIL and report the blocking findings below it.',
      'The supplied review snapshot is intentionally physically read-only and must remain unchanged.',
      'Do not classify read-only permission errors as implementation defects.',
      'If dependency installation, compilation, tests, or build outputs require writes, copy the complete review snapshot to a fresh temporary directory under /tmp, make only that disposable copy writable, run verification there, and discard it afterward.',
      'Run setup, dependency installation, tests, typecheck, build, and cleanup as short separate terminal tool invocations; do not combine the whole verification workflow into one long compound shell command.',
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

function durableSnapshot(record: ExecutionLinkRecord): DevelopmentExecutionSnapshot {
  const ended = TERMINAL.has(record.statusCache);
  return {
    executionId: record.executionId,
    projectKey: record.projectKey,
    phase: record.phase,
    objectiveSummary: record.objectiveSummary,
    status: record.statusCache,
    selection: selectionFromRecord(record),
    result: record.resultText
      ? {
          finalText: record.resultText,
          workspaceRef: record.workspaceRef,
          git: { branch: record.gitBranch ?? null },
        }
      : null,
    timing: {
      startedAt: new Date(record.startedAt ?? record.createdAt).toISOString(),
      endedAt: ended ? new Date(record.endedAt ?? record.updatedAt).toISOString() : undefined,
      durationMs: ended
        ? Math.max(0, (record.endedAt ?? record.updatedAt) - (record.startedAt ?? record.createdAt))
        : undefined,
    },
    usage: record.observedUsage ?? null,
    refs: {
      openhandsConversationId: record.openhandsConversationId,
      langfuseTraceId: record.langfuseTraceId,
      upstream: { routeUsage: record.observedRoutes ?? [] },
    },
    sourceHealth: {
      openhands: 'UNCONFIGURED',
      litellm: 'UNCONFIGURED',
      observability: 'UNCONFIGURED',
      langfuse: 'UNCONFIGURED',
    },
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
  readonly #plans: PlanRepository;
  readonly #delivery?: PlanDeliveryPort;
  readonly #backendAvailability: Readonly<Record<string, boolean>>;
  #writerAdmissionTail: Promise<void> = Promise.resolve();
  #planReconcileTail: Promise<void> = Promise.resolve();

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
    this.#plans = options.plans;
    this.#delivery = options.delivery;
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
            // Anchor review snapshots at the implementation's original source revision,
            // then overlay the implementation tree. This keeps committed worker changes
            // visible as reviewable Git diff instead of disappearing behind a moved HEAD.
            baseRevision = previous.sourceRevision ?? 'HEAD';
          }
          const provisioned = await this.#workspace.provision({
            executionId: record.executionId,
            repositoryPath,
            baseRevision,
            workspaceMode: record.workspaceMode,
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
      record = this.#links.updateStatus(
        record.executionId,
        hostSnapshot.status,
        Number.isFinite(observedAt) ? observedAt : undefined,
      );
    }
    const effectiveStatus = preserveCancelled
      ? 'CANCELLED'
      : (hostSnapshot?.status ?? record.statusCache);
    const hostFinalText = hostSnapshot?.finalText?.trim();
    if (hostFinalText && TERMINAL.has(effectiveStatus) && !record.resultText) {
      record = this.#links.attachResultText(record.executionId, hostFinalText);
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

  async createPlan(input: CreatePlanInput, commandKey: string) {
    if (!commandKey.trim()) throw new Error('IDEMPOTENCY_KEY_REQUIRED');
    const { plan, created } = this.#plans.create(input, commandKey);
    if (created) await this.reconcilePlans(plan.planId);
    return (await this.getPlan(plan.planId))!;
  }

  async getPlan(planId: string, hydrateExecutions = true) {
    const plan = this.#plans.get(planId);
    if (!plan) return null;
    const batches = [];
    for (const batch of this.#plans.batches(planId)) {
      const workItems = [];
      for (const item of this.#plans.workItems(batch.batchId)) {
        const executions = [];
        for (const executionId of this.#plans.executionIds(item.workItemId)) {
          const snapshot = hydrateExecutions
            ? await this.get(executionId)
            : (() => {
                const record = this.#links.get(executionId);
                return record ? durableSnapshot(record) : null;
              })();
          if (snapshot) executions.push(snapshot);
        }
        workItems.push({ ...item, executions });
      }
      batches.push({ ...batch, workItems });
    }
    return {
      ...plan,
      batches,
      events: this.#plans.events(planId),
    };
  }

  async listPlans(limit = 100) {
    const items = [];
    for (const plan of this.#plans.list(limit)) {
      const projection = await this.getPlan(plan.planId, false);
      if (projection) items.push(projection);
    }
    return items;
  }

  async #launchPlanPhase(
    plan: ReturnType<PlanRepository['get']> extends infer Value ? Exclude<Value, null> : never,
    batch: ReturnType<PlanRepository['batches']>[number],
    item: WorkItemRecord,
    phase: 'IMPLEMENT' | 'IMPLEMENT_FIX' | 'VERIFY_REVIEW',
    previousExecutionId: string | undefined,
    attempt: number,
    overrideBackend?: string,
  ) {
    const commandKey = `${plan.planId}:${batch.key}:${item.key}:${phase}:${attempt}`;
    const snapshot = await this.start(
      {
        phase,
        objective:
          phase === 'VERIFY_REVIEW'
            ? `Independently review ${item.title}: ${item.objective}`
            : item.objective,
        projectKey: plan.projectKey,
        repository: {
          path: phase === 'IMPLEMENT' ? plan.repositoryPath : '',
          baseRevision:
            phase === 'IMPLEMENT' ? (batch.baseRevision ?? plan.currentRevision) : undefined,
        },
        context: {
          previousExecutionId,
          acceptanceCriteria: item.acceptanceCriteria,
        },
        override: overrideBackend ? { backend: overrideBackend } : undefined,
        await: false,
        plan: {
          planId: plan.planId,
          batchId: batch.batchId,
          workItemId: item.workItemId,
          attempt,
          commandKey,
        },
      },
      commandKey,
    );
    this.#plans.setWorkItemStatus(item.workItemId, 'RUNNING');
    this.#plans.appendEvent(
      plan.planId,
      'EXECUTION_STARTED',
      { phase, attempt },
      { batchId: batch.batchId, workItemId: item.workItemId, executionId: snapshot.executionId },
    );
    return snapshot;
  }

  async #reconcileWorkItem(
    plan: Exclude<ReturnType<PlanRepository['get']>, null>,
    batch: ReturnType<PlanRepository['batches']>[number],
    item: WorkItemRecord,
  ): Promise<void> {
    const executionIds = this.#plans.executionIds(item.workItemId);
    if (executionIds.length === 0) {
      await this.#launchPlanPhase(plan, batch, item, 'IMPLEMENT', undefined, 1);
      return;
    }
    const records = executionIds
      .map((executionId) => this.#links.get(executionId))
      .filter((record): record is ExecutionLinkRecord => Boolean(record));
    const latest = records.at(-1);
    if (!latest) return;
    const snapshot = await this.get(latest.executionId);
    if (!snapshot || !TERMINAL.has(snapshot.status)) return;

    if (snapshot.status !== 'SUCCEEDED') {
      const sameParentAttempts = records.filter(
        (record) =>
          record.phase === latest.phase &&
          record.previousExecutionId === latest.previousExecutionId,
      ).length;
      const totalPhaseAttempts = records.filter((record) => record.phase === latest.phase).length;
      if (sameParentAttempts < 2) {
        await this.#launchPlanPhase(
          plan,
          batch,
          item,
          latest.phase as 'IMPLEMENT' | 'VERIFY_REVIEW',
          latest.previousExecutionId,
          totalPhaseAttempts + 1,
          latest.phase === 'VERIFY_REVIEW' ? 'openhands-builtin' : undefined,
        );
        return;
      }
      const reason = `${latest.phase}_${snapshot.status}`;
      this.#plans.setWorkItemStatus(item.workItemId, 'BLOCKED', reason);
      this.#plans.setBatchStatus(batch.batchId, 'BLOCKED', { blockedReason: reason });
      this.#plans.setPlanStatus(plan.planId, 'BLOCKED', reason);
      this.#plans.appendEvent(
        plan.planId,
        'WORK_ITEM_BLOCKED',
        { reason },
        {
          batchId: batch.batchId,
          workItemId: item.workItemId,
          executionId: latest.executionId,
        },
      );
      return;
    }

    if (latest.phase === 'IMPLEMENT' || latest.phase === 'IMPLEMENT_FIX') {
      const reviewAttempt = records.filter((record) => record.phase === 'VERIFY_REVIEW').length + 1;
      await this.#launchPlanPhase(
        plan,
        batch,
        item,
        'VERIFY_REVIEW',
        latest.executionId,
        reviewAttempt,
      );
      return;
    }

    const verdict = reviewVerdict(snapshot.result?.finalText ?? '');
    if (verdict === 'BLOCKING') {
      const fixAttempt = records.filter((record) => record.phase === 'IMPLEMENT_FIX').length + 1;
      if (fixAttempt > 3) {
        const reason = 'REVIEW_FIX_LIMIT_EXCEEDED';
        this.#plans.setWorkItemStatus(item.workItemId, 'BLOCKED', reason);
        this.#plans.setBatchStatus(batch.batchId, 'BLOCKED', { blockedReason: reason });
        this.#plans.setPlanStatus(plan.planId, 'BLOCKED', reason);
        return;
      }
      await this.#launchPlanPhase(
        plan,
        batch,
        item,
        'IMPLEMENT_FIX',
        latest.executionId,
        fixAttempt,
      );
      return;
    }
    if (verdict === 'UNKNOWN') {
      const sameParentReviews = records.filter(
        (record) =>
          record.phase === 'VERIFY_REVIEW' &&
          record.previousExecutionId === latest.previousExecutionId,
      ).length;
      if (sameParentReviews < 2) {
        const reviewAttempt =
          records.filter((record) => record.phase === 'VERIFY_REVIEW').length + 1;
        await this.#launchPlanPhase(
          plan,
          batch,
          item,
          'VERIFY_REVIEW',
          latest.previousExecutionId,
          reviewAttempt,
          'openhands-builtin',
        );
        return;
      }
      const reason = 'REVIEW_VERDICT_UNKNOWN';
      this.#plans.setWorkItemStatus(item.workItemId, 'BLOCKED', reason);
      this.#plans.setBatchStatus(batch.batchId, 'BLOCKED', { blockedReason: reason });
      this.#plans.setPlanStatus(plan.planId, 'BLOCKED', reason);
      return;
    }
    this.#plans.setWorkItemStatus(item.workItemId, 'SUCCEEDED');
    this.#plans.appendEvent(
      plan.planId,
      'WORK_ITEM_VERIFIED',
      {},
      {
        batchId: batch.batchId,
        workItemId: item.workItemId,
        executionId: latest.executionId,
      },
    );
  }

  async #integrateBatch(
    plan: Exclude<ReturnType<PlanRepository['get']>, null>,
    batch: ReturnType<PlanRepository['batches']>[number],
    items: WorkItemRecord[],
  ): Promise<void> {
    const implementations = items.map((item) => {
      const records = this.#plans
        .executionIds(item.workItemId)
        .map((executionId) => this.#links.get(executionId))
        .filter((record): record is ExecutionLinkRecord => Boolean(record));
      const implementation = [...records]
        .reverse()
        .find((record) => record.phase === 'IMPLEMENT' || record.phase === 'IMPLEMENT_FIX');
      if (!implementation?.workspaceRef || !implementation.sourceRevision) {
        throw new Error('BATCH_INTEGRATION_EVIDENCE_MISSING');
      }
      return {
        workspaceRef: implementation.workspaceRef,
        sourceRevision: implementation.sourceRevision,
        executionId: implementation.executionId,
      };
    });
    try {
      const integrated = this.#workspace.integrateBatch
        ? await this.#workspace.integrateBatch({
            planId: plan.planId,
            batchKey: batch.key,
            repositoryPath: plan.repositoryPath,
            baseRevision: batch.baseRevision ?? plan.currentRevision,
            implementations,
          })
        : {
            revision: `integrated:${implementations.map((item) => item.executionId).join('+')}`,
            ref: `refs/ai-office/plans/${plan.planId}/batches/${batch.key}`,
          };
      this.#plans.setBatchStatus(batch.batchId, 'SUCCEEDED', {
        integratedRevision: integrated.revision,
        integrationRef: integrated.ref,
      });
      this.#plans.appendEvent(
        plan.planId,
        'BATCH_INTEGRATED',
        { revision: integrated.revision, ref: integrated.ref },
        { batchId: batch.batchId },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'BATCH_INTEGRATION_FAILED';
      const reason = message.split(':', 1)[0] ?? 'BATCH_INTEGRATION_FAILED';
      this.#plans.setBatchStatus(batch.batchId, 'BLOCKED', { blockedReason: reason });
      this.#plans.setPlanStatus(plan.planId, 'BLOCKED', reason);
      this.#plans.appendEvent(
        plan.planId,
        'BATCH_INTEGRATION_BLOCKED',
        { reason, message: message.slice(0, 2_000) },
        { batchId: batch.batchId },
      );
    }
  }

  async #reconcilePlan(planId: string): Promise<void> {
    const plan = this.#plans.get(planId);
    if (!plan || !['PENDING', 'RUNNING'].includes(plan.status)) return;
    if (plan.status === 'PENDING') this.#plans.setPlanStatus(plan.planId, 'RUNNING');
    const batches = this.#plans.batches(plan.planId);
    if (batches.every((batch) => batch.status === 'SUCCEEDED')) {
      if (!plan.delivery) {
        this.#plans.setPlanStatus(plan.planId, 'SUCCEEDED');
        this.#plans.appendEvent(plan.planId, 'PLAN_SUCCEEDED', { revision: plan.currentRevision });
        return;
      }
      if (!this.#delivery) {
        this.#plans.setDeliveryState(plan.planId, {
          stage: 'BLOCKED',
          evidence: { reason: 'DELIVERY_ADAPTER_UNCONFIGURED' },
        });
        this.#plans.setPlanStatus(plan.planId, 'BLOCKED', 'DELIVERY_ADAPTER_UNCONFIGURED');
        this.#plans.appendEvent(plan.planId, 'PLAN_DELIVERY_BLOCKED', {
          reason: 'DELIVERY_ADAPTER_UNCONFIGURED',
        });
        return;
      }
      const result = await this.#delivery.reconcile({
        planId: plan.planId,
        repositoryPath: plan.repositoryPath,
        objective: plan.objective,
        revision: plan.currentRevision,
        config: plan.delivery,
      });
      this.#plans.setDeliveryState(plan.planId, {
        stage: result.stage,
        evidence: result.evidence,
        pullRequestUrl: result.pullRequestUrl,
        mergeRevision: result.outcome === 'SUCCEEDED' ? result.mergeRevision : undefined,
      });
      if (result.outcome === 'NEEDS_FIX') {
        const repair = this.#plans.addDeliveryRepairBatch(plan.planId, result.evidence);
        if (!repair) {
          this.#plans.setDeliveryState(plan.planId, {
            stage: 'BLOCKED',
            evidence: result.evidence,
            pullRequestUrl: result.pullRequestUrl,
          });
          this.#plans.setPlanStatus(plan.planId, 'BLOCKED', 'DELIVERY_FIX_LIMIT_EXCEEDED');
          this.#plans.appendEvent(plan.planId, 'PLAN_DELIVERY_BLOCKED', {
            reason: 'DELIVERY_FIX_LIMIT_EXCEEDED',
            ...result.evidence,
          });
        } else {
          this.#plans.setDeliveryState(plan.planId, {
            stage: 'PENDING',
            evidence: result.evidence,
            pullRequestUrl: result.pullRequestUrl,
          });
          this.#plans.appendEvent(plan.planId, 'PLAN_DELIVERY_REPAIR_SCHEDULED', {
            batchId: repair.batchId,
            ...result.evidence,
          });
        }
      } else if (result.outcome === 'BLOCKED') {
        this.#plans.setPlanStatus(plan.planId, 'BLOCKED', result.reason);
        this.#plans.appendEvent(plan.planId, 'PLAN_DELIVERY_BLOCKED', {
          reason: result.reason,
          ...result.evidence,
        });
      } else if (result.outcome === 'SUCCEEDED') {
        this.#plans.setPlanStatus(plan.planId, 'SUCCEEDED');
        this.#plans.appendEvent(plan.planId, 'PLAN_SUCCEEDED', {
          integratedRevision: plan.currentRevision,
          mergeRevision: result.mergeRevision,
          pullRequestUrl: result.pullRequestUrl,
          postMergeChecks: result.evidence,
        });
      } else if (plan.deliveryStage !== result.stage) {
        this.#plans.appendEvent(plan.planId, 'PLAN_DELIVERY_WAITING', {
          stage: result.stage,
          ...result.evidence,
        });
      }
      return;
    }
    const succeededKeys = new Set(
      batches.filter((batch) => batch.status === 'SUCCEEDED').map((batch) => batch.key),
    );
    const batch = batches.find(
      (candidate) =>
        ['PENDING', 'RUNNING'].includes(candidate.status) &&
        candidate.dependsOn.every((dependency) => succeededKeys.has(dependency)),
    );
    if (!batch) return;
    if (batch.status === 'PENDING') {
      this.#plans.setBatchStatus(batch.batchId, 'RUNNING', { baseRevision: plan.currentRevision });
      this.#plans.appendEvent(
        plan.planId,
        'BATCH_STARTED',
        { baseRevision: plan.currentRevision },
        {
          batchId: batch.batchId,
        },
      );
    }
    const currentBatch = this.#plans
      .batches(plan.planId)
      .find((item) => item.batchId === batch.batchId)!;
    const items = this.#plans.workItems(batch.batchId);
    for (const item of items) {
      if (item.status !== 'SUCCEEDED') {
        try {
          await this.#reconcileWorkItem(plan, currentBatch, item);
        } catch (error) {
          const code = error instanceof Error ? (error.message.split(':', 1)[0] ?? '') : '';
          if (!code.includes('CONCURRENCY') && !code.includes('LEASE_CONFLICT')) throw error;
        }
      }
    }
    const refreshed = this.#plans.workItems(batch.batchId);
    if (refreshed.every((item) => item.status === 'SUCCEEDED')) {
      await this.#integrateBatch(plan, currentBatch, refreshed);
    }
  }

  async reconcilePlans(planId?: string, recoverBlocked = false): Promise<void> {
    let release!: () => void;
    const predecessor = this.#planReconcileTail;
    this.#planReconcileTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      if (planId && recoverBlocked) {
        const blocked = this.#plans.get(planId);
        if (blocked?.status === 'BLOCKED') {
          const batch = this.#plans
            .batches(planId)
            .find((candidate) => candidate.status === 'BLOCKED');
          if (!batch && blocked.delivery?.autoMerge && blocked.deliveryStage === 'BLOCKED') {
            this.#plans.setPlanStatus(planId, 'RUNNING');
            this.#plans.setDeliveryState(planId, { stage: 'PENDING' });
            this.#plans.appendEvent(planId, 'PLAN_DELIVERY_RECOVERY_REQUESTED', {
              previousReason: blocked.blockedReason,
            });
          } else if (batch) {
            const items = this.#plans.workItems(batch.batchId);
            if (items.every((item) => item.status === 'SUCCEEDED')) {
              this.#plans.setPlanStatus(planId, 'RUNNING');
              this.#plans.setBatchStatus(batch.batchId, 'RUNNING');
              this.#plans.appendEvent(
                planId,
                'BATCH_INTEGRATION_RECOVERY_REQUESTED',
                { previousReason: blocked.blockedReason },
                { batchId: batch.batchId },
              );
            } else {
              const retryable = items.filter((item) => item.status === 'BLOCKED');
              this.#plans.setPlanStatus(planId, 'RUNNING');
              this.#plans.setBatchStatus(batch.batchId, 'RUNNING');
              for (const item of retryable) {
                const records = this.#plans
                  .executionIds(item.workItemId)
                  .map((executionId) => this.#links.get(executionId))
                  .filter((record): record is ExecutionLinkRecord => Boolean(record));
                const latest = records.at(-1);
                if (
                  !latest ||
                  !['IMPLEMENT', 'IMPLEMENT_FIX', 'VERIFY_REVIEW'].includes(latest.phase)
                ) {
                  continue;
                }
                const phase = latest.phase as 'IMPLEMENT' | 'IMPLEMENT_FIX' | 'VERIFY_REVIEW';
                const attempt = records.filter((record) => record.phase === phase).length + 1;
                this.#plans.setWorkItemStatus(item.workItemId, 'RUNNING');
                this.#plans.appendEvent(
                  planId,
                  'WORK_ITEM_RECOVERY_REQUESTED',
                  { previousReason: item.blockedReason, phase, attempt },
                  { batchId: batch.batchId, workItemId: item.workItemId },
                );
                await this.#launchPlanPhase(
                  blocked,
                  batch,
                  item,
                  phase,
                  latest.previousExecutionId,
                  attempt,
                  phase === 'VERIFY_REVIEW' ? 'openhands-builtin' : undefined,
                );
              }
            }
          }
        }
      }
      for (const plan of this.#plans.active(planId)) await this.#reconcilePlan(plan.planId);
    } finally {
      release();
    }
  }

  async continue(
    executionId: string,
    message: string,
  ): Promise<DevelopmentExecutionSnapshot | null> {
    const cleanMessage = message.trim();
    if (!cleanMessage) throw new Error('CONTINUATION_MESSAGE_REQUIRED');
    const record = this.#links.get(executionId);
    if (!record) return null;
    if (!record.openhandsConversationId || !this.#host.continueExecution) {
      throw new Error('EXECUTION_NOT_CONTINUABLE');
    }
    const current = await this.get(executionId);
    if (!current) return null;
    if (current.status !== 'PAUSED') {
      throw new Error('EXECUTION_NOT_CONTINUABLE');
    }
    const snapshot = await this.#host.continueExecution(
      record.openhandsConversationId,
      cleanMessage.slice(0, 20_000),
    );
    this.#links.updateStatus(executionId, snapshot.status);
    return this.get(executionId);
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
