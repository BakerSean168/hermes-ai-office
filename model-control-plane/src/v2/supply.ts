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
