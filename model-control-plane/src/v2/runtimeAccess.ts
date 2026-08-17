import { newId } from './ids.js';
import type { V2Repository, V2Row } from './repository.js';

type JsonRecord = Record<string, unknown>;

export type RuntimeAccessKind = 'OPENCODE' | 'CODEX' | 'CLAUDE_CODE';
export type RuntimeAccessAdapterKind = 'NATIVE_CONFIG' | 'GATEWAY';

export interface RuntimeAccessInput {
  employmentId: string;
  runtimeKind: RuntimeAccessKind;
  adapterKind?: RuntimeAccessAdapterKind;
  providerRef?: string;
  modelRef: string;
  profileRef?: string;
  baseUrl?: string;
  credentialRef?: string;
  protocol?: string;
  config?: JsonRecord;
  priority?: number;
}

function row(value: unknown): V2Row | null {
  return value && typeof value === 'object' ? (value as V2Row) : null;
}

function rows(value: unknown): V2Row[] {
  return Array.isArray(value) ? (value as V2Row[]) : [];
}

function decode<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function cleanText(value: unknown, max: number): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (text.length > max) throw new Error('RUNTIME_ACCESS_FIELD_TOO_LONG');
  return text;
}

function assertSafeConfig(value: unknown, path = 'config'): void {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    if (value.length > 4000) throw new Error('RUNTIME_ACCESS_CONFIG_VALUE_TOO_LONG');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error('RUNTIME_ACCESS_CONFIG_TOO_LARGE');
    for (const item of value) assertSafeConfig(item, path);
    return;
  }
  if (typeof value !== 'object') throw new Error('RUNTIME_ACCESS_CONFIG_INVALID');
  const entries = Object.entries(value as JsonRecord);
  if (entries.length > 100) throw new Error('RUNTIME_ACCESS_CONFIG_TOO_LARGE');
  for (const [key, item] of entries) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (
      normalized.includes('apikey') ||
      normalized.includes('password') ||
      normalized.includes('secret') ||
      normalized.includes('token') ||
      normalized.includes('credential')
    ) {
      throw new Error('RUNTIME_ACCESS_CONFIG_SECRET_FIELD_FORBIDDEN');
    }
    assertSafeConfig(item, `${path}.${key}`);
  }
}

export class RuntimeAccessRepository {
  readonly #domain: V2Repository;

  constructor(domain: V2Repository) {
    this.#domain = domain;
  }

  upsert(input: RuntimeAccessInput): V2Row {
    const employment = row(
      this.#domain.db
        .prepare(
          `SELECT em.id,em.status,a.lifecycle agreement_lifecycle
           FROM v2_employments em
           JOIN v2_supply_agreements a ON a.id=em.supply_agreement_id
           WHERE em.id=?`,
        )
        .get(input.employmentId),
    );
    if (!employment) throw new Error('EMPLOYMENT_NOT_FOUND');
    if (employment.status !== 'CURRENT' || employment.agreement_lifecycle !== 'ACTIVE') {
      throw new Error('EMPLOYMENT_NOT_CURRENT');
    }

    const runtimeKind = input.runtimeKind;
    const adapterKind = input.adapterKind ?? 'NATIVE_CONFIG';
    const modelRef = cleanText(input.modelRef, 240);
    if (!modelRef) throw new Error('RUNTIME_ACCESS_MODEL_REQUIRED');
    const providerRef = cleanText(input.providerRef, 120);
    const profileRef = cleanText(input.profileRef, 120);
    const credentialRef = cleanText(input.credentialRef, 240);
    const protocol = cleanText(input.protocol, 120);
    const baseUrl = cleanText(input.baseUrl, 1000);
    if (baseUrl && !/^https?:\/\//i.test(baseUrl))
      throw new Error('RUNTIME_ACCESS_BASE_URL_INVALID');
    const config = input.config ?? {};
    assertSafeConfig(config);
    const priority = Number.isFinite(input.priority) ? Math.trunc(input.priority!) : 100;
    const timestamp = Date.now();

    const existing = row(
      this.#domain.db
        .prepare(
          `SELECT * FROM v2_runtime_access_profiles
           WHERE employment_id=? AND runtime_kind=? AND adapter_kind=?
             AND COALESCE(provider_ref,'')=COALESCE(?, '')
             AND model_ref=?
             AND COALESCE(profile_ref,'')=COALESCE(?, '')
             AND COALESCE(base_url,'')=COALESCE(?, '')`,
        )
        .get(
          input.employmentId,
          runtimeKind,
          adapterKind,
          providerRef,
          modelRef,
          profileRef,
          baseUrl,
        ),
    );

    return this.#domain.transaction(() => {
      let id: string;
      let eventType: string;
      if (existing) {
        id = String(existing.id);
        eventType = 'runtime_access.updated';
        this.#domain.db
          .prepare(
            `UPDATE v2_runtime_access_profiles
             SET credential_ref=?,protocol=?,config_json=?,priority=?,lifecycle='ACTIVE',updated_at=?
             WHERE id=?`,
          )
          .run(credentialRef, protocol, JSON.stringify(config), priority, timestamp, id);
      } else {
        id = newId('raccess', timestamp);
        eventType = 'runtime_access.created';
        this.#domain.db
          .prepare(
            `INSERT INTO v2_runtime_access_profiles(
               id,employment_id,runtime_kind,adapter_kind,provider_ref,model_ref,profile_ref,
               base_url,credential_ref,protocol,config_json,priority,lifecycle,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            input.employmentId,
            runtimeKind,
            adapterKind,
            providerRef,
            modelRef,
            profileRef,
            baseUrl?.replace(/\/$/, '') ?? null,
            credentialRef,
            protocol,
            JSON.stringify(config),
            priority,
            'ACTIVE',
            timestamp,
            timestamp,
          );
      }
      this.#domain.emit({
        type: eventType,
        entityType: 'RuntimeAccessProfile',
        entityId: id,
        payload: {
          employmentId: input.employmentId,
          runtimeKind,
          adapterKind,
          providerRef,
          modelRef,
          profileRef,
          credentialRef,
          protocol,
          priority,
        },
      });
      return this.get(id)!;
    });
  }

  importLegacySelectors(): V2Row {
    const candidates = rows(
      this.#domain.db
        .prepare(
          `SELECT em.id employment_id,mo.commercial_metadata_json
           FROM v2_employments em
           JOIN v2_model_offerings mo ON mo.id=em.model_offering_id
           WHERE em.status='CURRENT' AND em.effective_to IS NULL AND mo.lifecycle='ACTIVE'
           ORDER BY em.id`,
        )
        .all(),
    );
    let createdOrUpdated = 0;
    const imported: V2Row[] = [];
    for (const candidate of candidates) {
      const metadata = decode<JsonRecord>(candidate.commercial_metadata_json, {});
      const selectors = metadata.runtimeSelectors;
      if (!selectors || typeof selectors !== 'object' || Array.isArray(selectors)) continue;
      for (const runtimeKind of ['OPENCODE', 'CODEX'] as const) {
        const raw = (selectors as JsonRecord)[runtimeKind];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const selector = raw as JsonRecord;
        const rawModel = cleanText(selector.model, 240);
        if (!rawModel) continue;
        const rawProvider = cleanText(selector.provider, 120);
        const profileRef = cleanText(selector.profile, 120);
        let providerRef = rawProvider;
        let modelRef = rawModel;
        if (runtimeKind === 'OPENCODE' && rawModel.includes('/')) {
          const slash = rawModel.indexOf('/');
          providerRef = rawModel.slice(0, slash);
          modelRef = rawModel.slice(slash + 1);
        }
        const adapterKind: RuntimeAccessAdapterKind =
          providerRef === 'hermes-office' || profileRef === 'hermes-office'
            ? 'GATEWAY'
            : 'NATIVE_CONFIG';
        const value = this.upsert({
          employmentId: String(candidate.employment_id),
          runtimeKind,
          adapterKind,
          providerRef: providerRef ?? undefined,
          modelRef,
          profileRef: profileRef ?? undefined,
          priority: 50,
          config: { importedFrom: 'MODEL_OFFERING_RUNTIME_SELECTOR' },
        });
        imported.push(value);
        createdOrUpdated += 1;
      }
    }
    return { imported: createdOrUpdated, items: imported };
  }

  get(id: string): V2Row | null {
    const value = row(
      this.#domain.db
        .prepare(
          `SELECT r.*,e.employee_id,e.supply_agreement_id
           FROM v2_runtime_access_profiles r
           JOIN v2_employments e ON e.id=r.employment_id
           WHERE r.id=?`,
        )
        .get(id),
    );
    return value ? this.#present(value) : null;
  }

  resolve(employmentId: string, runtimeKind: RuntimeAccessKind): V2Row | null {
    const value = row(
      this.#domain.db
        .prepare(
          `SELECT r.*,e.employee_id,e.supply_agreement_id
           FROM v2_runtime_access_profiles r
           JOIN v2_employments e ON e.id=r.employment_id
           WHERE r.employment_id=? AND r.runtime_kind=? AND r.lifecycle='ACTIVE'
           ORDER BY r.priority DESC,r.created_at ASC,r.id ASC LIMIT 1`,
        )
        .get(employmentId, runtimeKind),
    );
    return value ? this.#present(value) : null;
  }

  list(employmentId?: string): V2Row[] {
    return rows(
      this.#domain.db
        .prepare(
          `SELECT r.*,e.employee_id,e.supply_agreement_id
           FROM v2_runtime_access_profiles r
           JOIN v2_employments e ON e.id=r.employment_id
           WHERE (? IS NULL OR r.employment_id=?)
           ORDER BY r.employment_id,r.runtime_kind,r.priority DESC,r.created_at,r.id`,
        )
        .all(employmentId ?? null, employmentId ?? null),
    ).map((value) => this.#present(value));
  }

  #present(value: V2Row): V2Row {
    return {
      id: value.id,
      employmentId: value.employment_id,
      employeeId: value.employee_id,
      supplyAgreementId: value.supply_agreement_id,
      runtimeKind: value.runtime_kind,
      adapterKind: value.adapter_kind,
      providerRef: value.provider_ref,
      modelRef: value.model_ref,
      profileRef: value.profile_ref,
      baseUrl: value.base_url,
      credentialRef: value.credential_ref,
      protocol: value.protocol,
      config: decode<JsonRecord>(value.config_json, {}),
      priority: Number(value.priority ?? 0),
      lifecycle: value.lifecycle,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    };
  }
}
