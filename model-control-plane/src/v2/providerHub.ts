import { newId } from './ids.js';
import type { V2Repository, V2Row } from './repository.js';

type JsonRecord = Record<string, unknown>;

export type ProviderAuthKind = 'API_KEY' | 'OAUTH' | 'SUBSCRIPTION' | 'ACCOUNT_POOL' | 'NONE';
export type ProviderCredentialScope = 'GLOBAL' | 'PROFILE_LOCAL' | 'OAUTH_PROFILE' | 'EXTERNAL';
export type ProviderHealth = 'UNKNOWN' | 'READY' | 'DEGRADED' | 'UNAVAILABLE';
export type ProviderAdminState = 'ENABLED' | 'DISABLED';
export type ProviderAvailabilityState =
  'UNKNOWN' | 'AVAILABLE' | 'DEGRADED' | 'CONGESTED' | 'TEMP_UNAVAILABLE' | 'UNAVAILABLE';
export type ProviderShareScope = 'GLOBAL' | 'PROFILE_ONLY';
export type ProfileProviderRuntime = 'HERMES' | 'OPENCODE' | 'CODEX' | 'CLAUDE_CODE';
export type ProviderAttemptOutcome = 'SUCCESS' | 'FAILURE' | 'THROTTLED';
export type ProviderErrorKind =
  'RATE_LIMIT' | 'AUTH' | 'QUOTA' | 'NETWORK' | 'TIMEOUT' | 'SERVER' | 'CLIENT' | 'UNKNOWN';

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
  adminState?: ProviderAdminState;
  availabilityState?: ProviderAvailabilityState;
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

export interface ProviderAttemptInput {
  outcome: ProviderAttemptOutcome;
  errorKind?: ProviderErrorKind | string;
  httpStatus?: number;
  message?: string;
  observedAt?: number;
  source?: string;
  retryAfterAt?: number;
  retryAfterSeconds?: number;
  metadata?: JsonRecord;
}

export interface ProviderControlInput {
  enabled: boolean;
  reason?: string;
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
function redactMessage(text: unknown, max = 500): string | null {
  if (typeof text !== 'string') return null;
  let cleaned = text.trim();
  if (!cleaned) return null;
  cleaned = cleaned.replace(
    /(?:sk-[a-zA-Z0-9_-]{8,}|bearer\s+[a-zA-Z0-9._-]+|key=[a-zA-Z0-9._-]+|token=[a-zA-Z0-9._-]+|password=[^\s;&]+)/gi,
    '[REDACTED]',
  );
  if (cleaned.length > max) {
    cleaned = cleaned.slice(0, max);
  }
  return cleaned || null;
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
      const adminState =
        input.adminState ?? (existing?.admin_state as ProviderAdminState) ?? 'ENABLED';
      const availabilityState =
        input.availabilityState ??
        (existing?.availability_state as ProviderAvailabilityState) ??
        'UNKNOWN';
      const storedHealth: ProviderHealth =
        adminState === 'DISABLED'
          ? 'UNAVAILABLE'
          : availabilityState === 'AVAILABLE'
            ? 'READY'
            : availabilityState === 'UNAVAILABLE'
              ? 'UNAVAILABLE'
              : availabilityState === 'DEGRADED' || availabilityState === 'CONGESTED'
                ? 'DEGRADED'
                : 'UNKNOWN';
      if (existing) {
        this.#domain.db
          .prepare(
            `UPDATE v2_provider_connections SET
               display_name=?,supplier_id=?,website_url=?,protocol=?,auth_kind=?,credential_scope=?,source_kind=?,share_scope=?,health=?,admin_state=?,availability_state=?,models_json=?,metadata_json=?,lifecycle='ACTIVE',last_seen_at=?,updated_at=?
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
            storedHealth,
            adminState,
            availabilityState,
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
               source_profile_id,source_kind,share_scope,health,admin_state,availability_state,consecutive_failures,total_successes,total_failures,
               models_json,metadata_json,lifecycle,last_seen_at,created_at,updated_at
             ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,?,?,?,?,?,?)`,
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
            storedHealth,
            adminState,
            availabilityState,
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

  recordAttempt(connectionId: string, input: ProviderAttemptInput): V2Row {
    const connection = row(
      this.#domain.db.prepare('SELECT * FROM v2_provider_connections WHERE id=?').get(connectionId),
    );
    if (!connection) throw new Error('PROVIDER_CONNECTION_NOT_FOUND');

    const outcome = String(input.outcome ?? '').toUpperCase() as ProviderAttemptOutcome;
    if (!['SUCCESS', 'FAILURE', 'THROTTLED'].includes(outcome)) {
      throw new Error('PROVIDER_ATTEMPT_OUTCOME_INVALID');
    }

    const rawErrorKind = input.errorKind ? String(input.errorKind).toUpperCase() : undefined;
    const validErrorKinds: ProviderErrorKind[] = [
      'RATE_LIMIT',
      'AUTH',
      'QUOTA',
      'NETWORK',
      'TIMEOUT',
      'SERVER',
      'CLIENT',
      'UNKNOWN',
    ];
    let errorKind: ProviderErrorKind | undefined = undefined;
    if (rawErrorKind) {
      if (!validErrorKinds.includes(rawErrorKind as ProviderErrorKind)) {
        throw new Error('PROVIDER_ATTEMPT_ERROR_KIND_INVALID');
      }
      errorKind = rawErrorKind as ProviderErrorKind;
    }

    const httpStatus = Number.isInteger(input.httpStatus) ? Number(input.httpStatus) : undefined;
    const message = redactMessage(input.message);
    const observedAt = Number(input.observedAt ?? Date.now());
    const source = clean(input.source, 120) ?? 'HERMES_PLUGIN';
    const meta = safeJson(input.metadata);

    let retryAfterAt: number | null = null;
    if (Number.isFinite(input.retryAfterAt)) {
      retryAfterAt = Math.trunc(input.retryAfterAt!);
    } else if (Number.isFinite(input.retryAfterSeconds)) {
      retryAfterAt = observedAt + Math.trunc(input.retryAfterSeconds! * 1000);
    }

    return this.#domain.transaction(() => {
      const attemptId = newId('patt', observedAt);

      const adminState = (connection.admin_state as ProviderAdminState) ?? 'ENABLED';
      let availabilityState =
        (connection.availability_state as ProviderAvailabilityState) ?? 'UNKNOWN';
      let consecutiveFailures = Number(connection.consecutive_failures ?? 0);
      let totalSuccesses = Number(connection.total_successes ?? 0);
      let totalFailures = Number(connection.total_failures ?? 0);
      let lastSuccessAt = connection.last_success_at ? Number(connection.last_success_at) : null;
      let lastFailureAt = connection.last_failure_at ? Number(connection.last_failure_at) : null;
      let lastErrorKind: string | null = connection.last_error_kind
        ? String(connection.last_error_kind)
        : null;
      let lastErrorStatus: number | null = connection.last_error_status
        ? Number(connection.last_error_status)
        : null;
      let lastErrorMessage: string | null = connection.last_error_message
        ? String(connection.last_error_message)
        : null;
      let computedRetryAfterAt: number | null = retryAfterAt;
      let stateChangedAt = connection.state_changed_at ? Number(connection.state_changed_at) : null;

      if (outcome === 'SUCCESS') {
        const nextAvailability = 'AVAILABLE';
        if (availabilityState !== nextAvailability) {
          availabilityState = nextAvailability;
          stateChangedAt = observedAt;
        }
        consecutiveFailures = 0;
        totalSuccesses += 1;
        lastSuccessAt = observedAt;
        computedRetryAfterAt = null;
      } else if (outcome === 'THROTTLED' || errorKind === 'RATE_LIMIT' || httpStatus === 429) {
        const nextAvailability = 'CONGESTED';
        if (availabilityState !== nextAvailability) {
          availabilityState = nextAvailability;
          stateChangedAt = observedAt;
        }
        consecutiveFailures += 1;
        totalFailures += 1;
        lastFailureAt = observedAt;
        lastErrorKind = errorKind ?? 'RATE_LIMIT';
        lastErrorStatus = httpStatus ?? 429;
        lastErrorMessage = message;
        if (computedRetryAfterAt == null) {
          computedRetryAfterAt = observedAt + 30_000;
        }
      } else if (errorKind === 'AUTH' || httpStatus === 401 || httpStatus === 403) {
        const nextAvailability = 'UNAVAILABLE';
        if (availabilityState !== nextAvailability) {
          availabilityState = nextAvailability;
          stateChangedAt = observedAt;
        }
        consecutiveFailures += 1;
        totalFailures += 1;
        lastFailureAt = observedAt;
        lastErrorKind = 'AUTH';
        lastErrorStatus = httpStatus ?? 401;
        lastErrorMessage = message;
        computedRetryAfterAt = null;
      } else if (errorKind === 'QUOTA') {
        const nextAvailability = 'UNAVAILABLE';
        if (availabilityState !== nextAvailability) {
          availabilityState = nextAvailability;
          stateChangedAt = observedAt;
        }
        consecutiveFailures += 1;
        totalFailures += 1;
        lastFailureAt = observedAt;
        lastErrorKind = 'QUOTA';
        lastErrorStatus = httpStatus ?? 402;
        lastErrorMessage = message;
        computedRetryAfterAt = null;
      } else {
        consecutiveFailures += 1;
        totalFailures += 1;
        lastFailureAt = observedAt;
        lastErrorKind = errorKind ?? (httpStatus && httpStatus >= 500 ? 'SERVER' : 'UNKNOWN');
        lastErrorStatus = httpStatus ?? null;
        lastErrorMessage = message;
        if (consecutiveFailures >= 3) {
          const nextAvailability = 'TEMP_UNAVAILABLE';
          if (availabilityState !== nextAvailability) {
            availabilityState = nextAvailability;
            stateChangedAt = observedAt;
          }
          if (computedRetryAfterAt == null) {
            const backoff = Math.min(300_000, 15_000 * Math.pow(2, consecutiveFailures - 3));
            computedRetryAfterAt = observedAt + backoff;
          }
        } else {
          const nextAvailability = 'DEGRADED';
          if (availabilityState !== nextAvailability) {
            availabilityState = nextAvailability;
            stateChangedAt = observedAt;
          }
          computedRetryAfterAt = null;
        }
      }

      this.#domain.db
        .prepare(
          `INSERT INTO v2_provider_connection_attempts(
             id, connection_id, outcome, error_kind, http_status, error_message,
             observed_at, source, retry_after_at, metadata_json
           ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          attemptId,
          connectionId,
          outcome,
          errorKind ?? (outcome === 'SUCCESS' ? null : (lastErrorKind ?? 'UNKNOWN')),
          httpStatus ?? null,
          message,
          observedAt,
          source,
          computedRetryAfterAt,
          meta,
        );

      const inBackoff = computedRetryAfterAt !== null && computedRetryAfterAt > observedAt;
      const derivedHealth: ProviderHealth =
        adminState === 'DISABLED'
          ? 'UNAVAILABLE'
          : availabilityState === 'AVAILABLE'
            ? 'READY'
            : availabilityState === 'UNAVAILABLE'
              ? 'UNAVAILABLE'
              : availabilityState === 'CONGESTED' || availabilityState === 'DEGRADED'
                ? 'DEGRADED'
                : availabilityState === 'TEMP_UNAVAILABLE'
                  ? inBackoff
                    ? 'UNAVAILABLE'
                    : 'DEGRADED'
                  : 'UNKNOWN';

      this.#domain.db
        .prepare(
          `UPDATE v2_provider_connections SET
             health=?, availability_state=?, consecutive_failures=?, total_successes=?, total_failures=?,
             last_success_at=?, last_failure_at=?, last_error_kind=?, last_error_status=?,
             last_error_message=?, retry_after_at=?, state_changed_at=?, updated_at=?
           WHERE id=?`,
        )
        .run(
          derivedHealth,
          availabilityState,
          consecutiveFailures,
          totalSuccesses,
          totalFailures,
          lastSuccessAt,
          lastFailureAt,
          lastErrorKind,
          lastErrorStatus,
          lastErrorMessage,
          computedRetryAfterAt,
          stateChangedAt,
          observedAt,
          connectionId,
        );

      this.#domain.emit({
        type: 'provider_connection.attempt_recorded',
        entityType: 'ProviderConnection',
        entityId: connectionId,
        payload: {
          attemptId,
          outcome,
          errorKind: lastErrorKind,
          httpStatus,
          availabilityState,
          adminState,
          consecutiveFailures,
        },
      });

      return this.connectionDetail(connectionId)!;
    });
  }

  setControl(connectionId: string, input: ProviderControlInput): V2Row {
    const connection = row(
      this.#domain.db.prepare('SELECT * FROM v2_provider_connections WHERE id=?').get(connectionId),
    );
    if (!connection) throw new Error('PROVIDER_CONNECTION_NOT_FOUND');
    if (typeof input.enabled !== 'boolean') {
      throw new Error('PROVIDER_CONTROL_ENABLED_REQUIRED');
    }

    const enabled = input.enabled;
    const reason = clean(input.reason, 500);
    const timestamp = Date.now();

    return this.#domain.transaction(() => {
      const note = reason ?? (connection.operator_note ? String(connection.operator_note) : null);
      if (!enabled) {
        this.#domain.db
          .prepare(
            `UPDATE v2_provider_connections SET
               admin_state='DISABLED', health='UNAVAILABLE', operator_note=?, operator_updated_at=?, updated_at=?
             WHERE id=?`,
          )
          .run(note, timestamp, timestamp, connectionId);
      } else {
        this.#domain.db
          .prepare(
            `UPDATE v2_provider_connections SET
               admin_state='ENABLED', availability_state='UNKNOWN', health='UNKNOWN', consecutive_failures=0,
               retry_after_at=NULL, state_changed_at=?, operator_note=?, operator_updated_at=?, updated_at=?
             WHERE id=?`,
          )
          .run(timestamp, note, timestamp, timestamp, connectionId);
      }

      this.#domain.emit({
        type: 'provider_connection.control_updated',
        entityType: 'ProviderConnection',
        entityId: connectionId,
        payload: {
          adminState: enabled ? 'ENABLED' : 'DISABLED',
          reason,
        },
      });

      return this.connectionDetail(connectionId)!;
    });
  }

  listAttempts(connectionId: string, limit = 20): V2Row[] {
    const count = Math.min(100, Math.max(1, limit));
    return rows(
      this.#domain.db
        .prepare(
          `SELECT * FROM v2_provider_connection_attempts
           WHERE connection_id=? ORDER BY observed_at DESC LIMIT ?`,
        )
        .all(connectionId, count),
    ).map((item) => ({
      id: item.id,
      connectionId: item.connection_id,
      outcome: item.outcome,
      errorKind: item.error_kind,
      httpStatus: item.http_status,
      errorMessage: item.error_message,
      observedAt: item.observed_at,
      source: item.source,
      retryAfterAt: item.retry_after_at,
      metadata: parseJson<JsonRecord>(item.metadata_json, {}),
    }));
  }

  getConnection(id: string): V2Row | null {
    const value = row(
      this.#domain.db
        .prepare(
          `SELECT pc.*,s.name supplier_name,s.slug supplier_slug,s.website_url supplier_website_url
           FROM v2_provider_connections pc
           LEFT JOIN v2_suppliers s ON s.id=pc.supplier_id
           WHERE pc.id=?`,
        )
        .get(id),
    );
    return value ? this.#presentConnection(value) : null;
  }

  connectionDetail(id: string): V2Row | null {
    const connection = this.getConnection(id);
    if (!connection) return null;
    return {
      ...connection,
      profileLinks: this.listProfileLinks().filter((item) => String(item.connection_id) === id),
      recentAttempts: this.listAttempts(id, 20),
    };
  }

  summaryProjection(): V2Row {
    const items = this.listConnections();
    const links = this.listProfileLinks();
    const profileCounts = new Map<string, Set<string>>();
    for (const link of links) {
      const connectionId = String(link.connection_id);
      const profiles = profileCounts.get(connectionId) ?? new Set<string>();
      profiles.add(String(link.profile_id));
      profileCounts.set(connectionId, profiles);
    }
    return {
      summary: {
        connections: items.length,
        ready: items.filter((item) => item.health === 'READY').length,
        available: items.filter((item) => item.effectiveState === 'AVAILABLE').length,
        congested: items.filter((item) => String(item.effectiveState).startsWith('CONGESTED'))
          .length,
        unavailable: items.filter(
          (item) =>
            item.effectiveState === 'UNAVAILABLE' ||
            String(item.effectiveState).startsWith('TEMP_UNAVAILABLE'),
        ).length,
        disabled: items.filter((item) => item.adminState === 'DISABLED').length,
        shared: items.filter((item) => item.share_scope === 'GLOBAL').length,
        profiles: new Set(links.map((item) => String(item.profile_id))).size,
      },
      items: items.map((item) => ({
        id: item.id,
        providerKey: item.provider_key,
        displayName: item.display_name,
        health: item.health,
        adminState: item.adminState,
        availabilityState: item.availabilityState,
        effectiveState: item.effectiveState,
        routable: item.routable,
        retryable: item.retryable,
        authKind: item.auth_kind,
        modelCount: Array.isArray(item.models) ? item.models.length : 0,
        profileCount: profileCounts.get(String(item.id))?.size ?? 0,
        supplier: item.supplier
          ? {
              id: (item.supplier as V2Row).id,
              name: (item.supplier as V2Row).name,
              slug: (item.supplier as V2Row).slug,
            }
          : null,
      })),
    };
  }

  connectionsForSupplier(supplierId: string): V2Row[] {
    return this.listConnections()
      .filter((item) => String(item.supplier_id ?? '') === supplierId)
      .map((item) => this.connectionDetail(String(item.id)) ?? item);
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
        available: items.filter((item) => item.effectiveState === 'AVAILABLE').length,
        congested: items.filter((item) => String(item.effectiveState).startsWith('CONGESTED'))
          .length,
        unavailable: items.filter(
          (item) =>
            item.effectiveState === 'UNAVAILABLE' ||
            String(item.effectiveState).startsWith('TEMP_UNAVAILABLE'),
        ).length,
        disabled: items.filter((item) => item.adminState === 'DISABLED').length,
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
    const adminState: ProviderAdminState = (value.admin_state as ProviderAdminState) ?? 'ENABLED';
    const availabilityState: ProviderAvailabilityState =
      (value.availability_state as ProviderAvailabilityState) ?? 'UNKNOWN';
    const now = Date.now();
    const retryAfterAt = value.retry_after_at ? Number(value.retry_after_at) : null;
    const inBackoff = retryAfterAt !== null && retryAfterAt > now;

    let effectiveState: string;
    let routable: boolean;
    let retryable: boolean;
    let health: ProviderHealth;

    if (adminState === 'DISABLED') {
      effectiveState = 'DISABLED';
      routable = false;
      retryable = false;
      health = 'UNAVAILABLE';
    } else {
      switch (availabilityState) {
        case 'AVAILABLE':
          effectiveState = 'AVAILABLE';
          routable = true;
          retryable = true;
          health = 'READY';
          break;
        case 'UNKNOWN':
          effectiveState = 'UNKNOWN';
          routable = true;
          retryable = true;
          health = 'UNKNOWN';
          break;
        case 'DEGRADED':
          effectiveState = 'DEGRADED';
          routable = true;
          retryable = true;
          health = 'DEGRADED';
          break;
        case 'CONGESTED':
          effectiveState = inBackoff ? 'CONGESTED' : 'CONGESTED_RETRYABLE';
          routable = !inBackoff;
          retryable = true;
          health = 'DEGRADED';
          break;
        case 'TEMP_UNAVAILABLE':
          effectiveState = inBackoff ? 'TEMP_UNAVAILABLE' : 'TEMP_UNAVAILABLE_RETRYABLE';
          routable = !inBackoff;
          retryable = true;
          health = inBackoff ? 'UNAVAILABLE' : 'DEGRADED';
          break;
        case 'UNAVAILABLE':
        default:
          effectiveState = 'UNAVAILABLE';
          routable = false;
          retryable = false;
          health = 'UNAVAILABLE';
          break;
      }
    }

    return {
      ...value,
      adminState,
      availabilityState,
      effectiveState,
      routable,
      retryable,
      health,
      consecutiveFailures: Number(value.consecutive_failures ?? 0),
      totalSuccesses: Number(value.total_successes ?? 0),
      totalFailures: Number(value.total_failures ?? 0),
      lastSuccessAt: value.last_success_at ? Number(value.last_success_at) : null,
      lastFailureAt: value.last_failure_at ? Number(value.last_failure_at) : null,
      lastErrorKind: value.last_error_kind ?? null,
      lastErrorStatus: value.last_error_status ? Number(value.last_error_status) : null,
      lastErrorMessage: value.last_error_message ?? null,
      retryAfterAt,
      stateChangedAt: value.state_changed_at ? Number(value.state_changed_at) : null,
      operatorNote: value.operator_note ?? null,
      operatorUpdatedAt: value.operator_updated_at ? Number(value.operator_updated_at) : null,
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
