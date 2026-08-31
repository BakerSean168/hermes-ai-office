import { failClosed } from './errors.js';

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
