import { newId } from './ids.js';
import type { V2Repository, V2Row } from './repository.js';

type JsonRecord = Record<string, unknown>;

export type ProviderAuthKind = 'API_KEY' | 'OAUTH' | 'SUBSCRIPTION' | 'ACCOUNT_POOL' | 'NONE';
export type ProviderCredentialScope = 'GLOBAL' | 'PROFILE_LOCAL' | 'OAUTH_PROFILE' | 'EXTERNAL';
export type ProviderHealth = 'UNKNOWN' | 'READY' | 'DEGRADED' | 'UNAVAILABLE';
export type ProviderShareScope = 'GLOBAL' | 'PROFILE_ONLY';
export type ProfileProviderRuntime = 'HERMES' | 'OPENCODE' | 'CODEX' | 'CLAUDE_CODE';

export interface ProviderConnectionInput {
  providerKey: string;
  displayName: string;
  supplierId?: string;
  baseUrl?: string;
  websiteUrl?: string;
  protocol?: string;
  authKind?: ProviderAuthKind;
  credentialRef?: string;
  credentialScope?: ProviderCredentialScope;
  sourceProfileId?: string;
  sourceKind: string;
  shareScope?: ProviderShareScope;
  health?: ProviderHealth;
  models?: string[];
  metadata?: JsonRecord;
  lastSeenAt?: number;
}

export interface ProfileProviderLinkInput {
  connectionId: string;
  profileId: string;
  runtimeKind: ProfileProviderRuntime;
  providerRef?: string;
  modelRef?: string;
  profileRef?: string;
  sourceKind: string;
}

function row(value: unknown): V2Row | null {
  return value && typeof value === 'object' ? (value as V2Row) : null;
}
function rows(value: unknown): V2Row[] {
  return Array.isArray(value) ? (value as V2Row[]) : [];
}
function clean(value: unknown, max = 1000): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (text.length > max) throw new Error('PROVIDER_HUB_FIELD_TOO_LONG');
  return text;
}
function safeJson(value: JsonRecord | undefined): string {
  const metadata = value ?? {};
  const raw = JSON.stringify(metadata);
  const forbidden =
    /"[^"\\]*(?:api[_-]?key|password|secret|token|cookie|authorization)[^"\\]*"\s*:/i;
  if (forbidden.test(raw)) throw new Error('PROVIDER_HUB_SECRET_FIELD_FORBIDDEN');
  if (raw.length > 32_000) throw new Error('PROVIDER_HUB_METADATA_TOO_LARGE');
  return raw;
}
function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class ProviderHubRepository {
  readonly #domain: V2Repository;
  constructor(domain: V2Repository) {
    this.#domain = domain;
  }

  upsertConnection(input: ProviderConnectionInput): V2Row {
    const providerKey = clean(input.providerKey, 160);
    const displayName = clean(input.displayName, 240);
    const sourceKind = clean(input.sourceKind, 120);
    if (!providerKey || !displayName || !sourceKind)
      throw new Error('PROVIDER_CONNECTION_FIELDS_REQUIRED');
    const baseUrl = clean(input.baseUrl, 1000);
    if (baseUrl && !/^https?:\/\//i.test(baseUrl))
      throw new Error('PROVIDER_CONNECTION_BASE_URL_INVALID');
    const websiteUrl = clean(input.websiteUrl, 1000);
    if (websiteUrl && !/^https?:\/\//i.test(websiteUrl))
      throw new Error('PROVIDER_CONNECTION_WEBSITE_URL_INVALID');
    const credentialRef = clean(input.credentialRef, 240);
    const sourceProfileId = clean(input.sourceProfileId, 160);
    const models = [
      ...new Set((input.models ?? []).map((model) => String(model).trim()).filter(Boolean)),
    ].slice(0, 800);
    const timestamp = Date.now();
    const credentialScope = input.credentialScope ?? 'GLOBAL';
    const existing = row(
      credentialScope === 'GLOBAL'
        ? this.#domain.db
            .prepare(
              `SELECT * FROM v2_provider_connections
               WHERE provider_key=? AND COALESCE(base_url,'')=COALESCE(?, '')
                 AND COALESCE(credential_ref,'')=COALESCE(?, '') AND credential_scope='GLOBAL'`,
            )
            .get(providerKey, baseUrl, credentialRef)
        : this.#domain.db
            .prepare(
              `SELECT * FROM v2_provider_connections
               WHERE provider_key=? AND COALESCE(base_url,'')=COALESCE(?, '')
                 AND COALESCE(credential_ref,'')=COALESCE(?, '')
                 AND COALESCE(source_profile_id,'')=COALESCE(?, '') AND credential_scope!='GLOBAL'`,
            )
            .get(providerKey, baseUrl, credentialRef, sourceProfileId),
    );
    return this.#domain.transaction(() => {
      const id = existing ? String(existing.id) : newId('pconn', timestamp);
      if (existing) {
        this.#domain.db
          .prepare(
            `UPDATE v2_provider_connections SET
               display_name=?,supplier_id=?,website_url=?,protocol=?,auth_kind=?,credential_scope=?,source_kind=?,share_scope=?,health=?,models_json=?,metadata_json=?,lifecycle='ACTIVE',last_seen_at=?,updated_at=?
             WHERE id=?`,
          )
          .run(
            displayName,
            input.supplierId ?? (existing.supplier_id ? String(existing.supplier_id) : null),
            websiteUrl?.replace(/\/$/, '') ??
              (existing.website_url ? String(existing.website_url) : null),
            clean(input.protocol, 120),
            input.authKind ?? 'API_KEY',
            credentialScope,
            sourceKind,
            input.shareScope ?? 'GLOBAL',
            input.health ?? 'UNKNOWN',
            JSON.stringify(models),
            safeJson(input.metadata),
            input.lastSeenAt ?? timestamp,
            timestamp,
            id,
          );
      } else {
        this.#domain.db
          .prepare(
            `INSERT INTO v2_provider_connections(
               id,provider_key,display_name,supplier_id,base_url,website_url,protocol,auth_kind,credential_ref,credential_scope,
               source_profile_id,source_kind,share_scope,health,models_json,metadata_json,lifecycle,last_seen_at,created_at,updated_at
             ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            providerKey,
            displayName,
            input.supplierId ?? null,
            baseUrl?.replace(/\/$/, '') ?? null,
            websiteUrl?.replace(/\/$/, '') ?? null,
            clean(input.protocol, 120),
            input.authKind ?? 'API_KEY',
            credentialRef,
            credentialScope,
            sourceProfileId,
            sourceKind,
            input.shareScope ?? 'GLOBAL',
            input.health ?? 'UNKNOWN',
            JSON.stringify(models),
            safeJson(input.metadata),
            'ACTIVE',
            input.lastSeenAt ?? timestamp,
            timestamp,
            timestamp,
          );
      }
      if (credentialScope === 'GLOBAL') {
        const duplicates = rows(
          this.#domain.db
            .prepare(
              `SELECT id FROM v2_provider_connections
               WHERE id!=? AND provider_key=?
                 AND COALESCE(base_url,'')=COALESCE(?, '')
                 AND COALESCE(credential_ref,'')=COALESCE(?, '')
                 AND credential_scope!='GLOBAL' AND lifecycle='ACTIVE'`,
            )
            .all(id, providerKey, baseUrl, credentialRef),
        );
        for (const duplicate of duplicates) {
          const duplicateId = String(duplicate.id);
          const links = rows(
            this.#domain.db
              .prepare(
                "SELECT * FROM v2_profile_provider_links WHERE connection_id=? AND state='ACTIVE'",
              )
              .all(duplicateId),
          );
          for (const link of links) {
            const conflict = row(
              this.#domain.db
                .prepare(
                  `SELECT id FROM v2_profile_provider_links
                   WHERE connection_id=? AND profile_id=? AND runtime_kind=?
                     AND COALESCE(provider_ref,'')=COALESCE(?, '')
                     AND COALESCE(model_ref,'')=COALESCE(?, '')
                     AND COALESCE(profile_ref,'')=COALESCE(?, '') AND state='ACTIVE'`,
                )
                .get(
                  id,
                  String(link.profile_id),
                  String(link.runtime_kind),
                  link.provider_ref ? String(link.provider_ref) : null,
                  link.model_ref ? String(link.model_ref) : null,
                  link.profile_ref ? String(link.profile_ref) : null,
                ),
            );
            if (conflict) {
              this.#domain.db
                .prepare(
                  "UPDATE v2_profile_provider_links SET state='INACTIVE',updated_at=? WHERE id=?",
                )
                .run(timestamp, String(link.id));
            } else {
              this.#domain.db
                .prepare(
                  'UPDATE v2_profile_provider_links SET connection_id=?,updated_at=? WHERE id=?',
                )
                .run(id, timestamp, String(link.id));
            }
          }
          this.#domain.db
            .prepare(
              "UPDATE v2_provider_connections SET lifecycle='RETIRED',updated_at=? WHERE id=?",
            )
            .run(timestamp, duplicateId);
        }
      }
      this.#domain.emit({
        type: existing ? 'provider_connection.updated' : 'provider_connection.created',
        entityType: 'ProviderConnection',
        entityId: id,
        payload: { providerKey, supplierId: input.supplierId ?? null, sourceProfileId, sourceKind },
      });
      return this.getConnection(id)!;
    });
  }

  linkProfile(input: ProfileProviderLinkInput): V2Row {
    const connection = this.getConnection(input.connectionId);
    if (!connection || connection.lifecycle !== 'ACTIVE')
      throw new Error('PROVIDER_CONNECTION_NOT_FOUND');
    const profileId = clean(input.profileId, 160);
    const sourceKind = clean(input.sourceKind, 120);
    if (!profileId || !sourceKind) throw new Error('PROFILE_PROVIDER_LINK_FIELDS_REQUIRED');
    const timestamp = Date.now();
    const existing = row(
      this.#domain.db
        .prepare(
          `SELECT * FROM v2_profile_provider_links
           WHERE connection_id=? AND profile_id=? AND runtime_kind=?
             AND COALESCE(provider_ref,'')=COALESCE(?, '')
             AND COALESCE(model_ref,'')=COALESCE(?, '')
             AND COALESCE(profile_ref,'')=COALESCE(?, '')`,
        )
        .get(
          input.connectionId,
          profileId,
          input.runtimeKind,
          clean(input.providerRef, 160),
          clean(input.modelRef, 240),
          clean(input.profileRef, 160),
        ),
    );
    return this.#domain.transaction(() => {
      const id = existing ? String(existing.id) : newId('plink', timestamp);
      if (existing) {
        this.#domain.db
          .prepare(
            "UPDATE v2_profile_provider_links SET source_kind=?,state='ACTIVE',updated_at=? WHERE id=?",
          )
          .run(sourceKind, timestamp, id);
      } else {
        this.#domain.db
          .prepare(
            `INSERT INTO v2_profile_provider_links(
               id,connection_id,profile_id,runtime_kind,provider_ref,model_ref,profile_ref,source_kind,state,created_at,updated_at
             ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            input.connectionId,
            profileId,
            input.runtimeKind,
            clean(input.providerRef, 160),
            clean(input.modelRef, 240),
            clean(input.profileRef, 160),
            sourceKind,
            'ACTIVE',
            timestamp,
            timestamp,
          );
      }
      this.#domain.emit({
        type: existing ? 'profile_provider_link.updated' : 'profile_provider_link.created',
        entityType: 'ProfileProviderLink',
        entityId: id,
        payload: { connectionId: input.connectionId, profileId, runtimeKind: input.runtimeKind },
      });
      return this.listProfileLinks(profileId).find((item) => String(item.id) === id)!;
    });
  }

  getConnection(id: string): V2Row | null {
    const value = row(
      this.#domain.db.prepare('SELECT * FROM v2_provider_connections WHERE id=?').get(id),
    );
    return value ? this.#presentConnection(value) : null;
  }

  listConnections(includeRetired = false): V2Row[] {
    return rows(
      this.#domain.db
        .prepare(
          `SELECT pc.*,s.name supplier_name,s.slug supplier_slug,s.website_url supplier_website_url,
             (SELECT COUNT(*) FROM v2_profile_provider_links pl WHERE pl.connection_id=pc.id AND pl.state='ACTIVE') profile_count
           FROM v2_provider_connections pc
           LEFT JOIN v2_suppliers s ON s.id=pc.supplier_id
           ${includeRetired ? '' : "WHERE pc.lifecycle='ACTIVE'"}
           ORDER BY pc.display_name,pc.provider_key,pc.id`,
        )
        .all(),
    ).map((item) => this.#presentConnection(item));
  }

  listProfileLinks(profileId?: string): V2Row[] {
    const values = profileId
      ? this.#domain.db
          .prepare(
            `SELECT pl.*,pc.provider_key,pc.display_name connection_name,pc.health connection_health
             FROM v2_profile_provider_links pl JOIN v2_provider_connections pc ON pc.id=pl.connection_id
             WHERE pl.profile_id=? AND pl.state='ACTIVE' ORDER BY pl.runtime_kind,pc.display_name,pl.id`,
          )
          .all(profileId)
      : this.#domain.db
          .prepare(
            `SELECT pl.*,pc.provider_key,pc.display_name connection_name,pc.health connection_health
             FROM v2_profile_provider_links pl JOIN v2_provider_connections pc ON pc.id=pl.connection_id
             WHERE pl.state='ACTIVE' ORDER BY pl.profile_id,pl.runtime_kind,pc.display_name,pl.id`,
          )
          .all();
    return rows(values).map((value) => ({ ...value }));
  }

  projection(): V2Row {
    const items = this.listConnections();
    const links = this.listProfileLinks();
    const byConnection = new Map<string, V2Row[]>();
    for (const link of links) {
      const key = String(link.connection_id);
      const list = byConnection.get(key) ?? [];
      list.push(link);
      byConnection.set(key, list);
    }
    return {
      summary: {
        connections: items.length,
        ready: items.filter((item) => item.health === 'READY').length,
        shared: items.filter((item) => item.share_scope === 'GLOBAL').length,
        profiles: new Set(links.map((item) => String(item.profile_id))).size,
      },
      items: items.map((item) => ({
        ...item,
        profileLinks: byConnection.get(String(item.id)) ?? [],
      })),
    };
  }

  #presentConnection(value: V2Row): V2Row {
    return {
      ...value,
      models: parseJson<string[]>(value.models_json, []),
      metadata: parseJson<JsonRecord>(value.metadata_json, {}),
      supplier: value.supplier_id
        ? {
            id: value.supplier_id,
            name: value.supplier_name ?? null,
            slug: value.supplier_slug ?? null,
            websiteUrl: value.supplier_website_url ?? null,
          }
        : null,
    };
  }
}
