export const PLAN_LIMITS = {
  transportAttemptsPerParent: 2,
  retryableTransportAttemptsPerParent: 4,
  reviewRouteAttemptsPerParent: 6,
  reviewFixAttempts: 3,
  batchIntegrationRepairAttempts: 3,
  deliveryRepairAttempts: 3,
  errorDetailCharacters: 2_000,
  repairEvidenceCharacters: 12_000,
  listResults: 100,
  pullRequestResults: 100,
  pullRequestTitleCharacters: 240,
} as const;

export const PLAN_RECONCILE_INTERVAL_MS = 5_000;
export const DELIVERY_COMMAND_TIMEOUT_MS = 180_000;
export const DELIVERY_COMMAND_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
export const WORKSPACE_GIT_TIMEOUT_MS = 120_000;
export const WORKSPACE_LONG_COMMAND_TIMEOUT_MS = 180_000;
export const WORKSPACE_PERMISSION_TIMEOUT_MS = 60_000;
export const WORKSPACE_GIT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
export const WORKSPACE_GIT_LARGE_BUFFER_BYTES = 16 * 1024 * 1024;
