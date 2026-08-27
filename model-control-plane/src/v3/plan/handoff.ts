export interface PlanHandoffWorkItem {
  key: string;
  evidence: string[];
}

export interface PlanHandoffV1 {
  schemaVersion: 1;
  planId: string;
  baseRevision: string;
  headRevision: string;
  ref?: string;
  summary?: string;
  completedWorkItems: PlanHandoffWorkItem[];
  recommendedNextWorkItem?: string;
}

const GIT_SHA = /^[0-9a-f]{40}$/i;

function requiredString(value: unknown, code: string, max = 4_000): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(code);
  return text.slice(0, max);
}

export function parsePlanHandoff(input: unknown, expectedPlanId: string): PlanHandoffV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('HANDOFF_INVALID');
  }
  const raw = input as Record<string, unknown>;
  if (Number(raw.schemaVersion) !== 1) throw new Error('HANDOFF_SCHEMA_VERSION_INVALID');
  const planId = requiredString(raw.planId, 'HANDOFF_PLAN_ID_REQUIRED', 200);
  if (planId !== expectedPlanId) throw new Error('HANDOFF_PLAN_ID_MISMATCH');
  const baseRevision = requiredString(raw.baseRevision, 'HANDOFF_BASE_REVISION_REQUIRED', 80);
  const headRevision = requiredString(raw.headRevision, 'HANDOFF_HEAD_REVISION_REQUIRED', 80);
  if (!GIT_SHA.test(baseRevision)) throw new Error('HANDOFF_BASE_REVISION_INVALID');
  if (!GIT_SHA.test(headRevision)) throw new Error('HANDOFF_HEAD_REVISION_INVALID');
  if (baseRevision === headRevision) throw new Error('HANDOFF_EMPTY');

  const completedRaw = raw.completedWorkItems ?? [];
  if (!Array.isArray(completedRaw)) throw new Error('HANDOFF_COMPLETED_WORK_ITEMS_INVALID');
  const seen = new Set<string>();
  const completedWorkItems = completedRaw.slice(0, 100).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('HANDOFF_WORK_ITEM_INVALID');
    }
    const item = entry as Record<string, unknown>;
    const key = requiredString(item.key, 'HANDOFF_WORK_ITEM_KEY_REQUIRED', 200);
    if (seen.has(key)) throw new Error('HANDOFF_WORK_ITEM_DUPLICATE');
    seen.add(key);
    const evidence = Array.isArray(item.evidence)
      ? item.evidence.map((value) => String(value).trim()).filter(Boolean).slice(0, 20)
      : item.evidence
        ? [String(item.evidence).trim()].filter(Boolean)
        : [];
    return { key, evidence: evidence.map((value) => value.slice(0, 1_000)) };
  });

  const ref = raw.ref ? requiredString(raw.ref, 'HANDOFF_REF_INVALID', 500) : undefined;
  const summary = raw.summary ? requiredString(raw.summary, 'HANDOFF_SUMMARY_INVALID', 4_000) : undefined;
  const recommendedNextWorkItem = raw.recommendedNextWorkItem
    ? requiredString(raw.recommendedNextWorkItem, 'HANDOFF_NEXT_WORK_ITEM_INVALID', 200)
    : undefined;

  return {
    schemaVersion: 1,
    planId,
    baseRevision: baseRevision.toLowerCase(),
    headRevision: headRevision.toLowerCase(),
    ...(ref ? { ref } : {}),
    ...(summary ? { summary } : {}),
    completedWorkItems,
    ...(recommendedNextWorkItem ? { recommendedNextWorkItem } : {}),
  };
}
