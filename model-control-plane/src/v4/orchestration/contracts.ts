import type { DeliveryObservation, PlanDelivery } from '../domain/delivery.js';
import type { ExecutionPhase as DomainExecutionPhase } from '../domain/execution.js';
import type { Plan } from '../domain/plan.js';

export { EXECUTION_PHASES } from '../domain/execution.js';
export type ExecutionPhase = DomainExecutionPhase;

export const PROVIDER_SESSION_STATUSES = [
  'CREATED',
  'QUEUED',
  'RUNNING',
  'PAUSED',
  'WAITING_FOR_CONFIRMATION',
  'SUCCEEDED',
  'FAILED',
  'STUCK',
  'CANCELLED',
  'UNKNOWN',
] as const;
export type ProviderSessionStatus = (typeof PROVIDER_SESSION_STATUSES)[number];

export const EXECUTION_EVIDENCE_KINDS = [
  'WORKSPACE',
  'REVISION',
  'DIFF',
  'TEST',
  'PROVIDER_OUTPUT',
  'REVIEW',
  'RECOVERY',
] as const;
export type ExecutionEvidenceKind = (typeof EXECUTION_EVIDENCE_KINDS)[number];

export const REPOSITORY_COMPLETION_EVIDENCE_FILE = '.pixel-v4-completion-evidence.json';

export interface RepositoryObservation {
  repositoryPath: string;
  rootPath: string;
  headRevision: string;
  /** Exact independently-reviewed revision integrated or already contained in headRevision. */
  integratedRevision?: string;
  branch?: string;
  clean: boolean;
  commitExists: boolean;
  observedAt: string;
}

export interface WorkspaceDescriptor {
  executionId: string;
  hostPath: string;
  executionPath: string;
  evidenceHostPath: string;
  evidenceExecutionPath: string;
  sourceRepositoryPath: string;
  sourceRevision: string;
  createdAt: string;
}

export interface WorkspaceStorageStatus {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  minimumFreeBytes: number;
  lowCapacity: boolean;
}

export interface WorkspaceCachePruneResult {
  workspacesScanned: number;
  cacheDirectoriesPruned: number;
  freeBytesBefore: number;
  freeBytesAfter: number;
}

export interface TestCommandEvidence {
  command: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  exitCode?: number;
  summary?: string;
}

export interface ImplementationCompletionEvidence {
  version: 1;
  executionId: string;
  phase: 'IMPLEMENT' | 'IMPLEMENT_FIX';
  sourceRevision: string;
  resultRevision: string;
  outcome?: 'CHANGED' | 'SATISFIED';
  summary: string;
  tests: TestCommandEvidence[];
}

export interface ReviewCompletionEvidence {
  version: 1;
  executionId: string;
  phase: 'REVIEW';
  reviewedSha: string;
  verdict: 'PASS' | 'FAIL' | 'INVALID';
  findings: string[];
  checks: TestCommandEvidence[];
  summary: string;
}

export type CompletionEvidence = ImplementationCompletionEvidence | ReviewCompletionEvidence;

export interface ProviderSessionSnapshot {
  provider: string;
  providerSessionId: string;
  status: ProviderSessionStatus;
  finalResponse?: string;
  errorCode?: string;
  retryable?: boolean;
  /** Opaque hash/cursor that changes only when provider-side work advances. */
  progressFingerprint?: string;
  observedAt: string;
}

export interface ExecutionSession {
  executionId: string;
  phase: ExecutionPhase;
  provider: string;
  providerSessionId?: string;
  workspace: WorkspaceDescriptor;
  sourceRevision: string;
  providerStatus: ProviderSessionStatus;
  lastHeartbeatAt?: string;
  lastProviderObservedAt?: string;
  startedAt?: string;
  completedAt?: string;
  finalResponse?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionEvidence {
  evidenceId: string;
  executionId: string;
  kind: ExecutionEvidenceKind;
  name: string;
  sourceRevision?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ProviderLaunchInput {
  executionId: string;
  planId: string;
  projectKey: string;
  workItemId?: string;
  phase: ExecutionPhase;
  objective: string;
  acceptanceCriteria: string[];
  sourceRevision: string;
  baselineRevision?: string;
  route: string;
  workspace: WorkspaceDescriptor;
  reviewFindings?: string[];
}

export interface ProviderRuntimeProbeInput {
  probeId: string;
  workspace: WorkspaceDescriptor;
  sourceRevision: string;
}

export interface ProviderRuntimeProbeResult {
  provider: string;
  providerSessionId: string;
  status: ProviderSessionStatus;
  ready: boolean;
  errorCode?: string;
  observedAt: string;
}

export interface ProviderRecoveryInput {
  executionId: string;
  createdAt: string;
  projectKey?: string;
  phase?: ExecutionPhase;
  expectedWorkspacePath?: string;
}

export interface ProviderSessionReplacementInput extends ProviderLaunchInput {
  previousProviderSessionId: string;
  recoveryKey: string;
  instruction: string;
}

export interface WorkspaceCompletionSnapshot {
  workspace: WorkspaceDescriptor;
  clean: boolean;
  headRevision: string;
  sourceRevision: string;
  descendantOfSource: boolean;
  changedFiles: string[];
  diffStat: string;
  evidence: CompletionEvidence;
  observedAt: string;
}

export interface WorkspaceProvisionInput {
  executionId: string;
  planId?: string;
  projectKey?: string;
  workItemId?: string;
  repositoryPath: string;
  sourceRevision: string;
  phase?: ExecutionPhase;
  sourceWorkspace?: WorkspaceDescriptor;
}

export interface WorkspaceProviderPort {
  readonly integrationStrategy?: 'CANONICAL_FAST_FORWARD' | 'PLAN_WORKTREE';
  integrationStrategyFor?(
    planId: string,
    projectKey: string,
  ): 'CANONICAL_FAST_FORWARD' | 'PLAN_WORKTREE';
  assertPlanSafety?(planId: string): Promise<void>;
  deliveryWorkspace?(planId: string): Promise<string | undefined>;
  observeRepository(repositoryPath: string, revision: string): Promise<RepositoryObservation>;
  provision(input: WorkspaceProvisionInput): Promise<WorkspaceDescriptor>;
  /** Cheap signal used by the worker before attempting evidence-verified finalization. */
  hasCompletionEvidence?(workspace: WorkspaceDescriptor): boolean;
  /** Opaque repository-state hash; raw paths/content are never persisted by the worker. */
  progressFingerprint?(workspace: WorkspaceDescriptor): Promise<string>;
  storageStatus?(): WorkspaceStorageStatus;
  pruneTerminalCaches?(
    workspaces: readonly WorkspaceDescriptor[],
  ): Promise<WorkspaceCachePruneResult>;
  verifyImplementation(workspace: WorkspaceDescriptor): Promise<WorkspaceCompletionSnapshot>;
  verifyReview(
    workspace: WorkspaceDescriptor,
    reviewedSha: string,
  ): Promise<WorkspaceCompletionSnapshot>;
  integrateAcceptedRevision(input: {
    repositoryPath: string;
    expectedRevision: string;
    acceptedRevision: string;
    candidateWorkspace: WorkspaceDescriptor;
    planId?: string;
    workItemId?: string;
    integrationBaseRevision?: string;
  }): Promise<RepositoryObservation>;
}

export interface ExecutionProviderPort {
  readonly provider: string;
  probeRuntime?(input: ProviderRuntimeProbeInput): Promise<ProviderRuntimeProbeResult>;
  launch(input: ProviderLaunchInput): Promise<ProviderSessionSnapshot>;
  recover(input: ProviderRecoveryInput): Promise<ProviderSessionSnapshot | undefined>;
  inspect(providerSessionId: string): Promise<ProviderSessionSnapshot>;
  replace?(input: ProviderSessionReplacementInput): Promise<ProviderSessionSnapshot>;
  continue?(providerSessionId: string, instruction: string): Promise<ProviderSessionSnapshot>;
  interrupt?(providerSessionId: string): Promise<ProviderSessionSnapshot>;
  cancel?(providerSessionId: string): Promise<ProviderSessionSnapshot>;
}

export interface ReviewProviderPort extends ExecutionProviderPort {
  readonly independentReview: true;
}

export interface DeliveryAutomationPort {
  advance(
    plan: Plan,
    delivery: PlanDelivery,
    context?: { workspacePath?: string },
  ): Promise<DeliveryObservation>;
}
