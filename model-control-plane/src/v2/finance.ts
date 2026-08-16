import { newId } from './ids.js';
import type { V2Repository, V2Row } from './repository.js';

type JsonRecord = Record<string, unknown>;

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

export class FinanceRepository {
  readonly #domain: V2Repository;

  constructor(domain: V2Repository) {
    this.#domain = domain;
  }

  createReferencePrice(input: {
    supplierModelId: string;
    name: string;
    inputPerMillion?: number;
    outputPerMillion?: number;
    cacheReadPerMillion?: number;
    cacheWritePerMillion?: number;
    reasoningPerMillion?: number;
    currency?: string;
    source: string;
    effectiveFrom?: number;
    effectiveTo?: number;
    metadata?: JsonRecord;
  }): V2Row {
    const timestamp = now();
    const id = newId('price', timestamp);
    return this.#domain.transaction(() => {
      this.#domain.db
        .prepare(
          `INSERT INTO v2_reference_prices(
             id,supplier_model_id,name,input_per_million,output_per_million,cache_read_per_million,
             cache_write_per_million,reasoning_per_million,currency,source,effective_from,effective_to,
             metadata_json,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.supplierModelId,
          input.name,
          input.inputPerMillion ?? 0,
          input.outputPerMillion ?? 0,
          input.cacheReadPerMillion ?? 0,
          input.cacheWritePerMillion ?? 0,
          input.reasoningPerMillion ?? 0,
          input.currency ?? 'USD',
          input.source,
          input.effectiveFrom ?? timestamp,
          input.effectiveTo ?? null,
          encode(input.metadata),
          timestamp,
        );
      this.#domain.emit({
        type: 'reference_price.created',
        entityType: 'ReferencePrice',
        entityId: id,
        payload: { supplierModelId: input.supplierModelId, source: input.source },
      });
      return row(this.#domain.db.prepare('SELECT * FROM v2_reference_prices WHERE id=?').get(id))!;
    });
  }

  listReferencePrices(supplierModelId?: string): V2Row[] {
    return rows(
      this.#domain.db
        .prepare(
          `SELECT p.*,sm.display_name supplier_model_name,s.name supplier_name
           FROM v2_reference_prices p
           JOIN v2_supplier_models sm ON sm.id=p.supplier_model_id
           JOIN v2_suppliers s ON s.id=sm.supplier_id
           WHERE (? IS NULL OR p.supplier_model_id=?)
           ORDER BY p.effective_from DESC,p.created_at DESC`,
        )
        .all(supplierModelId ?? null, supplierModelId ?? null),
    ).map((value) => ({
      id: value.id,
      supplierModelId: value.supplier_model_id,
      supplierModelName: value.supplier_model_name,
      supplierName: value.supplier_name,
      name: value.name,
      inputPerMillion: Number(value.input_per_million ?? 0),
      outputPerMillion: Number(value.output_per_million ?? 0),
      cacheReadPerMillion: Number(value.cache_read_per_million ?? 0),
      cacheWritePerMillion: Number(value.cache_write_per_million ?? 0),
      reasoningPerMillion: Number(value.reasoning_per_million ?? 0),
      currency: value.currency,
      source: value.source,
      effectiveFrom: value.effective_from,
      effectiveTo: value.effective_to,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
  }

  applyReferencePrice(priceId: string): V2Row {
    const price = row(
      this.#domain.db.prepare('SELECT * FROM v2_reference_prices WHERE id=?').get(priceId),
    );
    if (!price) throw new Error('REFERENCE_PRICE_NOT_FOUND');
    const supplierModelId = String(price.supplier_model_id);
    const effectiveFrom = Number(price.effective_from);
    const effectiveTo = price.effective_to == null ? null : Number(price.effective_to);
    const currency = String(price.currency ?? 'USD');
    const usage = rows(
      this.#domain.db
        .prepare(
          `SELECT * FROM v2_usage_entries
           WHERE supplier_model_id=? AND occurred_at>=? AND (? IS NULL OR occurred_at<?)
           ORDER BY occurred_at,id`,
        )
        .all(supplierModelId, effectiveFrom, effectiveTo, effectiveTo),
    );
    const timestamp = now();
    let valued = 0;
    let total = 0;
    this.#domain.transaction(() => {
      for (const item of usage) {
        const amount =
          (Number(item.input_tokens ?? 0) * Number(price.input_per_million ?? 0) +
            Number(item.output_tokens ?? 0) * Number(price.output_per_million ?? 0) +
            Number(item.cache_read_tokens ?? 0) * Number(price.cache_read_per_million ?? 0) +
            Number(item.cache_write_tokens ?? 0) * Number(price.cache_write_per_million ?? 0) +
            Number(item.reasoning_tokens ?? 0) * Number(price.reasoning_per_million ?? 0)) /
          1_000_000;
        const existing = row(
          this.#domain.db
            .prepare(
              'SELECT * FROM v2_usage_market_valuations WHERE usage_entry_id=? AND reference_price_id=?',
            )
            .get(String(item.id), priceId),
        );
        this.#domain.db
          .prepare(
            `UPDATE v2_usage_market_valuations SET superseded_at=?
             WHERE usage_entry_id=? AND superseded_at IS NULL AND reference_price_id<>?`,
          )
          .run(timestamp, String(item.id), priceId);
        if (existing) {
          if (existing.superseded_at != null) {
            this.#domain.db
              .prepare(
                `UPDATE v2_usage_market_valuations SET superseded_at=NULL,amount=?,currency=?,calculated_at=?
                 WHERE id=?`,
              )
              .run(amount, currency, timestamp, String(existing.id));
          }
        } else {
          this.#domain.db
            .prepare(
              `INSERT INTO v2_usage_market_valuations(
                 id,usage_entry_id,reference_price_id,amount,currency,calculated_at,metadata_json)
               VALUES(?,?,?,?,?,?,?)`,
            )
            .run(
              newId('val', timestamp + valued),
              String(item.id),
              priceId,
              amount,
              currency,
              timestamp,
              '{}',
            );
        }
        valued += 1;
        total += amount;
      }
      this.#domain.emit({
        type: 'reference_price.applied',
        entityType: 'ReferencePrice',
        entityId: priceId,
        payload: { usageEntries: valued, marketValue: total, currency },
      });
    });
    return { priceId, usageEntries: valued, marketValue: total, currency };
  }

  allocateAgreementCost(input: {
    supplyAgreementId: string;
    periodStart: number;
    periodEnd: number;
    basis?: 'TOKENS' | 'REQUESTS';
    fixedCost?: number;
    currency?: string;
    policy?: JsonRecord;
  }): V2Row {
    if (!(input.periodEnd > input.periodStart)) throw new Error('ALLOCATION_PERIOD_INVALID');
    const agreement = row(
      this.#domain.db
        .prepare('SELECT * FROM v2_supply_agreements WHERE id=?')
        .get(input.supplyAgreementId),
    );
    if (!agreement) throw new Error('SUPPLY_AGREEMENT_NOT_FOUND');
    const fixedCost = input.fixedCost ?? Number(agreement.fixed_cost ?? 0);
    if (!(fixedCost > 0)) throw new Error('FIXED_COST_REQUIRED');
    const currency = input.currency ?? String(agreement.currency ?? 'USD');
    const basis = input.basis ?? 'TOKENS';
    const usage = rows(
      this.#domain.db
        .prepare(
          `SELECT * FROM v2_usage_entries
           WHERE supply_agreement_id=? AND occurred_at>=? AND occurred_at<? ORDER BY occurred_at,id`,
        )
        .all(input.supplyAgreementId, input.periodStart, input.periodEnd),
    );
    const measure = (value: V2Row): number =>
      basis === 'REQUESTS'
        ? 1
        : Number(value.input_tokens ?? 0) +
          Number(value.output_tokens ?? 0) +
          Number(value.cache_read_tokens ?? 0) +
          Number(value.cache_write_tokens ?? 0) +
          Number(value.reasoning_tokens ?? 0);
    const totalBasis = usage.reduce((sum, value) => sum + measure(value), 0);
    const timestamp = now();
    const id = newId('alloc', timestamp);
    this.#domain.transaction(() => {
      this.#domain.db
        .prepare(
          `UPDATE v2_cost_allocation_runs SET superseded_at=?
           WHERE supply_agreement_id=? AND period_start=? AND period_end=? AND superseded_at IS NULL`,
        )
        .run(timestamp, input.supplyAgreementId, input.periodStart, input.periodEnd);
      this.#domain.db
        .prepare(
          `INSERT INTO v2_cost_allocation_runs(
             id,supply_agreement_id,period_start,period_end,fixed_cost,currency,basis,status,total_basis,
             allocated_total,started_at,completed_at,policy_json)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.supplyAgreementId,
          input.periodStart,
          input.periodEnd,
          fixedCost,
          currency,
          basis,
          'COMPLETED',
          totalBasis,
          totalBasis > 0 ? fixedCost : 0,
          timestamp,
          timestamp,
          encode(input.policy),
        );
      if (totalBasis > 0) {
        usage.forEach((value, index) => {
          const basisValue = measure(value);
          const amount = (fixedCost * basisValue) / totalBasis;
          this.#domain.db
            .prepare(
              `INSERT INTO v2_cost_allocation_entries(
                 id,allocation_run_id,usage_entry_id,basis_value,amount,currency,metadata_json)
               VALUES(?,?,?,?,?,?,?)`,
            )
            .run(
              newId('aln', timestamp + index),
              id,
              String(value.id),
              basisValue,
              amount,
              currency,
              '{}',
            );
        });
      }
      this.#domain.emit({
        type: 'cost_allocation.completed',
        entityType: 'CostAllocationRun',
        entityId: id,
        payload: {
          supplyAgreementId: input.supplyAgreementId,
          usageEntries: usage.length,
          fixedCost,
          allocatedTotal: totalBasis > 0 ? fixedCost : 0,
          basis,
          currency,
        },
      });
    });
    return row(
      this.#domain.db.prepare('SELECT * FROM v2_cost_allocation_runs WHERE id=?').get(id),
    )!;
  }

  listAllocationRuns(supplyAgreementId?: string): V2Row[] {
    return rows(
      this.#domain.db
        .prepare(
          `SELECT r.*,a.name agreement_name,s.name supplier_name,
                  (SELECT COUNT(*) FROM v2_cost_allocation_entries e WHERE e.allocation_run_id=r.id) entry_count
           FROM v2_cost_allocation_runs r
           JOIN v2_supply_agreements a ON a.id=r.supply_agreement_id
           JOIN v2_suppliers s ON s.id=a.supplier_id
           WHERE (? IS NULL OR r.supply_agreement_id=?) ORDER BY r.started_at DESC`,
        )
        .all(supplyAgreementId ?? null, supplyAgreementId ?? null),
    ).map((value) => ({
      id: value.id,
      supplyAgreementId: value.supply_agreement_id,
      agreementName: value.agreement_name,
      supplierName: value.supplier_name,
      periodStart: value.period_start,
      periodEnd: value.period_end,
      fixedCost: Number(value.fixed_cost ?? 0),
      currency: value.currency,
      basis: value.basis,
      status: value.status,
      totalBasis: Number(value.total_basis ?? 0),
      allocatedTotal: Number(value.allocated_total ?? 0),
      entryCount: Number(value.entry_count ?? 0),
      supersededAt: value.superseded_at,
    }));
  }

  recordEvaluation(input: {
    subjectType: string;
    subjectId: string;
    positionId?: string;
    employeeId?: string;
    roleId?: string;
    dimensions: Record<string, number | boolean | string>;
    source: string;
    recordedAt?: number;
    metadata?: JsonRecord;
  }): V2Row {
    const timestamp = input.recordedAt ?? now();
    const id = newId('eval', timestamp);
    return this.#domain.transaction(() => {
      this.#domain.db
        .prepare(
          `INSERT INTO v2_evaluations(
             id,subject_type,subject_id,role_id,position_id,employee_id,dimensions_json,source,recorded_at,metadata_json)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.subjectType,
          input.subjectId,
          input.roleId ?? null,
          input.positionId ?? null,
          input.employeeId ?? null,
          encode(input.dimensions),
          input.source,
          timestamp,
          encode(input.metadata),
        );
      this.#domain.emit({
        type: 'evaluation.recorded',
        entityType: 'Evaluation',
        entityId: id,
        payload: {
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          employeeId: input.employeeId ?? null,
          positionId: input.positionId ?? null,
        },
      });
      return row(this.#domain.db.prepare('SELECT * FROM v2_evaluations WHERE id=?').get(id))!;
    });
  }

  listEvaluations(
    filters: { employeeId?: string; positionId?: string; limit?: number } = {},
  ): V2Row[] {
    const limit = Math.min(1_000, Math.max(1, filters.limit ?? 100));
    return rows(
      this.#domain.db
        .prepare(
          `SELECT e.*,p.name position_name
           FROM v2_evaluations e LEFT JOIN v2_positions p ON p.id=e.position_id
           WHERE (? IS NULL OR e.employee_id=?) AND (? IS NULL OR e.position_id=?)
           ORDER BY e.recorded_at DESC LIMIT ?`,
        )
        .all(
          filters.employeeId ?? null,
          filters.employeeId ?? null,
          filters.positionId ?? null,
          filters.positionId ?? null,
          limit,
        ),
    ).map((value) => ({
      id: value.id,
      subjectType: value.subject_type,
      subjectId: value.subject_id,
      roleId: value.role_id,
      positionId: value.position_id,
      positionName: value.position_name,
      employeeId: value.employee_id,
      dimensions: decode<JsonRecord>(value.dimensions_json, {}),
      source: value.source,
      recordedAt: value.recorded_at,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
  }

  performanceByPosition(employeeId: string): V2Row[] {
    const evaluations = this.listEvaluations({ employeeId, limit: 10_000 });
    const groups = new Map<
      string,
      { positionId: string; positionName: string; dimensions: Map<string, number[]> }
    >();
    for (const item of evaluations) {
      if (!item.positionId) continue;
      const key = String(item.positionId);
      let group = groups.get(key);
      if (!group) {
        group = {
          positionId: key,
          positionName: String(item.positionName ?? key),
          dimensions: new Map(),
        };
        groups.set(key, group);
      }
      for (const [dimension, value] of Object.entries(item.dimensions as JsonRecord)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const values = group.dimensions.get(dimension) ?? [];
        values.push(value);
        group.dimensions.set(dimension, values);
      }
    }
    return [...groups.values()].map((group) => ({
      positionId: group.positionId,
      positionName: group.positionName,
      dimensions: Object.fromEntries(
        [...group.dimensions.entries()].map(([name, values]) => [
          name,
          {
            count: values.length,
            average: values.reduce((sum, value) => sum + value, 0) / values.length,
          },
        ]),
      ),
    }));
  }
}
