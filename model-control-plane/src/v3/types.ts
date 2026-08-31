export const DEVELOPMENT_PHASES = [
  'ORCHESTRATE',
  'INVESTIGATE_PLAN',
  'ADOPT_CHANGE',
  'IMPLEMENT',
  'IMPLEMENT_FIX',
  'VERIFY_REVIEW',
  'BATCH_VERIFY',
  'FINALIZE',
] as const;

export type DevelopmentPhase = (typeof DEVELOPMENT_PHASES)[number];

export const TRANSPORT_MODES = ['LITELLM_MANAGED', 'PROVIDER_NATIVE', 'INTERNAL'] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];

export type SessionPolicy = 'fresh' | 'resume_preferred' | 'fresh_required';
export type WorkspaceMode =
  | 'read_oriented'
  | 'isolated_write'
  | 'reuse_implementation_workspace'
  | 'review_snapshot'
  | 'none';

export type ExecutionStatus =
  | 'STARTING'
  | 'RUNNING'
  | 'PAUSED'
  | 'WAITING_FOR_CONFIRMATION'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'STUCK'
  | 'CANCELLED'
  | 'UNKNOWN';

export type SourceHealthState = 'OK' | 'DEGRADED' | 'UNAVAILABLE' | 'UNCONFIGURED';

export interface RepositoryRef {
  path: string;
  baseRevision?: string;
}

export interface HermesExecutionContext {
  profile?: string;
  sessionId?: string;
  turnId?: string;
}

export interface ExecutionHints {
  complexity?: 'LOW' | 'MEDIUM' | 'HIGH';
  risk?: 'LOW' | 'MEDIUM' | 'HIGH';
  parallelism?: number;
  quality?: 'FAST' | 'STANDARD' | 'PREMIUM';
  budget?: 'LOW' | 'NORMAL' | 'HIGH';
}

export interface ExecutionOverride {
  backend?: string | null;
  modelClass?: string | null;
  transportMode?: TransportMode | null;
}

export interface StartDevelopmentExecutionInput {
  phase: DevelopmentPhase;
  objective: string;
  projectKey: string;
  repository: RepositoryRef;
  context?: {
    previousExecutionId?: string | null;
    previousResult?: string | null;
    acceptanceCriteria?: string[];
    reviewBaseRevision?: string | null;
    changeOrigin?: 'EXTERNAL' | null;
  };
  hints?: ExecutionHints;
  override?: ExecutionOverride;
  hermes?: HermesExecutionContext;
  await?: boolean;
  timeoutMs?: number;
  plan?: {
    planId: string;
    batchId: string;
    workItemId: string;
    attempt: number;
    commandKey: string;
  };
}

export interface ExecutionSelection {
  backend: string;
  modelClass: string;
  transportMode: TransportMode;
  workspaceMode: WorkspaceMode;
  sessionPolicy: SessionPolicy;
  reasons: string[];
}

export interface UsageSummary {
  source:
    | 'LITELLM_REPORTED'
    | 'LANGFUSE_REPORTED'
    | 'ACP_REPORTED'
    | 'OPENHANDS_REPORTED'
    | 'ANTIGRAVITY_REPORTED'
    | 'ESTIMATED'
    | 'UNKNOWN';
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: number;
  reasoningOutput?: number;
  costUsd?: number;
  calls?: number;
}

export interface RouteUsageSummary {
  model?: string;
  provider?: string;
  providerKey?: string;
  deploymentId?: string;
  apiBase?: string;
  input: number;
  output: number;
  cachedInput?: number;
  reasoningOutput?: number;
  costUsd: number;
  calls: number;
}

export interface ExecutionTiming {
  startedAt?: string;
  lastObservedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

export interface ExecutionRefs {
  openhandsConversationId?: string;
  langfuseTraceId?: string;
  upstream?: Record<string, unknown>;
}

export interface ExecutionResult {
  finalText: string;
  workspaceRef?: string;
  git?: {
    branch?: string | null;
    changedFiles?: string[];
  };
}

export interface ExecutionFailure {
  code: string;
  detail?: string;
  retryable: boolean;
}

export interface DevelopmentExecutionSnapshot {
  executionId: string;
  projectKey: string;
  phase: DevelopmentPhase;
  objectiveSummary: string;
  status: ExecutionStatus;
  selection: ExecutionSelection;
  result?: ExecutionResult | null;
  error?: ExecutionFailure | null;
  timing: ExecutionTiming;
  usage?: UsageSummary | null;
  refs: ExecutionRefs;
  sourceHealth: {
    openhands: SourceHealthState;
    litellm: SourceHealthState;
    observability: SourceHealthState;
    langfuse: SourceHealthState;
  };
}

export interface ExecutionLinkRecord {
  executionId: string;
  idempotencyKey: string;
  projectKey: string;
  phase: DevelopmentPhase;
  objectiveSummary: string;
  hermesProfile?: string;
  hermesSessionId?: string;
  hermesTurnId?: string;
  backend: string;
  transportMode: TransportMode;
  logicalModelClass: string;
  workspaceMode: WorkspaceMode;
  sessionPolicy: SessionPolicy;
  openhandsConversationId?: string;
  langfuseTraceId?: string;
  workspaceRef?: string;
  repositoryRoot?: string;
  gitBranch?: string;
  sourceRevision?: string;
  resultRevision?: string;
  writerStartRevision?: string;
  workspaceProvisionToken?: string;
  workspaceProvisionClaimedAt?: number;
  hostLaunchToken?: string;
  hostLaunchClaimedAt?: number;
  previousExecutionId?: string;
  planId?: string;
  batchId?: string;
  workItemId?: string;
  attempt?: number;
  commandKey?: string;
  resultText?: string;
  errorCode?: string;
  errorDetail?: string;
  errorRetryable?: boolean;
  observedUsage?: UsageSummary;
  observedRoutes?: RouteUsageSummary[];
  selectionReasons: string[];
  statusCache: ExecutionStatus;
  createdAt: number;
  updatedAt: number;
  hostUpdatedAt?: number;
  startedAt?: number;
  endedAt?: number;
}
