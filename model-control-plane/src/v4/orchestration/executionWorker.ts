import { createHash, randomUUID } from 'node:crypto';

import { V4Error } from '../domain/errors.js';
import type { Execution } from '../domain/execution.js';
import type { ExecutionResourceSelection } from '../domain/resourceRouting.js';
import type { Review } from '../domain/review.js';
import type { V4Repositories } from '../persistence/repositories.js';
import type {
  CompletionEvidence,
  ExecutionProviderPort,
  ExecutionSession,
  ProviderSessionSnapshot,
  ReviewCompletionEvidence,
  ReviewProviderPort,
  WorkspaceCompletionSnapshot,
  WorkspaceDescriptor,
  WorkspaceProviderPort,
} from './contracts.js';

export interface ExecutionWorkerRoute {
  route: string;
  provider: ExecutionProviderPort;
}

export interface ExecutionProviderFactory {
  (selection: ExecutionResourceSelection): ExecutionProviderPort;
}

export interface ExecutionResourceFeedbackPort {
  success(selection: ExecutionResourceSelection): void;
  failure(selection: ExecutionResourceSelection, error: unknown): void;
}

export interface ExecutionWorkerOptions {
  ownerId?: string;
  leaseTtlMs?: number;
  maxExecutionsPerCycle?: number;
  providerFactory?: ExecutionProviderFactory;
  resourceFeedback?: ExecutionResourceFeedbackPort;
  requireResourceSelection?: boolean;
  meaningfulProgressTimeoutMs?: number;
  maxStallRecoveries?: number;
  now?: () => Date;
}

export interface ExecutionWorkerResult {
  executionId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'RUNNING' | 'WAITING' | 'SKIPPED';
  code: string;
  providerSessionId?: string;
  resultRevision?: string;
}

const TERMINAL_PROVIDER_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'STUCK', 'CANCELLED']);
const MAX_RESULT_SUMMARY = 8_000;
const MAX_ERROR_CODE = 500;
const FINALIZATION_EVIDENCE_NAME = 'provider-finalization-requested';
const FINALIZABLE_IMPLEMENTATION_CODES = new Set([
  'WORKSPACE_DIRTY',
  'WORKSPACE_EVIDENCE_INVALID',
  'WORKSPACE_IMPLEMENTATION_EVIDENCE_MISMATCH',
]);
const RETRYABLE_RESOURCE_QUALITY_CODES = new Set(['WORKSPACE_IMPLEMENTATION_NOOP']);
const EVIDENCE_FINALIZATION_NAME = 'evidence-verified-provider-finalization';
const MEANINGFUL_PROGRESS_PREFIX = 'meaningful-progress-';
const MEANINGFUL_STALL_RECOVERY_PREFIX = 'meaningful-stall-recovery-';
const WORKSPACE_PROGRESS_DEGRADED_NAME = 'workspace-progress-probe-degraded';

function errorCode(error: unknown): string {
  if (error instanceof V4Error) return error.code;
  return error instanceof Error
    ? error.name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100) || 'EXECUTION_WORKER_FAILED'
    : 'EXECUTION_WORKER_FAILED';
}

function bounded(value: string | undefined, maximum: number): string | undefined {
  return value?.slice(0, maximum);
}

function evidencePayload(evidence: CompletionEvidence): Record<string, unknown> {
  return JSON.parse(JSON.stringify(evidence)) as Record<string, unknown>;
}

function workspacePayload(snapshot: WorkspaceCompletionSnapshot): Record<string, unknown> {
  return {
    hostPath: snapshot.workspace.hostPath,
    executionPath: snapshot.workspace.executionPath,
    evidenceHostPath: snapshot.workspace.evidenceHostPath,
    evidenceExecutionPath: snapshot.workspace.evidenceExecutionPath,
    sourceRepositoryPath: snapshot.workspace.sourceRepositoryPath,
    sourceRevision: snapshot.workspace.sourceRevision,
    headRevision: snapshot.headRevision,
    clean: snapshot.clean,
    descendantOfSource: snapshot.descendantOfSource,
    observedAt: snapshot.observedAt,
  };
}

export class ExecutionWorker {
  readonly ownerId: string;
  readonly leaseTtlMs: number;
  readonly maxExecutionsPerCycle: number;
  readonly routes: ReadonlyMap<string, ExecutionProviderPort>;
  readonly providerFactory?: ExecutionProviderFactory;
  readonly resourceFeedback?: ExecutionResourceFeedbackPort;
  readonly requireResourceSelection: boolean;
  readonly meaningfulProgressTimeoutMs: number;
  readonly maxStallRecoveries: number;
  readonly now: () => Date;

  constructor(
    readonly repositories: V4Repositories,
    readonly workspace: WorkspaceProviderPort,
    routes: readonly ExecutionWorkerRoute[],
    options: ExecutionWorkerOptions = {},
  ) {
    const mapped = new Map<string, ExecutionProviderPort>();
    for (const entry of routes) {
      if (!entry.route.trim()) throw new V4Error('EXECUTION_ROUTE_REQUIRED');
      if (mapped.has(entry.route)) throw new V4Error('EXECUTION_ROUTE_DUPLICATE');
      mapped.set(entry.route, entry.provider);
    }
    this.routes = mapped;
    this.providerFactory = options.providerFactory;
    this.resourceFeedback = options.resourceFeedback;
    this.requireResourceSelection = options.requireResourceSelection === true;
    this.ownerId = options.ownerId ?? 'execution-worker-' + randomUUID();
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.maxExecutionsPerCycle = options.maxExecutionsPerCycle ?? 20;
    this.meaningfulProgressTimeoutMs = options.meaningfulProgressTimeoutMs ?? 15 * 60_000;
    this.maxStallRecoveries = options.maxStallRecoveries ?? 2;
    this.now = options.now ?? (() => new Date());
    if (this.leaseTtlMs < 1_000 || this.leaseTtlMs > 5 * 60_000)
      throw new V4Error('EXECUTION_LEASE_TTL_INVALID');
    if (
      !Number.isInteger(this.maxExecutionsPerCycle) ||
      this.maxExecutionsPerCycle < 1 ||
      this.maxExecutionsPerCycle > 1_000
    ) {
      throw new V4Error('EXECUTION_CYCLE_LIMIT_INVALID');
    }
    if (this.requireResourceSelection && !this.providerFactory)
      throw new V4Error('EXECUTION_PROVIDER_FACTORY_REQUIRED');
    if (
      !Number.isInteger(this.meaningfulProgressTimeoutMs) ||
      this.meaningfulProgressTimeoutMs < 30_000 ||
      this.meaningfulProgressTimeoutMs > 24 * 60 * 60_000
    )
      throw new V4Error('EXECUTION_MEANINGFUL_PROGRESS_TIMEOUT_INVALID');
    if (
      !Number.isInteger(this.maxStallRecoveries) ||
      this.maxStallRecoveries < 0 ||
      this.maxStallRecoveries > 10
    )
      throw new V4Error('EXECUTION_STALL_RECOVERY_LIMIT_INVALID');
  }

  private resolveProvider(
    execution: Execution,
  ): { provider: ExecutionProviderPort; selection?: ExecutionResourceSelection } | undefined {
    const selection = this.repositories.resourceSelections.get(execution.identity.executionId);
    if (selection) {
      if (selection.phase !== execution.identity.phase)
        throw new V4Error('EXECUTION_RESOURCE_SELECTION_PHASE_MISMATCH');
      if (!this.providerFactory) throw new V4Error('EXECUTION_PROVIDER_FACTORY_REQUIRED');
      return { provider: this.providerFactory(selection), selection };
    }
    if (this.requireResourceSelection) return undefined;
    const provider = this.routes.get(execution.identity.route);
    return provider ? { provider } : undefined;
  }

  private reportResourceFailure(
    selection: ExecutionResourceSelection | undefined,
    error: unknown,
  ): void {
    if (!selection || !this.resourceFeedback) return;
    try {
      this.resourceFeedback.failure(selection, error);
    } catch {
      // Resource feedback is advisory to the current execution result. A stale
      // CAS or directory refresh must never rewrite the already-observed worker fact.
    }
  }

  private reportResourceSuccess(selection: ExecutionResourceSelection | undefined): void {
    if (!selection || !this.resourceFeedback) return;
    try {
      this.resourceFeedback.success(selection);
    } catch {
      // The successful execution remains authoritative even if feedback races.
    }
  }

  private providerFailureEligible(code: string): boolean {
    return /^(?:OPENHANDS|PROVIDER|LLM|ANTIGRAVITY|CODEX|CLAUDE|DSH|ZCODE|RESOURCE_NOT_READY|RESOURCE_UNAVAILABLE)/.test(
      code,
    );
  }

  async runOnce(): Promise<ExecutionWorkerResult[]> {
    const executions = this.repositories.executions.listByStatuses(
      ['QUEUED', 'RUNNING'],
      this.maxExecutionsPerCycle,
    );
    const results: ExecutionWorkerResult[] = [];
    for (const execution of executions)
      results.push(await this.runExecution(execution.identity.executionId));
    return results;
  }

  async continueExecution(
    executionId: string,
    instruction = 'Continue the same bounded execution from its durable workspace and finish the original objective.',
    options: { interruptCurrent?: boolean } = {},
  ): Promise<ExecutionWorkerResult> {
    const claim = this.repositories.executions.claimLease(
      executionId,
      this.ownerId,
      this.leaseTtlMs,
    );
    if (!claim.value || claim.status === 'rejected')
      return { executionId, status: 'SKIPPED', code: claim.reason ?? 'EXECUTION_LEASE_HELD' };
    try {
      let execution = this.repositories.executions.get(executionId);
      if (execution.status !== 'RUNNING')
        return { executionId, status: 'SKIPPED', code: 'EXECUTION_NOT_RESUMABLE' };
      const resolved = this.resolveProvider(execution);
      if (!resolved)
        return { executionId, status: 'WAITING', code: 'EXECUTION_RESOURCE_SELECTION_UNAVAILABLE' };
      const { provider } = resolved;
      if (!provider.continue)
        return { executionId, status: 'WAITING', code: 'PROVIDER_CONTINUE_UNAVAILABLE' };
      let session = this.repositories.sessions.get(executionId);
      const providerSessionId = session.providerSessionId;
      if (!providerSessionId)
        return { executionId, status: 'WAITING', code: 'PROVIDER_SESSION_ID_REQUIRED' };
      if (options.interruptCurrent) {
        if (!provider.interrupt)
          return { executionId, status: 'WAITING', code: 'PROVIDER_INTERRUPT_UNAVAILABLE' };
        const interrupted = await provider.interrupt(providerSessionId);
        if (TERMINAL_PROVIDER_STATUSES.has(interrupted.status))
          this.recordTerminalProviderStatus(executionId, session, interrupted);
        else this.recordActiveProviderStatus(executionId, session, interrupted);
        session = this.repositories.sessions.get(executionId);
      }
      const snapshot = await provider.continue(providerSessionId, instruction);
      if (TERMINAL_PROVIDER_STATUSES.has(snapshot.status))
        this.recordTerminalProviderStatus(executionId, session, snapshot);
      else this.recordActiveProviderStatus(executionId, session, snapshot);
      return {
        executionId,
        status:
          snapshot.status === 'FAILED' ||
          snapshot.status === 'STUCK' ||
          snapshot.status === 'CANCELLED'
            ? 'FAILED'
            : snapshot.status === 'PAUSED' || snapshot.status === 'WAITING_FOR_CONFIRMATION'
              ? 'WAITING'
              : snapshot.status === 'SUCCEEDED'
                ? 'SUCCEEDED'
                : 'RUNNING',
        code: 'PROVIDER_' + snapshot.status,
        providerSessionId: snapshot.providerSessionId,
      };
    } catch (error) {
      return { executionId, status: 'FAILED', code: errorCode(error) };
    } finally {
      this.repositories.executions.releaseLease(executionId, this.ownerId, claim.value.leaseToken);
    }
  }

  async replaceStalledProviderSession(
    executionId: string,
    idempotencyKey: string,
    instruction = 'Resume the same bounded execution from the existing durable workspace and finish the original objective.',
    reason = 'stalled provider session recovery',
  ): Promise<ExecutionWorkerResult> {
    const claim = this.repositories.executions.claimLease(
      executionId,
      this.ownerId,
      this.leaseTtlMs,
    );
    if (!claim.value || claim.status === 'rejected')
      return { executionId, status: 'SKIPPED', code: claim.reason ?? 'EXECUTION_LEASE_HELD' };
    try {
      const execution = this.repositories.executions.get(executionId);
      if (execution.status !== 'RUNNING')
        return { executionId, status: 'SKIPPED', code: 'EXECUTION_NOT_RESUMABLE' };
      if (!idempotencyKey.trim() || idempotencyKey.length > 1_000)
        throw new V4Error('PROVIDER_REPLACEMENT_IDEMPOTENCY_REQUIRED');
      if (!instruction.trim() || instruction.length > 32_000)
        throw new V4Error('PROVIDER_REPLACEMENT_INSTRUCTION_INVALID');
      if (!reason.trim() || reason.length > 2_000)
        throw new V4Error('PROVIDER_SESSION_REPLACEMENT_INVALID');
      const resolved = this.resolveProvider(execution);
      if (!resolved)
        return { executionId, status: 'WAITING', code: 'EXECUTION_RESOURCE_SELECTION_UNAVAILABLE' };
      const { provider } = resolved;
      if (!provider.replace)
        return { executionId, status: 'WAITING', code: 'PROVIDER_REPLACE_UNAVAILABLE' };
      if (!provider.interrupt)
        return { executionId, status: 'WAITING', code: 'PROVIDER_INTERRUPT_UNAVAILABLE' };
      const evidenceName =
        'provider-session-replacement-' +
        createHash('sha256').update(idempotencyKey.trim()).digest('hex').slice(0, 40);
      const existingEvidence = this.repositories.evidence.find(
        executionId,
        'RECOVERY',
        evidenceName,
      );
      if (existingEvidence) {
        const previous = existingEvidence.payload.previousProviderSessionId;
        const replacementId = existingEvidence.payload.providerSessionId;
        const storedReason = existingEvidence.payload.reason;
        if (
          typeof previous !== 'string' ||
          typeof replacementId !== 'string' ||
          typeof storedReason !== 'string' ||
          !storedReason.trim()
        )
          throw new V4Error('PROVIDER_REPLACEMENT_EVIDENCE_INVALID');
        let session = this.repositories.sessions.get(executionId);
        if (session.providerSessionId === previous) {
          const swapped = this.repositories.sessions.replaceProviderSession(
            executionId,
            previous,
            replacementId,
            storedReason,
          );
          if (swapped.status === 'rejected' || !swapped.value)
            throw new V4Error(swapped.reason ?? 'STALE_PROVIDER_SESSION');
          session = this.repositories.sessions.get(executionId);
        } else if (session.providerSessionId !== replacementId) {
          throw new V4Error('PROVIDER_REPLACEMENT_IDEMPOTENCY_CONFLICT');
        }
        const snapshot = await provider.inspect(replacementId);
        if (TERMINAL_PROVIDER_STATUSES.has(snapshot.status))
          this.recordTerminalProviderStatus(executionId, session, snapshot);
        else this.recordActiveProviderStatus(executionId, session, snapshot);
        return {
          executionId,
          status:
            snapshot.status === 'FAILED' ||
            snapshot.status === 'STUCK' ||
            snapshot.status === 'CANCELLED'
              ? 'FAILED'
              : snapshot.status === 'PAUSED' || snapshot.status === 'WAITING_FOR_CONFIRMATION'
                ? 'WAITING'
                : snapshot.status === 'SUCCEEDED'
                  ? 'SUCCEEDED'
                  : 'RUNNING',
          code: 'PROVIDER_SESSION_REPLACEMENT_EXISTING_' + snapshot.status,
          providerSessionId: replacementId,
        };
      }
      let session = this.repositories.sessions.get(executionId);
      const previousProviderSessionId = session.providerSessionId;
      if (!previousProviderSessionId)
        return { executionId, status: 'WAITING', code: 'PROVIDER_SESSION_ID_REQUIRED' };
      const observed = await provider.inspect(previousProviderSessionId);
      if (TERMINAL_PROVIDER_STATUSES.has(observed.status))
        return {
          executionId,
          status: 'WAITING',
          code: 'PROVIDER_TERMINAL_REPLACEMENT_REFUSED',
          providerSessionId: previousProviderSessionId,
        };
      if (observed.status !== 'PAUSED') {
        const interrupted = await provider.interrupt(previousProviderSessionId);
        if (TERMINAL_PROVIDER_STATUSES.has(interrupted.status))
          return {
            executionId,
            status: 'WAITING',
            code: 'PROVIDER_TERMINAL_REPLACEMENT_REFUSED',
            providerSessionId: previousProviderSessionId,
          };
        this.recordActiveProviderStatus(executionId, session, interrupted);
        session = this.repositories.sessions.get(executionId);
      } else {
        this.recordActiveProviderStatus(executionId, session, observed);
        session = this.repositories.sessions.get(executionId);
      }
      const plan = this.repositories.plans.getPlan(execution.identity.planId);
      const workItem = execution.identity.workItemId
        ? this.repositories.plans.getWorkItem(execution.identity.workItemId)
        : undefined;
      const recoveryKey =
        'provider-session-replacement:' +
        execution.identity.executionId +
        ':' +
        idempotencyKey.trim();
      const replacement = await provider.replace({
        executionId: execution.identity.executionId,
        planId: execution.identity.planId,
        projectKey: plan.projectKey,
        workItemId: execution.identity.workItemId,
        phase: execution.identity.phase,
        objective: execution.objective,
        acceptanceCriteria: workItem?.acceptanceCriteria ?? [],
        sourceRevision: execution.identity.sourceRevision!,
        route: execution.identity.route,
        workspace: session.workspace,
        ...(execution.identity.phase === 'IMPLEMENT_FIX'
          ? { reviewFindings: this.reviewFindings(execution) }
          : {}),
        previousProviderSessionId,
        recoveryKey,
        instruction,
      });
      if (replacement.providerSessionId === previousProviderSessionId)
        throw new V4Error('PROVIDER_REPLACEMENT_SESSION_UNCHANGED');
      this.repositories.evidence.append({
        executionId,
        kind: 'RECOVERY',
        name: evidenceName,
        sourceRevision: execution.identity.sourceRevision,
        payload: {
          idempotencyKey: idempotencyKey.trim(),
          previousProviderSessionId,
          providerSessionId: replacement.providerSessionId,
          recoveryKey,
          reason: reason.trim(),
          observedStatus: replacement.status,
        },
      });
      const swapped = this.repositories.sessions.replaceProviderSession(
        executionId,
        previousProviderSessionId,
        replacement.providerSessionId,
        reason.trim(),
      );
      if (swapped.status === 'rejected' || !swapped.value)
        throw new V4Error(swapped.reason ?? 'STALE_PROVIDER_SESSION');
      session = this.repositories.sessions.get(executionId);
      const currentReplacement = await provider.inspect(replacement.providerSessionId);
      if (TERMINAL_PROVIDER_STATUSES.has(currentReplacement.status))
        this.recordTerminalProviderStatus(executionId, session, currentReplacement);
      else this.recordActiveProviderStatus(executionId, session, currentReplacement);
      return {
        executionId,
        status:
          currentReplacement.status === 'FAILED' ||
          currentReplacement.status === 'STUCK' ||
          currentReplacement.status === 'CANCELLED'
            ? 'FAILED'
            : currentReplacement.status === 'PAUSED' ||
                currentReplacement.status === 'WAITING_FOR_CONFIRMATION'
              ? 'WAITING'
              : currentReplacement.status === 'SUCCEEDED'
                ? 'SUCCEEDED'
                : 'RUNNING',
        code: 'PROVIDER_SESSION_REPLACED_' + currentReplacement.status,
        providerSessionId: currentReplacement.providerSessionId,
      };
    } catch (error) {
      return { executionId, status: 'FAILED', code: errorCode(error) };
    } finally {
      this.repositories.executions.releaseLease(executionId, this.ownerId, claim.value.leaseToken);
    }
  }

  async adoptPausedImplementation(
    executionId: string,
    idempotencyKey: string,
    reason = 'operator-assisted durable workspace recovery',
  ): Promise<ExecutionWorkerResult> {
    const claim = this.repositories.executions.claimLease(
      executionId,
      this.ownerId,
      this.leaseTtlMs,
    );
    if (!claim.value || claim.status === 'rejected')
      return { executionId, status: 'SKIPPED', code: claim.reason ?? 'EXECUTION_LEASE_HELD' };
    try {
      const execution = this.repositories.executions.get(executionId);
      if (execution.status !== 'RUNNING')
        return { executionId, status: 'SKIPPED', code: 'EXECUTION_NOT_ADOPTABLE' };
      if (execution.identity.phase !== 'IMPLEMENT' && execution.identity.phase !== 'IMPLEMENT_FIX')
        throw new V4Error('OPERATOR_ADOPTION_IMPLEMENTATION_ONLY');
      if (!idempotencyKey.trim() || idempotencyKey.length > 1_000)
        throw new V4Error('OPERATOR_ADOPTION_IDEMPOTENCY_REQUIRED');
      if (!reason.trim() || reason.length > 2_000)
        throw new V4Error('OPERATOR_ADOPTION_REASON_INVALID');
      const resolved = this.resolveProvider(execution);
      if (!resolved)
        return { executionId, status: 'WAITING', code: 'EXECUTION_RESOURCE_SELECTION_UNAVAILABLE' };
      const { provider } = resolved;
      this.assertProviderPhase(provider, execution);
      const session = this.repositories.sessions.get(executionId);
      if (!session.providerSessionId)
        return { executionId, status: 'WAITING', code: 'PROVIDER_SESSION_ID_REQUIRED' };
      const observed = await provider.inspect(session.providerSessionId);
      if (observed.status !== 'PAUSED') {
        if (!TERMINAL_PROVIDER_STATUSES.has(observed.status))
          this.recordActiveProviderStatus(executionId, session, observed);
        return {
          executionId,
          status: 'WAITING',
          code: 'OPERATOR_ADOPTION_PROVIDER_NOT_PAUSED',
          providerSessionId: session.providerSessionId,
        };
      }
      this.recordActiveProviderStatus(executionId, session, observed);
      const completion = await this.workspace.verifyImplementation(session.workspace);
      const evidenceName =
        'operator-workspace-adoption-' +
        createHash('sha256').update(idempotencyKey.trim()).digest('hex').slice(0, 40);
      this.persistOperatorCompletion(execution, completion, observed, evidenceName, reason.trim());
      this.repositories.executions.recordResult(executionId, {
        status: 'SUCCEEDED',
        resultRevision: completion.headRevision,
        resultSummary: bounded(completion.evidence.summary, MAX_RESULT_SUMMARY),
      });
      return {
        executionId,
        status: 'SUCCEEDED',
        code: 'OPERATOR_WORKSPACE_ADOPTED',
        providerSessionId: session.providerSessionId,
        resultRevision: completion.headRevision,
      };
    } catch (error) {
      return { executionId, status: 'FAILED', code: errorCode(error) };
    } finally {
      this.repositories.executions.releaseLease(executionId, this.ownerId, claim.value.leaseToken);
    }
  }

  async abortPausedProviderAttempt(
    executionId: string,
    idempotencyKey: string,
    reason: string,
  ): Promise<ExecutionWorkerResult> {
    const claim = this.repositories.executions.claimLease(
      executionId,
      this.ownerId,
      this.leaseTtlMs,
    );
    if (!claim.value || claim.status === 'rejected')
      return { executionId, status: 'SKIPPED', code: claim.reason ?? 'EXECUTION_LEASE_HELD' };
    try {
      const execution = this.repositories.executions.get(executionId);
      if (execution.status !== 'RUNNING')
        return { executionId, status: 'SKIPPED', code: 'EXECUTION_NOT_ABORTABLE' };
      if (!idempotencyKey.trim() || idempotencyKey.length > 1_000)
        throw new V4Error('PROVIDER_ABORT_IDEMPOTENCY_REQUIRED');
      if (!reason.trim() || reason.length > 2_000)
        throw new V4Error('PROVIDER_ABORT_REASON_INVALID');
      const resolved = this.resolveProvider(execution);
      if (!resolved)
        return { executionId, status: 'WAITING', code: 'EXECUTION_RESOURCE_SELECTION_UNAVAILABLE' };
      const { provider } = resolved;
      const session = this.repositories.sessions.get(executionId);
      if (!session.providerSessionId)
        return { executionId, status: 'WAITING', code: 'PROVIDER_SESSION_ID_REQUIRED' };
      const observed = await provider.inspect(session.providerSessionId);
      if (observed.status !== 'PAUSED') {
        if (!TERMINAL_PROVIDER_STATUSES.has(observed.status))
          this.recordActiveProviderStatus(executionId, session, observed);
        return {
          executionId,
          status: 'WAITING',
          code: 'PROVIDER_ABORT_REQUIRES_PAUSED',
          providerSessionId: session.providerSessionId,
        };
      }
      this.recordActiveProviderStatus(executionId, session, observed);
      const evidenceName =
        'paused-provider-abort-' +
        createHash('sha256').update(idempotencyKey.trim()).digest('hex').slice(0, 40);
      this.repositories.evidence.append({
        executionId,
        kind: 'RECOVERY',
        name: evidenceName,
        sourceRevision: execution.identity.sourceRevision,
        payload: {
          mode: 'operator-abort-paused-provider-attempt',
          reason: reason.trim(),
          provider: observed.provider,
          providerSessionId: observed.providerSessionId,
          providerStatus: observed.status,
          observedAt: observed.observedAt,
        },
      });
      this.repositories.executions.recordResult(executionId, {
        status: 'FAILED',
        errorCode: 'PROVIDER_STALLED_OPERATOR_ABORT',
        retryable: true,
        resultSummary: bounded(reason.trim(), MAX_RESULT_SUMMARY),
      });
      return {
        executionId,
        status: 'FAILED',
        code: 'PROVIDER_STALLED_OPERATOR_ABORT',
        providerSessionId: observed.providerSessionId,
      };
    } catch (error) {
      return { executionId, status: 'FAILED', code: errorCode(error) };
    } finally {
      this.repositories.executions.releaseLease(executionId, this.ownerId, claim.value.leaseToken);
    }
  }

  async runExecution(executionId: string): Promise<ExecutionWorkerResult> {
    const claim = this.repositories.executions.claimLease(
      executionId,
      this.ownerId,
      this.leaseTtlMs,
    );
    if (!claim.value || claim.status === 'rejected') {
      return { executionId, status: 'SKIPPED', code: claim.reason ?? 'EXECUTION_LEASE_HELD' };
    }
    let selectedResource: ExecutionResourceSelection | undefined;
    try {
      let execution = this.repositories.executions.get(executionId);
      if (execution.status !== 'QUEUED' && execution.status !== 'RUNNING') {
        return { executionId, status: 'SKIPPED', code: 'EXECUTION_TERMINAL' };
      }
      const resolved = this.resolveProvider(execution);
      if (!resolved)
        return { executionId, status: 'WAITING', code: 'EXECUTION_RESOURCE_SELECTION_UNAVAILABLE' };
      const { provider, selection } = resolved;
      selectedResource = selection;
      if (execution.status === 'QUEUED') {
        const started = this.repositories.executions.compareAndSetStatus(
          executionId,
          'QUEUED',
          'RUNNING',
        );
        if (!started.value || started.status === 'rejected')
          return {
            executionId,
            status: 'SKIPPED',
            code: started.reason ?? 'STALE_EXECUTION_STATUS',
          };
        execution = started.value;
      }
      this.assertProviderPhase(provider, execution);
      const plan = this.repositories.plans.getPlan(execution.identity.planId);
      const workItem = execution.identity.workItemId
        ? this.repositories.plans.getWorkItem(execution.identity.workItemId)
        : undefined;
      if (!execution.identity.sourceRevision)
        throw new V4Error('EXECUTION_SOURCE_REVISION_REQUIRED');

      let session = this.repositories.sessions.getOptional(executionId);
      if (
        session &&
        (session.provider !== provider.provider ||
          session.phase !== execution.identity.phase ||
          session.sourceRevision !== execution.identity.sourceRevision)
      ) {
        throw new V4Error('EXECUTION_SESSION_ROUTE_MISMATCH');
      }
      if (!session) {
        const sourceWorkspace = this.sourceWorkspace(execution);
        const workspace = await this.workspace.provision({
          executionId,
          planId: plan.planId,
          projectKey: plan.projectKey,
          ...(execution.identity.workItemId ? { workItemId: execution.identity.workItemId } : {}),
          repositoryPath: plan.repositoryPath,
          sourceRevision: execution.identity.sourceRevision,
          phase: execution.identity.phase,
          ...(sourceWorkspace ? { sourceWorkspace } : {}),
        });
        session = this.repositories.sessions.create({
          executionId,
          phase: execution.identity.phase,
          provider: provider.provider,
          workspace,
          sourceRevision: execution.identity.sourceRevision,
        }).value;
        if (!session) throw new V4Error('EXECUTION_SESSION_CREATE_FAILED');
        this.repositories.evidence.append({
          executionId,
          kind: 'WORKSPACE',
          name: 'provisioned-workspace',
          sourceRevision: execution.identity.sourceRevision,
          payload: {
            hostPath: workspace.hostPath,
            executionPath: workspace.executionPath,
            evidenceHostPath: workspace.evidenceHostPath,
            evidenceExecutionPath: workspace.evidenceExecutionPath,
            sourceRepositoryPath: workspace.sourceRepositoryPath,
            sourceRevision: workspace.sourceRevision,
            createdAt: workspace.createdAt,
          },
        });
      }

      let snapshot = await this.resolveProviderSnapshot(
        provider,
        execution,
        session,
        plan.projectKey,
        workItem?.acceptanceCriteria ?? [],
      );
      session = this.repositories.sessions.get(executionId);
      if (!session.providerSessionId) throw new V4Error('PROVIDER_SESSION_ID_REQUIRED');

      if (execution.identity.phase === 'REVIEW') this.bindReviewerExecution(execution, session);
      this.renewLease(executionId, claim.value.leaseToken);

      if (!TERMINAL_PROVIDER_STATUSES.has(snapshot.status)) {
        const finalized = await this.finalizeFromVerifiedEvidence(
          provider,
          execution,
          session,
          snapshot,
          selectedResource,
        );
        if (finalized) return finalized;
        const stalled = await this.handleMeaningfulProgress(
          provider,
          execution,
          session,
          snapshot,
          selectedResource,
        );
        if (stalled) return stalled;
        this.recordActiveProviderStatus(executionId, session, snapshot);
        return {
          executionId,
          status:
            snapshot.status === 'PAUSED' || snapshot.status === 'WAITING_FOR_CONFIRMATION'
              ? 'WAITING'
              : 'RUNNING',
          code: 'PROVIDER_' + snapshot.status,
          providerSessionId: snapshot.providerSessionId,
        };
      }

      let completion: WorkspaceCompletionSnapshot | undefined;
      if (snapshot.status === 'SUCCEEDED') {
        try {
          completion =
            execution.identity.phase === 'REVIEW'
              ? await this.workspace.verifyReview(
                  session.workspace,
                  execution.identity.sourceRevision,
                )
              : await this.workspace.verifyImplementation(session.workspace);
        } catch (error) {
          const code = errorCode(error);
          const canFinalize =
            execution.identity.phase !== 'REVIEW' &&
            FINALIZABLE_IMPLEMENTATION_CODES.has(code) &&
            Boolean(provider.continue) &&
            Boolean(session.providerSessionId) &&
            !this.repositories.evidence.find(executionId, 'RECOVERY', FINALIZATION_EVIDENCE_NAME);
          if (!canFinalize) {
            this.recordTerminalProviderStatus(executionId, session, snapshot);
            throw error;
          }
          snapshot = await provider.continue!(
            session.providerSessionId!,
            this.finalizationInstruction(execution, session, code),
          );
          this.repositories.evidence.append({
            executionId,
            kind: 'RECOVERY',
            name: FINALIZATION_EVIDENCE_NAME,
            sourceRevision: execution.identity.sourceRevision,
            payload: { triggerCode: code, providerSessionId: session.providerSessionId! },
          });
          if (!TERMINAL_PROVIDER_STATUSES.has(snapshot.status)) {
            this.recordActiveProviderStatus(executionId, session, snapshot);
            return {
              executionId,
              status:
                snapshot.status === 'PAUSED' || snapshot.status === 'WAITING_FOR_CONFIRMATION'
                  ? 'WAITING'
                  : 'RUNNING',
              code: 'PROVIDER_FINALIZATION_' + snapshot.status,
              providerSessionId: snapshot.providerSessionId,
            };
          }
          if (snapshot.status === 'SUCCEEDED') {
            try {
              completion = await this.workspace.verifyImplementation(session.workspace);
            } catch (finalizationError) {
              this.recordTerminalProviderStatus(executionId, session, snapshot);
              throw finalizationError;
            }
          }
        }
      }

      this.recordTerminalProviderStatus(executionId, session, snapshot);
      if (snapshot.status === 'FAILED' || snapshot.status === 'STUCK') {
        const code =
          bounded(snapshot.errorCode, MAX_ERROR_CODE) ??
          (snapshot.status === 'STUCK' ? 'PROVIDER_STUCK' : 'PROVIDER_FAILED');
        this.reportResourceFailure(selectedResource, {
          code,
          message: [snapshot.errorCode, snapshot.finalResponse].filter(Boolean).join(' '),
        });
        this.repositories.executions.recordResult(executionId, {
          status: 'FAILED',
          errorCode: code,
          retryable: snapshot.status === 'STUCK' ? true : Boolean(snapshot.retryable),
          resultSummary: bounded(snapshot.finalResponse, MAX_RESULT_SUMMARY),
        });
        return {
          executionId,
          status: 'FAILED',
          code,
          providerSessionId: snapshot.providerSessionId,
        };
      }
      if (snapshot.status === 'CANCELLED') {
        this.repositories.executions.updateStatus(executionId, 'CANCELLED');
        return {
          executionId,
          status: 'FAILED',
          code: 'PROVIDER_CANCELLED',
          providerSessionId: snapshot.providerSessionId,
        };
      }
      if (!completion) throw new V4Error('WORKSPACE_COMPLETION_MISSING');
      this.persistCompletion(execution, completion, snapshot);
      this.repositories.executions.recordResult(executionId, {
        status: 'SUCCEEDED',
        resultRevision: completion.headRevision,
        resultSummary: bounded(completion.evidence.summary, MAX_RESULT_SUMMARY),
      });
      if (execution.identity.phase === 'REVIEW')
        this.persistReviewVerdict(executionId, completion.evidence);
      this.reportResourceSuccess(selectedResource);
      return {
        executionId,
        status: 'SUCCEEDED',
        code:
          execution.identity.phase === 'REVIEW'
            ? 'REVIEW_EXECUTION_SUCCEEDED'
            : 'IMPLEMENTATION_EXECUTION_SUCCEEDED',
        providerSessionId: snapshot.providerSessionId,
        resultRevision: completion.headRevision,
      };
    } catch (error) {
      const code = errorCode(error);
      if (this.providerFailureEligible(code)) this.reportResourceFailure(selectedResource, error);
      if (RETRYABLE_RESOURCE_QUALITY_CODES.has(code))
        this.reportResourceFailure(selectedResource, {
          code: 'PROVIDER_SUCCESS_NO_IMPLEMENTATION',
          message:
            'Provider completed without a verified implementation change or SATISFIED evidence.',
        });
      const execution = this.repositories.executions.get(executionId);
      if (execution.status === 'RUNNING') {
        const workspaceInfrastructureFailure =
          code.startsWith('WORKSPACE_STORAGE_') ||
          code.startsWith('WORKSPACE_CAPACITY_') ||
          code.startsWith('WORKSPACE_EVIDENCE_') ||
          code.startsWith('WORKSPACE_REVIEW_');
        const retryable =
          workspaceInfrastructureFailure ||
          this.providerFailureEligible(code) ||
          RETRYABLE_RESOURCE_QUALITY_CODES.has(code) ||
          (execution.identity.phase !== 'REVIEW' && FINALIZABLE_IMPLEMENTATION_CODES.has(code));
        this.repositories.executions.recordResult(executionId, {
          status: 'FAILED',
          errorCode: code,
          retryable,
        });
      }
      return { executionId, status: 'FAILED', code };
    } finally {
      this.repositories.executions.releaseLease(executionId, this.ownerId, claim.value.leaseToken);
    }
  }

  private async finalizeFromVerifiedEvidence(
    provider: ExecutionProviderPort,
    execution: Execution,
    session: ExecutionSession,
    observed: ProviderSessionSnapshot,
    selectedResource: ExecutionResourceSelection | undefined,
  ): Promise<ExecutionWorkerResult | undefined> {
    if (!session.providerSessionId || !this.workspace.hasCompletionEvidence?.(session.workspace))
      return undefined;
    let completion: WorkspaceCompletionSnapshot;
    try {
      completion =
        execution.identity.phase === 'REVIEW'
          ? await this.workspace.verifyReview(session.workspace, execution.identity.sourceRevision!)
          : await this.workspace.verifyImplementation(session.workspace);
    } catch {
      // A worker can create the evidence file before the final atomic write or
      // clean-status check. Treat incomplete evidence as progress, not success.
      return undefined;
    }
    if (!provider.interrupt) return undefined;
    const stopped = await provider.interrupt(session.providerSessionId);
    if (!TERMINAL_PROVIDER_STATUSES.has(stopped.status) && stopped.status !== 'PAUSED') {
      this.recordActiveProviderStatus(execution.identity.executionId, session, stopped);
      return undefined;
    }
    if (TERMINAL_PROVIDER_STATUSES.has(stopped.status))
      this.recordTerminalProviderStatus(execution.identity.executionId, session, stopped);
    else this.recordActiveProviderStatus(execution.identity.executionId, session, stopped);

    this.persistCompletion(
      execution,
      completion,
      stopped,
      'evidence-finalization-provider-snapshot',
    );
    this.repositories.evidence.append({
      executionId: execution.identity.executionId,
      kind: 'RECOVERY',
      name: EVIDENCE_FINALIZATION_NAME,
      sourceRevision: execution.identity.sourceRevision,
      payload: {
        mode: 'evidence-verified-provider-finalization',
        provider: stopped.provider,
        providerSessionId: stopped.providerSessionId,
        providerStatus: stopped.status,
        observedStatus: observed.status,
        observedAt: stopped.observedAt,
        resultRevision: completion.headRevision,
        ...(completion.evidence.phase === 'REVIEW'
          ? { verdict: completion.evidence.verdict }
          : { outcome: completion.evidence.outcome ?? 'CHANGED' }),
      },
    });
    this.repositories.executions.recordResult(execution.identity.executionId, {
      status: 'SUCCEEDED',
      resultRevision: completion.headRevision,
      resultSummary: bounded(completion.evidence.summary, MAX_RESULT_SUMMARY),
    });
    if (execution.identity.phase === 'REVIEW')
      this.persistReviewVerdict(execution.identity.executionId, completion.evidence);
    this.reportResourceSuccess(selectedResource);
    return {
      executionId: execution.identity.executionId,
      status: 'SUCCEEDED',
      code:
        execution.identity.phase === 'REVIEW'
          ? 'REVIEW_EVIDENCE_FINALIZED'
          : 'IMPLEMENTATION_EVIDENCE_FINALIZED',
      providerSessionId: stopped.providerSessionId,
      resultRevision: completion.headRevision,
    };
  }

  private progressEvidence(executionId: string) {
    return this.repositories.evidence
      .listByExecution(executionId)
      .filter(
        (item) => item.kind === 'RECOVERY' && item.name.startsWith(MEANINGFUL_PROGRESS_PREFIX),
      );
  }

  private stallRecoveryEvidence(executionId: string) {
    return this.repositories.evidence
      .listByExecution(executionId)
      .filter(
        (item) =>
          item.kind === 'RECOVERY' && item.name.startsWith(MEANINGFUL_STALL_RECOVERY_PREFIX),
      );
  }

  private async handleMeaningfulProgress(
    provider: ExecutionProviderPort,
    execution: Execution,
    session: ExecutionSession,
    snapshot: ProviderSessionSnapshot,
    selectedResource: ExecutionResourceSelection | undefined,
  ): Promise<ExecutionWorkerResult | undefined> {
    if (!['CREATED', 'QUEUED', 'RUNNING', 'UNKNOWN'].includes(snapshot.status)) return undefined;
    const existing = this.progressEvidence(execution.identity.executionId);
    let workspaceFingerprint: string;
    try {
      workspaceFingerprint = this.workspace.progressFingerprint
        ? await this.workspace.progressFingerprint(session.workspace)
        : createHash('sha256')
            .update(session.workspace.sourceRevision)
            .update('|')
            .update(String(this.workspace.hasCompletionEvidence?.(session.workspace) === true))
            .digest('hex');
    } catch (error) {
      if (!(error instanceof V4Error) || error.code !== 'WORKSPACE_GIT_COMMAND_FAILED') throw error;
      const previous = existing.at(-1)?.payload.workspaceFingerprint;
      workspaceFingerprint =
        typeof previous === 'string' && previous.length > 0
          ? previous
          : createHash('sha256')
              .update(session.workspace.sourceRevision)
              .update('|')
              .update(String(this.workspace.hasCompletionEvidence?.(session.workspace) === true))
              .digest('hex');
      if (
        !this.repositories.evidence.find(
          execution.identity.executionId,
          'RECOVERY',
          WORKSPACE_PROGRESS_DEGRADED_NAME,
        )
      )
        this.repositories.evidence.append({
          executionId: execution.identity.executionId,
          kind: 'RECOVERY',
          name: WORKSPACE_PROGRESS_DEGRADED_NAME,
          sourceRevision: execution.identity.sourceRevision,
          payload: {
            code: error.code,
            providerSessionId: snapshot.providerSessionId,
            observedAt: this.now().toISOString(),
          },
        });
    }
    const providerFingerprint =
      snapshot.progressFingerprint ??
      createHash('sha256')
        .update(snapshot.providerSessionId)
        .update('|')
        .update(snapshot.status)
        .digest('hex');
    const fingerprint = createHash('sha256')
      .update(snapshot.providerSessionId)
      .update('|')
      .update(workspaceFingerprint)
      .update('|')
      .update(providerFingerprint)
      .digest('hex');
    const latest = existing.at(-1);
    if (
      !latest ||
      latest.payload.fingerprint !== fingerprint ||
      latest.payload.providerSessionId !== snapshot.providerSessionId
    ) {
      const sequence = existing.length + 1;
      this.repositories.evidence.append({
        executionId: execution.identity.executionId,
        kind: 'RECOVERY',
        name: MEANINGFUL_PROGRESS_PREFIX + String(sequence).padStart(6, '0'),
        sourceRevision: execution.identity.sourceRevision,
        payload: {
          sequence,
          fingerprint,
          workspaceFingerprint,
          providerFingerprint,
          providerSessionId: snapshot.providerSessionId,
          providerStatus: snapshot.status,
          observedAt: this.now().toISOString(),
        },
      });
      return undefined;
    }
    const lastProgressAt = Date.parse(
      typeof latest.payload.observedAt === 'string' ? latest.payload.observedAt : latest.createdAt,
    );
    const now = this.now().getTime();
    if (!Number.isFinite(lastProgressAt) || now - lastProgressAt < this.meaningfulProgressTimeoutMs)
      return undefined;
    return await this.recoverMeaningfulProgressStall(
      provider,
      execution,
      session,
      snapshot,
      selectedResource,
      fingerprint,
      latest.createdAt,
    );
  }

  private async recoverMeaningfulProgressStall(
    provider: ExecutionProviderPort,
    execution: Execution,
    session: ExecutionSession,
    snapshot: ProviderSessionSnapshot,
    selectedResource: ExecutionResourceSelection | undefined,
    fingerprint: string,
    stalledSince: string,
  ): Promise<ExecutionWorkerResult> {
    const previousProviderSessionId = session.providerSessionId;
    if (!previousProviderSessionId) throw new V4Error('PROVIDER_SESSION_ID_REQUIRED');
    const recoveries = this.stallRecoveryEvidence(execution.identity.executionId);
    const recoveryNumber = recoveries.length + 1;
    const evidenceName = MEANINGFUL_STALL_RECOVERY_PREFIX + String(recoveryNumber).padStart(4, '0');
    const basePayload = {
      recoveryNumber,
      fingerprint,
      stalledSince,
      previousProviderSessionId,
      providerStatus: snapshot.status,
      timeoutMs: this.meaningfulProgressTimeoutMs,
    };

    if (recoveries.length < this.maxStallRecoveries && provider.replace && provider.interrupt) {
      let stopped = snapshot;
      if (snapshot.status !== 'PAUSED')
        stopped = await provider.interrupt(previousProviderSessionId);
      if (TERMINAL_PROVIDER_STATUSES.has(stopped.status)) {
        this.recordTerminalProviderStatus(execution.identity.executionId, session, stopped);
        this.repositories.evidence.append({
          executionId: execution.identity.executionId,
          kind: 'RECOVERY',
          name: evidenceName,
          sourceRevision: execution.identity.sourceRevision,
          payload: { ...basePayload, action: 'terminal-race', terminalStatus: stopped.status },
        });
        return {
          executionId: execution.identity.executionId,
          status: 'WAITING',
          code: 'PROVIDER_MEANINGFUL_PROGRESS_TERMINAL_RACE',
          providerSessionId: stopped.providerSessionId,
        };
      }
      this.recordActiveProviderStatus(execution.identity.executionId, session, stopped);
      const currentSession = this.repositories.sessions.get(execution.identity.executionId);
      const plan = this.repositories.plans.getPlan(execution.identity.planId);
      const workItem = execution.identity.workItemId
        ? this.repositories.plans.getWorkItem(execution.identity.workItemId)
        : undefined;
      const replacement = await provider.replace({
        executionId: execution.identity.executionId,
        planId: execution.identity.planId,
        projectKey: plan.projectKey,
        workItemId: execution.identity.workItemId,
        phase: execution.identity.phase,
        objective: execution.objective,
        acceptanceCriteria: workItem?.acceptanceCriteria ?? [],
        sourceRevision: execution.identity.sourceRevision!,
        route: execution.identity.route,
        workspace: currentSession.workspace,
        ...(execution.identity.phase === 'IMPLEMENT_FIX'
          ? { reviewFindings: this.reviewFindings(execution) }
          : {}),
        previousProviderSessionId,
        recoveryKey:
          'meaningful-progress-stall:' +
          execution.identity.executionId +
          ':' +
          recoveryNumber +
          ':' +
          createHash('sha256').update(stalledSince).digest('hex').slice(0, 16),
        instruction:
          'The prior provider turn was alive but made no meaningful provider-event or repository progress for the bounded stall window. Continue the same objective from the existing durable workspace. Preserve any valid work, run the required verification, commit intended changes, and finish.',
      });
      if (replacement.providerSessionId === previousProviderSessionId)
        throw new V4Error('PROVIDER_REPLACEMENT_SESSION_UNCHANGED');
      this.repositories.evidence.append({
        executionId: execution.identity.executionId,
        kind: 'RECOVERY',
        name: evidenceName,
        sourceRevision: execution.identity.sourceRevision,
        payload: {
          ...basePayload,
          action: 'replace',
          providerSessionId: replacement.providerSessionId,
          observedStatus: replacement.status,
        },
      });
      const swapped = this.repositories.sessions.replaceProviderSession(
        execution.identity.executionId,
        previousProviderSessionId,
        replacement.providerSessionId,
        'automatic meaningful-progress stall recovery',
      );
      if (swapped.status === 'rejected' || !swapped.value)
        throw new V4Error(swapped.reason ?? 'STALE_PROVIDER_SESSION');
      const current = await provider.inspect(replacement.providerSessionId);
      const replacedSession = this.repositories.sessions.get(execution.identity.executionId);
      if (TERMINAL_PROVIDER_STATUSES.has(current.status))
        this.recordTerminalProviderStatus(execution.identity.executionId, replacedSession, current);
      else
        this.recordActiveProviderStatus(execution.identity.executionId, replacedSession, current);
      return {
        executionId: execution.identity.executionId,
        status:
          current.status === 'FAILED' ||
          current.status === 'STUCK' ||
          current.status === 'CANCELLED'
            ? 'FAILED'
            : current.status === 'SUCCEEDED'
              ? 'SUCCEEDED'
              : current.status === 'PAUSED' || current.status === 'WAITING_FOR_CONFIRMATION'
                ? 'WAITING'
                : 'RUNNING',
        code: 'PROVIDER_MEANINGFUL_PROGRESS_RECOVERED_' + current.status,
        providerSessionId: current.providerSessionId,
      };
    }

    let stopped: ProviderSessionSnapshot | undefined;
    if (provider.interrupt) stopped = await provider.interrupt(previousProviderSessionId);
    else if (provider.cancel) stopped = await provider.cancel(previousProviderSessionId);
    if (stopped) {
      if (TERMINAL_PROVIDER_STATUSES.has(stopped.status))
        this.recordTerminalProviderStatus(execution.identity.executionId, session, stopped);
      else this.recordActiveProviderStatus(execution.identity.executionId, session, stopped);
    }
    this.repositories.evidence.append({
      executionId: execution.identity.executionId,
      kind: 'RECOVERY',
      name: evidenceName,
      sourceRevision: execution.identity.sourceRevision,
      payload: {
        ...basePayload,
        action: 'fail-retryable',
        ...(stopped ? { stoppedStatus: stopped.status } : {}),
      },
    });
    const failure = new V4Error(
      'PROVIDER_MEANINGFUL_PROGRESS_STALLED',
      'Provider liveness continued without meaningful provider-event or repository progress.',
    );
    this.reportResourceFailure(selectedResource, failure);
    this.repositories.executions.recordResult(execution.identity.executionId, {
      status: 'FAILED',
      errorCode: failure.code,
      retryable: true,
      resultSummary: 'Meaningful progress stalled since ' + stalledSince + '.',
    });
    return {
      executionId: execution.identity.executionId,
      status: 'FAILED',
      code: failure.code,
      providerSessionId: previousProviderSessionId,
    };
  }

  private finalizationInstruction(
    execution: Execution,
    session: ExecutionSession,
    triggerCode: string,
  ): string {
    const evidenceTemplate = JSON.stringify({
      version: 1,
      executionId: execution.identity.executionId,
      phase: execution.identity.phase,
      sourceRevision: execution.identity.sourceRevision,
      resultRevision: '<exact git HEAD after commit>',
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
    return [
      'Finalize the existing Pixel implementation in the same workspace.',
      'The provider already reported completion, but deterministic verification returned ' +
        triggerCode +
        '.',
      'Do not broaden scope and do not discard intended existing work.',
      'Inspect the current changes, run focused checks for the original objective, commit every intended repository change, and leave git status clean.',
      'Then atomically write one JSON object outside the Git repository at ' +
        session.workspace.evidenceExecutionPath +
        ' using this schema: ' +
        evidenceTemplate,
      'The resultRevision must be the exact committed git HEAD. Finish only after the commit, checks, clean-status verification, and evidence write all succeed.',
    ].join('\n');
  }

  private assertProviderPhase(provider: ExecutionProviderPort, execution: Execution): void {
    if (execution.identity.phase === 'REVIEW') {
      if ((provider as Partial<ReviewProviderPort>).independentReview !== true)
        throw new V4Error('INDEPENDENT_REVIEW_PROVIDER_REQUIRED');
    } else if ((provider as Partial<ReviewProviderPort>).independentReview === true) {
      throw new V4Error('IMPLEMENTATION_PROVIDER_REQUIRED');
    }
  }

  private sourceWorkspace(execution: Execution): WorkspaceDescriptor | undefined {
    if (execution.identity.phase === 'IMPLEMENT' || !execution.identity.parentExecutionId)
      return undefined;
    return this.repositories.sessions.get(execution.identity.parentExecutionId).workspace;
  }

  private async resolveProviderSnapshot(
    provider: ExecutionProviderPort,
    execution: Execution,
    session: ExecutionSession,
    projectKey: string,
    acceptanceCriteria: string[],
  ): Promise<ProviderSessionSnapshot> {
    if (TERMINAL_PROVIDER_STATUSES.has(session.providerStatus) && session.providerSessionId) {
      return {
        provider: session.provider,
        providerSessionId: session.providerSessionId,
        status: session.providerStatus,
        ...(session.finalResponse ? { finalResponse: session.finalResponse } : {}),
        ...(session.errorCode ? { errorCode: session.errorCode } : {}),
        observedAt: session.completedAt ?? session.updatedAt,
      };
    }
    if (session.providerSessionId) return await provider.inspect(session.providerSessionId);

    const recovery = {
      executionId: execution.identity.executionId,
      createdAt: execution.createdAt,
      projectKey,
      phase: execution.identity.phase,
      expectedWorkspacePath: session.workspace.executionPath,
    } as const;
    let snapshot = await provider.recover(recovery);
    if (!snapshot) {
      try {
        snapshot = await provider.launch({
          executionId: execution.identity.executionId,
          planId: execution.identity.planId,
          projectKey,
          workItemId: execution.identity.workItemId,
          phase: execution.identity.phase,
          objective: execution.objective,
          acceptanceCriteria,
          sourceRevision: execution.identity.sourceRevision!,
          route: execution.identity.route,
          workspace: session.workspace,
          ...(execution.identity.phase === 'IMPLEMENT_FIX'
            ? { reviewFindings: this.reviewFindings(execution) }
            : {}),
        });
      } catch (error) {
        const recovered = await provider.recover(recovery);
        if (!recovered) throw error;
        snapshot = recovered;
      }
    }
    const attached = this.repositories.sessions.attachProviderSession(
      execution.identity.executionId,
      snapshot.providerSessionId,
    );
    if (attached.status === 'rejected')
      throw new V4Error(attached.reason ?? 'STALE_PROVIDER_SESSION');
    return snapshot;
  }

  private reviewFindings(execution: Execution): string[] {
    if (!execution.identity.parentExecutionId) return [];
    return (
      this.repositories.reviews.findByImplementationExecution(execution.identity.parentExecutionId)
        ?.findings ?? []
    );
  }

  private bindReviewerExecution(execution: Execution, session: ExecutionSession): void {
    if (!execution.identity.parentExecutionId || !session.providerSessionId)
      throw new V4Error('REVIEW_PARENT_REQUIRED');
    const review = this.repositories.reviews.findByImplementationExecution(
      execution.identity.parentExecutionId,
    );
    if (!review) throw new V4Error('REVIEW_NOT_FOUND');
    const attached = this.repositories.reviews.attachReviewerExecution(
      review.reviewId,
      execution.identity.executionId,
    );
    if (attached.status === 'rejected')
      throw new V4Error(attached.reason ?? 'STALE_REVIEWER_EXECUTION');
  }

  private recordActiveProviderStatus(
    executionId: string,
    session: ExecutionSession,
    snapshot: ProviderSessionSnapshot,
  ): void {
    if (session.providerStatus === snapshot.status) {
      const heartbeat = this.repositories.sessions.heartbeat(
        executionId,
        snapshot.status,
        snapshot.observedAt,
      );
      if (heartbeat.status === 'rejected' && heartbeat.reason !== 'STALE_PROVIDER_HEARTBEAT')
        throw new V4Error(heartbeat.reason ?? 'PROVIDER_HEARTBEAT_REJECTED');
      return;
    }
    const updated = this.repositories.sessions.updateProviderStatus(
      executionId,
      snapshot.status,
      snapshot.observedAt,
    );
    if (updated.status === 'rejected') throw new V4Error(updated.reason ?? 'STALE_PROVIDER_STATUS');
  }

  private recordTerminalProviderStatus(
    executionId: string,
    session: ExecutionSession,
    snapshot: ProviderSessionSnapshot,
  ): void {
    if (TERMINAL_PROVIDER_STATUSES.has(session.providerStatus)) return;
    const completed = this.repositories.sessions.complete(executionId, {
      status: snapshot.status as 'SUCCEEDED' | 'FAILED' | 'STUCK' | 'CANCELLED',
      ...(snapshot.finalResponse ? { finalResponse: bounded(snapshot.finalResponse, 64_000) } : {}),
      ...(snapshot.errorCode ? { errorCode: bounded(snapshot.errorCode, MAX_ERROR_CODE) } : {}),
      completedAt: snapshot.observedAt,
    });
    if (completed.status === 'rejected')
      throw new V4Error(completed.reason ?? 'STALE_PROVIDER_STATUS');
  }

  private persistOperatorCompletion(
    execution: Execution,
    snapshot: WorkspaceCompletionSnapshot,
    provider: ProviderSessionSnapshot,
    recoveryName: string,
    reason: string,
  ): void {
    const sourceRevision = execution.identity.sourceRevision;
    this.repositories.evidence.append({
      executionId: execution.identity.executionId,
      kind: 'WORKSPACE',
      name: 'verified-workspace',
      sourceRevision,
      payload: workspacePayload(snapshot),
    });
    this.repositories.evidence.append({
      executionId: execution.identity.executionId,
      kind: 'REVISION',
      name: 'result-revision',
      sourceRevision,
      payload: { sourceRevision: snapshot.sourceRevision, resultRevision: snapshot.headRevision },
    });
    this.repositories.evidence.append({
      executionId: execution.identity.executionId,
      kind: 'DIFF',
      name: 'implementation-diff',
      sourceRevision,
      payload: {
        changedFiles: snapshot.changedFiles,
        diffStat: snapshot.diffStat,
        completion: evidencePayload(snapshot.evidence),
      },
    });
    this.repositories.evidence.append({
      executionId: execution.identity.executionId,
      kind: 'RECOVERY',
      name: recoveryName,
      sourceRevision,
      payload: {
        mode: 'operator-assisted-workspace-adoption',
        reason,
        provider: provider.provider,
        providerSessionId: provider.providerSessionId,
        providerStatus: provider.status,
        observedAt: provider.observedAt,
        resultRevision: snapshot.headRevision,
      },
    });
  }

  private persistCompletion(
    execution: Execution,
    snapshot: WorkspaceCompletionSnapshot,
    provider: ProviderSessionSnapshot,
    providerEvidenceName = 'terminal-provider-snapshot',
  ): void {
    const sourceRevision = execution.identity.sourceRevision;
    this.repositories.evidence.append({
      executionId: execution.identity.executionId,
      kind: 'WORKSPACE',
      name: 'verified-workspace',
      sourceRevision,
      payload: workspacePayload(snapshot),
    });
    this.repositories.evidence.append({
      executionId: execution.identity.executionId,
      kind: 'REVISION',
      name: 'result-revision',
      sourceRevision,
      payload: { sourceRevision: snapshot.sourceRevision, resultRevision: snapshot.headRevision },
    });
    this.repositories.evidence.append({
      executionId: execution.identity.executionId,
      kind: execution.identity.phase === 'REVIEW' ? 'REVIEW' : 'DIFF',
      name: execution.identity.phase === 'REVIEW' ? 'review-verdict' : 'implementation-diff',
      sourceRevision,
      payload:
        execution.identity.phase === 'REVIEW'
          ? evidencePayload(snapshot.evidence)
          : {
              changedFiles: snapshot.changedFiles,
              diffStat: snapshot.diffStat,
              completion: evidencePayload(snapshot.evidence),
            },
    });
    this.repositories.evidence.append({
      executionId: execution.identity.executionId,
      kind: 'PROVIDER_OUTPUT',
      name: providerEvidenceName,
      sourceRevision,
      payload: {
        provider: provider.provider,
        providerSessionId: provider.providerSessionId,
        status: provider.status,
        observedAt: provider.observedAt,
      },
    });
  }

  private persistReviewVerdict(executionId: string, evidence: CompletionEvidence): void {
    if (evidence.phase !== 'REVIEW') throw new V4Error('WORKSPACE_REVIEW_EVIDENCE_INVALID');
    const review = this.repositories.reviews.findByReviewerExecution(executionId);
    if (!review) throw new V4Error('REVIEW_NOT_FOUND');
    if (review.status === 'PENDING')
      this.repositories.reviews.updateStatus(review.reviewId, 'RUNNING');
    this.repositories.reviews.recordVerdict(review.reviewId, evidence.verdict, evidence.findings);
  }

  private renewLease(executionId: string, leaseToken: string): void {
    const renewed = this.repositories.executions.renewLease(
      executionId,
      this.ownerId,
      leaseToken,
      this.leaseTtlMs,
    );
    if (!renewed.value || renewed.status === 'rejected')
      throw new V4Error(renewed.reason ?? 'EXECUTION_LEASE_LOST');
  }
}
