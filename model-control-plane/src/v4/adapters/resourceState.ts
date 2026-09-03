/**
 * The lifecycle policy is deliberately pure. This adapter-shaped module keeps
 * the future provider effects boundary explicit without owning any I/O yet.
 */
export {
  COMMUNITY_SUSPENSION_MS,
  PAID_TRANSIENT_COOLDOWN_MS,
  normalizeResourceFailure,
  transitionResourceState,
  transitionResourceStateOnSuccess,
  validateNormalizedResourceFailure,
} from '../domain/resourceRouting.js';
export type {
  NormalizedFailureClass,
  NormalizedResourceFailure,
  ResourceFailureInput,
  ResourceStatePolicyInput,
  ResourceStatePolicyResult,
} from '../domain/resourceRouting.js';
