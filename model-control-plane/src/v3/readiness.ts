import fs from 'node:fs';
import { parse } from 'yaml';

import { reviewVerdict } from './reviewVerdict.js';
import type { DevelopmentExecutionService } from './service.js';
import type { DevelopmentPhase, DevelopmentExecutionSnapshot } from './types.js';

interface RepresentativeWorkflowEvidence {
  key: string;
  project_key?: string;
  description?: string;
  execution_ids?: string[];
}

interface BooleanEvidence {
  verified?: boolean;
  [key: string]: unknown;
}

interface FixLoopEvidence extends BooleanEvidence {
  implementation_execution_id?: string;
  blocking_review_execution_id?: string;
  fix_execution_id?: string;
  final_review_execution_id?: string;
  source_checkout_clean?: boolean;
}

export interface V3ReadinessEvidence {
  version: number;
  recorded_at?: string;
  representative_workflows: {
    required: number;
    verified: RepresentativeWorkflowEvidence[];
  };
  observability_execution_ids?: string[];
  provider_fallback?: BooleanEvidence;
  gateway_reconnect?: BooleanEvidence;
  rollback?: BooleanEvidence;
  workspace_isolation?: BooleanEvidence;
  operator_recovery?: BooleanEvidence;
  fix_loop?: FixLoopEvidence;
}

export function loadV3ReadinessEvidence(file: string): V3ReadinessEvidence {
  const value = parse(fs.readFileSync(file, 'utf8')) as V3ReadinessEvidence;
  if (!value || value.version !== 1) throw new Error('V3_READINESS_EVIDENCE_VERSION_INVALID');
  const required = Number(value.representative_workflows?.required ?? 0);
  if (!Number.isInteger(required) || required < 1) {
    throw new Error('V3_READINESS_REPRESENTATIVE_REQUIRED_INVALID');
  }
  if (!Array.isArray(value.representative_workflows?.verified)) {
    throw new Error('V3_READINESS_REPRESENTATIVE_EVIDENCE_INVALID');
  }
  return value;
}

function countBy<T extends string>(values: T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function evidenceGate(value: BooleanEvidence | undefined, label: string) {
  return {
    pass: value?.verified === true,
    label,
    evidence: value ?? { verified: false },
  };
}

async function fixLoopGate(
  service: DevelopmentExecutionService,
  executions: Awaited<ReturnType<DevelopmentExecutionService['list']>>,
  evidence: FixLoopEvidence | undefined,
) {
  const ids = {
    implementation: String(evidence?.implementation_execution_id ?? '').trim(),
    blockingReview: String(evidence?.blocking_review_execution_id ?? '').trim(),
    fix: String(evidence?.fix_execution_id ?? '').trim(),
    finalReview: String(evidence?.final_review_execution_id ?? '').trim(),
  };
  const completeIds = Object.values(ids).every(Boolean);
  const byId = new Map(executions.map((item) => [item.executionId, item]));
  const implementation = byId.get(ids.implementation);
  const blockingReview = byId.get(ids.blockingReview);
  const fix = byId.get(ids.fix);
  const finalReview = byId.get(ids.finalReview);
  const structural = Boolean(
    evidence?.verified === true &&
    completeIds &&
    evidence?.source_checkout_clean === true &&
    implementation?.phase === 'IMPLEMENT' &&
    implementation.status === 'SUCCEEDED' &&
    blockingReview?.phase === 'VERIFY_REVIEW' &&
    blockingReview.status === 'SUCCEEDED' &&
    blockingReview.previousExecutionId === ids.implementation &&
    fix?.phase === 'IMPLEMENT_FIX' &&
    fix.status === 'SUCCEEDED' &&
    fix.previousExecutionId === ids.blockingReview &&
    finalReview?.phase === 'VERIFY_REVIEW' &&
    finalReview.status === 'SUCCEEDED' &&
    finalReview.previousExecutionId === ids.fix,
  );

  let blockingSnapshot: DevelopmentExecutionSnapshot | null = null;
  let finalSnapshot: DevelopmentExecutionSnapshot | null = null;
  if (structural) {
    try {
      [blockingSnapshot, finalSnapshot] = await Promise.all([
        service.get(ids.blockingReview),
        service.get(ids.finalReview),
      ]);
    } catch {
      blockingSnapshot = null;
      finalSnapshot = null;
    }
  }
  const blockingText = blockingSnapshot?.result?.finalText?.trim() ?? '';
  const finalText = finalSnapshot?.result?.finalText?.trim() ?? '';
  const blockingFindingVerified = reviewVerdict(blockingText) === 'BLOCKING';
  const finalApprovalVerified = reviewVerdict(finalText) === 'APPROVED';
  return {
    pass: structural && blockingFindingVerified && finalApprovalVerified,
    label: 'failed review -> IMPLEMENT_FIX -> fresh review pass',
    evidence: evidence ?? { verified: false },
    causalChain: {
      ...ids,
      structural,
      blockingFindingVerified,
      finalApprovalVerified,
      sourceCheckoutClean: evidence?.source_checkout_clean === true,
    },
  };
}

async function observabilityGate(
  service: DevelopmentExecutionService,
  executionIds: string[],
): Promise<{
  pass: boolean;
  required: number;
  verified: number;
  items: Array<{
    executionId: string;
    exists: boolean;
    status?: string;
    usageSource?: string | null;
    physicalRouteObserved: boolean;
  }>;
}> {
  const items = [];
  for (const executionId of executionIds) {
    let snapshot: DevelopmentExecutionSnapshot | null = null;
    try {
      snapshot = await service.get(executionId);
    } catch {
      snapshot = null;
    }
    const route = snapshot?.refs.upstream?.route;
    items.push({
      executionId,
      exists: snapshot !== null,
      ...(snapshot ? { status: snapshot.status } : {}),
      usageSource: snapshot?.usage?.source ?? null,
      physicalRouteObserved: Boolean(
        route && typeof route === 'object' && (route as Record<string, unknown>).model,
      ),
    });
  }
  const verified = items.filter(
    (item) =>
      item.exists &&
      item.status === 'SUCCEEDED' &&
      item.usageSource === 'LITELLM_REPORTED' &&
      item.physicalRouteObserved,
  ).length;
  return {
    pass: executionIds.length > 0 && verified === executionIds.length,
    required: executionIds.length,
    verified,
    items,
  };
}

export async function buildV3ReadinessReport(
  service: DevelopmentExecutionService,
  evidence: V3ReadinessEvidence,
) {
  const executions = await service.list({ limit: 500 });
  const phases = executions.map((item) => item.phase as DevelopmentPhase);
  const statuses = executions.map((item) => item.status);
  const phaseCounts = countBy(phases);
  const statusCounts = countBy(statuses);
  const requiredCorePhases: DevelopmentPhase[] = [
    'INVESTIGATE_PLAN',
    'IMPLEMENT',
    'VERIFY_REVIEW',
    'FINALIZE',
  ];
  const phaseCoverage = Object.fromEntries(
    requiredCorePhases.map((phase) => [phase, (phaseCounts[phase] ?? 0) > 0]),
  );
  const phaseCoveragePass = Object.values(phaseCoverage).every(Boolean);
  const representativeCurrent = evidence.representative_workflows.verified.length;
  const representativeRequired = evidence.representative_workflows.required;
  const observability = await observabilityGate(
    service,
    evidence.observability_execution_ids ?? [],
  );
  const fixLoop = await fixLoopGate(service, executions, evidence.fix_loop);
  const terminal = executions.filter((item) =>
    ['SUCCEEDED', 'FAILED', 'STUCK', 'CANCELLED'].includes(item.status),
  );
  const succeeded = terminal.filter((item) => item.status === 'SUCCEEDED').length;

  const gates = {
    representativeWorkflows: {
      pass: representativeCurrent >= representativeRequired,
      current: representativeCurrent,
      required: representativeRequired,
      verified: evidence.representative_workflows.verified,
    },
    corePhaseCoverage: { pass: phaseCoveragePass, phases: phaseCoverage },
    fixLoop,
    providerFallback: evidenceGate(
      evidence.provider_fallback,
      'provider failure/fallback injected',
    ),
    gatewayReconnect: evidenceGate(
      evidence.gateway_reconnect,
      'Gateway restart while external worker continues',
    ),
    rollback: evidenceGate(evidence.rollback, 'V3 -> V2 -> V3 rollback'),
    workspaceIsolation: evidenceGate(
      evidence.workspace_isolation,
      'isolated mutable workspaces and read-only review snapshots',
    ),
    operatorRecovery: evidenceGate(evidence.operator_recovery, 'recovery without raw DB edits'),
    observability,
  };
  const ready = Object.values(gates).every((gate) => gate.pass === true);

  return {
    ready,
    status: ready ? 'READY' : 'NOT_READY',
    generatedAt: new Date().toISOString(),
    evidenceVersion: evidence.version,
    evidenceRecordedAt: evidence.recorded_at ?? null,
    gates,
    observedMetrics: {
      allExecutions: executions.length,
      terminalExecutions: terminal.length,
      successRateAllObserved: terminal.length > 0 ? succeeded / terminal.length : null,
      phaseCounts,
      statusCounts,
    },
    unknownMetrics: {
      representativeHumanCorrectionRate:
        'UNKNOWN: no canonical human-correction event is currently recorded per representative workflow.',
      maintenanceComplexity:
        'UNKNOWN: requires an explicit observation window/operational rubric, not inference from execution count.',
      operatorInterventions:
        'UNKNOWN: operator intervention events are not yet a canonical V3 fact.',
    },
  };
}
