import type { ExecutionLinkRecord, ExecutionStatus } from './types.js';
import type { PlanStatus } from './plan/model.js';
import type { WorkspaceProvisioningPort } from './workspace.js';

const TERMINAL = new Set<ExecutionStatus>(['SUCCEEDED', 'FAILED', 'STUCK', 'CANCELLED']);
const TERMINAL_PLANS = new Set<PlanStatus>(['SUCCEEDED', 'CANCELLED']);

export interface WorkspaceRetentionLinkStore {
  list(input?: { projectKey?: string; limit?: number; offset?: number }): ExecutionLinkRecord[];
}

export interface WorkspaceRetentionPlanStore {
  get(planId: string): { status: PlanStatus } | null;
}

export interface WorkspaceRetentionOptions {
  links: WorkspaceRetentionLinkStore;
  plans: WorkspaceRetentionPlanStore;
  workspace: WorkspaceProvisioningPort;
  standaloneSuccessTtlMs?: number;
  standaloneFailureTtlMs?: number;
  terminalPlanTtlMs?: number;
  recoverablePlanArtifactTtlMs?: number;
}

export interface WorkspaceRetentionSummary {
  scanned: number;
  pruned: number;
  deleted: number;
  protected: number;
}

export class ExecutionWorkspaceRetention {
  readonly #links: WorkspaceRetentionLinkStore;
  readonly #plans: WorkspaceRetentionPlanStore;
  readonly #workspace: WorkspaceProvisioningPort;
  readonly #standaloneSuccessTtlMs: number;
  readonly #standaloneFailureTtlMs: number;
  readonly #terminalPlanTtlMs: number;
  readonly #recoverablePlanArtifactTtlMs: number;

  constructor(options: WorkspaceRetentionOptions) {
    this.#links = options.links;
    this.#plans = options.plans;
    this.#workspace = options.workspace;
    this.#standaloneSuccessTtlMs = options.standaloneSuccessTtlMs ?? 6 * 60 * 60_000;
    this.#standaloneFailureTtlMs = options.standaloneFailureTtlMs ?? 60 * 60_000;
    this.#terminalPlanTtlMs = options.terminalPlanTtlMs ?? 60 * 60_000;
    this.#recoverablePlanArtifactTtlMs = options.recoverablePlanArtifactTtlMs ?? 60 * 60_000;
  }

  async collect(now = Date.now()): Promise<WorkspaceRetentionSummary> {
    const records = this.#links.list({ limit: 5000 });
    const byId = new Map(records.map((record) => [record.executionId, record] as const));
    const protectedIds = new Set<string>();
    const activeWorkspaceRefs = new Set<string>();
    const recoverableWorkspaceRefs = new Set<string>();
    const planStatus = new Map<string, PlanStatus | null>();

    const statusForPlan = (planId: string): PlanStatus | null => {
      if (planStatus.has(planId)) return planStatus.get(planId) ?? null;
      const status = this.#plans.get(planId)?.status ?? null;
      planStatus.set(planId, status);
      return status;
    };

    for (const record of records) {
      if (TERMINAL.has(record.statusCache)) continue;
      if (record.workspaceRef) activeWorkspaceRefs.add(record.workspaceRef);
      let previous = record.previousExecutionId;
      while (previous && !protectedIds.has(previous)) {
        protectedIds.add(previous);
        previous = byId.get(previous)?.previousExecutionId;
      }
    }

    // A recoverable plan only needs the latest successful implementation artifact for
    // each work item. Review snapshots and superseded/failed attempts are durable in
    // the DB and can be recreated or retried from repository state. Keeping every
    // historical clone is what previously allowed one BLOCKED plan to pin tens of GB.
    const latestImplementationByWorkItem = new Map<string, ExecutionLinkRecord>();
    for (const record of records) {
      if (
        !record.planId ||
        !record.workItemId ||
        record.statusCache !== 'SUCCEEDED' ||
        !record.workspaceRef ||
        !['ADOPT_CHANGE', 'IMPLEMENT', 'IMPLEMENT_FIX'].includes(record.phase)
      ) {
        continue;
      }
      const status = statusForPlan(record.planId);
      if (!status || TERMINAL_PLANS.has(status)) continue;
      const current = latestImplementationByWorkItem.get(record.workItemId);
      if (!current || record.createdAt > current.createdAt) {
        latestImplementationByWorkItem.set(record.workItemId, record);
      }
    }
    for (const record of latestImplementationByWorkItem.values()) {
      recoverableWorkspaceRefs.add(record.workspaceRef!);
    }

    let pruned = 0;
    let deleted = 0;
    let protectedCount = 0;
    const prunedWorkspaceRefs = new Set<string>();

    for (const record of records) {
      if (!TERMINAL.has(record.statusCache) || !record.workspaceRef) continue;
      const causallyProtected =
        protectedIds.has(record.executionId) || activeWorkspaceRefs.has(record.workspaceRef);
      if (causallyProtected) {
        protectedCount += 1;
        continue;
      }

      const status = record.planId ? statusForPlan(record.planId) : null;
      const terminalPlan = Boolean(status && TERMINAL_PLANS.has(status));
      const recoverablePlanArtifact = Boolean(
        record.planId && !terminalPlan && recoverableWorkspaceRefs.has(record.workspaceRef),
      );
      const unknownPlan = Boolean(record.planId && !status);
      const planProtected = recoverablePlanArtifact || unknownPlan;
      const endedAt = record.endedAt ?? record.updatedAt;
      const ageMs = Math.max(0, now - endedAt);
      const ttlMs = record.planId
        ? terminalPlan
          ? this.#terminalPlanTtlMs
          : this.#recoverablePlanArtifactTtlMs
        : record.statusCache === 'SUCCEEDED'
          ? this.#standaloneSuccessTtlMs
          : this.#standaloneFailureTtlMs;

      if (!planProtected && ageMs >= ttlMs && this.#workspace.removeExecutionWorkspace) {
        if (await this.#workspace.removeExecutionWorkspace(record.executionId)) deleted += 1;
        continue;
      }

      if (planProtected) protectedCount += 1;
      if (
        this.#workspace.pruneExecutionArtifacts &&
        !prunedWorkspaceRefs.has(record.workspaceRef)
      ) {
        if (
          await this.#workspace.pruneExecutionArtifacts({
            executionId: record.executionId,
            workspaceRef: record.workspaceRef,
          })
        ) {
          pruned += 1;
          prunedWorkspaceRefs.add(record.workspaceRef);
        }
      }
    }

    return { scanned: records.length, pruned, deleted, protected: protectedCount };
  }
}
