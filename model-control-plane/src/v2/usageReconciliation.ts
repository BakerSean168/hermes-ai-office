import type { GatewayUsageEvidence } from '../gateway/ports.js';
import { GatewayRegistry } from '../gateway/registry.js';
import type {
  RequestUsageReconciliationResult,
  UsageReconciliationSummary,
  V2Repository,
} from './repository.js';

export interface UsageReconciliationResult extends UsageReconciliationSummary {
  reconciliationRunId: string;
  gatewayId: string;
}

function issueFor(
  evidence: GatewayUsageEvidence,
  result: RequestUsageReconciliationResult,
): Record<string, unknown> | null {
  if (evidence.kind !== 'request') return null;
  if (result.status === 'UNMATCHED') {
    return {
      code: 'GATEWAY_REQUEST_UNMATCHED',
      gatewayRequestId: evidence.gatewayRequestId,
      externalRouteRef: evidence.externalRouteRef,
    };
  }
  if (result.status === 'MISMATCH') {
    return {
      code: 'USAGE_LEDGER_MISMATCH',
      gatewayRequestId: evidence.gatewayRequestId,
      attemptId: result.attemptId,
      differences: result.differences ?? {},
    };
  }
  return null;
}

export class UsageReconciliationService {
  readonly #repository: V2Repository;
  readonly #gateways: GatewayRegistry;

  constructor(repository: V2Repository, gateways: GatewayRegistry) {
    this.#repository = repository;
    this.#gateways = gateways;
  }

  gatewayIds(): string[] {
    return this.#gateways
      .list()
      .map((gateway) => gateway.gatewayId)
      .filter((gatewayId) => this.#gateways.getUsage(gatewayId));
  }

  async reconcileAll(): Promise<UsageReconciliationResult[]> {
    const results: UsageReconciliationResult[] = [];
    for (const gatewayId of this.gatewayIds()) {
      const gateway = this.#repository.findGatewayBySlug(gatewayId);
      if (!gateway) continue;
      results.push(await this.reconcile(gatewayId));
    }
    return results;
  }

  async reconcile(gatewayId: string, cursor?: string): Promise<UsageReconciliationResult> {
    const adapter = this.#gateways.getUsage(gatewayId);
    if (!adapter) throw new Error('GATEWAY_USAGE_UNAVAILABLE');
    const gateway = this.#repository.findGatewayBySlug(gatewayId);
    if (!gateway) throw new Error('GATEWAY_NOT_REGISTERED');
    const run = this.#repository.startUsageReconciliationRun(String(gateway.id), cursor);
    const summary: UsageReconciliationSummary = {
      evidenceCount: 0,
      requestMatched: 0,
      requestUnmatched: 0,
      requestUsageCreated: 0,
      requestMismatched: 0,
      aggregateCount: 0,
      issues: [],
    };

    try {
      const page = await adapter.pullUsage(cursor);
      summary.evidenceCount = page.evidence.length;
      summary.nextCursor = page.nextCursor;
      this.#repository.transaction(() => {
        for (const evidence of page.evidence) {
          this.#repository.upsertGatewayUsageEvidence(String(gateway.id), evidence);
          if (evidence.kind === 'aggregate') {
            summary.aggregateCount += 1;
            continue;
          }
          const result = this.#repository.reconcileRequestUsageEvidence(
            String(gateway.id),
            evidence,
          );
          if (result.status === 'MATCHED') summary.requestMatched += 1;
          else if (result.status === 'USAGE_CREATED') summary.requestUsageCreated += 1;
          else if (result.status === 'MISMATCH') summary.requestMismatched += 1;
          else summary.requestUnmatched += 1;
          const issue = issueFor(evidence, result);
          if (issue) summary.issues.push(issue);
        }
      });
      this.#repository.completeUsageReconciliationRun(String(run.id), summary);
      return { reconciliationRunId: String(run.id), gatewayId, ...summary };
    } catch (error) {
      const errorCode = error instanceof Error ? error.message : 'USAGE_RECONCILIATION_FAILED';
      this.#repository.failUsageReconciliationRun(String(run.id), errorCode);
      throw error;
    }
  }
}
