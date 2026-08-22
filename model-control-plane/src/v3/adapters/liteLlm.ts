import type {
  ModelGatewayPort,
  ModelGatewaySummary,
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
  #healthCache: { status: 'OK' | 'UNAVAILABLE'; at: number } | null = null;

  constructor(options: {
    baseUrl: string;
    secrets: EnvFileValueProvider;
    keyName?: string;
    lookbackDays?: number;
    requestTimeoutMs?: number;
    healthTtlMs?: number;
  }) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#secrets = options.secrets;
    this.#keyName = options.keyName ?? 'LITELLM_MASTER_KEY';
    this.#lookbackDays = Math.min(365, Math.max(1, options.lookbackDays ?? 30));
    this.#requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? 10_000);
    this.#healthTtlMs = Math.max(1_000, options.healthTtlMs ?? 30_000);
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
      for (const row of rows) {
        input += finiteNumber(row.prompt_tokens);
        output += finiteNumber(row.completion_tokens);
        costUsd += finiteNumber(row.spend);
        calls += 1;

        const metadata = nestedRecord(row, 'metadata');
        const usageObject = nestedRecord(metadata, 'usage_object');
        const promptDetails = nestedRecord(usageObject, 'prompt_tokens_details');
        const completionDetails = nestedRecord(usageObject, 'completion_tokens_details');
        cachedInput += finiteNumber(promptDetails.cached_tokens);
        reasoningOutput += finiteNumber(completionDetails.reasoning_tokens);
      }

      const latest = rows[0] ?? {};
      const model = String(latest.model ?? '').trim();
      const provider = String(latest.custom_llm_provider ?? latest.provider ?? '').trim();
      const deploymentId = String(latest.model_id ?? '').trim();
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
                ...(deploymentId ? { deploymentId } : {}),
              },
            }
          : {}),
      };
    } catch {
      this.#setHealth('UNAVAILABLE');
      return { health: 'UNAVAILABLE' };
    }
  }
}
