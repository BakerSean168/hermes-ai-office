export type GatewayProtocol =
  'openai-chat-completions' | 'openai-responses' | 'anthropic-messages' | 'unknown';

export type GatewayHealth = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface GatewayBinding {
  gatewayId: string;
  employmentId: string;
  externalRouteRef: string;
  protocol: GatewayProtocol;
}

export interface GatewayBindingSource {
  findByEmploymentId(employmentId: string): Promise<GatewayBinding | null>;
}

export interface GatewayRouteRef extends GatewayBinding {}

export interface GatewayRouteResolution {
  route: GatewayRouteRef | null;
  routable: boolean;
  reasons: string[];
  observedAt: number;
}

export interface GatewayRouteEvidence {
  externalRouteRef: string;
  protocol: GatewayProtocol;
  health: GatewayHealth;
  supplierHint?: string;
  supplierModelHint?: string;
  agreementHint?: string;
  capabilities: string[];
  deployments: Array<{
    externalDeploymentRef: string;
    health: GatewayHealth;
    metadata?: Record<string, unknown>;
  }>;
  metadata?: Record<string, unknown>;
}

export interface GatewayDiscoverySnapshot {
  gatewayId: string;
  observedAt: number;
  routes: GatewayRouteEvidence[];
  cursor?: string;
}

interface GatewayUsageEvidenceBase {
  gatewayId: string;
  externalRouteRef: string;
  model?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  actualCost?: number;
  currency?: string;
  metadata?: Record<string, unknown>;
}

export interface GatewayRequestUsageEvidence extends GatewayUsageEvidenceBase {
  kind: 'request';
  gatewayRequestId: string;
  externalDeploymentRef?: string;
  startedAt: number;
  completedAt?: number;
  status: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  errorClass?: string;
}

export interface GatewayAggregateUsageEvidence extends GatewayUsageEvidenceBase {
  kind: 'aggregate';
  aggregateKey: string;
  window: string;
  generatedAt: number;
  requests: number;
  failedRequests: number;
}

export type GatewayUsageEvidence = GatewayRequestUsageEvidence | GatewayAggregateUsageEvidence;

export interface GatewayUsagePage {
  evidence: GatewayUsageEvidence[];
  nextCursor?: string;
}

export interface GatewayInvocationRequest {
  route: GatewayRouteRef;
  input: string;
  maxOutputTokens?: number;
  metadata?: Record<string, unknown>;
}

export interface GatewayInvocationResult {
  gatewayRequestId: string;
  externalDeploymentRef?: string;
  outputText: string;
  responseModel?: string;
  status: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  actualCost?: number;
  currency?: string;
  latencyMs: number;
  metadata?: Record<string, unknown>;
}

export interface GatewayInvocationPort {
  readonly gatewayId: string;
  invoke(request: GatewayInvocationRequest, signal?: AbortSignal): Promise<GatewayInvocationResult>;
}

export function supportsGatewayInvocation(
  gateway: GatewayExecutionPort,
): gateway is GatewayExecutionPort & GatewayInvocationPort {
  return (
    'invoke' in gateway && typeof (gateway as Partial<GatewayInvocationPort>).invoke === 'function'
  );
}

export interface GatewayExecutionPort {
  readonly gatewayId: string;
  resolveRoute(employmentId: string): Promise<GatewayRouteResolution>;
  getRouteHealth(route: GatewayRouteRef): Promise<GatewayHealth>;
}

export interface GatewayDiscoveryPort {
  readonly gatewayId: string;
  discover(cursor?: string): Promise<GatewayDiscoverySnapshot>;
}

export interface GatewayUsagePort {
  readonly gatewayId: string;
  pullUsage(cursor?: string): Promise<GatewayUsagePage>;
}

export type GatewayPort = GatewayExecutionPort &
  Partial<GatewayDiscoveryPort> &
  Partial<GatewayUsagePort>;
