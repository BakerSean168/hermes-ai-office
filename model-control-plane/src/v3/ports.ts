import type {
  DevelopmentExecutionSnapshot,
  DevelopmentPhase,
  ExecutionSelection,
  ExecutionStatus,
  RouteUsageSummary,
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

export interface ModelRegistryCredentialSummary {
  name: string;
  provider?: string;
}

export interface ModelRegistryDeploymentSummary {
  id: string;
  group: string;
  model?: string;
  credential?: string;
  order?: number;
  blocked: boolean;
  providerKey?: string;
  commercialType?: string;
  protocol?: string;
  supplyOrigin?: string;
}

export interface ModelRegistrySummary {
  authority: 'LITELLM';
  health: SourceHealthState;
  adminUrl?: string;
  credentials: { count: number; items: ModelRegistryCredentialSummary[] };
  deployments: {
    count: number;
    active: number;
    paused: number;
    groups: Record<string, number>;
    items: ModelRegistryDeploymentSummary[];
  };
  aliases: Record<string, string>;
  upstream?: Record<string, unknown>;
}

export interface ModelRegistryPort {
  summary(): Promise<ModelRegistrySummary>;
  providerRoutingIndex?(): Promise<{
    byDeploymentId: Record<string, string>;
    byApiBase: Record<string, string>;
  }>;
}

export interface ObservabilityExecutionSummary {
  health: SourceHealthState;
  traceId?: string;
  traceUrl?: string;
  usage?: UsageSummary | null;
  lastObservedRoute?: {
    model?: string;
    provider?: string;
    providerKey?: string;
    deploymentId?: string;
    apiBase?: string;
  };
  routeUsage?: RouteUsageSummary[];
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
