import type { GatewayProtocol } from '../gateway/ports.js';
import { newId } from './ids.js';
import type { V2Repository, V2Row } from './repository.js';

type JsonRecord = Record<string, unknown>;

type CapacityDimension = 'TOKENS' | 'REQUESTS' | 'COST' | 'CONCURRENCY' | 'CUSTOM';

function now(): number {
  return Date.now();
}

function encode(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function decode<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function row(value: unknown): V2Row | null {
  return value && typeof value === 'object' ? (value as V2Row) : null;
}

function rows(value: unknown): V2Row[] {
  return Array.isArray(value) ? (value as V2Row[]) : [];
}

export interface CapacityState {
  available: boolean;
  reasons: string[];
  pools: Array<{
    id: string;
    name: string;
    dimension: string;
    limit: number | null;
    remaining: number | null;
    unit: string | null;
    resetAt: number | null;
    source: string;
  }>;
}

export class SupplyRepository {
  readonly #domain: V2Repository;

  constructor(domain: V2Repository) {
    this.#domain = domain;
  }

  upsertSource(input: {
    slug: string;
    name: string;
    websiteUrl?: string;
    sourceKind?: 'EXTERNAL' | 'INTERNAL';
  }): V2Row {
    return this.#domain.getOrCreateSupplier(
      input.slug.trim(),
      input.name.trim(),
      input.websiteUrl,
      input.sourceKind ?? 'EXTERNAL',
    );
  }

  setStaffingPreferences(
    supplierId: string,
    input: { enabledEmployeeIds: string[]; defaultEmployeeId?: string | null },
  ): V2Row {
    return this.#domain.setSupplierStaffingPreferences({ supplierId, ...input });
  }

  updateSupplierProfile(supplierId: string, input: { name: string; websiteUrl?: string }): V2Row {
    const name = input.name.trim();
    if (!name) throw new Error('SUPPLIER_NAME_REQUIRED');
    const existing = row(
      this.#domain.db.prepare('SELECT * FROM v2_suppliers WHERE id=?').get(supplierId),
    );
    if (!existing) throw new Error('SUPPLIER_NOT_FOUND');
    const previousName = String(existing.name);
    const websiteUrl = input.websiteUrl?.trim().replace(/\/$/, '') || null;
    if (websiteUrl && !/^https?:\/\//i.test(websiteUrl))
      throw new Error('SUPPLIER_WEBSITE_URL_INVALID');
    if (
      previousName === name &&
      String(existing.website_url ?? '') === String(websiteUrl ?? existing.website_url ?? '')
    )
      return existing;
    const timestamp = now();
    return this.#domain.transaction(() => {
      this.#domain.db
        .prepare(
          'UPDATE v2_suppliers SET name=?,website_url=COALESCE(?,website_url),updated_at=? WHERE id=?',
        )
        .run(name, websiteUrl, timestamp, supplierId);

      const employees = rows(
        this.#domain.db
          .prepare(
            `SELECT e.id,e.display_name,sm.display_name supplier_model_name
             FROM v2_employees e
             JOIN v2_supplier_models sm ON sm.id=e.supplier_model_id
             WHERE e.supplier_id=?`,
          )
          .all(supplierId),
      );
      const updateEmployee = this.#domain.db.prepare(
        'UPDATE v2_employees SET display_name=?,updated_at=? WHERE id=?',
      );
      for (const employee of employees) {
        const generatedPreviousName = `${String(employee.supplier_model_name)} @ ${previousName}`;
        if (String(employee.display_name) !== generatedPreviousName) continue;
        updateEmployee.run(
          `${String(employee.supplier_model_name)} @ ${name}`,
          timestamp,
          String(employee.id),
        );
      }

      this.#domain.emit({
        type: 'supplier.profile.updated',
        entityType: 'Supplier',
        entityId: supplierId,
        payload: { previousName, name, websiteUrl },
      });
      return row(this.#domain.db.prepare('SELECT * FROM v2_suppliers WHERE id=?').get(supplierId))!;
    });
  }

  openRelationshipsForSupplier(supplierId: string): {
    employmentIds: string[];
    appointmentIds: string[];
  } {
    const supplier = row(
      this.#domain.db.prepare('SELECT id FROM v2_suppliers WHERE id=?').get(supplierId),
    );
    if (!supplier) throw new Error('SUPPLIER_NOT_FOUND');
    const employmentIds = rows(
      this.#domain.db
        .prepare(
          `SELECT em.id FROM v2_employments em
           JOIN v2_employees e ON e.id=em.employee_id
           WHERE e.supplier_id=?
             AND em.status IN ('SCHEDULED','CURRENT','SUSPENDED')
             AND em.effective_to IS NULL
           ORDER BY em.id`,
        )
        .all(supplierId),
    ).map((item) => String(item.id));
    const appointmentIds = rows(
      this.#domain.db
        .prepare(
          `SELECT a.id FROM v2_appointments a
           JOIN v2_employees e ON e.id=a.employee_id
           WHERE e.supplier_id=?
             AND a.status IN ('SCHEDULED','CURRENT','SUSPENDED')
             AND a.effective_to IS NULL
           ORDER BY a.id`,
        )
        .all(supplierId),
    ).map((item) => String(item.id));
    return { employmentIds, appointmentIds };
  }

  retireSupplier(supplierId: string, reason = 'OPERATOR_RETIRED'): V2Row {
    const supplier = row(
      this.#domain.db.prepare('SELECT * FROM v2_suppliers WHERE id=?').get(supplierId),
    );
    if (!supplier) throw new Error('SUPPLIER_NOT_FOUND');
    if (supplier.lifecycle === 'RETIRED') return supplier;

    const openEmploymentCount = Number(
      row(
        this.#domain.db
          .prepare(
            `SELECT COUNT(*) count
             FROM v2_employments em
             JOIN v2_employees e ON e.id=em.employee_id
             WHERE e.supplier_id=?
               AND em.status IN ('SCHEDULED','CURRENT','SUSPENDED')
               AND em.effective_to IS NULL`,
          )
          .get(supplierId),
      )?.count ?? 0,
    );
    const openAppointmentCount = Number(
      row(
        this.#domain.db
          .prepare(
            `SELECT COUNT(*) count
             FROM v2_appointments a
             JOIN v2_employees e ON e.id=a.employee_id
             WHERE e.supplier_id=?
               AND a.status IN ('SCHEDULED','CURRENT','SUSPENDED')
               AND a.effective_to IS NULL`,
          )
          .get(supplierId),
      )?.count ?? 0,
    );
    if (openEmploymentCount > 0 || openAppointmentCount > 0) {
      throw new Error('SUPPLIER_HAS_OPEN_RELATIONSHIPS');
    }

    const timestamp = now();
    return this.#domain.transaction(() => {
      this.#domain.db
        .prepare(
          `UPDATE v2_gateway_bindings
                  SET lifecycle='RETIRED',updated_at=?
                  WHERE employment_id IN (
                    SELECT em.id FROM v2_employments em
                    JOIN v2_employees e ON e.id=em.employee_id
                    WHERE e.supplier_id=?
                  ) AND lifecycle!='RETIRED'`,
        )
        .run(timestamp, supplierId);
      this.#domain.db
        .prepare(
          `UPDATE v2_runtime_access_profiles
                  SET lifecycle='RETIRED',updated_at=?
                  WHERE employment_id IN (
                    SELECT em.id FROM v2_employments em
                    JOIN v2_employees e ON e.id=em.employee_id
                    WHERE e.supplier_id=?
                  ) AND lifecycle!='RETIRED'`,
        )
        .run(timestamp, supplierId);
      this.#domain.db
        .prepare(
          `UPDATE v2_channels
                  SET lifecycle='ARCHIVED',updated_at=?
                  WHERE supply_agreement_id IN (
                    SELECT id FROM v2_supply_agreements WHERE supplier_id=?
                  ) AND lifecycle!='ARCHIVED'`,
        )
        .run(timestamp, supplierId);
      this.#domain.db
        .prepare(
          `UPDATE v2_capacity_pools
                  SET lifecycle='RETIRED',updated_at=?
                  WHERE supply_agreement_id IN (
                    SELECT id FROM v2_supply_agreements WHERE supplier_id=?
                  ) AND lifecycle!='RETIRED'`,
        )
        .run(timestamp, supplierId);
      this.#domain.db
        .prepare(
          "UPDATE v2_model_offerings SET lifecycle='RETIRED',updated_at=? WHERE supplier_id=? AND lifecycle!='RETIRED'",
        )
        .run(timestamp, supplierId);
      this.#domain.db
        .prepare(
          "UPDATE v2_plans SET lifecycle='RETIRED',updated_at=? WHERE supplier_id=? AND lifecycle!='RETIRED'",
        )
        .run(timestamp, supplierId);
      this.#domain.db
        .prepare(
          `UPDATE v2_supply_agreements
                  SET lifecycle='TERMINATED',ended_at=COALESCE(ended_at,?),updated_at=?
                  WHERE supplier_id=? AND lifecycle NOT IN ('TERMINATED','ARCHIVED')`,
        )
        .run(timestamp, timestamp, supplierId);
      this.#domain.db
        .prepare(
          `UPDATE v2_employees
                  SET record_lifecycle='RETIRED',retired_at=COALESCE(retired_at,?),updated_at=?
                  WHERE supplier_id=? AND record_lifecycle!='RETIRED'`,
        )
        .run(timestamp, timestamp, supplierId);
      this.#domain.db
        .prepare(
          `UPDATE v2_supplier_models
                  SET lifecycle='RETIRED',retired_at=COALESCE(retired_at,?)
                  WHERE supplier_id=? AND lifecycle!='RETIRED'`,
        )
        .run(timestamp, supplierId);
      this.#domain.db
        .prepare(
          `UPDATE v2_profile_provider_links
           SET state='INACTIVE',updated_at=?
           WHERE connection_id IN (
             SELECT id FROM v2_provider_connections WHERE supplier_id=?
           ) AND state='ACTIVE'`,
        )
        .run(timestamp, supplierId);
      this.#domain.db
        .prepare(
          `UPDATE v2_provider_connections
           SET lifecycle='RETIRED',admin_state='DISABLED',health='UNAVAILABLE',operator_note=?,operator_updated_at=?,updated_at=?
           WHERE supplier_id=? AND lifecycle!='RETIRED'`,
        )
        .run(reason, timestamp, timestamp, supplierId);
      this.#domain.db
        .prepare("UPDATE v2_suppliers SET lifecycle='RETIRED',updated_at=? WHERE id=?")
        .run(timestamp, supplierId);

      this.#domain.emit({
        type: 'supplier.retired',
        entityType: 'Supplier',
        entityId: supplierId,
        payload: { reason },
      });
      return row(this.#domain.db.prepare('SELECT * FROM v2_suppliers WHERE id=?').get(supplierId))!;
    });
  }

  getOrCreatePlan(input: {
    supplierId: string;
    slug: string;
    name: string;
    commercialType?: 'FREE' | 'SUBSCRIPTION' | 'PREPAID' | 'METERED' | 'SPONSORED' | 'OTHER';
    terms?: JsonRecord;
  }): V2Row {
    const existing = row(
      this.#domain.db
        .prepare('SELECT * FROM v2_plans WHERE supplier_id=? AND slug=?')
        .get(input.supplierId, input.slug),
    );
    if (existing) return existing;
    const timestamp = now();
    const id = newId('plan', timestamp);
    return this.#domain.transaction(() => {
      this.#domain.db
        .prepare(
          `INSERT INTO v2_plans(id,supplier_id,slug,name,commercial_type,terms_json,lifecycle,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?, ?,?)`,
        )
        .run(
          id,
          input.supplierId,
          input.slug,
          input.name,
          input.commercialType ?? 'METERED',
          encode(input.terms),
          'ACTIVE',
          timestamp,
          timestamp,
        );
      this.#domain.emit({
        type: 'plan.created',
        entityType: 'Plan',
        entityId: id,
        payload: { supplierId: input.supplierId, slug: input.slug },
      });
      return row(this.#domain.db.prepare('SELECT * FROM v2_plans WHERE id=?').get(id))!;
    });
  }

  listPlans(supplierId?: string): V2Row[] {
    return rows(
      this.#domain.db
        .prepare(
          `SELECT p.*,s.slug supplier_slug,s.name supplier_name
           FROM v2_plans p JOIN v2_suppliers s ON s.id=p.supplier_id
           WHERE (? IS NULL OR p.supplier_id=?) ORDER BY s.name,p.name`,
        )
        .all(supplierId ?? null, supplierId ?? null),
    ).map((value) => ({
      id: value.id,
      supplierId: value.supplier_id,
      supplierSlug: value.supplier_slug,
      supplierName: value.supplier_name,
      slug: value.slug,
      name: value.name,
      commercialType: value.commercial_type,
      lifecycle: value.lifecycle,
      terms: decode<JsonRecord>(value.terms_json, {}),
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    }));
  }

  getOrCreateModelOffering(input: {
    supplierId: string;
    supplierModelId: string;
    planId?: string;
    supplyAgreementId?: string;
    advertisedCapabilities?: string[];
    protocolOptions?: string[];
    commercialMetadata?: JsonRecord;
    validFrom?: number;
    validTo?: number;
  }): V2Row {
    const existing = row(
      this.#domain.db
        .prepare(
          `SELECT * FROM v2_model_offerings
           WHERE supplier_model_id=? AND plan_id IS ? AND supply_agreement_id IS ?`,
        )
        .get(input.supplierModelId, input.planId ?? null, input.supplyAgreementId ?? null),
    );
    if (existing) return existing;
    const timestamp = now();
    const id = newId('off', timestamp);
    return this.#domain.transaction(() => {
      this.#domain.db
        .prepare(
          `INSERT INTO v2_model_offerings(
             id,supplier_id,supplier_model_id,plan_id,supply_agreement_id,lifecycle,
             advertised_capabilities_json,protocol_options_json,commercial_metadata_json,
             valid_from,valid_to,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.supplierId,
          input.supplierModelId,
          input.planId ?? null,
          input.supplyAgreementId ?? null,
          'ACTIVE',
          encode(input.advertisedCapabilities ?? []),
          encode(input.protocolOptions ?? []),
          encode(input.commercialMetadata),
          input.validFrom ?? null,
          input.validTo ?? null,
          timestamp,
          timestamp,
        );
      this.#domain.emit({
        type: 'model_offering.created',
        entityType: 'ModelOffering',
        entityId: id,
        payload: {
          supplierId: input.supplierId,
          supplierModelId: input.supplierModelId,
          planId: input.planId ?? null,
          supplyAgreementId: input.supplyAgreementId ?? null,
        },
      });
      return row(this.#domain.db.prepare('SELECT * FROM v2_model_offerings WHERE id=?').get(id))!;
    });
  }

  listModelOfferings(filters: { supplierId?: string; agreementId?: string } = {}): V2Row[] {
    return rows(
      this.#domain.db
        .prepare(
          `SELECT o.*,s.name supplier_name,sm.display_name supplier_model_name,p.name plan_name,a.name agreement_name
           FROM v2_model_offerings o
           JOIN v2_suppliers s ON s.id=o.supplier_id
           JOIN v2_supplier_models sm ON sm.id=o.supplier_model_id
           LEFT JOIN v2_plans p ON p.id=o.plan_id
           LEFT JOIN v2_supply_agreements a ON a.id=o.supply_agreement_id
           WHERE (? IS NULL OR o.supplier_id=?) AND (? IS NULL OR o.supply_agreement_id=?)
           ORDER BY s.name,sm.display_name`,
        )
        .all(
          filters.supplierId ?? null,
          filters.supplierId ?? null,
          filters.agreementId ?? null,
          filters.agreementId ?? null,
        ),
    ).map((value) => ({
      id: value.id,
      supplierId: value.supplier_id,
      supplierName: value.supplier_name,
      supplierModelId: value.supplier_model_id,
      supplierModelName: value.supplier_model_name,
      planId: value.plan_id,
      planName: value.plan_name,
      supplyAgreementId: value.supply_agreement_id,
      agreementName: value.agreement_name,
      lifecycle: value.lifecycle,
      advertisedCapabilities: decode<string[]>(value.advertised_capabilities_json, []),
      protocolOptions: decode<string[]>(value.protocol_options_json, []),
      commercialMetadata: decode<JsonRecord>(value.commercial_metadata_json, {}),
      validFrom: value.valid_from,
      validTo: value.valid_to,
    }));
  }

  upsertCapacityPool(input: {
    supplyAgreementId: string;
    name: string;
    dimension: CapacityDimension;
    limit?: number;
    remaining?: number;
    unit?: string;
    resetPolicy?: JsonRecord;
    resetAt?: number;
    lifecycle?: 'ACTIVE' | 'SUSPENDED' | 'RETIRED';
    source: string;
    metadata?: JsonRecord;
    observedAt?: number;
  }): V2Row {
    const timestamp = now();
    const existing = row(
      this.#domain.db
        .prepare(
          `SELECT * FROM v2_capacity_pools
           WHERE supply_agreement_id=? AND name=? AND dimension=?`,
        )
        .get(input.supplyAgreementId, input.name, input.dimension),
    );
    return this.#domain.transaction(() => {
      let id: string;
      if (existing) {
        id = String(existing.id);
        this.#domain.db
          .prepare(
            `UPDATE v2_capacity_pools SET limit_value=?,remaining_value=?,unit=?,reset_policy_json=?,
               reset_at=?,lifecycle=?,source=?,metadata_json=?,observed_at=?,updated_at=? WHERE id=?`,
          )
          .run(
            input.limit ?? null,
            input.remaining ?? null,
            input.unit ?? null,
            encode(input.resetPolicy),
            input.resetAt ?? null,
            input.lifecycle ?? String(existing.lifecycle),
            input.source,
            encode(input.metadata),
            input.observedAt ?? timestamp,
            timestamp,
            id,
          );
      } else {
        id = newId('pool', timestamp);
        this.#domain.db
          .prepare(
            `INSERT INTO v2_capacity_pools(
               id,supply_agreement_id,name,dimension,limit_value,remaining_value,unit,reset_policy_json,
               reset_at,lifecycle,source,metadata_json,observed_at,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            input.supplyAgreementId,
            input.name,
            input.dimension,
            input.limit ?? null,
            input.remaining ?? null,
            input.unit ?? null,
            encode(input.resetPolicy),
            input.resetAt ?? null,
            input.lifecycle ?? 'ACTIVE',
            input.source,
            encode(input.metadata),
            input.observedAt ?? timestamp,
            timestamp,
            timestamp,
          );
      }
      this.#domain.emit({
        type: 'capacity_pool.observed',
        entityType: 'CapacityPool',
        entityId: id,
        payload: {
          supplyAgreementId: input.supplyAgreementId,
          dimension: input.dimension,
          limit: input.limit ?? null,
          remaining: input.remaining ?? null,
          source: input.source,
        },
      });
      return row(this.#domain.db.prepare('SELECT * FROM v2_capacity_pools WHERE id=?').get(id))!;
    });
  }

  listSupplyAgreements(supplierId?: string): V2Row[] {
    return rows(
      this.#domain.db
        .prepare(
          `SELECT a.*,s.slug supplier_slug,s.name supplier_name,p.slug plan_slug,p.name plan_name
           FROM v2_supply_agreements a
           JOIN v2_suppliers s ON s.id=a.supplier_id
           LEFT JOIN v2_plans p ON p.id=a.plan_id
           WHERE (? IS NULL OR a.supplier_id=?) ORDER BY s.name,a.name,a.valid_from DESC`,
        )
        .all(supplierId ?? null, supplierId ?? null),
    ).map((value) => ({
      id: value.id,
      supplierId: value.supplier_id,
      supplierSlug: value.supplier_slug,
      supplierName: value.supplier_name,
      planId: value.plan_id,
      planSlug: value.plan_slug,
      planName: value.plan_name,
      name: value.name,
      externalAccountRef: value.external_account_ref,
      lifecycle: value.lifecycle,
      validFrom: value.valid_from,
      validTo: value.valid_to,
      fixedCost: value.fixed_cost == null ? null : Number(value.fixed_cost),
      currency: value.currency,
      billingPeriod: value.billing_period,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
  }

  updateAgreementCommercialTerms(
    agreementId: string,
    input: { fixedCost?: number | null; currency?: string | null; billingPeriod?: string | null },
  ): V2Row {
    const existing = row(
      this.#domain.db.prepare('SELECT * FROM v2_supply_agreements WHERE id=?').get(agreementId),
    );
    if (!existing) throw new Error('SUPPLY_AGREEMENT_NOT_FOUND');
    const timestamp = now();
    return this.#domain.transaction(() => {
      this.#domain.db
        .prepare(
          `UPDATE v2_supply_agreements SET fixed_cost=?,currency=?,billing_period=?,updated_at=? WHERE id=?`,
        )
        .run(
          input.fixedCost === undefined
            ? existing.fixed_cost == null
              ? null
              : Number(existing.fixed_cost)
            : input.fixedCost,
          input.currency === undefined
            ? existing.currency == null
              ? null
              : String(existing.currency)
            : input.currency,
          input.billingPeriod === undefined
            ? existing.billing_period == null
              ? null
              : String(existing.billing_period)
            : input.billingPeriod,
          timestamp,
          agreementId,
        );
      this.#domain.emit({
        type: 'supply_agreement.commercial_terms.changed',
        entityType: 'SupplyAgreement',
        entityId: agreementId,
        payload: {
          fixedCost:
            input.fixedCost === undefined
              ? existing.fixed_cost == null
                ? null
                : Number(existing.fixed_cost)
              : input.fixedCost,
          currency:
            input.currency === undefined
              ? existing.currency == null
                ? null
                : String(existing.currency)
              : input.currency,
          billingPeriod:
            input.billingPeriod === undefined
              ? existing.billing_period == null
                ? null
                : String(existing.billing_period)
              : input.billingPeriod,
        },
      });
      return row(
        this.#domain.db.prepare('SELECT * FROM v2_supply_agreements WHERE id=?').get(agreementId),
      )!;
    });
  }

  assignPlanToAgreement(agreementId: string, planId: string): V2Row {
    const joined = row(
      this.#domain.db
        .prepare(
          `SELECT a.id agreement_id,a.supplier_id agreement_supplier_id,p.supplier_id plan_supplier_id
           FROM v2_supply_agreements a JOIN v2_plans p ON p.id=? WHERE a.id=?`,
        )
        .get(planId, agreementId),
    );
    if (!joined) throw new Error('AGREEMENT_OR_PLAN_NOT_FOUND');
    if (joined.agreement_supplier_id !== joined.plan_supplier_id) {
      throw new Error('PLAN_SUPPLIER_MISMATCH');
    }
    const timestamp = now();
    return this.#domain.transaction(() => {
      this.#domain.db
        .prepare('UPDATE v2_supply_agreements SET plan_id=?,updated_at=? WHERE id=?')
        .run(planId, timestamp, agreementId);
      this.#domain.emit({
        type: 'supply_agreement.plan_assigned',
        entityType: 'SupplyAgreement',
        entityId: agreementId,
        payload: { planId },
      });
      return row(
        this.#domain.db.prepare('SELECT * FROM v2_supply_agreements WHERE id=?').get(agreementId),
      )!;
    });
  }

  assignOfferingToEmployment(employmentId: string, offeringId: string): V2Row {
    const joined = row(
      this.#domain.db
        .prepare(
          `SELECT em.id employment_id,e.supplier_id employee_supplier_id,e.supplier_model_id employee_model_id,
                  o.supplier_id offering_supplier_id,o.supplier_model_id offering_model_id,
                  o.supply_agreement_id offering_agreement_id,em.supply_agreement_id
           FROM v2_employments em
           JOIN v2_employees e ON e.id=em.employee_id
           JOIN v2_model_offerings o ON o.id=?
           WHERE em.id=?`,
        )
        .get(offeringId, employmentId),
    );
    if (!joined) throw new Error('EMPLOYMENT_OR_OFFERING_NOT_FOUND');
    if (
      joined.employee_supplier_id !== joined.offering_supplier_id ||
      joined.employee_model_id !== joined.offering_model_id
    ) {
      throw new Error('OFFERING_EMPLOYEE_IDENTITY_MISMATCH');
    }
    if (
      joined.offering_agreement_id &&
      joined.offering_agreement_id !== joined.supply_agreement_id
    ) {
      throw new Error('OFFERING_AGREEMENT_MISMATCH');
    }
    const timestamp = now();
    return this.#domain.transaction(() => {
      this.#domain.db
        .prepare('UPDATE v2_employments SET model_offering_id=?,updated_at=? WHERE id=?')
        .run(offeringId, timestamp, employmentId);
      this.#domain.emit({
        type: 'employment.offering_assigned',
        entityType: 'Employment',
        entityId: employmentId,
        payload: { offeringId },
      });
      return row(
        this.#domain.db.prepare('SELECT * FROM v2_employments WHERE id=?').get(employmentId),
      )!;
    });
  }

  listCapacityPools(supplyAgreementId?: string): V2Row[] {
    return rows(
      this.#domain.db
        .prepare(
          `SELECT p.*,a.name agreement_name,s.name supplier_name
           FROM v2_capacity_pools p
           JOIN v2_supply_agreements a ON a.id=p.supply_agreement_id
           JOIN v2_suppliers s ON s.id=a.supplier_id
           WHERE (? IS NULL OR p.supply_agreement_id=?)
           ORDER BY s.name,a.name,p.dimension,p.name`,
        )
        .all(supplyAgreementId ?? null, supplyAgreementId ?? null),
    ).map((value) => ({
      id: value.id,
      supplyAgreementId: value.supply_agreement_id,
      agreementName: value.agreement_name,
      supplierName: value.supplier_name,
      name: value.name,
      dimension: value.dimension,
      limit: value.limit_value == null ? null : Number(value.limit_value),
      remaining: value.remaining_value == null ? null : Number(value.remaining_value),
      unit: value.unit,
      resetPolicy: decode<JsonRecord>(value.reset_policy_json, {}),
      resetAt: value.reset_at,
      lifecycle: value.lifecycle,
      source: value.source,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
      observedAt: value.observed_at,
      updatedAt: value.updated_at,
    }));
  }

  setRuntimeSelectors(offeringId: string, runtimeSelectors: JsonRecord): V2Row {
    const existing = row(
      this.#domain.db.prepare('SELECT * FROM v2_model_offerings WHERE id=?').get(offeringId),
    );
    if (!existing) throw new Error('MODEL_OFFERING_NOT_FOUND');
    const current = decode<JsonRecord>(existing.commercial_metadata_json, {});
    const normalized: JsonRecord = {};
    for (const runtimeKind of ['OPENCODE', 'CODEX']) {
      const value = runtimeSelectors[runtimeKind];
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const selector = value as JsonRecord;
      const model = typeof selector.model === 'string' ? selector.model.trim() : '';
      if (!model || model.length > 240) continue;
      const profile = typeof selector.profile === 'string' ? selector.profile.trim() : '';
      const provider = typeof selector.provider === 'string' ? selector.provider.trim() : '';
      normalized[runtimeKind] = {
        model,
        ...(profile ? { profile: profile.slice(0, 120) } : {}),
        ...(provider ? { provider: provider.slice(0, 120) } : {}),
      };
    }
    if (Object.keys(normalized).length === 0) throw new Error('RUNTIME_SELECTOR_REQUIRED');
    const next = { ...current, runtimeSelectors: normalized };
    const timestamp = now();
    this.#domain.db
      .prepare('UPDATE v2_model_offerings SET commercial_metadata_json=?,updated_at=? WHERE id=?')
      .run(encode(next), timestamp, offeringId);
    this.#domain.emit({
      type: 'model_offering.runtime_selectors.changed',
      entityType: 'ModelOffering',
      entityId: offeringId,
      payload: { runtimeKinds: Object.keys(normalized) },
    });
    return row(
      this.#domain.db.prepare('SELECT * FROM v2_model_offerings WHERE id=?').get(offeringId),
    )!;
  }

  registerCatalogEntry(input: {
    supplier: {
      slug: string;
      name: string;
      websiteUrl?: string;
      sourceKind?: 'EXTERNAL' | 'INTERNAL';
    };
    supplierModel: { key: string; name: string };
    agreement: { externalAccountRef: string; name: string };
    plan?: {
      slug: string;
      name: string;
      commercialType?: 'FREE' | 'SUBSCRIPTION' | 'PREPAID' | 'METERED' | 'SPONSORED' | 'OTHER';
    };
    gatewayRoute?: {
      gatewaySlug: string;
      externalRouteRef: string;
      activateBinding?: boolean;
    };
    runtimeSelectors?: JsonRecord;
  }): V2Row {
    return this.#domain.transaction(() => {
      const supplier = this.#domain.getOrCreateSupplier(
        input.supplier.slug,
        input.supplier.name,
        input.supplier.websiteUrl,
        input.supplier.sourceKind ?? 'EXTERNAL',
      );
      const supplierModel = this.#domain.getOrCreateSupplierModel({
        supplierId: String(supplier.id),
        supplierModelKey: input.supplierModel.key,
        displayName: input.supplierModel.name,
      });
      const employee = this.#domain.getOrCreateEmployee({
        supplierId: String(supplier.id),
        supplierModelId: String(supplierModel.id),
        displayName: `${input.supplierModel.name} @ ${input.supplier.name}`,
      });
      const agreement = this.#domain.getOrCreateAgreement({
        supplierId: String(supplier.id),
        externalAccountRef: input.agreement.externalAccountRef,
        name: input.agreement.name,
      });
      const employment = this.#domain.getOrCreateCurrentEmployment({
        employeeId: String(employee.id),
        supplyAgreementId: String(agreement.id),
      });

      let plan: V2Row | null = null;
      if (input.plan) {
        plan = this.getOrCreatePlan({
          supplierId: String(supplier.id),
          slug: input.plan.slug,
          name: input.plan.name,
          commercialType: input.plan.commercialType,
        });
        this.assignPlanToAgreement(String(agreement.id), String(plan.id));
      }
      let offering = this.getOrCreateModelOffering({
        supplierId: String(supplier.id),
        supplierModelId: String(supplierModel.id),
        planId: plan ? String(plan.id) : undefined,
        supplyAgreementId: String(agreement.id),
      });
      if (input.runtimeSelectors && Object.keys(input.runtimeSelectors).length > 0) {
        offering = this.setRuntimeSelectors(String(offering.id), input.runtimeSelectors);
      }
      this.assignOfferingToEmployment(String(employment.id), String(offering.id));

      let channel: V2Row | null = null;
      let binding: V2Row | null = null;
      if (input.gatewayRoute) {
        const gateway = this.#domain.findGatewayBySlug(input.gatewayRoute.gatewaySlug);
        if (!gateway) throw new Error('GATEWAY_NOT_FOUND');
        channel =
          this.#domain
            .listChannels(input.gatewayRoute.gatewaySlug)
            .find((item) => item.externalRouteRef === input.gatewayRoute!.externalRouteRef) ?? null;
        if (!channel) throw new Error('GATEWAY_CHANNEL_NOT_FOUND');
        const protocol = String(channel.protocol ?? 'unknown') as GatewayProtocol;
        this.#domain.upsertChannelObservation({
          gatewayId: String(channel.gatewayId),
          supplyAgreementId: String(agreement.id),
          externalRouteRef: String(channel.externalRouteRef),
          name: String(channel.name),
          protocol,
          health: String(channel.health) as 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN',
          lifecycle: String(channel.lifecycle) as 'ENABLED' | 'DISABLED',
          supplierHint: input.supplier.slug,
          supplierModelHint: input.supplierModel.key,
          capabilities: Array.isArray(channel.capabilities) ? channel.capabilities.map(String) : [],
          metadata: {
            ...(channel.metadata && typeof channel.metadata === 'object'
              ? (channel.metadata as JsonRecord)
              : {}),
            commercialClassification: 'EXPLICIT_V2_CATALOG',
          },
          observedAt: Number(channel.lastSeenAt ?? now()),
        });
        if (input.gatewayRoute.activateBinding) {
          binding = this.#domain.getOrCreateGatewayBinding({
            employmentId: String(employment.id),
            gatewayId: String(gateway.id),
            externalRouteRef: input.gatewayRoute.externalRouteRef,
            protocol,
          });
        }
      }

      this.#domain.emit({
        type: 'supply.catalog.registered',
        entityType: 'Employment',
        entityId: String(employment.id),
        payload: {
          supplierId: supplier.id,
          supplierModelId: supplierModel.id,
          employeeId: employee.id,
          agreementId: agreement.id,
          planId: plan?.id ?? null,
          offeringId: offering.id,
          gatewayRoute: input.gatewayRoute ?? null,
        },
      });

      return {
        supplier,
        supplierModel,
        employee: this.#domain.listEmployees().find((item) => item.id === employee.id) ?? employee,
        agreement: this.listSupplyAgreements(String(supplier.id)).find(
          (item) => item.id === agreement.id,
        ),
        employment: this.#domain
          .listEmployments(String(employee.id))
          .find((item) => item.id === employment.id),
        plan,
        offering,
        channel,
        binding,
      };
    });
  }

  projection(): V2Row {
    const suppliers = rows(
      this.#domain.db
        .prepare(
          `SELECT id,slug,name,website_url,source_kind,lifecycle,metadata_json,created_at,updated_at
           FROM v2_suppliers WHERE lifecycle='ACTIVE' ORDER BY name`,
        )
        .all(),
    ).map((value) => ({
      id: value.id,
      slug: value.slug,
      name: value.name,
      websiteUrl: value.website_url ?? null,
      sourceKind: value.source_kind ?? 'EXTERNAL',
      lifecycle: value.lifecycle,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    }));
    const supplierModels = rows(
      this.#domain.db
        .prepare(
          `SELECT id,supplier_id,supplier_model_key,model_definition_ref,aliases_json,display_name,lifecycle,
                  first_seen_at,retired_at,metadata_json
           FROM v2_supplier_models ORDER BY display_name`,
        )
        .all(),
    ).map((value) => ({
      id: value.id,
      supplierId: value.supplier_id,
      key: value.supplier_model_key,
      modelDefinitionRef: value.model_definition_ref,
      aliases: decode<string[]>(value.aliases_json, []),
      name: value.display_name,
      lifecycle: value.lifecycle,
      firstSeenAt: value.first_seen_at,
      retiredAt: value.retired_at,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
    const plans = this.listPlans();
    const agreements = this.listSupplyAgreements();
    const offerings = this.listModelOfferings();
    const capacityPools = this.listCapacityPools();
    const employees = this.#domain.listEmployees();
    const employments = rows(
      this.#domain.db
        .prepare(
          `SELECT em.*,e.display_name employee_name,e.supplier_id,e.supplier_model_id,
                  sm.supplier_model_key,sm.display_name supplier_model_name,
                  a.name agreement_name,a.lifecycle agreement_lifecycle
           FROM v2_employments em
           JOIN v2_employees e ON e.id=em.employee_id
           JOIN v2_supplier_models sm ON sm.id=e.supplier_model_id
           JOIN v2_supply_agreements a ON a.id=em.supply_agreement_id
           ORDER BY em.effective_from DESC`,
        )
        .all(),
    ).map((value) => ({
      id: value.id,
      employeeId: value.employee_id,
      employeeName: value.employee_name,
      supplierId: value.supplier_id,
      supplierModelId: value.supplier_model_id,
      supplierModelKey: value.supplier_model_key,
      supplierModelName: value.supplier_model_name,
      supplyAgreementId: value.supply_agreement_id,
      agreementName: value.agreement_name,
      agreementLifecycle: value.agreement_lifecycle,
      modelOfferingId: value.model_offering_id,
      status: value.status,
      effectiveFrom: value.effective_from,
      effectiveTo: value.effective_to,
      endedReason: value.ended_reason,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
    const runtimeAccessProfiles = rows(
      this.#domain.db
        .prepare(
          `SELECT r.*,em.employee_id,em.supply_agreement_id
           FROM v2_runtime_access_profiles r
           JOIN v2_employments em ON em.id=r.employment_id
           ORDER BY r.employment_id,r.runtime_kind,r.priority DESC,r.created_at,r.id`,
        )
        .all(),
    ).map((value) => ({
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
    }));
    const bindings = rows(
      this.#domain.db
        .prepare(
          `SELECT b.*,g.slug gateway_slug,g.display_name gateway_name,g.kind gateway_kind,
                  em.supply_agreement_id
           FROM v2_gateway_bindings b
           JOIN v2_gateways g ON g.id=b.gateway_id
           JOIN v2_employments em ON em.id=b.employment_id
           ORDER BY g.display_name,b.priority DESC,b.created_at`,
        )
        .all(),
    ).map((value) => ({
      id: value.id,
      employmentId: value.employment_id,
      supplyAgreementId: value.supply_agreement_id,
      gatewayId: value.gateway_id,
      gatewaySlug: value.gateway_slug,
      gatewayName: value.gateway_name,
      gatewayKind: value.gateway_kind,
      externalRouteRef: value.external_route_ref,
      protocol: value.protocol,
      lifecycle: value.lifecycle,
      priority: Number(value.priority ?? 0),
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
    const channels = this.#domain.listChannels();
    const activeChannels = channels.filter((channel) => channel.lifecycle !== 'ARCHIVED');
    const gateways = this.#domain.listGateways();

    const supplierItems = suppliers.map((supplier) => {
      const supplierId = String(supplier.id);
      const supplierAgreements = agreements.filter((item) => item.supplierId === supplierId);
      const agreementIds = new Set(supplierAgreements.map((item) => String(item.id)));
      const supplierEmployments = employments.filter((item) => item.supplierId === supplierId);
      const employmentIds = new Set(supplierEmployments.map((item) => String(item.id)));
      const supplierEmployees = employees.filter(
        (item) =>
          (item.supplier as { id?: unknown } | undefined)?.id === supplierId &&
          item.recordLifecycle === 'ACTIVE',
      );
      return {
        ...supplier,
        supplierModels: supplierModels.filter((item) => item.supplierId === supplierId),
        plans: plans.filter((item) => item.supplierId === supplierId),
        modelOfferings: offerings.filter((item) => item.supplierId === supplierId),
        employees: supplierEmployees,
        agreements: supplierAgreements.map((agreement) => ({
          ...agreement,
          employments: supplierEmployments
            .filter((employment) => employment.supplyAgreementId === agreement.id)
            .map((employment) => ({
              ...employment,
              employee: supplierEmployees.find((item) => item.id === employment.employeeId) ?? null,
              bindings: bindings.filter((binding) => binding.employmentId === employment.id),
              runtimeAccess: runtimeAccessProfiles.filter(
                (access) => access.employmentId === employment.id,
              ),
            })),
          capacityPools: capacityPools.filter((pool) => pool.supplyAgreementId === agreement.id),
          channels: activeChannels.filter((channel) => channel.supplyAgreementId === agreement.id),
        })),
        infrastructure: {
          bindings: bindings.filter((binding) => employmentIds.has(String(binding.employmentId))),
          channels: activeChannels.filter(
            (channel) =>
              channel.supplyAgreementId != null &&
              agreementIds.has(String(channel.supplyAgreementId)),
          ),
        },
        summary: {
          supplierModels: supplierModels.filter((item) => item.supplierId === supplierId).length,
          employees: supplierEmployees.length,
          employed: supplierEmployees.filter((item) => item.cooperationState === 'EMPLOYED').length,
          plans: plans.filter((item) => item.supplierId === supplierId).length,
          agreements: supplierAgreements.length,
          activeAgreements: supplierAgreements.filter((item) => item.lifecycle === 'ACTIVE').length,
          currentEmployments: supplierEmployments.filter((item) => item.status === 'CURRENT')
            .length,
          capacityPools: capacityPools.filter((pool) =>
            agreementIds.has(String(pool.supplyAgreementId)),
          ).length,
          activeBindings: bindings.filter(
            (binding) =>
              employmentIds.has(String(binding.employmentId)) && binding.lifecycle === 'ACTIVE',
          ).length,
          runtimeAccessProfiles: runtimeAccessProfiles.filter(
            (access) =>
              employmentIds.has(String(access.employmentId)) && access.lifecycle === 'ACTIVE',
          ).length,
          nativeRuntimeAccessProfiles: runtimeAccessProfiles.filter(
            (access) =>
              employmentIds.has(String(access.employmentId)) &&
              access.lifecycle === 'ACTIVE' &&
              access.adapterKind === 'NATIVE_CONFIG',
          ).length,
          gatewayRuntimeAccessProfiles: runtimeAccessProfiles.filter(
            (access) =>
              employmentIds.has(String(access.employmentId)) &&
              access.lifecycle === 'ACTIVE' &&
              access.adapterKind === 'GATEWAY',
          ).length,
        },
      };
    });

    const currentAgreementById = new Map(
      agreements
        .filter((agreement) => agreement.lifecycle === 'ACTIVE')
        .map((agreement) => [String(agreement.id), agreement]),
    );
    const activeSupplierById = new Map(
      suppliers.map((supplier) => [String(supplier.id), supplier]),
    );
    const channelGroups = [
      ...new Set(
        activeChannels.map(
          (channel) => `${String(channel.gatewaySlug)}\u0000${String(channel.name)}`,
        ),
      ),
    ]
      .map((key) => {
        const [gatewaySlug = '', channelName = ''] = key.split('\u0000');
        const groupChannels = activeChannels.filter(
          (channel) => channel.gatewaySlug === gatewaySlug && channel.name === channelName,
        );
        const mappedSuppliers = [
          ...new Map(
            groupChannels
              .map((channel) =>
                channel.supplyAgreementId == null
                  ? null
                  : currentAgreementById.get(String(channel.supplyAgreementId)),
              )
              .filter((agreement): agreement is V2Row => Boolean(agreement))
              .map((agreement) => {
                const supplier = activeSupplierById.get(String(agreement.supplierId));
                return supplier
                  ? [
                      String(supplier.id),
                      { id: supplier.id, slug: supplier.slug, name: supplier.name },
                    ]
                  : null;
              })
              .filter((entry): entry is [string, { id: unknown; slug: unknown; name: unknown }] =>
                Boolean(entry),
              ),
          ).values(),
        ];
        const mappedRouteCount = groupChannels.filter(
          (channel) =>
            channel.supplyAgreementId != null &&
            currentAgreementById.has(String(channel.supplyAgreementId)),
        ).length;
        const classification =
          mappedRouteCount === 0
            ? 'UNMAPPED'
            : mappedRouteCount === groupChannels.length
              ? 'MAPPED'
              : 'PARTIAL';
        return {
          gatewaySlug,
          gatewayName: groupChannels[0]?.gatewayName,
          channelName,
          classification,
          mappedSuppliers,
          health: [...new Set(groupChannels.map((channel) => String(channel.health)))],
          modelHints: [
            ...new Set(
              groupChannels
                .map((channel) => channel.supplierModelHint)
                .filter((value): value is string => typeof value === 'string' && value.length > 0),
            ),
          ],
          routes: groupChannels.map((channel) => ({
            id: channel.id,
            externalRouteRef: channel.externalRouteRef,
            protocol: channel.protocol,
            health: channel.health,
            mapped:
              channel.supplyAgreementId != null &&
              currentAgreementById.has(String(channel.supplyAgreementId)),
          })),
        };
      })
      .sort(
        (a, b) =>
          String(a.gatewayName).localeCompare(String(b.gatewayName)) ||
          a.channelName.localeCompare(b.channelName),
      );
    const channelGateways = gateways
      .map((gateway) => {
        const groups = channelGroups.filter((group) => group.gatewaySlug === gateway.slug);
        return {
          id: gateway.id,
          slug: gateway.slug,
          name: gateway.displayName,
          kind: gateway.kind,
          lifecycle: gateway.lifecycle,
          groups,
          summary: {
            channels: groups.length,
            routes: groups.reduce((count, group) => count + group.routes.length, 0),
            unmappedRoutes: groups.reduce(
              (count, group) => count + group.routes.filter((route) => !route.mapped).length,
              0,
            ),
          },
        };
      })
      .filter((gateway) => gateway.groups.length > 0);
    const unmappedChannels = activeChannels.filter(
      (channel) =>
        channel.supplyAgreementId == null ||
        !currentAgreementById.has(String(channel.supplyAgreementId)),
    );
    const unmappedGroups = channelGroups.filter((group) => group.classification !== 'MAPPED');
    const externalSupplierItems = supplierItems.filter(
      (item) => String(item.sourceKind ?? 'EXTERNAL') !== 'INTERNAL',
    );
    const internalSourceItems = supplierItems.filter(
      (item) => String(item.sourceKind ?? 'EXTERNAL') === 'INTERNAL',
    );
    return {
      projectionVersion: 2,
      generatedAt: now(),
      suppliers: supplierItems,
      gateways,
      channelInfrastructure: {
        gateways: channelGateways,
        count: activeChannels.length,
      },
      unmappedInfrastructure: {
        channels: unmappedChannels,
        groups: unmappedGroups,
        count: unmappedChannels.length,
      },
      summary: {
        suppliers: externalSupplierItems.length,
        activeSuppliers: externalSupplierItems.filter((item) => item.lifecycle === 'ACTIVE').length,
        workforceSources: supplierItems.length,
        internalSources: internalSourceItems.length,
        supplierModels: supplierModels.filter((item) =>
          externalSupplierItems.some((supplier) => supplier.id === item.supplierId),
        ).length,
        employees: supplierItems.reduce((count, supplier) => count + supplier.employees.length, 0),
        internalEmployees: internalSourceItems.reduce(
          (count, supplier) => count + supplier.employees.length,
          0,
        ),
        plans: plans.filter(
          (item) =>
            externalSupplierItems.some((supplier) => supplier.id === item.supplierId) &&
            item.lifecycle === 'ACTIVE',
        ).length,
        agreements: agreements.filter(
          (item) =>
            externalSupplierItems.some((supplier) => supplier.id === item.supplierId) &&
            item.lifecycle === 'ACTIVE',
        ).length,
        activeAgreements: agreements.filter(
          (item) =>
            externalSupplierItems.some((supplier) => supplier.id === item.supplierId) &&
            item.lifecycle === 'ACTIVE',
        ).length,
        currentEmployments: employments.filter(
          (item) =>
            supplierItems.some((supplier) => supplier.id === item.supplierId) &&
            item.status === 'CURRENT',
        ).length,
        capacityPools: capacityPools.filter((pool) =>
          agreements.some(
            (agreement) =>
              agreement.id === pool.supplyAgreementId &&
              agreement.lifecycle === 'ACTIVE' &&
              supplierItems.some((supplier) => supplier.id === agreement.supplierId),
          ),
        ).length,
        activeBindings: bindings.filter(
          (item) =>
            item.lifecycle === 'ACTIVE' &&
            employments.some(
              (employment) =>
                employment.id === item.employmentId &&
                supplierItems.some((supplier) => supplier.id === employment.supplierId),
            ),
        ).length,
        runtimeAccessProfiles: runtimeAccessProfiles.filter(
          (item) =>
            item.lifecycle === 'ACTIVE' &&
            employments.some(
              (employment) =>
                employment.id === item.employmentId &&
                supplierItems.some((supplier) => supplier.id === employment.supplierId),
            ),
        ).length,
        nativeRuntimeAccessProfiles: runtimeAccessProfiles.filter(
          (item) =>
            item.lifecycle === 'ACTIVE' &&
            item.adapterKind === 'NATIVE_CONFIG' &&
            employments.some(
              (employment) =>
                employment.id === item.employmentId &&
                supplierItems.some((supplier) => supplier.id === employment.supplierId),
            ),
        ).length,
        gatewayRuntimeAccessProfiles: runtimeAccessProfiles.filter(
          (item) =>
            item.lifecycle === 'ACTIVE' &&
            item.adapterKind === 'GATEWAY' &&
            employments.some(
              (employment) =>
                employment.id === item.employmentId &&
                supplierItems.some((supplier) => supplier.id === employment.supplierId),
            ),
        ).length,
        gateways: gateways.length,
        unmappedChannels: unmappedChannels.length,
      },
    };
  }

  capacityForAgreement(supplyAgreementId: string): CapacityState {
    const pools = this.listCapacityPools(supplyAgreementId).filter(
      (pool) => pool.lifecycle === 'ACTIVE',
    );
    const blocking = pools.filter((pool) => pool.remaining !== null && Number(pool.remaining) <= 0);
    return {
      available: blocking.length === 0,
      reasons: blocking.map((pool) => `CAPACITY_${String(pool.dimension)}_EXHAUSTED`),
      pools: pools.map((pool) => ({
        id: String(pool.id),
        name: String(pool.name),
        dimension: String(pool.dimension),
        limit: pool.limit == null ? null : Number(pool.limit),
        remaining: pool.remaining == null ? null : Number(pool.remaining),
        unit: pool.unit == null ? null : String(pool.unit),
        resetAt: pool.resetAt == null ? null : Number(pool.resetAt),
        source: String(pool.source),
      })),
    };
  }
}
