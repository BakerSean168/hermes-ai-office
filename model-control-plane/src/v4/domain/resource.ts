import { failClosed } from './errors.js';

export {
  COMMUNITY_SUSPENSION_MS,
  DEFAULT_AFFINITY_POLICY,
  DEFAULT_MODEL_AFFINITY_POLICY,
  EXECUTION_CAPABILITIES,
  EXECUTION_PHASES,
  NORMALIZED_FAILURE_CLASSES,
  PAID_TRANSIENT_COOLDOWN_MS,
  RESOURCE_COMMERCIAL_TYPES,
  RESOURCE_LIFECYCLES,
  RESOURCE_SELECTION_REASONS,
  RESOURCE_STATES,
  RESOURCE_SUPPLY_ORIGINS,
  RESOURCE_TIERS,
  RESOURCE_TIER_RANKS,
  RESOURCE_TRANSPORTS,
  ROUTING_EXECUTION_PHASES,
  affinitiesForCapability,
  capabilityForPhase,
  createExecutionResourceSelection,
  deriveResourceTier,
  freezeExecutionResourceSelection,
  normalizeResourceFailure,
  resourceTierRank,
  transitionResourceState,
  transitionResourceStateOnSuccess,
  validateAffinityPolicy,
  validateExecutionCapability,
  validateExecutableProfile,
  validateExecutionResource,
  validateExecutionResourceBinding,
  validateExecutionResourceSelection,
  validateModelAffinity,
  validateNormalizedResourceFailure,
  validateResourceState,
  validateResourceStateOverride,
  validateResourceTier,
  validateResourceTransport,
} from './resourceRouting.js';
export type {
  AffinityPolicy,
  ExecutableProfile,
  ExecutionCapability,
  ExecutionResource,
  ExecutionResourceBinding,
  ExecutionResourceSelection,
  ModelAffinity,
  NormalizedFailureClass,
  NormalizedResourceFailure,
  ResourceCommercialType,
  ResourceFailureInput,
  ResourceLifecycle,
  ResourceSelectionReason,
  ResourceState,
  ResourceStateOverride,
  ResourceStateOverrideSource,
  ResourceStatePolicyInput,
  ResourceStatePolicyResult,
  ResourceSupplyOrigin,
  ResourceTier,
  ResourceTransport,
  RoutingExecutionPhase,
} from './resourceRouting.js';

export type ResourceStatus = 'AVAILABLE' | 'DEGRADED' | 'EXHAUSTED' | 'UNAVAILABLE' | 'UNCONFIGURED';

export interface Lease {
  aggregateType: 'SUPERVISOR' | 'EXECUTION' | 'ACTION' | 'RESOURCE';
  aggregateId: string;
  ownerId: string;
  leaseToken: string;
  claimedAt: number;
  expiresAt: number;
}

export interface ResourceObservation {
  resourceId: string;
  kind: 'PROVIDER' | 'MODEL_ROUTE' | 'WORKSPACE' | 'NATIVE_MACHINE' | 'GITHUB';
  status: ResourceStatus;
  capabilities: string[];
  quotaRemaining?: number;
  observedAt: string;
  evidenceRef?: string;
}

export function validateResourceObservation(observation: ResourceObservation): void {
  failClosed(observation.resourceId.length > 0, 'RESOURCE_ID_REQUIRED');
  failClosed(observation.kind.length > 0, 'RESOURCE_KIND_REQUIRED');
  failClosed(observation.capabilities.every((capability) => capability.length > 0), 'RESOURCE_CAPABILITY_INVALID');
}
