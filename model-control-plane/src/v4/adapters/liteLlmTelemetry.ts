import fs from 'node:fs';

interface JsonRecord {
  [key: string]: unknown;
}

export interface ExecutionUsageProjection {
  source: 'LITELLM_REPORTED';
  input: number;
  output: number;
  cachedInput: number;
  reasoningOutput: number;
  costUsd: number;
  calls: number;
}

export interface ExecutionRouteUsageProjection extends Omit<ExecutionUsageProjection, 'source'> {
  deploymentId: string;
  providerKey: string;
  model: string;
  provider?: string;
  apiBase?: string;
  modelGroup?: string;
  credential?: string;
  commercialType?: string;
  supplyOrigin?: string;
  order?: number;
}

export interface ExecutionTelemetryProjection {
  health: 'OK' | 'UNAVAILABLE';
  usage: ExecutionUsageProjection | null;
  route?: Omit<ExecutionRouteUsageProjection, keyof Omit<ExecutionUsageProjection, 'source'>>;
  routeUsage: ExecutionRouteUsageProjection[];
}

export interface ExecutionTelemetryTarget {
  executionId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface DeploymentMetadata {
  deploymentId: string;
  providerKey: string;
  model?: string;
  modelGroup?: string;
  credential?: string;
  commercialType?: string;
  supplyOrigin?: string;
  order?: number;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function finite(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedApiBase(value: unknown): string {
  return text(value).replace(/\/+$/, '');
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftedDate(value: string, days: number, fallback: Date): string {
  const parsed = new Date(value);
  const date = Number.isFinite(parsed.getTime()) ? parsed : fallback;
  date.setUTCDate(date.getUTCDate() + days);
  return utcDate(date);
}

function readEnvValue(file: string, key: string): string {
  const source = fs.readFileSync(file, 'utf8');
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1 || line.slice(0, separator).trim() !== key) continue;
    const raw = line.slice(separator + 1).trim();
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1);
    }
    return raw;
  }
  throw new Error('LITELLM_TELEMETRY_KEY_MISSING');
}

const TERMINAL_EXECUTION_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED']);

export class LiteLlmExecutionTelemetry {
  readonly #baseUrl: string;
  readonly #envFile: string;
  readonly #keyName: string;
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;
  readonly #activeTtlMs: number;
  readonly #terminalTtlMs: number;
  readonly #cache = new Map<
    string,
    { at: number; revision: string; value: ExecutionTelemetryProjection }
  >();
  #registryCache: {
    at: number;
    byDeploymentId: Map<string, DeploymentMetadata>;
    byApiBase: Map<string, DeploymentMetadata>;
  } | null = null;

  constructor(options: {
    baseUrl: string;
    envFile: string;
    keyName?: string;
    fetchImpl?: typeof fetch;
    requestTimeoutMs?: number;
    activeTtlMs?: number;
    terminalTtlMs?: number;
  }) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#envFile = options.envFile;
    this.#keyName = options.keyName ?? 'LITELLM_MASTER_KEY';
    this.#fetch = options.fetchImpl ?? fetch;
    this.#requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? 10_000);
    this.#activeTtlMs = Math.max(1_000, options.activeTtlMs ?? 10_000);
    this.#terminalTtlMs = Math.max(10_000, options.terminalTtlMs ?? 6 * 60 * 60_000);
  }

  async project(target: ExecutionTelemetryTarget): Promise<ExecutionTelemetryProjection> {
    const revision = `${target.status}\u0000${target.updatedAt}`;
    const cached = this.#cache.get(target.executionId);
    const ttl = TERMINAL_EXECUTION_STATUSES.has(target.status)
      ? this.#terminalTtlMs
      : this.#activeTtlMs;
    if (cached && cached.revision === revision && Date.now() - cached.at < ttl) return cached.value;

    let value: ExecutionTelemetryProjection;
    try {
      const rows = await this.#rows(target);
      value =
        rows.length > 0
          ? await this.#aggregate(rows)
          : { health: 'OK', usage: null, routeUsage: [] };
    } catch {
      value = { health: 'UNAVAILABLE', usage: null, routeUsage: [] };
    }
    this.#cache.set(target.executionId, { at: Date.now(), revision, value });
    return value;
  }

  async #json(path: string): Promise<JsonRecord> {
    const key = readEnvValue(this.#envFile, this.#keyName);
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`LITELLM_TELEMETRY_HTTP_${response.status}`);
    return asRecord(await response.json());
  }

  async #rows(target: ExecutionTelemetryTarget): Promise<JsonRecord[]> {
    const now = new Date();
    const startDate = shiftedDate(target.createdAt, -1, now);
    const endDate = TERMINAL_EXECUTION_STATUSES.has(target.status)
      ? shiftedDate(target.updatedAt, 1, now)
      : shiftedDate(now.toISOString(), 1, now);
    const rows: JsonRecord[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const query = new URLSearchParams({
        start_date: startDate,
        end_date: endDate,
        page: String(page),
        page_size: '100',
        end_user: target.executionId,
        sort_by: 'startTime',
        sort_order: 'desc',
      });
      const payload = await this.#json(`/spend/logs/v2?${query}`);
      const current = Array.isArray(payload.data) ? payload.data.map(asRecord) : [];
      rows.push(...current.filter((row) => text(row.end_user) === target.executionId));
      if (current.length < 100) break;
    }
    return rows;
  }

  async #registry(): Promise<{
    byDeploymentId: Map<string, DeploymentMetadata>;
    byApiBase: Map<string, DeploymentMetadata>;
  }> {
    const cached = this.#registryCache;
    if (cached && Date.now() - cached.at < 30_000) {
      return { byDeploymentId: cached.byDeploymentId, byApiBase: cached.byApiBase };
    }
    const payload = await this.#json('/model/info');
    const byDeploymentId = new Map<string, DeploymentMetadata>();
    const providersByApiBase = new Map<string, DeploymentMetadata[]>();
    for (const raw of Array.isArray(payload.data) ? payload.data.map(asRecord) : []) {
      const info = asRecord(raw.model_info);
      const params = asRecord(raw.litellm_params);
      const metadata = asRecord(info.metadata);
      const deploymentId = text(info.id);
      if (!deploymentId) continue;
      const credential = text(params.litellm_credential_name);
      const providerKey =
        text(metadata.legacy_provider_key) || text(metadata.supplier_slug) || credential;
      if (!providerKey) continue;
      const order = finite(params.order);
      const deployment: DeploymentMetadata = {
        deploymentId,
        providerKey,
        ...(text(params.model) ? { model: text(params.model) } : {}),
        ...(text(raw.model_name) ? { modelGroup: text(raw.model_name) } : {}),
        ...(credential ? { credential } : {}),
        ...(text(metadata.commercial_type)
          ? { commercialType: text(metadata.commercial_type) }
          : {}),
        ...(text(metadata.supply_origin) ? { supplyOrigin: text(metadata.supply_origin) } : {}),
        ...(Number.isFinite(Number(params.order)) ? { order } : {}),
      };
      byDeploymentId.set(deploymentId, deployment);
      const apiBase = normalizedApiBase(params.api_base);
      if (apiBase)
        providersByApiBase.set(apiBase, [...(providersByApiBase.get(apiBase) ?? []), deployment]);
    }
    const byApiBase = new Map<string, DeploymentMetadata>();
    for (const [apiBase, deployments] of providersByApiBase) {
      const providerKeys = new Set(deployments.map((item) => item.providerKey));
      if (providerKeys.size === 1) byApiBase.set(apiBase, deployments[0]!);
    }
    this.#registryCache = { at: Date.now(), byDeploymentId, byApiBase };
    return { byDeploymentId, byApiBase };
  }

  async #aggregate(rows: JsonRecord[]): Promise<ExecutionTelemetryProjection> {
    let input = 0;
    let output = 0;
    let cachedInput = 0;
    let reasoningOutput = 0;
    let costUsd = 0;
    let calls = 0;
    const registry = await this.#registry().catch(() => ({
      byDeploymentId: new Map<string, DeploymentMetadata>(),
      byApiBase: new Map<string, DeploymentMetadata>(),
    }));
    const routeTotals = new Map<string, ExecutionRouteUsageProjection>();

    for (const row of rows) {
      const rowInput = finite(row.prompt_tokens);
      const rowOutput = finite(row.completion_tokens);
      const rowCost = finite(row.spend);
      const usageObject = asRecord(asRecord(row.metadata).usage_object);
      const promptDetails = asRecord(usageObject.prompt_tokens_details);
      const completionDetails = asRecord(usageObject.completion_tokens_details);
      const rowCached = finite(promptDetails.cached_tokens);
      const rowReasoning = finite(completionDetails.reasoning_tokens);
      const deploymentId = text(row.model_id);
      const apiBase = normalizedApiBase(row.api_base);
      const metadata =
        (deploymentId ? registry.byDeploymentId.get(deploymentId) : undefined) ??
        (apiBase ? registry.byApiBase.get(apiBase) : undefined);
      if (metadata) {
        const model = text(row.model) || metadata.model || metadata.modelGroup || 'unknown';
        const provider = text(row.custom_llm_provider) || text(row.provider);
        const key = `${deploymentId || metadata.deploymentId}\u0000${metadata.providerKey}\u0000${model}`;
        const route = routeTotals.get(key) ?? {
          deploymentId: deploymentId || metadata.deploymentId,
          providerKey: metadata.providerKey,
          model,
          ...(provider ? { provider } : {}),
          ...(apiBase ? { apiBase } : {}),
          ...(metadata.modelGroup ? { modelGroup: metadata.modelGroup } : {}),
          ...(metadata.credential ? { credential: metadata.credential } : {}),
          ...(metadata.commercialType ? { commercialType: metadata.commercialType } : {}),
          ...(metadata.supplyOrigin ? { supplyOrigin: metadata.supplyOrigin } : {}),
          ...(metadata.order !== undefined ? { order: metadata.order } : {}),
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
        routeTotals.set(key, route);
      }
      input += rowInput;
      output += rowOutput;
      cachedInput += rowCached;
      reasoningOutput += rowReasoning;
      costUsd += rowCost;
      calls += 1;
    }

    const routes = [...routeTotals.values()];
    const latest = rows[0] ?? {};
    const latestDeploymentId = text(latest.model_id);
    const latestApiBase = normalizedApiBase(latest.api_base);
    const latestMetadata =
      (latestDeploymentId ? registry.byDeploymentId.get(latestDeploymentId) : undefined) ??
      (latestApiBase ? registry.byApiBase.get(latestApiBase) : undefined);
    const latestRoute = latestMetadata
      ? routes.find(
          (item) => item.deploymentId === (latestDeploymentId || latestMetadata.deploymentId),
        )
      : undefined;
    const route = latestRoute
      ? {
          deploymentId: latestRoute.deploymentId,
          providerKey: latestRoute.providerKey,
          model: latestRoute.model,
          ...(latestRoute.provider ? { provider: latestRoute.provider } : {}),
          ...(latestRoute.apiBase ? { apiBase: latestRoute.apiBase } : {}),
          ...(latestRoute.modelGroup ? { modelGroup: latestRoute.modelGroup } : {}),
          ...(latestRoute.credential ? { credential: latestRoute.credential } : {}),
          ...(latestRoute.commercialType ? { commercialType: latestRoute.commercialType } : {}),
          ...(latestRoute.supplyOrigin ? { supplyOrigin: latestRoute.supplyOrigin } : {}),
          ...(latestRoute.order !== undefined ? { order: latestRoute.order } : {}),
        }
      : undefined;

    return {
      health: 'OK',
      usage: {
        source: 'LITELLM_REPORTED',
        input,
        output,
        cachedInput,
        reasoningOutput,
        costUsd,
        calls,
      },
      ...(route ? { route } : {}),
      routeUsage: routes,
    };
  }
}
