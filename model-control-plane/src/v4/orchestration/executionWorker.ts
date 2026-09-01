import { randomUUID } from 'node:crypto';

import { V4Error } from '../domain/errors.js';
import type { Execution } from '../domain/execution.js';
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

export interface ExecutionWorkerOptions {
  ownerId?: string;
  leaseTtlMs?: number;
  maxExecutionsPerCycle?: number;
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
    this.ownerId = options.ownerId ?? 'execution-worker-' + randomUUID();
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.maxExecutionsPerCycle = options.maxExecutionsPerCycle ?? 20;
    if (this.leaseTtlMs < 1_000 || this.leaseTtlMs > 5 * 60_000) throw new V4Error('EXECUTION_LEASE_TTL_INVALID');
    if (!Number.isInteger(this.maxExecutionsPerCycle) || this.maxExecutionsPerCycle < 1 || this.maxExecutionsPerCycle > 1_000) {
      throw new V4Error('EXECUTION_CYCLE_LIMIT_INVALID');
    }
  }

  async runOnce(): Promise<ExecutionWorkerResult[]> {
    const executions = this.repositories.executions.listByStatuses(['QUEUED', 'RUNNING'], this.maxExecutionsPerCycle);
    const results: ExecutionWorkerResult[] = [];
    for (const execution of executions) results.push(await this.runExecution(execution.identity.executionId));
    return results;
  }

  async continueExecution(
    executionId: string,
    instruction = 'Continue the same bounded execution from its durable workspace and finish the original objective.',
    options: { interruptCurrent?: boolean } = {},
  ): Promise<ExecutionWorkerResult> {
    const claim = this.repositories.executions.claimLease(executionId, this.ownerId, this.leaseTtlMs);
    if (!claim.value || claim.status === 'rejected') return { executionId, status: 'SKIPPED', code: claim.reason ?? 'EXECUTION_LEASE_HELD' };
    try {
      const execution = this.repositories.executions.get(executionId);
      if (execution.status !== 'RUNNING') return { executionId, status: 'SKIPPED', code: 'EXECUTION_NOT_RESUMABLE' };
      const provider = this.routes.get(execution.identity.route);
      if (!provider) return { executionId, status: 'WAITING', code: 'EXECUTION_ROUTE_UNAVAILABLE' };
      if (!provider.continue) return { executionId, status: 'WAITING', code: 'PROVIDER_CONTINUE_UNAVAILABLE' };
      let session = this.repositories.sessions.get(executionId);
      const providerSessionId = session.providerSessionId;
      if (!providerSessionId) return { executionId, status: 'WAITING', code: 'PROVIDER_SESSION_ID_REQUIRED' };
      if (options.interruptCurrent) {
        if (!provider.interrupt) return { executionId, status: 'WAITING', code: 'PROVIDER_INTERRUPT_UNAVAILABLE' };
        const interrupted = await provider.interrupt(providerSessionId);
        if (TERMINAL_PROVIDER_STATUSES.has(interrupted.status))
          this.recordTerminalProviderStatus(executionId, session, interrupted);
        else this.recordActiveProviderStatus(executionId, session, interrupted);
        session = this.repositories.sessions.get(executionId);
      }
      const snapshot = await provider.continue(providerSessionId, instruction);
      if (TERMINAL_PROVIDER_STATUSES.has(snapshot.status)) this.recordTerminalProviderStatus(executionId, session, snapshot);
      else this.recordActiveProviderStatus(executionId, session, snapshot);
      return {
        executionId,
        status: snapshot.status === 'FAILED' || snapshot.status === 'STUCK' || snapshot.status === 'CANCELLED'
          ? 'FAILED'
          : snapshot.status === 'PAUSED' || snapshot.status === 'WAITING_FOR_CONFIRMATION'
            ? 'WAITING'
            : snapshot.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'RUNNING',
        code: 'PROVIDER_' + snapshot.status,
        providerSessionId: snapshot.providerSessionId,
      };
    } catch (error) {
      return { executionId, status: 'FAILED', code: errorCode(error) };
    } finally {
      this.repositories.executions.releaseLease(executionId, this.ownerId, claim.value.leaseToken);
    }
  }

  async runExecution(executionId: string): Promise<ExecutionWorkerResult> {
    const claim = this.repositories.executions.claimLease(executionId, this.ownerId, this.leaseTtlMs);
    if (!claim.value || claim.status === 'rejected') {
      return { executionId, status: 'SKIPPED', code: claim.reason ?? 'EXECUTION_LEASE_HELD' };
    }
    try {
      const execution = this.repositories.executions.get(executionId);
      if (execution.status !== 'QUEUED' && execution.status !== 'RUNNING') {
        return { executionId, status: 'SKIPPED', code: 'EXECUTION_TERMINAL' };
      }
      const provider = this.routes.get(execution.identity.route);
      if (!provider) return { executionId, status: 'WAITING', code: 'EXECUTION_ROUTE_UNAVAILABLE' };
      this.assertProviderPhase(provider, execution);
      const plan = this.repositories.plans.getPlan(execution.identity.planId);
      const workItem = execution.identity.workItemId
        ? this.repositories.plans.getWorkItem(execution.identity.workItemId)
        : undefined;
      if (!execution.identity.sourceRevision) throw new V4Error('EXECUTION_SOURCE_REVISION_REQUIRED');

      let session = this.repositories.sessions.getOptional(executionId);
      if (session && (session.provider !== provider.provider || session.phase !== execution.identity.phase || session.sourceRevision !== execution.identity.sourceRevision)) {
        throw new V4Error('EXECUTION_SESSION_ROUTE_MISMATCH');
      }
      if (!session) {
        const sourceWorkspace = this.sourceWorkspace(execution);
        const workspace = await this.workspace.provision({
          executionId,
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

      let snapshot = await this.resolveProviderSnapshot(provider, execution, session, plan.projectKey, workItem?.acceptanceCriteria ?? []);
      session = this.repositories.sessions.get(executionId);
      if (!session.providerSessionId) throw new V4Error('PROVIDER_SESSION_ID_REQUIRED');

      if (execution.status === 'QUEUED') {
        const started = this.repositories.executions.compareAndSetStatus(executionId, 'QUEUED', 'RUNNING');
        if (started.status === 'rejected') return { executionId, status: 'SKIPPED', code: started.reason ?? 'STALE_EXECUTION_STATUS' };
      }
      if (execution.identity.phase === 'REVIEW') this.bindReviewerExecution(execution, session);
      this.renewLease(executionId, claim.value.leaseToken);

      if (!TERMINAL_PROVIDER_STATUSES.has(snapshot.status)) {
        this.recordActiveProviderStatus(executionId, session, snapshot);
        return {
          executionId,
          status: snapshot.status === 'PAUSED' || snapshot.status === 'WAITING_FOR_CONFIRMATION' ? 'WAITING' : 'RUNNING',
          code: 'PROVIDER_' + snapshot.status,
          providerSessionId: snapshot.providerSessionId,
        };
      }

      let completion: WorkspaceCompletionSnapshot | undefined;
      if (snapshot.status === 'SUCCEEDED') {
        try {
          completion = execution.identity.phase === 'REVIEW'
            ? await this.workspace.verifyReview(session.workspace, execution.identity.sourceRevision)
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
        const code = bounded(snapshot.errorCode, MAX_ERROR_CODE) ?? (snapshot.status === 'STUCK' ? 'PROVIDER_STUCK' : 'PROVIDER_FAILED');
        this.repositories.executions.recordResult(executionId, {
          status: 'FAILED',
          errorCode: code,
          retryable: snapshot.status === 'STUCK' ? true : Boolean(snapshot.retryable),
          resultSummary: bounded(snapshot.finalResponse, MAX_RESULT_SUMMARY),
        });
        return { executionId, status: 'FAILED', code, providerSessionId: snapshot.providerSessionId };
      }
      if (snapshot.status === 'CANCELLED') {
        this.repositories.executions.updateStatus(executionId, 'CANCELLED');
        return { executionId, status: 'FAILED', code: 'PROVIDER_CANCELLED', providerSessionId: snapshot.providerSessionId };
      }
      if (!completion) throw new V4Error('WORKSPACE_COMPLETION_MISSING');
      this.persistCompletion(execution, completion, snapshot);
      this.repositories.executions.recordResult(executionId, {
        status: 'SUCCEEDED',
        resultRevision: completion.headRevision,
        resultSummary: bounded(completion.evidence.summary, MAX_RESULT_SUMMARY),
      });
      if (execution.identity.phase === 'REVIEW') this.persistReviewVerdict(executionId, completion.evidence);
      return {
        executionId,
        status: 'SUCCEEDED',
        code: execution.identity.phase === 'REVIEW' ? 'REVIEW_EXECUTION_SUCCEEDED' : 'IMPLEMENTATION_EXECUTION_SUCCEEDED',
        providerSessionId: snapshot.providerSessionId,
        resultRevision: completion.headRevision,
      };
    } catch (error) {
      const code = errorCode(error);
      const execution = this.repositories.executions.get(executionId);
      if (execution.status === 'RUNNING' && code.startsWith('WORKSPACE_')) {
        const retryable =
          execution.identity.phase !== 'REVIEW' && FINALIZABLE_IMPLEMENTATION_CODES.has(code);
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
      'The provider already reported completion, but deterministic verification returned ' + triggerCode + '.',
      'Do not broaden scope and do not discard intended existing work.',
      'Inspect the current changes, run focused checks for the original objective, commit every intended repository change, and leave git status clean.',
      'Then atomically write one JSON object outside the Git repository at ' + session.workspace.evidenceExecutionPath + ' using this schema: ' + evidenceTemplate,
      'The resultRevision must be the exact committed git HEAD. Finish only after the commit, checks, clean-status verification, and evidence write all succeed.',
    ].join('\n');
  }

  private assertProviderPhase(provider: ExecutionProviderPort, execution: Execution): void {
    if (execution.identity.phase === 'REVIEW') {
      if ((provider as Partial<ReviewProviderPort>).independentReview !== true) throw new V4Error('INDEPENDENT_REVIEW_PROVIDER_REQUIRED');
    } else if ((provider as Partial<ReviewProviderPort>).independentReview === true) {
      throw new V4Error('IMPLEMENTATION_PROVIDER_REQUIRED');
    }
  }

  private sourceWorkspace(execution: Execution): WorkspaceDescriptor | undefined {
    if (execution.identity.phase === 'IMPLEMENT' || !execution.identity.parentExecutionId) return undefined;
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
          ...(execution.identity.phase === 'IMPLEMENT_FIX' ? { reviewFindings: this.reviewFindings(execution) } : {}),
        });
      } catch (error) {
        const recovered = await provider.recover(recovery);
        if (!recovered) throw error;
        snapshot = recovered;
      }
    }
    const attached = this.repositories.sessions.attachProviderSession(execution.identity.executionId, snapshot.providerSessionId);
    if (attached.status === 'rejected') throw new V4Error(attached.reason ?? 'STALE_PROVIDER_SESSION');
    return snapshot;
  }

  private reviewFindings(execution: Execution): string[] {
    if (!execution.identity.parentExecutionId) return [];
    return this.repositories.reviews.findByImplementationExecution(execution.identity.parentExecutionId)?.findings ?? [];
  }

  private bindReviewerExecution(execution: Execution, session: ExecutionSession): void {
    if (!execution.identity.parentExecutionId || !session.providerSessionId) throw new V4Error('REVIEW_PARENT_REQUIRED');
    const review = this.repositories.reviews.findByImplementationExecution(execution.identity.parentExecutionId);
    if (!review) throw new V4Error('REVIEW_NOT_FOUND');
    const attached = this.repositories.reviews.attachReviewerExecution(review.reviewId, execution.identity.executionId);
    if (attached.status === 'rejected') throw new V4Error(attached.reason ?? 'STALE_REVIEWER_EXECUTION');
  }

  private recordActiveProviderStatus(executionId: string, session: ExecutionSession, snapshot: ProviderSessionSnapshot): void {
    if (session.providerStatus === snapshot.status) {
      const heartbeat = this.repositories.sessions.heartbeat(executionId, snapshot.status, snapshot.observedAt);
      if (heartbeat.status === 'rejected' && heartbeat.reason !== 'STALE_PROVIDER_HEARTBEAT') throw new V4Error(heartbeat.reason ?? 'PROVIDER_HEARTBEAT_REJECTED');
      return;
    }
    const updated = this.repositories.sessions.updateProviderStatus(executionId, snapshot.status, snapshot.observedAt);
    if (updated.status === 'rejected') throw new V4Error(updated.reason ?? 'STALE_PROVIDER_STATUS');
  }

  private recordTerminalProviderStatus(executionId: string, session: ExecutionSession, snapshot: ProviderSessionSnapshot): void {
    if (TERMINAL_PROVIDER_STATUSES.has(session.providerStatus)) return;
    const completed = this.repositories.sessions.complete(executionId, {
      status: snapshot.status as 'SUCCEEDED' | 'FAILED' | 'STUCK' | 'CANCELLED',
      ...(snapshot.finalResponse ? { finalResponse: bounded(snapshot.finalResponse, 64_000) } : {}),
      ...(snapshot.errorCode ? { errorCode: bounded(snapshot.errorCode, MAX_ERROR_CODE) } : {}),
      completedAt: snapshot.observedAt,
    });
    if (completed.status === 'rejected') throw new V4Error(completed.reason ?? 'STALE_PROVIDER_STATUS');
  }

  private persistCompletion(execution: Execution, snapshot: WorkspaceCompletionSnapshot, provider: ProviderSessionSnapshot): void {
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
      payload: execution.identity.phase === 'REVIEW'
        ? evidencePayload(snapshot.evidence)
        : { changedFiles: snapshot.changedFiles, diffStat: snapshot.diffStat, completion: evidencePayload(snapshot.evidence) },
    });
    this.repositories.evidence.append({
      executionId: execution.identity.executionId,
      kind: 'PROVIDER_OUTPUT',
      name: 'terminal-provider-snapshot',
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
    if (review.status === 'PENDING') this.repositories.reviews.updateStatus(review.reviewId, 'RUNNING');
    this.repositories.reviews.recordVerdict(review.reviewId, evidence.verdict, evidence.findings);
  }

  private renewLease(executionId: string, leaseToken: string): void {
    const renewed = this.repositories.executions.renewLease(executionId, this.ownerId, leaseToken, this.leaseTtlMs);
    if (!renewed.value || renewed.status === 'rejected') throw new V4Error(renewed.reason ?? 'EXECUTION_LEASE_LOST');
  }
}
