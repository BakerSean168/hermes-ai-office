import type { V2Row } from './repository.js';

export type SupplyOrigin =
  | 'OFFICIAL'
  | 'COMMERCIAL_RELAY'
  | 'COMMUNITY_RELAY'
  | 'EVENT_GRANT'
  | 'PERSONAL_HOSTED'
  | 'INTERNAL_POOL'
  | 'UNKNOWN';

export type RoutingPolicy = 'AUTO' | 'MANUAL_ONLY' | 'BRAIN_ONLY' | 'DISABLED';
export type CommercialType =
  'FREE' | 'SUBSCRIPTION' | 'PREPAID' | 'METERED' | 'SPONSORED' | 'OTHER';
export type SpendTier = 'ZERO_COST' | 'COMMITTED_EXPIRING' | 'PAY_AS_YOU_GO' | 'UNKNOWN';
export type CapacityState = 'AVAILABLE' | 'UNKNOWN' | 'RESET_DUE' | 'EXHAUSTED';

const ORIGINS = new Set<SupplyOrigin>([
  'OFFICIAL',
  'COMMERCIAL_RELAY',
  'COMMUNITY_RELAY',
  'EVENT_GRANT',
  'PERSONAL_HOSTED',
  'INTERNAL_POOL',
  'UNKNOWN',
]);
const ROUTING_POLICIES = new Set<RoutingPolicy>(['AUTO', 'MANUAL_ONLY', 'BRAIN_ONLY', 'DISABLED']);
const COMMERCIAL_TYPES = new Set<CommercialType>([
  'FREE',
  'SUBSCRIPTION',
  'PREPAID',
  'METERED',
  'SPONSORED',
  'OTHER',
]);

export const SPEND_TIER_PRIORITY: Record<SpendTier, number> = {
  ZERO_COST: 0,
  COMMITTED_EXPIRING: 1,
  PAY_AS_YOU_GO: 2,
  UNKNOWN: 3,
};

function normalizedEnum<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase() as T;
  return allowed.has(normalized) ? normalized : fallback;
}

export function normalizeSupplyOrigin(value: unknown): SupplyOrigin {
  return normalizedEnum(value, ORIGINS, 'UNKNOWN');
}

export function normalizeRoutingPolicy(value: unknown): RoutingPolicy {
  return normalizedEnum(value, ROUTING_POLICIES, 'AUTO');
}

export function normalizeCommercialType(value: unknown): CommercialType {
  return normalizedEnum(value, COMMERCIAL_TYPES, 'OTHER');
}

export function spendTierFor(commercialType: CommercialType): SpendTier {
  if (commercialType === 'FREE' || commercialType === 'SPONSORED') return 'ZERO_COST';
  if (commercialType === 'SUBSCRIPTION' || commercialType === 'PREPAID') {
    return 'COMMITTED_EXPIRING';
  }
  if (commercialType === 'METERED') return 'PAY_AS_YOU_GO';
  return 'UNKNOWN';
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function termsExpiry(terms: V2Row): number | null {
  for (const key of ['expiresAt', 'validUntil', 'expiryAt']) {
    const value = numberOrNull(terms[key]);
    if (value != null) return value;
  }
  return null;
}

export interface SupplyEconomicsEvaluation {
  origin: SupplyOrigin;
  routingPolicy: RoutingPolicy;
  commercialType: CommercialType;
  spendTier: SpendTier;
  spendPriority: number;
  capacityState: CapacityState;
  capacityEligible: boolean;
  expiresAt: number | null;
  expiryPriority: number;
  reasons: string[];
}

export function evaluateSupplyEconomics(input: {
  supplier: V2Row;
  employment: V2Row;
  capacityPools?: V2Row[];
  at: number;
}): SupplyEconomicsEvaluation {
  const origin = normalizeSupplyOrigin(input.supplier.supplyOrigin ?? input.supplier.supply_origin);
  const routingPolicy = normalizeRoutingPolicy(
    input.supplier.routingPolicy ?? input.supplier.routing_policy,
  );
  const commercialType = normalizeCommercialType(
    input.employment.commercialType ?? input.employment.commercial_type,
  );
  const spendTier = spendTierFor(commercialType);
  const activePools = (input.capacityPools ?? []).filter(
    (pool) => String(pool.lifecycle ?? 'ACTIVE').toUpperCase() === 'ACTIVE',
  );
  const blocking = activePools.filter((pool) => {
    const remaining = numberOrNull(pool.remaining);
    if (remaining == null || remaining > 0) return false;
    const resetAt = numberOrNull(pool.resetAt ?? pool.reset_at);
    return resetAt == null || resetAt > input.at;
  });
  const resetDue = activePools.some((pool) => {
    const remaining = numberOrNull(pool.remaining);
    const resetAt = numberOrNull(pool.resetAt ?? pool.reset_at);
    return remaining != null && remaining <= 0 && resetAt != null && resetAt <= input.at;
  });
  const hasKnownRemaining = activePools.some((pool) => {
    const remaining = numberOrNull(pool.remaining);
    return remaining != null && remaining > 0;
  });
  const capacityState: CapacityState = blocking.length
    ? 'EXHAUSTED'
    : resetDue
      ? 'RESET_DUE'
      : hasKnownRemaining
        ? 'AVAILABLE'
        : 'UNKNOWN';

  const planTerms =
    input.employment.planTerms && typeof input.employment.planTerms === 'object'
      ? (input.employment.planTerms as V2Row)
      : {};
  const expiryCandidates = [
    numberOrNull(input.employment.agreementValidTo ?? input.employment.agreement_valid_to),
    termsExpiry(planTerms),
    ...activePools.map((pool) => numberOrNull(pool.resetAt ?? pool.reset_at)),
  ].filter((value): value is number => value != null && value > input.at);
  const expiresAt = expiryCandidates.length ? Math.min(...expiryCandidates) : null;

  const reasons = [
    `SUPPLY_ORIGIN_${origin}`,
    `ROUTING_POLICY_${routingPolicy}`,
    `COMMERCIAL_${commercialType}`,
    `SPEND_TIER_${spendTier}`,
    `CAPACITY_${capacityState}`,
  ];
  if (expiresAt != null) reasons.push('EXPIRING_CAPACITY_FIRST');

  return {
    origin,
    routingPolicy,
    commercialType,
    spendTier,
    spendPriority: SPEND_TIER_PRIORITY[spendTier],
    capacityState,
    capacityEligible: blocking.length === 0,
    expiresAt,
    expiryPriority: expiresAt == null ? 1 : 0,
    reasons,
  };
}
