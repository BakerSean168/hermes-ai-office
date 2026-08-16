export type GatewayProtocol =
  'openai-chat-completions' | 'openai-responses' | 'anthropic-messages' | 'unknown';

export type GatewayHealth = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface GatewayRouteRef {
  gatewayId: string;
  employmentId: string;
  externalRouteRef: string;
  protocol: GatewayProtocol;
}

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

export interface GatewayUsageEvidence {
  gatewayId: string;
  gatewayRequestId: string;
  externalRouteRef: string;
  externalDeploymentRef?: string;
  model?: string;
  provider?: string;
  startedAt: number;
  completedAt?: number;
  status: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  actualCost?: number;
  currency?: string;
  errorClass?: string;
  metadata?: Record<string, unknown>;
}

export interface GatewayUsagePage {
  evidence: GatewayUsageEvidence[];
  nextCursor?: string;
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
