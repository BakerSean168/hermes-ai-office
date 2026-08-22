import type {
  DevelopmentExecutionSnapshot,
  DevelopmentPhase,
  ExecutionSelection,
  ExecutionStatus,
  SourceHealthState,
  UsageSummary,
} from './types.js';

export interface ExecutionHostCreateInput {
  executionId: string;
  projectKey: string;
  phase: DevelopmentPhase;
  objective: string;
  repositoryPath: string;
  selection: ExecutionSelection;
  correlationMetadata: Record<string, string>;
}

export interface ExecutionHostSnapshot {
  conversationId: string;
  status: ExecutionStatus;
  finalText?: string;
  startedAt?: string;
  updatedAt?: string;
  usage?: UsageSummary | null;
  currentModelId?: string | null;
  upstream?: Record<string, unknown>;
}

export interface ExecutionHostPort {
  health(): Promise<SourceHealthState>;
  createExecution(input: ExecutionHostCreateInput): Promise<ExecutionHostSnapshot>;
  getExecution(conversationId: string): Promise<ExecutionHostSnapshot>;
  cancelExecution(conversationId: string): Promise<ExecutionHostSnapshot>;
  continueExecution?(conversationId: string, message: string): Promise<ExecutionHostSnapshot>;
}

export interface ModelGatewaySummary {
  health: SourceHealthState;
  logicalModels: string[];
  upstream?: Record<string, unknown>;
}

export interface ModelGatewayPort {
  summary(): Promise<ModelGatewaySummary>;
}

export interface ObservabilityExecutionSummary {
  health: SourceHealthState;
  traceId?: string;
  traceUrl?: string;
  usage?: UsageSummary | null;
  lastObservedRoute?: {
    model?: string;
    provider?: string;
    deploymentId?: string;
  };
}

export interface ObservabilityPort {
  readonly source: 'LITELLM' | 'LANGFUSE' | 'UNCONFIGURED';
  health(): Promise<SourceHealthState>;
  getExecutionSummary(executionId: string): Promise<ObservabilityExecutionSummary>;
}

export interface DevelopmentExecutionServicePort {
  start(
    input: import('./types.js').StartDevelopmentExecutionInput,
    idempotencyKey: string,
  ): Promise<DevelopmentExecutionSnapshot>;
  get(executionId: string): Promise<DevelopmentExecutionSnapshot | null>;
  cancel(executionId: string): Promise<DevelopmentExecutionSnapshot | null>;
  continue(executionId: string, message: string): Promise<DevelopmentExecutionSnapshot | null>;
}
