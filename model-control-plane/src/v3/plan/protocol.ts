import type { CreatePlanInput } from '../plans.js';

export interface OrchestrationProposal {
  analysisSummary: string;
  batches: CreatePlanInput['batches'];
}

export interface ExternalProgressAudit {
  candidateRevision: string;
  safeToAdopt: boolean;
  analysisSummary: string;
  blockedBatch: { key: string; resolved: boolean; evidence: string };
  workItems: Array<{
    key: string;
    status: 'VERIFIED_COMPLETE' | 'NOT_VERIFIED';
    evidence: string;
  }>;
  risks: string[];
}

function extractJsonObject(finalText: string, missingCode: string): Record<string, unknown> {
  let text = finalText.trim();
  if (text.startsWith('```')) {
    text = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error(missingCode);
  const parsed = JSON.parse(text.slice(first, last + 1)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(missingCode);
  return parsed as Record<string, unknown>;
}

export function parseExternalProgressAudit(
  finalText: string,
  expectedRevision: string,
  blockedBatchKey: string,
  allowedWorkItemKeys: Set<string>,
): ExternalProgressAudit {
  const parsed = extractJsonObject(finalText, 'EXTERNAL_PROGRESS_AUDIT_JSON_MISSING');
  const candidateRevision = String(parsed.candidateRevision ?? '').trim();
  if (candidateRevision !== expectedRevision) {
    throw new Error('EXTERNAL_PROGRESS_AUDIT_REVISION_MISMATCH');
  }
  const analysisSummary = String(parsed.analysisSummary ?? '').trim();
  if (!analysisSummary) throw new Error('EXTERNAL_PROGRESS_AUDIT_SUMMARY_REQUIRED');
  const blockedRaw = parsed.blockedBatch;
  if (!blockedRaw || typeof blockedRaw !== 'object' || Array.isArray(blockedRaw)) {
    throw new Error('EXTERNAL_PROGRESS_AUDIT_BLOCKED_BATCH_REQUIRED');
  }
  const blocked = blockedRaw as Record<string, unknown>;
  const blockedKey = String(blocked.key ?? '').trim();
  if (blockedKey !== blockedBatchKey) {
    throw new Error('EXTERNAL_PROGRESS_AUDIT_BLOCKED_BATCH_MISMATCH');
  }
  const workItemsRaw = parsed.workItems;
  if (!Array.isArray(workItemsRaw)) throw new Error('EXTERNAL_PROGRESS_AUDIT_WORK_ITEMS_REQUIRED');
  const seen = new Set<string>();
  const workItems = workItemsRaw.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('EXTERNAL_PROGRESS_AUDIT_WORK_ITEM_INVALID');
    }
    const item = raw as Record<string, unknown>;
    const key = String(item.key ?? '').trim();
    if (!allowedWorkItemKeys.has(key) || seen.has(key)) {
      throw new Error('EXTERNAL_PROGRESS_AUDIT_WORK_ITEM_UNKNOWN');
    }
    seen.add(key);
    const status = String(item.status ?? '').trim().toUpperCase();
    if (!['VERIFIED_COMPLETE', 'NOT_VERIFIED'].includes(status)) {
      throw new Error('EXTERNAL_PROGRESS_AUDIT_WORK_ITEM_STATUS_INVALID');
    }
    return {
      key,
      status: status as 'VERIFIED_COMPLETE' | 'NOT_VERIFIED',
      evidence: String(item.evidence ?? '').trim().slice(0, 2_000),
    };
  });
  if (seen.size !== allowedWorkItemKeys.size) throw new Error('EXTERNAL_PROGRESS_AUDIT_INCOMPLETE');
  return {
    candidateRevision,
    safeToAdopt: parsed.safeToAdopt === true,
    analysisSummary: analysisSummary.slice(0, 12_000),
    blockedBatch: {
      key: blockedKey,
      resolved: blocked.resolved === true,
      evidence: String(blocked.evidence ?? '').trim().slice(0, 4_000),
    },
    workItems,
    risks: Array.isArray(parsed.risks)
      ? parsed.risks.map((risk) => String(risk).trim().slice(0, 2_000)).filter(Boolean).slice(0, 24)
      : [],
  };
}

export function parseOrchestrationProposal(finalText: string): OrchestrationProposal {
  const parsed = extractJsonObject(finalText, 'PLAN_ORCHESTRATION_JSON_MISSING');
  const analysisSummary = String(parsed.analysisSummary ?? '').trim();
  if (!analysisSummary) throw new Error('PLAN_ANALYSIS_REQUIRED');
  if (!Array.isArray(parsed.batches) || parsed.batches.length === 0) {
    throw new Error('PLAN_BATCHES_REQUIRED');
  }
  const batches = parsed.batches.slice(0, 24).map((rawBatch) => {
    if (!rawBatch || typeof rawBatch !== 'object' || Array.isArray(rawBatch)) {
      throw new Error('PLAN_BATCH_INVALID');
    }
    const batch = rawBatch as Record<string, unknown>;
    if (!Array.isArray(batch.workItems) || batch.workItems.length === 0) {
      throw new Error('PLAN_WORK_ITEMS_REQUIRED');
    }
    return {
      key: String(batch.key ?? '').trim().slice(0, 160),
      title: String(batch.title ?? batch.key ?? '').trim().slice(0, 500),
      dependsOn: Array.isArray(batch.dependsOn)
        ? batch.dependsOn.map((item) => String(item).trim().slice(0, 160)).filter(Boolean)
        : [],
      workItems: batch.workItems.slice(0, 48).map((rawItem) => {
        if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
          throw new Error('PLAN_WORK_ITEM_INVALID');
        }
        const item = rawItem as Record<string, unknown>;
        return {
          key: String(item.key ?? '').trim().slice(0, 160),
          title: String(item.title ?? item.key ?? '').trim().slice(0, 500),
          objective: String(item.objective ?? '').trim().slice(0, 20_000),
          acceptanceCriteria: Array.isArray(item.acceptanceCriteria)
            ? item.acceptanceCriteria
                .map((criterion) => String(criterion).trim().slice(0, 2_000))
                .filter(Boolean)
                .slice(0, 24)
            : [],
        };
      }),
    };
  });
  return { analysisSummary: analysisSummary.slice(0, 12_000), batches };
}
