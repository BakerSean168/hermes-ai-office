import type {
  ModelGatewayPort,
  ModelGatewaySummary,
  ModelRegistryPort,
  ModelRegistrySummary,
  ObservabilityExecutionSummary,
  ObservabilityPort,
} from '../ports.js';
import { EnvFileValueProvider } from './openHands.js';

interface JsonRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function normalizeApiBase(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\/+$/, '');
}

export class LiteLlmModelGateway implements ModelGatewayPort {
  readonly #baseUrl: string;
  readonly #secrets: EnvFileValueProvider;
  readonly #keyName: string;

  constructor(options: { baseUrl: string; secrets: EnvFileValueProvider; keyName?: string }) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#secrets = options.secrets;
    this.#keyName = options.keyName ?? 'LITELLM_V3_KEY';
  }

  async #json(path: string): Promise<JsonRecord> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.#secrets.read(this.#keyName)}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`LITELLM_V3_HTTP_${response.status}`);
    return asRecord(await response.json());
  }

  async summary(): Promise<ModelGatewaySummary> {
    try {
      const [health, models] = await Promise.all([
        this.#json('/health/liveliness'),
        this.#json('/v1/models'),
      ]);
      const rows = Array.isArray(models.data) ? models.data.map(asRecord) : [];
      return {
        health: 'OK',
        logicalModels: rows
          .map((item) => String(item.id ?? ''))
          .filter(Boolean)
          .sort(),
        upstream: { health },
      };
    } catch (error) {
      return {
        health: 'UNAVAILABLE',
        logicalModels: [],
        upstream: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }
}

export class LiteLlmModelRegistry implements ModelRegistryPort {
  readonly #baseUrl: string;
  readonly #secrets: EnvFileValueProvider;
  readonly #keyName: string;
  readonly #adminUrl?: string;
  #providerRoutingIndexCache: {
    at: number;
    value: { byDeploymentId: Record<string, string>; byApiBase: Record<string, string> };
  } | null = null;

  constructor(options: {
    baseUrl: string;
    secrets: EnvFileValueProvider;
    keyName?: string;
    adminUrl?: string;
  }) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#secrets = options.secrets;
    this.#keyName = options.keyName ?? 'LITELLM_MASTER_KEY';
    this.#adminUrl = options.adminUrl?.trim() || undefined;
  }

  async #json(path: string): Promise<JsonRecord> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.#secrets.read(this.#keyName)}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`LITELLM_REGISTRY_HTTP_${response.status}`);
    return asRecord(await response.json());
  }

  async providerRoutingIndex(): Promise<{
    byDeploymentId: Record<string, string>;
    byApiBase: Record<string, string>;
  }> {
    const cached = this.#providerRoutingIndexCache;
    if (cached && Date.now() - cached.at < 30_000) return cached.value;

    const [credentialsPayload, modelsPayload] = await Promise.all([
      this.#json('/credentials'),
      this.#json('/model/info'),
    ]);
    const credentialRows = Array.isArray(credentialsPayload.credentials)
      ? credentialsPayload.credentials.map(asRecord)
      : [];
    const apiBaseByCredential = new Map<string, string>();
    for (const row of credentialRows) {
      const name = String(row.credential_name ?? '').trim();
      const values = asRecord(row.credential_values);
      const apiBase = normalizeApiBase(values.api_base);
      if (name && apiBase) apiBaseByCredential.set(name, apiBase);
    }

    const byDeploymentId: Record<string, string> = {};
    const providerKeysByApiBase = new Map<string, Set<string>>();
    const modelRows = Array.isArray(modelsPayload.data) ? modelsPayload.data.map(asRecord) : [];
    for (const row of modelRows) {
      const info = asRecord(row.model_info);
      if (info.db_model !== true) continue;
      const params = asRecord(row.litellm_params);
      const metadata = asRecord(info.metadata);
      const deploymentId = String(info.id ?? '').trim();
      const credentialName = String(params.litellm_credential_name ?? '').trim();
      const providerKey = String(metadata.legacy_provider_key ?? '').trim() || credentialName;
      if (!providerKey) continue;
      if (deploymentId) byDeploymentId[deploymentId] = providerKey;
      const apiBase = credentialName ? apiBaseByCredential.get(credentialName) : undefined;
      if (!apiBase) continue;
      const keys = providerKeysByApiBase.get(apiBase) ?? new Set<string>();
      keys.add(providerKey);
      providerKeysByApiBase.set(apiBase, keys);
    }

    const byApiBase: Record<string, string> = {};
    for (const [apiBase, providerKeys] of providerKeysByApiBase) {
      if (providerKeys.size === 1) byApiBase[apiBase] = [...providerKeys][0]!;
    }
    const value = { byDeploymentId, byApiBase };
    this.#providerRoutingIndexCache = { at: Date.now(), value };
    return value;
  }

  async summary(): Promise<ModelRegistrySummary> {
    try {
      const [credentialsPayload, modelsPayload, routerPayload] = await Promise.all([
        this.#json('/credentials'),
        this.#json('/model/info'),
        this.#json('/router/settings'),
      ]);
      const credentialRows = Array.isArray(credentialsPayload.credentials)
        ? credentialsPayload.credentials.map(asRecord)
        : [];
      const routerValues = asRecord(routerPayload.current_values);
      const aliasPayload = asRecord(routerValues.model_group_alias);
      const aliases = Object.fromEntries(
        Object.entries(aliasPayload)
          .map(([alias, target]) => [alias, String(target ?? '')] as const)
          .filter(([, target]) => Boolean(target))
          .sort(([left], [right]) => left.localeCompare(right)),
      );
      const aliasNames = new Set(Object.keys(aliases));
      const modelRows = Array.isArray(modelsPayload.data) ? modelsPayload.data.map(asRecord) : [];

      // /model/info projects one DB deployment through every matching model-group alias.
      // Dedupe by immutable model id and prefer the canonical non-alias group.
      const unique = new Map<string, JsonRecord>();
      for (const row of modelRows) {
        const info = asRecord(row.model_info);
        const id = String(info.id ?? '').trim();
        if (!id || info.db_model !== true) continue;
        const existing = unique.get(id);
        if (!existing) {
          unique.set(id, row);
          continue;
        }
        const existingName = String(existing.model_name ?? '');
        const candidateName = String(row.model_name ?? '');
        if (aliasNames.has(existingName) && !aliasNames.has(candidateName)) unique.set(id, row);
      }

      const deployments = [...unique.values()]
        .map((row) => {
          const info = asRecord(row.model_info);
          const params = asRecord(row.litellm_params);
          const metadata = asRecord(info.metadata);
          const order = Number(params.order);
          const credentialName = String(params.litellm_credential_name ?? '').trim();
          const providerKey = String(metadata.legacy_provider_key ?? '').trim() || credentialName;
          return {
            id: String(info.id ?? ''),
            group: String(row.model_name ?? ''),
            ...(params.model ? { model: String(params.model) } : {}),
            ...(credentialName ? { credential: credentialName } : {}),
            ...(Number.isFinite(order) ? { order } : {}),
            blocked: info.blocked === true,
            ...(providerKey ? { providerKey } : {}),
            ...(metadata.commercial_type
              ? { commercialType: String(metadata.commercial_type) }
              : {}),
            ...(metadata.protocol ? { protocol: String(metadata.protocol) } : {}),
            ...(metadata.supply_origin ? { supplyOrigin: String(metadata.supply_origin) } : {}),
            ...(metadata.resource_lifecycle
              ? { resourceLifecycle: String(metadata.resource_lifecycle) }
              : {}),
            ...(metadata.expires_at ? { expiresAt: String(metadata.expires_at) } : {}),
            ...(Number.isFinite(Number(metadata.quota_amount))
              ? { quotaAmount: Number(metadata.quota_amount) }
              : {}),
            ...(metadata.quota_unit ? { quotaUnit: String(metadata.quota_unit) } : {}),
          };
        })
        .sort(
          (left, right) =>
            left.group.localeCompare(right.group) ||
            (left.order ?? 999) - (right.order ?? 999) ||
            left.id.localeCompare(right.id),
        );
      const groups: Record<string, number> = {};
      for (const deployment of deployments)
        groups[deployment.group] = (groups[deployment.group] ?? 0) + 1;
      const active = deployments.filter((item) => !item.blocked).length;
      const credentials = credentialRows
        .map((row) => {
          const info = asRecord(row.credential_info);
          return {
            name: String(row.credential_name ?? ''),
            ...(info.custom_llm_provider ? { provider: String(info.custom_llm_provider) } : {}),
          };
        })
        .filter((item) => Boolean(item.name))
        .sort((left, right) => left.name.localeCompare(right.name));

      return {
        authority: 'LITELLM',
        health: 'OK',
        ...(this.#adminUrl ? { adminUrl: this.#adminUrl } : {}),
        credentials: { count: credentials.length, items: credentials },
        deployments: {
          count: deployments.length,
          active,
          paused: deployments.length - active,
          groups,
          items: deployments,
        },
        aliases,
      };
    } catch (error) {
      return {
        authority: 'LITELLM',
        health: 'UNAVAILABLE',
        ...(this.#adminUrl ? { adminUrl: this.#adminUrl } : {}),
        credentials: { count: 0, items: [] },
        deployments: { count: 0, active: 0, paused: 0, groups: {}, items: [] },
        aliases: {},
        upstream: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }
}

function finiteNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function utcDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function nestedRecord(parent: JsonRecord, key: string): JsonRecord {
  return asRecord(parent[key]);
}

export class LiteLlmSpendObservability implements ObservabilityPort {
  readonly source = 'LITELLM' as const;
  readonly #baseUrl: string;
  readonly #secrets: EnvFileValueProvider;
  readonly #keyName: string;
  readonly #lookbackDays: number;
  readonly #requestTimeoutMs: number;
  readonly #healthTtlMs: number;
  readonly #modelRegistry?: ModelRegistryPort;
  readonly #providerLookupTtlMs: number;
  #healthCache: { status: 'OK' | 'UNAVAILABLE'; at: number } | null = null;
  #providerLookupCache: {
    at: number;
    byDeploymentId: Map<string, string>;
    byApiBase: Map<string, string>;
  } | null = null;

  constructor(options: {
    baseUrl: string;
    secrets: EnvFileValueProvider;
    keyName?: string;
    lookbackDays?: number;
    requestTimeoutMs?: number;
    healthTtlMs?: number;
    modelRegistry?: ModelRegistryPort;
    providerLookupTtlMs?: number;
  }) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#secrets = options.secrets;
    this.#keyName = options.keyName ?? 'LITELLM_MASTER_KEY';
    this.#lookbackDays = Math.min(365, Math.max(1, options.lookbackDays ?? 30));
    this.#requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? 10_000);
    this.#healthTtlMs = Math.max(1_000, options.healthTtlMs ?? 30_000);
    this.#modelRegistry = options.modelRegistry;
    this.#providerLookupTtlMs = Math.max(1_000, options.providerLookupTtlMs ?? 30_000);
  }

  async #providerLookup(): Promise<{
    byDeploymentId: Map<string, string>;
    byApiBase: Map<string, string>;
  }> {
    const cached = this.#providerLookupCache;
    if (cached && Date.now() - cached.at < this.#providerLookupTtlMs) {
      return { byDeploymentId: cached.byDeploymentId, byApiBase: cached.byApiBase };
    }
    const byDeploymentId = new Map<string, string>();
    const byApiBase = new Map<string, string>();
    if (this.#modelRegistry) {
      try {
        if (this.#modelRegistry.providerRoutingIndex) {
          const index = await this.#modelRegistry.providerRoutingIndex();
          for (const [deploymentId, providerKey] of Object.entries(index.byDeploymentId)) {
            if (deploymentId && providerKey) byDeploymentId.set(deploymentId, providerKey);
          }
          for (const [apiBase, providerKey] of Object.entries(index.byApiBase)) {
            const normalized = normalizeApiBase(apiBase);
            if (normalized && providerKey) byApiBase.set(normalized, providerKey);
          }
        } else {
          const registry = await this.#modelRegistry.summary();
          if (registry.health === 'OK') {
            for (const deployment of registry.deployments.items) {
              const providerKey = deployment.providerKey?.trim();
              if (providerKey) byDeploymentId.set(deployment.id, providerKey);
            }
          }
        }
      } catch {
        // Spend/usage remains available even if registry metadata is temporarily unavailable.
      }
    }
    this.#providerLookupCache = { at: Date.now(), byDeploymentId, byApiBase };
    return { byDeploymentId, byApiBase };
  }

  #dateWindow(): { startDate: string; endDate: string } {
    const now = new Date();
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - this.#lookbackDays);
    const end = new Date(now);
    end.setUTCDate(end.getUTCDate() + 1);
    return { startDate: utcDateOnly(start), endDate: utcDateOnly(end) };
  }

  async #page(endUser: string, page: number, pageSize: number): Promise<JsonRecord[]> {
    const { startDate, endDate } = this.#dateWindow();
    const query = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
      page: String(page),
      page_size: String(pageSize),
      end_user: endUser,
      sort_by: 'startTime',
      sort_order: 'desc',
    });
    const response = await fetch(`${this.#baseUrl}/spend/logs/v2?${query}`, {
      headers: { Authorization: `Bearer ${this.#secrets.read(this.#keyName)}` },
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`LITELLM_SPEND_HTTP_${response.status}`);
    const payload = asRecord(await response.json());
    return Array.isArray(payload.data) ? payload.data.map(asRecord) : [];
  }

  async #rows(endUser: string): Promise<JsonRecord[]> {
    const pageSize = 100;
    const rows: JsonRecord[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const current = await this.#page(endUser, page, pageSize);
      // Defense in depth: LiteLLM already applies end_user server-side, but never
      // join a row to an execution unless the persisted correlation matches exactly.
      rows.push(...current.filter((row) => String(row.end_user ?? '') === endUser));
      if (current.length < pageSize) break;
    }
    return rows;
  }

  #setHealth(status: 'OK' | 'UNAVAILABLE'): void {
    this.#healthCache = { status, at: Date.now() };
  }

  async health(): Promise<'OK' | 'UNAVAILABLE'> {
    const cached = this.#healthCache;
    if (cached && Date.now() - cached.at < this.#healthTtlMs) return cached.status;
    try {
      // Probe the spend endpoint with an impossible execution ID. This validates
      // both service reachability and admin spend-read permission without reading
      // unrelated request rows.
      await this.#page('__hermes_v3_observability_health__', 1, 1);
      this.#setHealth('OK');
      return 'OK';
    } catch {
      this.#setHealth('UNAVAILABLE');
      return 'UNAVAILABLE';
    }
  }

  async getExecutionSummary(executionId: string): Promise<ObservabilityExecutionSummary> {
    const normalized = executionId.trim();
    if (!normalized) return { health: 'UNAVAILABLE' };
    try {
      const rows = await this.#rows(normalized);
      this.#setHealth('OK');
      if (rows.length === 0) return { health: 'OK', usage: null };

      let input = 0;
      let output = 0;
      let cachedInput = 0;
      let reasoningOutput = 0;
      let costUsd = 0;
      let calls = 0;
      const providerLookup = await this.#providerLookup();
      const routeTotals = new Map<
        string,
        {
          model?: string;
          provider?: string;
          providerKey?: string;
          deploymentId?: string;
          apiBase?: string;
          input: number;
          output: number;
          cachedInput: number;
          reasoningOutput: number;
          costUsd: number;
          calls: number;
        }
      >();
      for (const row of rows) {
        const rowInput = finiteNumber(row.prompt_tokens);
        const rowOutput = finiteNumber(row.completion_tokens);
        const rowCost = finiteNumber(row.spend);
        const metadata = nestedRecord(row, 'metadata');
        const usageObject = nestedRecord(metadata, 'usage_object');
        const promptDetails = nestedRecord(usageObject, 'prompt_tokens_details');
        const completionDetails = nestedRecord(usageObject, 'completion_tokens_details');
        const rowCached = finiteNumber(promptDetails.cached_tokens);
        const rowReasoning = finiteNumber(completionDetails.reasoning_tokens);
        const model = String(row.model ?? '').trim();
        const provider = String(row.custom_llm_provider ?? row.provider ?? '').trim();
        const deploymentId = String(row.model_id ?? '').trim();
        const apiBase = normalizeApiBase(row.api_base);
        const providerKey =
          (deploymentId ? providerLookup.byDeploymentId.get(deploymentId) : undefined) ??
          (apiBase ? providerLookup.byApiBase.get(apiBase) : undefined);
        const routeKey = `${deploymentId}\u0000${provider}\u0000${model}\u0000${apiBase}`;
        const route = routeTotals.get(routeKey) ?? {
          ...(model ? { model } : {}),
          ...(provider ? { provider } : {}),
          ...(providerKey ? { providerKey } : {}),
          ...(deploymentId ? { deploymentId } : {}),
          ...(apiBase ? { apiBase } : {}),
          input: 0,
          output: 0,
          cachedInput: 0,
          reasoningOutput: 0,
          costUsd: 0,
          calls: 0,
        };
        route.input += rowInput;
        route.output += rowOutput;
        route.cachedInput += rowCached;
        route.reasoningOutput += rowReasoning;
        route.costUsd += rowCost;
        route.calls += 1;
        routeTotals.set(routeKey, route);

        input += rowInput;
        output += rowOutput;
        cachedInput += rowCached;
        reasoningOutput += rowReasoning;
        costUsd += rowCost;
        calls += 1;
      }

      const latest = rows[0] ?? {};
      const model = String(latest.model ?? '').trim();
      const provider = String(latest.custom_llm_provider ?? latest.provider ?? '').trim();
      const deploymentId = String(latest.model_id ?? '').trim();
      const apiBase = normalizeApiBase(latest.api_base);
      const providerKey =
        (deploymentId ? providerLookup.byDeploymentId.get(deploymentId) : undefined) ??
        (apiBase ? providerLookup.byApiBase.get(apiBase) : undefined);
      return {
        health: 'OK',
        usage: {
          source: 'LITELLM_REPORTED',
          input,
          output,
          ...(cachedInput > 0 ? { cachedInput } : {}),
          ...(reasoningOutput > 0 ? { reasoningOutput } : {}),
          costUsd,
          calls,
        },
        ...(model || provider || deploymentId
          ? {
              lastObservedRoute: {
                ...(model ? { model } : {}),
                ...(provider ? { provider } : {}),
                ...(providerKey ? { providerKey } : {}),
                ...(deploymentId ? { deploymentId } : {}),
                ...(apiBase ? { apiBase } : {}),
              },
            }
          : {}),
        routeUsage: [...routeTotals.values()].map((route) => ({
          ...(route.model ? { model: route.model } : {}),
          ...(route.provider ? { provider: route.provider } : {}),
          ...(route.providerKey ? { providerKey: route.providerKey } : {}),
          ...(route.deploymentId ? { deploymentId: route.deploymentId } : {}),
          ...(route.apiBase ? { apiBase: route.apiBase } : {}),
          input: route.input,
          output: route.output,
          ...(route.cachedInput > 0 ? { cachedInput: route.cachedInput } : {}),
          ...(route.reasoningOutput > 0 ? { reasoningOutput: route.reasoningOutput } : {}),
          costUsd: route.costUsd,
          calls: route.calls,
        })),
      };
    } catch {
      this.#setHealth('UNAVAILABLE');
      return { health: 'UNAVAILABLE' };
    }
  }
}
