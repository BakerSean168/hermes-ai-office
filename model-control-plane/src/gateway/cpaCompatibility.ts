import type {
  GatewayAggregateUsageEvidence,
  GatewayBindingSource,
  GatewayDiscoveryPort,
  GatewayDiscoverySnapshot,
  GatewayExecutionPort,
  GatewayHealth,
  GatewayProtocol,
  GatewayRouteEvidence,
  GatewayRouteRef,
  GatewayRouteResolution,
  GatewayUsagePage,
  GatewayUsagePort,
} from './ports.js';

interface CpaChannelStatus {
  name: string;
  protocol?: string;
  enabled: boolean;
  models: string[];
  logicalAliases?: string[];
  lastTest?: string;
  health?: string;
}

export interface CpaStatusSource {
  status(): Promise<CpaChannelStatus[]>;
}

export interface CpaAggregateUsageSource {
  snapshot(range?: string): Promise<unknown>;
}

interface JsonRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeProtocol(protocol: string | undefined): GatewayProtocol {
  if (protocol === 'codex-responses') return 'openai-responses';
  if (protocol === 'anthropic-messages') return 'anthropic-messages';
  if (protocol === 'openai-compatible') return 'openai-chat-completions';
  return 'unknown';
}

function normalizeHealth(channel: CpaChannelStatus | undefined): GatewayHealth {
  if (!channel || !channel.enabled) return 'unhealthy';
  if (channel.health === 'healthy' || channel.lastTest === 'pass') return 'healthy';
  if (channel.health === 'degraded' || channel.lastTest === 'fail') return 'degraded';
  if (channel.health === 'unavailable' || channel.health === 'disabled') return 'unhealthy';
  return 'unknown';
}

export function cpaRouteRef(channelName: string, modelId: string): string {
  return `cpa/channel/${encodeURIComponent(channelName)}/model/${encodeURIComponent(modelId)}`;
}

export function parseCpaRouteRef(
  routeRef: string,
): { channelName: string; modelId: string } | null {
  const match = /^cpa\/channel\/([^/]+)\/model\/([^/]+)$/.exec(routeRef);
  if (!match?.[1] || !match[2]) return null;
  return {
    channelName: decodeURIComponent(match[1]),
    modelId: decodeURIComponent(match[2]),
  };
}

function channelFromProvider(provider: string, channels: CpaChannelStatus[]): string | null {
  const exact = channels.find((channel) => provider.endsWith(channel.name));
  return exact?.name ?? null;
}

export class CpaCompatibilityGateway
  implements GatewayExecutionPort, GatewayDiscoveryPort, GatewayUsagePort
{
  readonly gatewayId: string;
  readonly #statusSource: CpaStatusSource;
  readonly #usageSource: CpaAggregateUsageSource;
  readonly #bindings: GatewayBindingSource;
  readonly #usageRange: string;

  constructor(options: {
    gatewayId?: string;
    statusSource: CpaStatusSource;
    usageSource: CpaAggregateUsageSource;
    bindings: GatewayBindingSource;
    usageRange?: string;
  }) {
    this.gatewayId = options.gatewayId ?? 'cpa-compat';
    this.#statusSource = options.statusSource;
    this.#usageSource = options.usageSource;
    this.#bindings = options.bindings;
    this.#usageRange = options.usageRange ?? '30d';
  }

  async resolveRoute(employmentId: string): Promise<GatewayRouteResolution> {
    const binding = await this.#bindings.findByEmploymentId(employmentId);
    const observedAt = Date.now();
    if (!binding || binding.gatewayId !== this.gatewayId) {
      return { route: null, routable: false, reasons: ['NO_GATEWAY_BINDING'], observedAt };
    }
    const route: GatewayRouteRef = { ...binding };
    const health = await this.getRouteHealth(route);
    const routable = health === 'healthy' || health === 'unknown';
    return {
      route: routable ? route : null,
      routable,
      reasons: routable ? ['CPA_ROUTE_AVAILABLE'] : ['CPA_ROUTE_UNAVAILABLE'],
      observedAt,
    };
  }

  async getRouteHealth(route: GatewayRouteRef): Promise<GatewayHealth> {
    const parsed = parseCpaRouteRef(route.externalRouteRef);
    if (!parsed) return 'unhealthy';
    const channels = await this.#statusSource.status();
    const channel = channels.find((item) => item.name === parsed.channelName);
    if (!channel?.models.includes(parsed.modelId)) return 'unhealthy';
    return normalizeHealth(channel);
  }

  async discover(): Promise<GatewayDiscoverySnapshot> {
    const observedAt = Date.now();
    const channels = await this.#statusSource.status();
    const routes: GatewayRouteEvidence[] = [];
    for (const channel of channels) {
      for (const modelId of channel.models.filter((model) => !model.startsWith('position:'))) {
        routes.push({
          externalRouteRef: cpaRouteRef(channel.name, modelId),
          protocol: normalizeProtocol(channel.protocol),
          health: normalizeHealth(channel),
          supplierModelHint: modelId,
          capabilities: [],
          deployments: [
            {
              externalDeploymentRef: channel.name,
              health: normalizeHealth(channel),
              metadata: { source: 'gatewayctl' },
            },
          ],
          metadata: {
            source: 'cpa-compat',
            channelName: channel.name,
            lastTest: channel.lastTest ?? null,
          },
        });
      }
    }
    return { gatewayId: this.gatewayId, observedAt, routes };
  }

  async pullUsage(cursor?: string): Promise<GatewayUsagePage> {
    const range = cursor || this.#usageRange;
    const raw = asRecord(await this.#usageSource.snapshot(range));
    const stats = asRecord(raw.stats);
    const costs = asRecord(raw.costs);
    const channels = await this.#statusSource.status();
    const costMap = new Map<string, number>();
    for (const rawCost of asArray(costs.models)) {
      const cost = asRecord(rawCost);
      const key = `${String(cost.provider ?? '')}\u0000${String(cost.model ?? '')}`;
      costMap.set(key, asNumber(cost.total_usd));
    }
    const generatedAt = Date.parse(String(stats.generated_at ?? '')) || Date.now();
    const evidence: GatewayAggregateUsageEvidence[] = [];
    for (const rawGroup of asArray(stats.groups)) {
      const group = asRecord(rawGroup);
      const provider = String(group.provider ?? 'unknown');
      const model = String(group.model ?? group.alias ?? 'unknown');
      const channelName = channelFromProvider(provider, channels) ?? provider;
      evidence.push({
        kind: 'aggregate',
        gatewayId: this.gatewayId,
        aggregateKey: `${range}:${provider}:${model}`,
        window: range,
        generatedAt,
        externalRouteRef: cpaRouteRef(channelName, model),
        model,
        provider,
        requests: asNumber(group.requests),
        failedRequests: asNumber(group.failed_requests),
        inputTokens: asNumber(group.input_tokens),
        outputTokens: asNumber(group.output_tokens),
        cacheReadTokens: asNumber(group.cached_tokens),
        cacheWriteTokens: 0,
        reasoningTokens: asNumber(group.reasoning_tokens),
        actualCost: costMap.get(`${provider}\u0000${model}`) ?? 0,
        currency: 'USD',
        metadata: {
          aggregate: true,
          source: 'cpa-cap-token-usage-tracker',
        },
      });
    }
    return { evidence };
  }
}
