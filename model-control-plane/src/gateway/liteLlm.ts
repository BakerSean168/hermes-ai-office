import type {
  GatewayBindingSource,
  GatewayDiscoveryPort,
  GatewayDiscoverySnapshot,
  GatewayExecutionPort,
  GatewayHealth,
  GatewayProtocol,
  GatewayRouteEvidence,
  GatewayRouteRef,
  GatewayRouteResolution,
} from './ports.js';

interface JsonRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export interface GatewaySecretProvider {
  readBearerToken(): Promise<string>;
}

export class StaticBearerTokenProvider implements GatewaySecretProvider {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  async readBearerToken(): Promise<string> {
    return this.#token;
  }
}

export class LiteLlmGateway implements GatewayExecutionPort, GatewayDiscoveryPort {
  readonly gatewayId: string;
  readonly #baseUrl: string;
  readonly #secrets: GatewaySecretProvider;
  readonly #bindings: GatewayBindingSource;
  readonly #routeProtocols: Readonly<Record<string, GatewayProtocol>>;

  constructor(options: {
    gatewayId?: string;
    baseUrl: string;
    secrets: GatewaySecretProvider;
    bindings: GatewayBindingSource;
    routeProtocols?: Record<string, GatewayProtocol>;
  }) {
    this.gatewayId = options.gatewayId ?? 'litellm-reference';
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#secrets = options.secrets;
    this.#bindings = options.bindings;
    this.#routeProtocols = options.routeProtocols ?? {};
  }

  async #requestJson(path: string): Promise<unknown> {
    const token = await this.#secrets.readBearerToken();
    if (!token) throw new Error('empty LiteLLM bearer token');
    const response = await fetch(`${this.#baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`LiteLLM returned HTTP ${response.status}`);
    return response.json();
  }

  async #modelIds(): Promise<Set<string>> {
    const payload = asRecord(await this.#requestJson('/v1/models'));
    const rows = Array.isArray(payload.data) ? payload.data : [];
    return new Set(rows.map((row) => String(asRecord(row).id ?? '')).filter(Boolean));
  }

  async resolveRoute(employmentId: string): Promise<GatewayRouteResolution> {
    const binding = await this.#bindings.findByEmploymentId(employmentId);
    const observedAt = Date.now();
    if (!binding || binding.gatewayId !== this.gatewayId) {
      return { route: null, routable: false, reasons: ['NO_GATEWAY_BINDING'], observedAt };
    }
    const route: GatewayRouteRef = { ...binding };
    const health = await this.getRouteHealth(route);
    const routable = health === 'healthy';
    return {
      route: routable ? route : null,
      routable,
      reasons: routable ? ['LITELLM_ROUTE_AVAILABLE'] : ['LITELLM_ROUTE_UNAVAILABLE'],
      observedAt,
    };
  }

  async getRouteHealth(route: GatewayRouteRef): Promise<GatewayHealth> {
    try {
      await this.#requestJson('/health/liveliness');
      const ids = await this.#modelIds();
      return ids.has(route.externalRouteRef) ? 'healthy' : 'unhealthy';
    } catch {
      return 'unhealthy';
    }
  }

  async discover(): Promise<GatewayDiscoverySnapshot> {
    const observedAt = Date.now();
    const ids = await this.#modelIds();
    const routes: GatewayRouteEvidence[] = [...ids].sort().map((externalRouteRef) => ({
      externalRouteRef,
      protocol: this.#routeProtocols[externalRouteRef] ?? 'unknown',
      health: 'healthy',
      capabilities: [],
      deployments: [],
      metadata: { source: 'litellm-model-list' },
    }));
    return { gatewayId: this.gatewayId, observedAt, routes };
  }

  invocationEndpoint(): string {
    return this.#baseUrl;
  }
}
