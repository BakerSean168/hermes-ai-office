import { V4Error, failClosed } from './errors.js';

export const EXECUTION_CAPABILITIES = ['IMPLEMENTATION', 'REASONING'] as const;
export type ExecutionCapability = (typeof EXECUTION_CAPABILITIES)[number];

export const ROUTING_EXECUTION_PHASES = [
  'ORCHESTRATE',
  'PLAN',
  'IMPLEMENT',
  'IMPLEMENT_FIX',
  'REVIEW',
  'FINALIZE',
] as const;
export type RoutingExecutionPhase = (typeof ROUTING_EXECUTION_PHASES)[number];
export const EXECUTION_PHASES = ROUTING_EXECUTION_PHASES;
export type ExecutionPhase = RoutingExecutionPhase;

export const RESOURCE_TIERS = ['PROMOTIONAL', 'FREE', 'SUBSCRIPTION', 'METERED', 'OTHER'] as const;
export type ResourceTier = (typeof RESOURCE_TIERS)[number];

export const RESOURCE_STATES = ['ACTIVE', 'SUSPENDED', 'DISABLED'] as const;
export type ResourceState = (typeof RESOURCE_STATES)[number];

export const RESOURCE_TRANSPORTS = ['LITELLM_MANAGED', 'PROVIDER_NATIVE'] as const;
export type ResourceTransport = (typeof RESOURCE_TRANSPORTS)[number];

export const RESOURCE_SELECTION_REASONS = ['STATIC_POLICY'] as const;
export type ResourceSelectionReason = (typeof RESOURCE_SELECTION_REASONS)[number];

export const RESOURCE_COMMERCIAL_TYPES = [
  'FREE',
  'SPONSORED',
  'SUBSCRIPTION',
  'METERED',
  'OTHER',
] as const;
export type ResourceCommercialType = (typeof RESOURCE_COMMERCIAL_TYPES)[number];

export const RESOURCE_SUPPLY_ORIGINS = [
  'COMMUNITY_RELAY',
  'COMMERCIAL_RELAY',
  'OFFICIAL',
  'UNKNOWN',
] as const;
export type ResourceSupplyOrigin = (typeof RESOURCE_SUPPLY_ORIGINS)[number];

export const RESOURCE_LIFECYCLES = ['STABLE', 'RECURRING', 'PROMOTIONAL'] as const;
export type ResourceLifecycle = (typeof RESOURCE_LIFECYCLES)[number];

export const RESOURCE_TIER_RANKS: Readonly<Record<ResourceTier, number>> = Object.freeze({
  PROMOTIONAL: 10,
  FREE: 20,
  SUBSCRIPTION: 30,
  METERED: 40,
  OTHER: 60,
});

export const COMMUNITY_SUSPENSION_MS = 24 * 60 * 60 * 1_000;
export const PAID_TRANSIENT_COOLDOWN_MS = 15 * 60 * 1_000;

export function resourceTierRank(tier: ResourceTier): number {
  const rank = RESOURCE_TIER_RANKS[tier];
  failClosed(rank !== undefined, 'RESOURCE_TIER_INVALID');
  return rank;
}

export function validateExecutionCapability(capability: ExecutionCapability): void {
  oneOf(capability, EXECUTION_CAPABILITIES, 'EXECUTION_CAPABILITY_INVALID');
}

export function validateResourceTier(tier: ResourceTier): void {
  oneOf(tier, RESOURCE_TIERS, 'RESOURCE_TIER_INVALID');
}

export function validateResourceState(state: ResourceState): void {
  oneOf(state, RESOURCE_STATES, 'RESOURCE_STATE_INVALID');
}

export function validateResourceTransport(transport: ResourceTransport): void {
  oneOf(transport, RESOURCE_TRANSPORTS, 'RESOURCE_TRANSPORT_INVALID');
}

export function deriveResourceTier(
  commercialType: ResourceCommercialType,
  lifecycle: ResourceLifecycle,
): ResourceTier {
  if (lifecycle === 'PROMOTIONAL') return 'PROMOTIONAL';
  if (commercialType === 'FREE' || commercialType === 'SPONSORED') return 'FREE';
  if (commercialType === 'SUBSCRIPTION') return 'SUBSCRIPTION';
  if (commercialType === 'METERED') return 'METERED';
  return 'OTHER';
}

export function capabilityForPhase(phase: RoutingExecutionPhase): ExecutionCapability | undefined {
  if (phase === 'IMPLEMENT' || phase === 'IMPLEMENT_FIX') return 'IMPLEMENTATION';
  if (phase === 'ORCHESTRATE' || phase === 'PLAN' || phase === 'REVIEW') return 'REASONING';
  return undefined;
}

function nonEmpty(value: unknown, code: string, maximum = 500): asserts value is string {
  failClosed(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum, code);
}

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  code: string,
): asserts value is T {
  failClosed(typeof value === 'string' && values.includes(value as T), code);
}

export interface ModelAffinity {
  readonly capability: ExecutionCapability;
  readonly modelFamily: string;
  readonly modelRank: number;
  readonly agentBackend?: string;
  /** YAML policy files may use the shorter backend spelling. */
  readonly backend?: string;
  /** Provider-native affinities can declare their transport without entering LiteLLM routing. */
  readonly transport?: ResourceTransport;
  /** A non-empty key makes a profile opt-in to a project trust policy. */
  readonly requiresPolicy?: string;
}

export interface AffinityPolicy {
  readonly version: 1;
  readonly capabilities: Readonly<Record<ExecutionCapability, readonly ModelAffinity[]>>;
  /** Provider-native profiles are represented here but are opt-in at selection time. */
  readonly providerNativeProfiles: readonly ModelAffinity[];
}

export const DEFAULT_AFFINITY_POLICY: AffinityPolicy = Object.freeze({
  version: 1,
  capabilities: Object.freeze({
    IMPLEMENTATION: Object.freeze([
      Object.freeze({
        capability: 'IMPLEMENTATION',
        modelFamily: 'deepseek-v4-flash',
        modelRank: 10,
        agentBackend: 'dsh-acp',
      }),
      Object.freeze({
        capability: 'IMPLEMENTATION',
        modelFamily: 'glm-current',
        modelRank: 20,
        agentBackend: 'zcode-acp',
      }),
      Object.freeze({
        capability: 'IMPLEMENTATION',
        modelFamily: 'gpt-5.6-luna',
        modelRank: 30,
        agentBackend: 'codex-acp',
      }),
    ]),
    REASONING: Object.freeze([
      Object.freeze({
        capability: 'REASONING',
        modelFamily: 'gpt-5.6-sol',
        modelRank: 10,
        agentBackend: 'codex-acp',
      }),
      Object.freeze({
        capability: 'REASONING',
        modelFamily: 'claude-opus-5',
        modelRank: 20,
        agentBackend: 'claude-code-acp',
      }),
      Object.freeze({
        capability: 'REASONING',
        modelFamily: 'claude-opus-4-8',
        modelRank: 30,
        agentBackend: 'claude-code-acp',
      }),
    ]),
  }),
  providerNativeProfiles: Object.freeze([
    Object.freeze({
      capability: 'IMPLEMENTATION',
      modelFamily: 'gemini-3.8-flash-high',
      modelRank: 10,
      agentBackend: 'antigravity-worker',
      transport: 'PROVIDER_NATIVE',
      requiresPolicy: 'provider-native-trusted-input',
    }),
    Object.freeze({
      capability: 'IMPLEMENTATION',
      modelFamily: 'gemini-3.7-flash-high',
      modelRank: 20,
      agentBackend: 'antigravity-worker',
      transport: 'PROVIDER_NATIVE',
      requiresPolicy: 'provider-native-trusted-input',
    }),
    Object.freeze({
      capability: 'REASONING',
      modelFamily: 'gemini-3.1-pro-high',
      modelRank: 15,
      agentBackend: 'antigravity-review',
      transport: 'PROVIDER_NATIVE',
      requiresPolicy: 'provider-native-trusted-input',
    }),
  ]),
});

export const DEFAULT_MODEL_AFFINITY_POLICY = DEFAULT_AFFINITY_POLICY;

export function validateModelAffinity(affinity: ModelAffinity): void {
  oneOf(affinity.capability, EXECUTION_CAPABILITIES, 'MODEL_AFFINITY_CAPABILITY_INVALID');
  nonEmpty(affinity.modelFamily, 'MODEL_AFFINITY_MODEL_REQUIRED');
  failClosed(
    Number.isInteger(affinity.modelRank) && affinity.modelRank > 0,
    'MODEL_AFFINITY_RANK_INVALID',
  );
  nonEmpty(affinity.agentBackend ?? affinity.backend, 'MODEL_AFFINITY_BACKEND_REQUIRED');
  if (affinity.transport !== undefined)
    oneOf(affinity.transport, RESOURCE_TRANSPORTS, 'MODEL_AFFINITY_TRANSPORT_INVALID');
  if (affinity.requiresPolicy !== undefined)
    nonEmpty(affinity.requiresPolicy, 'MODEL_AFFINITY_POLICY_INVALID');
}

function validateAffinityList(affinities: readonly ModelAffinity[], codePrefix: string): void {
  failClosed(Array.isArray(affinities) && affinities.length > 0, codePrefix + '_EMPTY');
  const families = new Set<string>();
  const ranks = new Set<string>();
  for (const affinity of affinities) {
    validateModelAffinity(affinity);
    if (families.has(affinity.modelFamily)) throw new V4Error(codePrefix + '_DUPLICATE_MODEL');
    const rankKey = affinity.capability + ':' + String(affinity.modelRank);
    if (ranks.has(rankKey)) throw new V4Error(codePrefix + '_DUPLICATE_RANK');
    families.add(affinity.modelFamily);
    ranks.add(rankKey);
  }
}

export function validateAffinityPolicy(policy: AffinityPolicy): void {
  if (policy === null || typeof policy !== 'object') throw new V4Error('AFFINITY_POLICY_INVALID');
  failClosed(policy.version === 1, 'AFFINITY_POLICY_VERSION_UNSUPPORTED');
  failClosed(
    policy.capabilities !== null && typeof policy.capabilities === 'object',
    'AFFINITY_POLICY_CAPABILITIES_INVALID',
  );
  for (const capability of EXECUTION_CAPABILITIES) {
    const affinities = policy.capabilities?.[capability];
    failClosed(Array.isArray(affinities), 'AFFINITY_POLICY_CAPABILITY_MISSING');
    validateAffinityList(affinities, 'AFFINITY_POLICY_' + capability);
    for (const affinity of affinities)
      failClosed(affinity.capability === capability, 'AFFINITY_POLICY_CAPABILITY_MISMATCH');
  }
  validateAffinityList(policy.providerNativeProfiles, 'AFFINITY_POLICY_PROVIDER_NATIVE');
  for (const affinity of policy.providerNativeProfiles) {
    failClosed(
      affinity.transport === 'PROVIDER_NATIVE',
      'AFFINITY_POLICY_NATIVE_TRANSPORT_REQUIRED',
    );
  }
}

export function affinitiesForCapability(
  policy: AffinityPolicy,
  capability: ExecutionCapability,
  includeProviderNativeProfiles = false,
): readonly ModelAffinity[] {
  validateAffinityPolicy(policy);
  const core = policy.capabilities[capability];
  if (!includeProviderNativeProfiles) return core;
  return [
    ...core,
    ...policy.providerNativeProfiles.filter((affinity) => affinity.capability === capability),
  ];
}

export interface ExecutionResourceBinding {
  readonly bindingId: string;
  readonly modelFamily: string;
  readonly transport: ResourceTransport;
  readonly enabled: boolean;
  readonly ready: boolean;
  /** A provider-native binding may use a backend different from the family default. */
  readonly agentBackend?: string;
  readonly backend?: string;
  readonly deploymentId?: string;
  /** Public route model exposed by LiteLLM or the provider-native adapter. */
  readonly routeModel?: string;
  /** Sanitized wire protocol label, never a credential. */
  readonly protocol?: string;
  readonly requiresPolicy?: string;
}

export interface ExecutionResource {
  readonly resourceId: string;
  readonly resourceTier: ResourceTier;
  readonly resourceSequence: number;
  readonly state: ResourceState;
  readonly ready: boolean;
  readonly commercialType: ResourceCommercialType;
  readonly supplyOrigin: ResourceSupplyOrigin;
  readonly resourceLifecycle: ResourceLifecycle;
  readonly bindings: readonly ExecutionResourceBinding[];
  readonly providerId?: string;
  readonly displayName?: string;
  readonly requiresPolicy?: string;
}

export function validateExecutionResourceBinding(binding: ExecutionResourceBinding): void {
  nonEmpty(binding.bindingId, 'RESOURCE_BINDING_ID_REQUIRED');
  nonEmpty(binding.modelFamily, 'RESOURCE_BINDING_MODEL_REQUIRED');
  oneOf(binding.transport, RESOURCE_TRANSPORTS, 'RESOURCE_BINDING_TRANSPORT_INVALID');
  failClosed(typeof binding.enabled === 'boolean', 'RESOURCE_BINDING_ENABLED_INVALID');
  failClosed(typeof binding.ready === 'boolean', 'RESOURCE_BINDING_READY_INVALID');
  if (binding.agentBackend !== undefined)
    nonEmpty(binding.agentBackend, 'RESOURCE_BINDING_BACKEND_INVALID');
  if (binding.backend !== undefined) nonEmpty(binding.backend, 'RESOURCE_BINDING_BACKEND_INVALID');
  if (binding.deploymentId !== undefined)
    nonEmpty(binding.deploymentId, 'RESOURCE_BINDING_DEPLOYMENT_INVALID');
  if (binding.routeModel !== undefined)
    nonEmpty(binding.routeModel, 'RESOURCE_BINDING_ROUTE_MODEL_INVALID');
  if (binding.protocol !== undefined)
    nonEmpty(binding.protocol, 'RESOURCE_BINDING_PROTOCOL_INVALID');
  if (binding.requiresPolicy !== undefined)
    nonEmpty(binding.requiresPolicy, 'RESOURCE_BINDING_POLICY_INVALID');
}

export function validateExecutionResource(resource: ExecutionResource): void {
  nonEmpty(resource.resourceId, 'RESOURCE_ID_REQUIRED');
  oneOf(resource.resourceTier, RESOURCE_TIERS, 'RESOURCE_TIER_INVALID');
  failClosed(
    Number.isInteger(resource.resourceSequence) && resource.resourceSequence > 0,
    'RESOURCE_SEQUENCE_INVALID',
  );
  oneOf(resource.state, RESOURCE_STATES, 'RESOURCE_STATE_INVALID');
  failClosed(typeof resource.ready === 'boolean', 'RESOURCE_READY_INVALID');
  oneOf(resource.commercialType, RESOURCE_COMMERCIAL_TYPES, 'RESOURCE_COMMERCIAL_TYPE_INVALID');
  oneOf(resource.supplyOrigin, RESOURCE_SUPPLY_ORIGINS, 'RESOURCE_SUPPLY_ORIGIN_INVALID');
  oneOf(resource.resourceLifecycle, RESOURCE_LIFECYCLES, 'RESOURCE_LIFECYCLE_INVALID');
  failClosed(
    resource.resourceTier ===
      deriveResourceTier(resource.commercialType, resource.resourceLifecycle),
    'RESOURCE_TIER_DERIVATION_INVALID',
  );
  failClosed(Array.isArray(resource.bindings), 'RESOURCE_BINDINGS_INVALID');
  const bindingIds = new Set<string>();
  for (const binding of resource.bindings) {
    validateExecutionResourceBinding(binding);
    if (bindingIds.has(binding.bindingId)) throw new V4Error('RESOURCE_BINDING_DUPLICATE');
    bindingIds.add(binding.bindingId);
  }
  if (resource.providerId !== undefined)
    nonEmpty(resource.providerId, 'RESOURCE_PROVIDER_ID_INVALID');
  if (resource.displayName !== undefined)
    nonEmpty(resource.displayName, 'RESOURCE_DISPLAY_NAME_INVALID');
  if (resource.requiresPolicy !== undefined)
    nonEmpty(resource.requiresPolicy, 'RESOURCE_POLICY_INVALID');
}

export interface ExecutableProfile {
  readonly capability: ExecutionCapability;
  readonly phase: RoutingExecutionPhase;
  readonly modelFamily: string;
  readonly agentBackend: string;
  readonly transport: ResourceTransport;
  readonly resourceId: string;
  readonly resourceTier: ResourceTier;
  readonly modelRank: number;
  readonly resourceSequence: number;
  readonly resourceState: ResourceState;
  readonly selectionReason: ResourceSelectionReason;
  readonly bindingId?: string;
  readonly deploymentId?: string;
  readonly routeModel?: string;
  readonly protocol?: string;
}

export function validateExecutableProfile(profile: ExecutableProfile): void {
  oneOf(profile.capability, EXECUTION_CAPABILITIES, 'EXECUTABLE_PROFILE_CAPABILITY_INVALID');
  oneOf(profile.phase, ROUTING_EXECUTION_PHASES, 'EXECUTABLE_PROFILE_PHASE_INVALID');
  failClosed(
    capabilityForPhase(profile.phase) === profile.capability,
    'EXECUTABLE_PROFILE_PHASE_CAPABILITY_MISMATCH',
  );
  nonEmpty(profile.modelFamily, 'EXECUTABLE_PROFILE_MODEL_REQUIRED');
  nonEmpty(profile.agentBackend, 'EXECUTABLE_PROFILE_BACKEND_REQUIRED');
  oneOf(profile.transport, RESOURCE_TRANSPORTS, 'EXECUTABLE_PROFILE_TRANSPORT_INVALID');
  nonEmpty(profile.resourceId, 'EXECUTABLE_PROFILE_RESOURCE_REQUIRED');
  oneOf(profile.resourceTier, RESOURCE_TIERS, 'EXECUTABLE_PROFILE_TIER_INVALID');
  failClosed(
    Number.isInteger(profile.modelRank) && profile.modelRank > 0,
    'EXECUTABLE_PROFILE_RANK_INVALID',
  );
  failClosed(
    Number.isInteger(profile.resourceSequence) && profile.resourceSequence > 0,
    'EXECUTABLE_PROFILE_SEQUENCE_INVALID',
  );
  oneOf(profile.resourceState, RESOURCE_STATES, 'EXECUTABLE_PROFILE_RESOURCE_STATE_INVALID');
  oneOf(
    profile.selectionReason,
    RESOURCE_SELECTION_REASONS,
    'EXECUTABLE_PROFILE_SELECTION_REASON_INVALID',
  );
  if (profile.bindingId !== undefined)
    nonEmpty(profile.bindingId, 'EXECUTABLE_PROFILE_BINDING_INVALID');
  if (profile.deploymentId !== undefined)
    nonEmpty(profile.deploymentId, 'EXECUTABLE_PROFILE_DEPLOYMENT_INVALID');
  if (profile.routeModel !== undefined)
    nonEmpty(profile.routeModel, 'EXECUTABLE_PROFILE_ROUTE_MODEL_INVALID');
  if (profile.protocol !== undefined)
    nonEmpty(profile.protocol, 'EXECUTABLE_PROFILE_PROTOCOL_INVALID');
}

export interface ExecutionResourceSelection extends Readonly<ExecutableProfile> {
  readonly selectionVersion: 1;
  readonly executionId: string;
  readonly selectedAt: string;
}

export function validateExecutionResourceSelection(selection: ExecutionResourceSelection): void {
  validateExecutableProfile(selection);
  failClosed(selection.selectionVersion === 1, 'EXECUTION_SELECTION_VERSION_UNSUPPORTED');
  nonEmpty(selection.executionId, 'EXECUTION_SELECTION_EXECUTION_REQUIRED');
  nonEmpty(selection.selectedAt, 'EXECUTION_SELECTION_TIME_REQUIRED', 100);
  failClosed(!Number.isNaN(Date.parse(selection.selectedAt)), 'EXECUTION_SELECTION_TIME_INVALID');
}

export function freezeExecutionResourceSelection(
  selection: ExecutionResourceSelection,
): ExecutionResourceSelection {
  validateExecutionResourceSelection(selection);
  return Object.freeze({ ...selection });
}

export function createExecutionResourceSelection(
  executionId: string,
  profile: ExecutableProfile,
  selectedAt = new Date().toISOString(),
): ExecutionResourceSelection {
  const selection = {
    ...profile,
    selectionVersion: 1 as const,
    executionId,
    selectedAt,
  };
  return freezeExecutionResourceSelection(selection);
}

export const NORMALIZED_FAILURE_CLASSES = [
  'AUTH_REJECTED',
  'QUOTA_EXHAUSTED',
  'RATE_LIMITED',
  'TEMPORARY_PROVIDER_FAILURE',
  'CONNECTION_UNAVAILABLE',
  'MODEL_UNAVAILABLE',
  'ROUTE_MISCONFIGURED',
  'PROMOTION_EXPIRED',
  'UNKNOWN_PROVIDER_FAILURE',
] as const;
export type NormalizedFailureClass = (typeof NORMALIZED_FAILURE_CLASSES)[number];

export interface ResourceFailureInput {
  readonly message?: string;
  readonly code?: string | number;
  readonly status?: number;
  readonly statusCode?: number;
  readonly resetAt?: string;
}

export interface NormalizedResourceFailure {
  readonly failureClass: NormalizedFailureClass;
  readonly scope: 'RESOURCE' | 'BINDING';
  readonly sanitizedReason: string;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly resetAt?: string;
}

function failureText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof Error) return input.name + ' ' + input.message;
  if (input !== null && typeof input === 'object') {
    const value = input as Record<string, unknown>;
    return [value.code, value.status, value.statusCode, value.message, value.error, value.detail]
      .filter((part) => typeof part === 'string' || typeof part === 'number')
      .join(' ');
  }
  return String(input ?? '');
}

function statusCode(input: unknown, text: string): number | undefined {
  if (input !== null && typeof input === 'object') {
    const value = input as Record<string, unknown>;
    const candidate = value.status ?? value.statusCode;
    if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate;
  }
  const match = text.match(/\b([1-5]\d\d)\b/);
  return match ? Number(match[1]) : undefined;
}

export function normalizeResourceFailure(input: unknown): NormalizedResourceFailure {
  const text = failureText(input);
  const lowered = text.toLowerCase();
  const status = statusCode(input, text);
  let failureClass: NormalizedFailureClass;
  if (
    /promotion(?:al)?\s+(?:has\s+)?expired|promo(?:tion)?\s+expired|trial\s+expired/.test(lowered)
  ) {
    failureClass = 'PROMOTION_EXPIRED';
  } else if (
    /monthly\s+(?:usage|spend)\s+limit|quota\s+(?:is\s+)?exhausted|quota\s+exceeded|insufficient\s+balance|credits?\s+exhausted|usage\s+limit\s+(?:reached|exceeded)|billing\s+limit/.test(
      lowered,
    )
  ) {
    failureClass = 'QUOTA_EXHAUSTED';
  } else if (
    status === 401 ||
    status === 403 ||
    /invalid\s+(?:api\s*)?key|authentication\s+(?:failed|rejected)|unauthori[sz]ed|access\s+denied|forbidden|credential(?:s)?\s+(?:expired|invalid|rejected)/.test(
      lowered,
    )
  ) {
    failureClass = 'AUTH_REJECTED';
  } else if (
    /model\s+(?:not\s+found|unavailable|unsupported)|unsupported\s+model|no\s+such\s+model|unknown\s+model/.test(
      lowered,
    ) ||
    (status === 404 && /model/.test(lowered))
  ) {
    failureClass = 'MODEL_UNAVAILABLE';
  } else if (
    /no\s+(?:active\s+)?deployments?|route\s+(?:not\s+found|misconfigured|unavailable)|deployment\s+(?:not\s+found|misconfigured)/.test(
      lowered,
    )
  ) {
    failureClass = 'ROUTE_MISCONFIGURED';
  } else if (status === 429 || /rate\s*limit|too\s+many\s+requests|throttl/.test(lowered)) {
    failureClass = 'RATE_LIMITED';
  } else if (
    /timeout|timed\s+out|etimedout|econnrefused|enotfound|connection\s+(?:reset|refused|unavailable)|network\s+unreachable|fetch\s+failed/.test(
      lowered,
    )
  ) {
    failureClass = 'CONNECTION_UNAVAILABLE';
  } else if (
    (status !== undefined && status >= 500) ||
    /service\s+unavailable|internal\s+server|bad\s+gateway|provider\s+failure|temporar(?:y|ily)/.test(
      lowered,
    )
  ) {
    failureClass = 'TEMPORARY_PROVIDER_FAILURE';
  } else {
    failureClass = 'UNKNOWN_PROVIDER_FAILURE';
  }
  const binding = failureClass === 'MODEL_UNAVAILABLE';
  const resetAt =
    input !== null &&
    typeof input === 'object' &&
    typeof (input as Record<string, unknown>).resetAt === 'string'
      ? ((input as Record<string, unknown>).resetAt as string)
      : undefined;
  if (resetAt !== undefined)
    failClosed(!Number.isNaN(Date.parse(resetAt)), 'RESOURCE_FAILURE_RESET_TIME_INVALID');
  const statusSuffix = status === undefined ? '' : ' (HTTP ' + status + ')';
  return Object.freeze({
    failureClass,
    scope: binding ? 'BINDING' : 'RESOURCE',
    sanitizedReason: failureClass + statusSuffix,
    retryable: ![
      'AUTH_REJECTED',
      'QUOTA_EXHAUSTED',
      'PROMOTION_EXPIRED',
      'MODEL_UNAVAILABLE',
      'ROUTE_MISCONFIGURED',
    ].includes(failureClass),
    ...(status === undefined ? {} : { statusCode: status }),
    ...(resetAt === undefined ? {} : { resetAt }),
  });
}

export interface ResourceStatePolicyInput {
  readonly state: ResourceState;
  readonly resourceTier: ResourceTier;
  readonly commercialType?: ResourceCommercialType;
  readonly supplyOrigin?: ResourceSupplyOrigin;
  readonly resourceLifecycle?: ResourceLifecycle;
  readonly suspendedUntil?: string;
  readonly probe?: boolean;
}

export interface ResourceStatePolicyResult {
  readonly state: ResourceState;
  readonly suspendedUntil?: string;
  readonly probeRequired: boolean;
  readonly bindingState?: 'ENABLED' | 'DISABLED';
  readonly reasonClass?: NormalizedFailureClass;
  readonly sanitizedReason?: string;
}

function isCommunityFree(input: ResourceStatePolicyInput): boolean {
  return (
    (input.resourceTier === 'FREE' ||
      input.commercialType === 'FREE' ||
      input.commercialType === 'SPONSORED') &&
    (input.supplyOrigin === undefined || input.supplyOrigin === 'COMMUNITY_RELAY')
  );
}

function isPaid(input: ResourceStatePolicyInput): boolean {
  return input.resourceTier === 'SUBSCRIPTION' || input.resourceTier === 'METERED';
}

function later(now: string, durationMs: number): string {
  const at = Date.parse(now);
  failClosed(!Number.isNaN(at), 'RESOURCE_STATE_TIME_INVALID');
  return new Date(at + durationMs).toISOString();
}

export function transitionResourceState(
  input: ResourceStatePolicyInput,
  failure: NormalizedResourceFailure,
  now: string,
): ResourceStatePolicyResult {
  oneOf(input.state, RESOURCE_STATES, 'RESOURCE_STATE_INVALID');
  oneOf(input.resourceTier, RESOURCE_TIERS, 'RESOURCE_TIER_INVALID');
  validateNormalizedResourceFailure(failure);
  failClosed(!Number.isNaN(Date.parse(now)), 'RESOURCE_STATE_TIME_INVALID');
  if (failure.scope === 'BINDING') {
    return Object.freeze({
      state: input.state,
      ...(input.suspendedUntil ? { suspendedUntil: input.suspendedUntil } : {}),
      probeRequired: false,
      bindingState: 'DISABLED',
      reasonClass: failure.failureClass,
      sanitizedReason: failure.sanitizedReason,
    });
  }
  if (
    failure.failureClass === 'AUTH_REJECTED' ||
    failure.failureClass === 'QUOTA_EXHAUSTED' ||
    failure.failureClass === 'PROMOTION_EXPIRED' ||
    failure.failureClass === 'ROUTE_MISCONFIGURED'
  ) {
    return Object.freeze({
      state: 'DISABLED',
      probeRequired: false,
      reasonClass: failure.failureClass,
      sanitizedReason: failure.sanitizedReason,
    });
  }
  if (input.state === 'SUSPENDED' && input.probe === true) {
    return Object.freeze({
      state: 'DISABLED',
      probeRequired: false,
      reasonClass: failure.failureClass,
      sanitizedReason: failure.sanitizedReason,
    });
  }
  const duration = isCommunityFree(input)
    ? COMMUNITY_SUSPENSION_MS
    : isPaid(input)
      ? PAID_TRANSIENT_COOLDOWN_MS
      : PAID_TRANSIENT_COOLDOWN_MS;
  return Object.freeze({
    state: 'SUSPENDED',
    suspendedUntil: later(now, duration),
    probeRequired: isCommunityFree(input),
    reasonClass: failure.failureClass,
    sanitizedReason: failure.sanitizedReason,
  });
}

export function transitionResourceStateOnSuccess(
  input: ResourceStatePolicyInput,
): ResourceStatePolicyResult {
  oneOf(input.state, RESOURCE_STATES, 'RESOURCE_STATE_INVALID');
  return Object.freeze({
    state: input.state === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
    probeRequired: false,
  });
}

export function validateNormalizedResourceFailure(failure: NormalizedResourceFailure): void {
  oneOf(failure.failureClass, NORMALIZED_FAILURE_CLASSES, 'RESOURCE_FAILURE_CLASS_INVALID');
  oneOf(failure.scope, ['RESOURCE', 'BINDING'] as const, 'RESOURCE_FAILURE_SCOPE_INVALID');
  nonEmpty(failure.sanitizedReason, 'RESOURCE_FAILURE_REASON_REQUIRED', 2_000);
  failClosed(typeof failure.retryable === 'boolean', 'RESOURCE_FAILURE_RETRYABLE_INVALID');
  if (failure.statusCode !== undefined)
    failClosed(
      Number.isInteger(failure.statusCode) &&
        failure.statusCode >= 100 &&
        failure.statusCode <= 599,
      'RESOURCE_FAILURE_STATUS_INVALID',
    );
  if (failure.resetAt !== undefined)
    failClosed(!Number.isNaN(Date.parse(failure.resetAt)), 'RESOURCE_FAILURE_RESET_TIME_INVALID');
}

export type ResourceStateOverrideSource = 'EXECUTION' | 'PROBE' | 'OPERATOR' | 'EXPIRY_TIMER';
export const RESOURCE_STATE_OVERRIDE_SOURCES = [
  'EXECUTION',
  'PROBE',
  'OPERATOR',
  'EXPIRY_TIMER',
] as const;

export interface ResourceStateOverride {
  readonly resourceId: string;
  readonly state: ResourceState;
  readonly reasonClass?: NormalizedFailureClass;
  readonly sanitizedReason?: string;
  readonly suspendedUntil?: string;
  readonly source: ResourceStateOverrideSource;
  readonly version: number;
  readonly updatedAt: string;
}

export function validateResourceStateOverride(override: ResourceStateOverride): void {
  nonEmpty(override.resourceId, 'RESOURCE_OVERRIDE_ID_REQUIRED');
  oneOf(override.state, RESOURCE_STATES, 'RESOURCE_OVERRIDE_STATE_INVALID');
  if (override.reasonClass !== undefined)
    oneOf(override.reasonClass, NORMALIZED_FAILURE_CLASSES, 'RESOURCE_OVERRIDE_REASON_INVALID');
  if (override.sanitizedReason !== undefined)
    nonEmpty(override.sanitizedReason, 'RESOURCE_OVERRIDE_REASON_REQUIRED', 2_000);
  if (override.suspendedUntil !== undefined)
    failClosed(
      !Number.isNaN(Date.parse(override.suspendedUntil)),
      'RESOURCE_OVERRIDE_SUSPENSION_TIME_INVALID',
    );
  oneOf(override.source, RESOURCE_STATE_OVERRIDE_SOURCES, 'RESOURCE_OVERRIDE_SOURCE_INVALID');
  failClosed(
    Number.isInteger(override.version) && override.version > 0,
    'RESOURCE_OVERRIDE_VERSION_INVALID',
  );
  nonEmpty(override.updatedAt, 'RESOURCE_OVERRIDE_TIME_REQUIRED', 100);
  failClosed(!Number.isNaN(Date.parse(override.updatedAt)), 'RESOURCE_OVERRIDE_TIME_INVALID');
  failClosed(
    override.state !== 'SUSPENDED' || override.suspendedUntil !== undefined,
    'RESOURCE_OVERRIDE_SUSPENSION_REQUIRED',
  );
}
