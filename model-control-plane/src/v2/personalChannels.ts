import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { SupplyRepository } from './supply.js';

export type PersonalChannelHealth = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';

export interface PersonalChannelModel {
  id: string;
  provider?: string;
  upstreamModel?: string;
  capability?: string;
}

export interface PersonalChannelAccountSummary {
  total: number;
  enabled: number;
  ready: number;
  disabled: number;
  reauthRequired: number;
}

export interface PersonalChannelSnapshot {
  id: string;
  name: string;
  kind: 'ACCOUNT_POOL';
  sourceKind: 'CPA' | 'GROK2API';
  provider: string;
  health: PersonalChannelHealth;
  baseUrlHint?: string;
  accounts: PersonalChannelAccountSummary;
  models: PersonalChannelModel[];
  groups?: Array<{
    id: string;
    name: string;
    total: number;
    enabled: number;
    ready: number;
    reauthRequired: number;
  }>;
  metadata?: Record<string, unknown>;
}

export interface PersonalChannelSource {
  snapshot(): Promise<PersonalChannelSnapshot> | PersonalChannelSnapshot;
}

export interface CpaModelListSource {
  models(): Promise<string[]>;
}

function safeJson(file: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export class CpaXaiPersonalChannelSource implements PersonalChannelSource {
  readonly #authDir: string;
  readonly #models: CpaModelListSource;
  readonly #baseUrl: string;

  constructor(options: { authDir: string; models: CpaModelListSource; baseUrl?: string }) {
    this.#authDir = options.authDir;
    this.#models = options.models;
    this.#baseUrl = options.baseUrl ?? 'http://127.0.0.1:8317';
  }

  async snapshot(): Promise<PersonalChannelSnapshot> {
    const files = fs.existsSync(this.#authDir)
      ? fs
          .readdirSync(this.#authDir)
          .filter((name) => /^xai-.*\.json$/i.test(name))
          .map((name) => path.join(this.#authDir, name))
      : [];
    let total = 0;
    let enabled = 0;
    for (const file of files) {
      const value = safeJson(file);
      if (!value || String(value.type ?? '').toLowerCase() !== 'xai') continue;
      total += 1;
      if (value.disabled !== true) enabled += 1;
    }
    let modelIds: string[] = [];
    try {
      modelIds = (await this.#models.models()).filter((model) => /grok/i.test(model));
    } catch {
      modelIds = [];
    }
    const models = [...new Set(modelIds)]
      .sort((a, b) => a.localeCompare(b))
      .map((id) => ({ id, provider: 'xai', capability: 'responses' }));
    const health: PersonalChannelHealth =
      total === 0 ? 'UNAVAILABLE' : enabled > 0 && models.length > 0 ? 'HEALTHY' : 'DEGRADED';
    return {
      id: 'my-cpa-grok',
      name: 'My CPA',
      kind: 'ACCOUNT_POOL',
      sourceKind: 'CPA',
      provider: 'xAI / Grok',
      health,
      baseUrlHint: this.#baseUrl,
      accounts: {
        total,
        enabled,
        ready: enabled,
        disabled: Math.max(0, total - enabled),
        reauthRequired: 0,
      },
      models,
      metadata: {
        poolKind: 'IMPORTED_FREE_ACCOUNTS',
        evidence: 'CPA_XAI_AUTH_POOL',
      },
    };
  }
}

interface DbRow {
  [key: string]: unknown;
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class Grok2ApiPersonalChannelSource implements PersonalChannelSource {
  readonly #dbFile: string;
  readonly #baseUrl: string;

  constructor(options: { dbFile: string; baseUrl?: string }) {
    this.#dbFile = options.dbFile;
    this.#baseUrl = options.baseUrl ?? 'http://127.0.0.1:8000';
  }

  snapshot(): PersonalChannelSnapshot {
    if (!fs.existsSync(this.#dbFile)) {
      return {
        id: 'grok2api',
        name: 'Grok2API',
        kind: 'ACCOUNT_POOL',
        sourceKind: 'GROK2API',
        provider: 'Grok multi-account pool',
        health: 'UNAVAILABLE',
        baseUrlHint: this.#baseUrl,
        accounts: { total: 0, enabled: 0, ready: 0, disabled: 0, reauthRequired: 0 },
        models: [],
        metadata: { evidence: 'GROK2API_DB_UNAVAILABLE' },
      };
    }

    const db = new DatabaseSync(this.#dbFile, { readOnly: true });
    try {
      const groups = db
        .prepare(
          `SELECT provider,
                  COUNT(*) total,
                  SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) enabled,
                  SUM(CASE WHEN enabled=1 AND auth_status='active'
                                AND (cooldown_until IS NULL OR cooldown_until <= datetime('now'))
                           THEN 1 ELSE 0 END) ready,
                  SUM(CASE WHEN auth_status='reauthRequired' THEN 1 ELSE 0 END) reauth_required
             FROM provider_accounts
            GROUP BY provider
            ORDER BY provider`,
        )
        .all() as DbRow[];
      const routes = db
        .prepare(
          `SELECT public_id,provider,upstream_model,capability
             FROM model_routes
            WHERE enabled=1 AND capability IN ('responses','chat')
            ORDER BY provider,public_id,capability`,
        )
        .all() as DbRow[];
      const groupItems = groups.map((row) => ({
        id: String(row.provider ?? 'unknown'),
        name: String(row.provider ?? 'unknown'),
        total: number(row.total),
        enabled: number(row.enabled),
        ready: number(row.ready),
        reauthRequired: number(row.reauth_required),
      }));
      const total = groupItems.reduce((sum, item) => sum + item.total, 0);
      const enabled = groupItems.reduce((sum, item) => sum + item.enabled, 0);
      const ready = groupItems.reduce((sum, item) => sum + item.ready, 0);
      const reauthRequired = groupItems.reduce((sum, item) => sum + item.reauthRequired, 0);
      const models = routes.map((row) => ({
        id: String(row.public_id),
        provider: String(row.provider),
        upstreamModel: String(row.upstream_model),
        capability: String(row.capability),
      }));
      return {
        id: 'grok2api',
        name: 'Grok2API',
        kind: 'ACCOUNT_POOL',
        sourceKind: 'GROK2API',
        provider: 'Grok Build / Console / Web',
        health: ready > 0 && models.length > 0 ? 'HEALTHY' : total > 0 ? 'DEGRADED' : 'UNAVAILABLE',
        baseUrlHint: this.#baseUrl,
        accounts: {
          total,
          enabled,
          ready,
          disabled: Math.max(0, total - enabled),
          reauthRequired,
        },
        models,
        groups: groupItems,
        metadata: {
          poolKind: 'MULTI_ACCOUNT_GATEWAY',
          evidence: 'GROK2API_SQLITE',
        },
      };
    } finally {
      db.close();
    }
  }
}

export class PersonalChannelProjectionService {
  readonly #sources: PersonalChannelSource[];

  constructor(sources: PersonalChannelSource[]) {
    this.#sources = [...sources];
  }

  async projection(): Promise<Record<string, unknown>> {
    const snapshots = await Promise.all(
      this.#sources.map(async (source) => {
        try {
          return await source.snapshot();
        } catch {
          return null;
        }
      }),
    );
    const channels = snapshots.filter((value): value is PersonalChannelSnapshot => Boolean(value));
    return {
      projectionVersion: 1,
      generatedAt: Date.now(),
      channels,
      summary: {
        channels: channels.length,
        healthyChannels: channels.filter((item) => item.health === 'HEALTHY').length,
        accounts: channels.reduce((sum, item) => sum + item.accounts.total, 0),
        readyAccounts: channels.reduce((sum, item) => sum + item.accounts.ready, 0),
        models: channels.reduce((sum, item) => sum + item.models.length, 0),
      },
    };
  }
}

export class InternalPoolWorkforceSyncService {
  readonly #channels: PersonalChannelProjectionService;
  readonly #supply: SupplyRepository;

  constructor(channels: PersonalChannelProjectionService, supply: SupplyRepository) {
    this.#channels = channels;
    this.#supply = supply;
  }

  async sync(): Promise<{ sources: number; employees: number }> {
    const projection = (await this.#channels.projection()) as {
      channels?: PersonalChannelSnapshot[];
    };
    const channels = Array.isArray(projection.channels) ? projection.channels : [];
    let employees = 0;
    for (const channel of channels) {
      const slug = channel.id === 'my-cpa-grok' ? 'internal-my-cpa' : 'internal-grok2api';
      const agreementRef = `internal-pool:${channel.id}`;
      for (const model of channel.models) {
        this.#supply.registerCatalogEntry({
          supplier: {
            slug,
            name: channel.name,
            sourceKind: 'INTERNAL',
          },
          supplierModel: { key: model.id, name: model.id },
          agreement: {
            externalAccountRef: agreementRef,
            name: `${channel.name} internal account pool`,
          },
        });
        employees += 1;
      }
      if (channel.models.length === 0) {
        this.#supply.upsertSource({ slug, name: channel.name, sourceKind: 'INTERNAL' });
      }
    }
    return { sources: channels.length, employees };
  }
}
