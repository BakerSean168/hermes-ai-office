import type { DatabaseSync } from 'node:sqlite';

import type {
  GatewayAggregateUsageEvidence,
  GatewayBinding,
  GatewayBindingSource,
  GatewayProtocol,
  GatewayRequestUsageEvidence,
  GatewayUsageEvidence,
} from '../gateway/ports.js';
import { newId } from './ids.js';

interface JsonRecord {
  [key: string]: unknown;
}

export type V2Row = Record<string, unknown>;
type Row = V2Row;

export interface V2Event extends V2Row {
  seq: number;
  eventId: string;
  type: string;
  occurredAt: number;
  recordedAt: number;
}

export type V2EventListener = (event: V2Event) => void;

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

function row(value: unknown): Row | null {
  return value && typeof value === 'object' ? (value as Row) : null;
}

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : [];
}

export interface InvocationContext {
  dutySessionId: string;
  runId: string;
  positionId: string;
  staffingSegmentId: string;
  employeeId: string;
  employmentId: string;
  supplyAgreementId: string;
  supplierId: string;
  supplierModelId: string;
  gatewayDbId: string;
  gatewayId: string;
  gatewayBindingId: string;
  externalRouteRef: string;
  protocol: GatewayProtocol;
}

export interface UsageInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  actualCost?: number;
  allocatedCost?: number;
  marketValue?: number;
  currency?: string;
}

export interface CreateRunInput {
  workScopeId: string;
  title: string;
  externalRunRef?: string;
  metadata?: JsonRecord;
}

export interface OpenDutyInput {
  runId: string;
  positionId: string;
  activity?: string;
  metadata?: JsonRecord;
}

export interface DispatchRouteCandidate {
  employmentId: string;
  supplyAgreementId: string;
  gatewayId: string;
  gatewayBindingId: string;
  externalRouteRef: string;
  protocol: GatewayProtocol;
  bindingPriority: number;
}

export interface DispatchCandidate {
  employeeId: string;
  employeeName: string;
  employeeLifecycle: string;
  appointmentId: string;
  appointmentClass: 'PRIMARY' | 'BACKUP' | 'RESERVE';
  appointmentPriority: number;
  qualified: boolean;
  eligible: boolean;
  reasons: string[];
  routes: DispatchRouteCandidate[];
}

export interface DispatchSelection {
  employeeId: string;
  appointmentId: string;
  employmentId: string;
}

export interface RecordDispatchInput {
  dutySessionId: string;
  trigger: string;
  policyVersion: string;
  correlationId?: string;
  candidateResults: unknown[];
  selected?: DispatchSelection;
  reasons?: string[];
}

export interface ChannelObservationInput {
  gatewayId: string;
  supplyAgreementId?: string;
  externalRouteRef: string;
  name: string;
  protocol: GatewayProtocol;
  health: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
  lifecycle?: 'ENABLED' | 'DISABLED' | 'QUARANTINED' | 'ARCHIVED';
  supplierHint?: string;
  supplierModelHint?: string;
  capabilities?: string[];
  metadata?: JsonRecord;
  observedAt: number;
}

export interface ChannelObservationResult {
  channel: Row;
  created: boolean;
  healthChanged: boolean;
  previousHealth?: string;
}

export interface DiscoveryRunSummary {
  routeCount: number;
  createdSuppliers: number;
  createdSupplierModels: number;
  createdEmployees: number;
  createdAgreements: number;
  createdEmployments: number;
  createdBindings: number;
  issues: unknown[];
}

export interface UsageReconciliationSummary {
  evidenceCount: number;
  requestMatched: number;
  requestUnmatched: number;
  requestUsageCreated: number;
  requestMismatched: number;
  aggregateCount: number;
  issues: unknown[];
  nextCursor?: string;
}

export interface RequestUsageReconciliationResult {
  status: 'MATCHED' | 'USAGE_CREATED' | 'MISMATCH' | 'UNMATCHED';
  attemptId?: string;
  usageEntryId?: string;
  differences?: Record<string, { ledger: number | string; evidence: number | string }>;
}

export interface BootstrapReferenceInput {
  supplierSlug: string;
  supplierName: string;
  supplierModelKey: string;
  supplierModelName: string;
  agreementRef: string;
  agreementName: string;
  gatewaySlug: string;
  gatewayKind: 'LITELLM' | 'CPA' | 'DIRECT' | 'OTHER';
  gatewayName: string;
  gatewayBaseUrlHint?: string;
  workScopeSlug: string;
  workScopeName: string;
  externalProfileRef?: string;
  positionSlug: string;
  positionName: string;
  positionKind: string;
  runtimeKind?: string;
  protocol: GatewayProtocol;
}

export interface BootstrapReferenceResult {
  supplierId: string;
  supplierModelId: string;
  employeeId: string;
  agreementId: string;
  employmentId: string;
  gatewayId: string;
  gatewayBindingId: string;
  externalRouteRef: string;
  workScopeId: string;
  positionId: string;
  appointmentId: string;
}

export class V2Repository {
  readonly db: DatabaseSync;
  readonly #listeners = new Set<V2EventListener>();
  #transactionDepth = 0;
  #pendingEvents: V2Event[] = [];

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  subscribe(listener: V2EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  transaction<T>(operation: () => T): T {
    if (this.#transactionDepth > 0) return operation();
    this.db.exec('BEGIN IMMEDIATE');
    this.#transactionDepth = 1;
    this.#pendingEvents = [];
    try {
      const result = operation();
      this.db.exec('COMMIT');
      const committedEvents = this.#pendingEvents;
      this.#pendingEvents = [];
      this.#transactionDepth = 0;
      for (const event of committedEvents) {
        for (const listener of this.#listeners) listener(event);
      }
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The original error is authoritative.
      }
      this.#pendingEvents = [];
      this.#transactionDepth = 0;
      throw error;
    }
  }

  emit(input: {
    type: string;
    entityType?: string;
    entityId?: string;
    correlationId?: string;
    causationId?: string;
    runId?: string;
    dutySessionId?: string;
    invocationId?: string;
    actorKind?: string;
    actorRef?: string;
    payload?: unknown;
    occurredAt?: number;
  }): V2Event {
    const recordedAt = now();
    const eventId = newId('event', recordedAt);
    const result = this.db
      .prepare(
        `INSERT INTO v2_events(event_id,type,schema_version,entity_type,entity_id,correlation_id,causation_id,run_id,duty_session_id,invocation_id,actor_kind,actor_ref,payload_json,occurred_at,recorded_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        eventId,
        input.type,
        1,
        input.entityType ?? null,
        input.entityId ?? null,
        input.correlationId ?? null,
        input.causationId ?? null,
        input.runId ?? null,
        input.dutySessionId ?? null,
        input.invocationId ?? null,
        input.actorKind ?? 'SYSTEM',
        input.actorRef ?? null,
        encode(input.payload),
        input.occurredAt ?? recordedAt,
        recordedAt,
      );
    const event: V2Event = {
      seq: Number(result.lastInsertRowid),
      eventId,
      type: input.type,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      payload: input.payload ?? {},
      occurredAt: input.occurredAt ?? recordedAt,
      recordedAt,
    };
    if (this.#transactionDepth > 0) this.#pendingEvents.push(event);
    else for (const listener of this.#listeners) listener(event);
    return event;
  }

  getOrCreateSupplier(slug: string, name: string): Row {
    const existing = row(this.db.prepare('SELECT * FROM v2_suppliers WHERE slug=?').get(slug));
    if (existing) return existing;
    const timestamp = now();
    const id = newId('sup', timestamp);
    this.db
      .prepare(
        `INSERT INTO v2_suppliers(id,slug,name,lifecycle,metadata_json,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(id, slug, name, 'ACTIVE', '{}', timestamp, timestamp);
    this.emit({
      type: 'supplier.created',
      entityType: 'Supplier',
      entityId: id,
      payload: { slug },
    });
    return row(this.db.prepare('SELECT * FROM v2_suppliers WHERE id=?').get(id))!;
  }

  getOrCreateSupplierModel(input: {
    supplierId: string;
    supplierModelKey: string;
    displayName: string;
  }): Row {
    const existing = row(
      this.db
        .prepare('SELECT * FROM v2_supplier_models WHERE supplier_id=? AND supplier_model_key=?')
        .get(input.supplierId, input.supplierModelKey),
    );
    if (existing) return existing;
    const timestamp = now();
    const id = newId('smdl', timestamp);
    this.db
      .prepare(
        `INSERT INTO v2_supplier_models(id,supplier_id,supplier_model_key,aliases_json,display_name,lifecycle,first_seen_at,metadata_json)
         VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.supplierId,
        input.supplierModelKey,
        '[]',
        input.displayName,
        'ACTIVE',
        timestamp,
        '{}',
      );
    this.emit({
      type: 'supplier_model.discovered',
      entityType: 'SupplierModel',
      entityId: id,
      payload: { supplierId: input.supplierId, supplierModelKey: input.supplierModelKey },
    });
    return row(this.db.prepare('SELECT * FROM v2_supplier_models WHERE id=?').get(id))!;
  }

  getOrCreateEmployee(input: {
    supplierId: string;
    supplierModelId: string;
    displayName: string;
  }): Row {
    const existing = row(
      this.db
        .prepare('SELECT * FROM v2_employees WHERE supplier_id=? AND supplier_model_id=?')
        .get(input.supplierId, input.supplierModelId),
    );
    if (existing) return existing;
    const timestamp = now();
    const id = newId('emp', timestamp);
    this.db
      .prepare(
        `INSERT INTO v2_employees(id,supplier_id,supplier_model_id,display_name,record_lifecycle,first_seen_at,metadata_json,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.supplierId,
        input.supplierModelId,
        input.displayName,
        'ACTIVE',
        timestamp,
        '{}',
        timestamp,
        timestamp,
      );
    this.emit({
      type: 'employee.discovered',
      entityType: 'Employee',
      entityId: id,
      payload: { supplierId: input.supplierId, supplierModelId: input.supplierModelId },
    });
    return row(this.db.prepare('SELECT * FROM v2_employees WHERE id=?').get(id))!;
  }

  getOrCreateAgreement(input: {
    supplierId: string;
    externalAccountRef: string;
    name: string;
  }): Row {
    const existing = row(
      this.db
        .prepare(
          'SELECT * FROM v2_supply_agreements WHERE supplier_id=? AND external_account_ref=? ORDER BY created_at LIMIT 1',
        )
        .get(input.supplierId, input.externalAccountRef),
    );
    if (existing) return existing;
    const timestamp = now();
    const id = newId('agr', timestamp);
    this.db
      .prepare(
        `INSERT INTO v2_supply_agreements(id,supplier_id,name,external_account_ref,lifecycle,valid_from,metadata_json,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.supplierId,
        input.name,
        input.externalAccountRef,
        'ACTIVE',
        timestamp,
        '{}',
        timestamp,
        timestamp,
      );
    this.emit({ type: 'agreement.activated', entityType: 'SupplyAgreement', entityId: id });
    return row(this.db.prepare('SELECT * FROM v2_supply_agreements WHERE id=?').get(id))!;
  }

  getOrCreateCurrentEmployment(input: { employeeId: string; supplyAgreementId: string }): Row {
    const existing = row(
      this.db
        .prepare(
          `SELECT * FROM v2_employments
           WHERE employee_id=? AND supply_agreement_id=? AND status IN ('SCHEDULED','CURRENT','SUSPENDED') AND effective_to IS NULL
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(input.employeeId, input.supplyAgreementId),
    );
    if (existing) return existing;
    const timestamp = now();
    const id = newId('empl', timestamp);
    this.db
      .prepare(
        `INSERT INTO v2_employments(id,employee_id,supply_agreement_id,status,effective_from,metadata_json,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.employeeId,
        input.supplyAgreementId,
        'CURRENT',
        timestamp,
        '{}',
        timestamp,
        timestamp,
      );
    this.emit({
      type: 'employment.started',
      entityType: 'Employment',
      entityId: id,
      payload: { employeeId: input.employeeId, supplyAgreementId: input.supplyAgreementId },
    });
    return row(this.db.prepare('SELECT * FROM v2_employments WHERE id=?').get(id))!;
  }

  getEmployment(employmentId: string): Row | null {
    return row(
      this.db
        .prepare(
          `SELECT em.*,a.lifecycle agreement_lifecycle,a.name agreement_name
           FROM v2_employments em
           JOIN v2_supply_agreements a ON a.id=em.supply_agreement_id
           WHERE em.id=?`,
        )
        .get(employmentId),
    );
  }

  suspendEmployment(
    employmentId: string,
    reason = 'OPERATOR_SUSPENDED',
    correlationId?: string,
  ): Row {
    const existing = this.getEmployment(employmentId);
    if (!existing) throw new Error('EMPLOYMENT_NOT_FOUND');
    if (existing.status === 'SUSPENDED') return existing;
    if (existing.status !== 'CURRENT') throw new Error('EMPLOYMENT_NOT_SUSPENDABLE');
    const timestamp = now();
    return this.transaction(() => {
      this.db
        .prepare(
          `UPDATE v2_employments SET status='SUSPENDED',ended_reason=?,updated_at=? WHERE id=?`,
        )
        .run(reason, timestamp, employmentId);
      this.emit({
        type: 'employment.suspended',
        correlationId,
        entityType: 'Employment',
        entityId: employmentId,
        payload: { employeeId: existing.employee_id, reason },
      });
      return this.getEmployment(employmentId)!;
    });
  }

  resumeEmployment(employmentId: string, correlationId?: string): Row {
    const existing = this.getEmployment(employmentId);
    if (!existing) throw new Error('EMPLOYMENT_NOT_FOUND');
    if (existing.status === 'CURRENT') return existing;
    if (existing.status !== 'SUSPENDED') throw new Error('EMPLOYMENT_NOT_RESUMABLE');
    const timestamp = now();
    return this.transaction(() => {
      this.db
        .prepare(
          `UPDATE v2_employments SET status='CURRENT',ended_reason=NULL,updated_at=? WHERE id=?`,
        )
        .run(timestamp, employmentId);
      this.emit({
        type: 'employment.resumed',
        correlationId,
        entityType: 'Employment',
        entityId: employmentId,
        payload: { employeeId: existing.employee_id },
      });
      return this.getEmployment(employmentId)!;
    });
  }

  endEmployment(employmentId: string, reason = 'OPERATOR_ENDED', correlationId?: string): Row {
    const existing = this.getEmployment(employmentId);
    if (!existing) throw new Error('EMPLOYMENT_NOT_FOUND');
    if (existing.status === 'ENDED') return existing;
    if (!['SCHEDULED', 'CURRENT', 'SUSPENDED'].includes(String(existing.status))) {
      throw new Error('EMPLOYMENT_NOT_ENDABLE');
    }
    const timestamp = now();
    return this.transaction(() => {
      this.db
        .prepare(
          `UPDATE v2_employments
           SET status='ENDED',effective_to=COALESCE(effective_to,?),ended_reason=?,updated_at=?
           WHERE id=?`,
        )
        .run(timestamp, reason, timestamp, employmentId);
      const currentCount = Number(
        row(
          this.db
            .prepare(
              `SELECT COUNT(*) count FROM v2_employments
               WHERE employee_id=? AND status='CURRENT' AND effective_to IS NULL`,
            )
            .get(String(existing.employee_id)),
        )?.count ?? 0,
      );
      this.emit({
        type: 'employment.ended',
        correlationId,
        entityType: 'Employment',
        entityId: employmentId,
        payload: {
          employeeId: existing.employee_id,
          supplyAgreementId: existing.supply_agreement_id,
          reason,
          employeeCooperationStateAfter: currentCount > 0 ? 'EMPLOYED' : 'DORMANT',
        },
      });
      return this.getEmployment(employmentId)!;
    });
  }

  activeDutyIdsForEmployee(employeeId: string): string[] {
    return rows(
      this.db
        .prepare(
          `SELECT d.id FROM v2_duty_sessions d
           JOIN v2_staffing_segments ss ON ss.duty_session_id=d.id AND ss.ended_at IS NULL
           WHERE ss.employee_id=? AND d.lifecycle='ACTIVE'
           ORDER BY d.opened_at`,
        )
        .all(employeeId),
    ).map((value) => String(value.id));
  }

  getOrCreateGateway(input: {
    slug: string;
    kind: 'LITELLM' | 'CPA' | 'DIRECT' | 'OTHER';
    displayName: string;
    baseUrlHint?: string;
  }): Row {
    const existing = row(this.db.prepare('SELECT * FROM v2_gateways WHERE slug=?').get(input.slug));
    if (existing) return existing;
    const timestamp = now();
    const id = newId('gw', timestamp);
    this.db
      .prepare(
        `INSERT INTO v2_gateways(id,slug,kind,display_name,base_url_hint,capabilities_json,lifecycle,last_seen_at,metadata_json,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.slug,
        input.kind,
        input.displayName,
        input.baseUrlHint ?? null,
        '{}',
        'ACTIVE',
        timestamp,
        '{}',
        timestamp,
        timestamp,
      );
    this.emit({ type: 'gateway.registered', entityType: 'Gateway', entityId: id });
    return row(this.db.prepare('SELECT * FROM v2_gateways WHERE id=?').get(id))!;
  }

  getOrCreateGatewayBinding(input: {
    employmentId: string;
    gatewayId: string;
    externalRouteRef: string;
    protocol: GatewayProtocol;
    priority?: number;
  }): Row {
    const existing = row(
      this.db
        .prepare(
          `SELECT * FROM v2_gateway_bindings
           WHERE employment_id=? AND gateway_id=? AND external_route_ref=?`,
        )
        .get(input.employmentId, input.gatewayId, input.externalRouteRef),
    );
    if (existing) return existing;
    const timestamp = now();
    const id = newId('gbind', timestamp);
    this.db
      .prepare(
        `INSERT INTO v2_gateway_bindings(id,employment_id,gateway_id,external_route_ref,protocol,lifecycle,priority,metadata_json,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.employmentId,
        input.gatewayId,
        input.externalRouteRef,
        input.protocol,
        'ACTIVE',
        input.priority ?? 100,
        '{}',
        timestamp,
        timestamp,
      );
    this.emit({
      type: 'gateway_binding.created',
      entityType: 'GatewayBinding',
      entityId: id,
      payload: { employmentId: input.employmentId, gatewayId: input.gatewayId },
    });
    return row(this.db.prepare('SELECT * FROM v2_gateway_bindings WHERE id=?').get(id))!;
  }

  getOrCreateWorkScope(input: { slug: string; name: string; externalProfileRef?: string }): Row {
    const existing = row(
      this.db.prepare('SELECT * FROM v2_work_scopes WHERE slug=?').get(input.slug),
    );
    if (existing) return existing;
    const timestamp = now();
    const id = newId('scope', timestamp);
    this.db
      .prepare(
        `INSERT INTO v2_work_scopes(id,slug,name,lifecycle,external_profile_ref,metadata_json,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.slug,
        input.name,
        'ACTIVE',
        input.externalProfileRef ?? null,
        '{}',
        timestamp,
        timestamp,
      );
    this.emit({ type: 'scope.created', entityType: 'WorkScope', entityId: id });
    return row(this.db.prepare('SELECT * FROM v2_work_scopes WHERE id=?').get(id))!;
  }

  getOrCreatePosition(input: {
    workScopeId: string;
    slug: string;
    name: string;
    kind: string;
    runtimeKind?: string;
  }): Row {
    const existing = row(
      this.db
        .prepare('SELECT * FROM v2_positions WHERE work_scope_id=? AND slug=?')
        .get(input.workScopeId, input.slug),
    );
    if (existing) return existing;
    const timestamp = now();
    const id = newId('pos', timestamp);
    this.db
      .prepare(
        `INSERT INTO v2_positions(id,work_scope_id,slug,name,kind,lifecycle,runtime_kind,requirements_json,metadata_json,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.workScopeId,
        input.slug,
        input.name,
        input.kind,
        'ACTIVE',
        input.runtimeKind ?? null,
        '{}',
        '{}',
        timestamp,
        timestamp,
      );
    this.emit({ type: 'position.created', entityType: 'Position', entityId: id });
    return row(this.db.prepare('SELECT * FROM v2_positions WHERE id=?').get(id))!;
  }

  getOrCreateCurrentAppointment(input: {
    employeeId: string;
    positionId: string;
    appointmentClass?: 'PRIMARY' | 'BACKUP' | 'RESERVE';
    priority?: number;
  }): Row {
    const existing = row(
      this.db
        .prepare(
          `SELECT * FROM v2_appointments
           WHERE employee_id=? AND position_id=? AND status IN ('SCHEDULED','CURRENT','SUSPENDED') AND effective_to IS NULL
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(input.employeeId, input.positionId),
    );
    if (existing) return existing;
    const timestamp = now();
    const id = newId('apt', timestamp);
    this.db
      .prepare(
        `INSERT INTO v2_appointments(id,employee_id,position_id,appointment_class,priority,status,effective_from,source,metadata_json,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.employeeId,
        input.positionId,
        input.appointmentClass ?? 'PRIMARY',
        input.priority ?? 100,
        'CURRENT',
        timestamp,
        'MANUAL',
        '{}',
        timestamp,
        timestamp,
      );
    this.emit({
      type: 'appointment.started',
      entityType: 'Appointment',
      entityId: id,
      payload: { employeeId: input.employeeId, positionId: input.positionId },
    });
    return row(this.db.prepare('SELECT * FROM v2_appointments WHERE id=?').get(id))!;
  }

  getAppointment(appointmentId: string): Row | null {
    return row(
      this.db
        .prepare(
          `SELECT a.*,e.display_name employee_name,p.name position_name
           FROM v2_appointments a
           JOIN v2_employees e ON e.id=a.employee_id
           JOIN v2_positions p ON p.id=a.position_id
           WHERE a.id=?`,
        )
        .get(appointmentId),
    );
  }

  suspendAppointment(
    appointmentId: string,
    reason = 'OPERATOR_SUSPENDED',
    correlationId?: string,
  ): Row {
    const existing = this.getAppointment(appointmentId);
    if (!existing) throw new Error('APPOINTMENT_NOT_FOUND');
    if (existing.status === 'SUSPENDED') return existing;
    if (existing.status !== 'CURRENT') throw new Error('APPOINTMENT_NOT_SUSPENDABLE');
    const timestamp = now();
    return this.transaction(() => {
      this.db
        .prepare(
          `UPDATE v2_appointments SET status='SUSPENDED',ended_reason=?,updated_at=? WHERE id=?`,
        )
        .run(reason, timestamp, appointmentId);
      this.emit({
        type: 'appointment.suspended',
        correlationId,
        entityType: 'Appointment',
        entityId: appointmentId,
        payload: {
          employeeId: existing.employee_id,
          positionId: existing.position_id,
          reason,
        },
      });
      return this.getAppointment(appointmentId)!;
    });
  }

  resumeAppointment(appointmentId: string, correlationId?: string): Row {
    const existing = this.getAppointment(appointmentId);
    if (!existing) throw new Error('APPOINTMENT_NOT_FOUND');
    if (existing.status === 'CURRENT') return existing;
    if (existing.status !== 'SUSPENDED') throw new Error('APPOINTMENT_NOT_RESUMABLE');
    const timestamp = now();
    return this.transaction(() => {
      this.db
        .prepare(
          `UPDATE v2_appointments SET status='CURRENT',ended_reason=NULL,updated_at=? WHERE id=?`,
        )
        .run(timestamp, appointmentId);
      this.emit({
        type: 'appointment.resumed',
        correlationId,
        entityType: 'Appointment',
        entityId: appointmentId,
        payload: { employeeId: existing.employee_id, positionId: existing.position_id },
      });
      return this.getAppointment(appointmentId)!;
    });
  }

  endAppointment(appointmentId: string, reason = 'OPERATOR_ENDED', correlationId?: string): Row {
    const existing = this.getAppointment(appointmentId);
    if (!existing) throw new Error('APPOINTMENT_NOT_FOUND');
    if (existing.status === 'ENDED') return existing;
    if (!['SCHEDULED', 'CURRENT', 'SUSPENDED'].includes(String(existing.status))) {
      throw new Error('APPOINTMENT_NOT_ENDABLE');
    }
    const timestamp = now();
    return this.transaction(() => {
      this.db
        .prepare(
          `UPDATE v2_appointments
           SET status='ENDED',effective_to=COALESCE(effective_to,?),ended_reason=?,updated_at=?
           WHERE id=?`,
        )
        .run(timestamp, reason, timestamp, appointmentId);
      this.emit({
        type: 'appointment.ended',
        correlationId,
        entityType: 'Appointment',
        entityId: appointmentId,
        payload: {
          employeeId: existing.employee_id,
          positionId: existing.position_id,
          reason,
        },
      });
      return this.getAppointment(appointmentId)!;
    });
  }

  activeDutyIdsForAppointment(appointmentId: string): string[] {
    return rows(
      this.db
        .prepare(
          `SELECT d.id FROM v2_duty_sessions d
           JOIN v2_staffing_segments ss ON ss.duty_session_id=d.id AND ss.ended_at IS NULL
           WHERE ss.appointment_id=? AND d.lifecycle='ACTIVE'
           ORDER BY d.opened_at`,
        )
        .all(appointmentId),
    ).map((value) => String(value.id));
  }

  bootstrapReference(input: BootstrapReferenceInput): BootstrapReferenceResult {
    return this.transaction(() => {
      const supplier = this.getOrCreateSupplier(input.supplierSlug, input.supplierName);
      const supplierModel = this.getOrCreateSupplierModel({
        supplierId: String(supplier.id),
        supplierModelKey: input.supplierModelKey,
        displayName: input.supplierModelName,
      });
      const employee = this.getOrCreateEmployee({
        supplierId: String(supplier.id),
        supplierModelId: String(supplierModel.id),
        displayName: `${input.supplierModelName} @ ${input.supplierName}`,
      });
      const agreement = this.getOrCreateAgreement({
        supplierId: String(supplier.id),
        externalAccountRef: input.agreementRef,
        name: input.agreementName,
      });
      const employment = this.getOrCreateCurrentEmployment({
        employeeId: String(employee.id),
        supplyAgreementId: String(agreement.id),
      });
      const gateway = this.getOrCreateGateway({
        slug: input.gatewaySlug,
        kind: input.gatewayKind,
        displayName: input.gatewayName,
        baseUrlHint: input.gatewayBaseUrlHint,
      });
      const externalRouteRef = `employment:${String(employment.id)}`;
      const binding = this.getOrCreateGatewayBinding({
        employmentId: String(employment.id),
        gatewayId: String(gateway.id),
        externalRouteRef,
        protocol: input.protocol,
      });
      const workScope = this.getOrCreateWorkScope({
        slug: input.workScopeSlug,
        name: input.workScopeName,
        externalProfileRef: input.externalProfileRef,
      });
      const position = this.getOrCreatePosition({
        workScopeId: String(workScope.id),
        slug: input.positionSlug,
        name: input.positionName,
        kind: input.positionKind,
        runtimeKind: input.runtimeKind,
      });
      const appointment = this.getOrCreateCurrentAppointment({
        employeeId: String(employee.id),
        positionId: String(position.id),
        appointmentClass: 'PRIMARY',
        priority: 100,
      });
      return {
        supplierId: String(supplier.id),
        supplierModelId: String(supplierModel.id),
        employeeId: String(employee.id),
        agreementId: String(agreement.id),
        employmentId: String(employment.id),
        gatewayId: String(gateway.id),
        gatewayBindingId: String(binding.id),
        externalRouteRef,
        workScopeId: String(workScope.id),
        positionId: String(position.id),
        appointmentId: String(appointment.id),
      };
    });
  }

  findActiveGatewayBinding(employmentId: string, gatewaySlug?: string): GatewayBinding | null {
    const value = row(
      this.db
        .prepare(
          `SELECT b.*,g.slug gateway_slug
           FROM v2_gateway_bindings b JOIN v2_gateways g ON g.id=b.gateway_id
           WHERE b.employment_id=? AND b.lifecycle='ACTIVE' AND g.lifecycle='ACTIVE'
             AND (? IS NULL OR g.slug=?)
           ORDER BY b.priority DESC,b.created_at ASC LIMIT 1`,
        )
        .get(employmentId, gatewaySlug ?? null, gatewaySlug ?? null),
    );
    if (!value) return null;
    return {
      gatewayId: String(value.gateway_slug),
      employmentId: String(value.employment_id),
      externalRouteRef: String(value.external_route_ref),
      protocol: String(value.protocol) as GatewayProtocol,
    };
  }

  listEmployees(): Row[] {
    return rows(
      this.db
        .prepare(
          `SELECT e.id,e.display_name,e.record_lifecycle,e.first_seen_at,
                  s.id supplier_id,s.slug supplier_slug,s.name supplier_name,
                  sm.id supplier_model_id,sm.supplier_model_key,sm.display_name supplier_model_name,
                  (SELECT COUNT(*) FROM v2_employments em
                    WHERE em.employee_id=e.id AND em.status='CURRENT' AND em.effective_to IS NULL) current_employments,
                  (SELECT COUNT(*) FROM v2_appointments a
                    WHERE a.employee_id=e.id AND a.status='CURRENT' AND a.effective_to IS NULL) current_appointments,
                  (SELECT COUNT(*) FROM v2_staffing_segments ss
                    WHERE ss.employee_id=e.id AND ss.ended_at IS NULL) current_duties
           FROM v2_employees e
           JOIN v2_suppliers s ON s.id=e.supplier_id
           JOIN v2_supplier_models sm ON sm.id=e.supplier_model_id
           ORDER BY e.display_name`,
        )
        .all(),
    ).map((value) => ({
      id: value.id,
      displayName: value.display_name,
      recordLifecycle: value.record_lifecycle,
      cooperationState: Number(value.current_employments ?? 0) > 0 ? 'EMPLOYED' : 'DORMANT',
      supplier: {
        id: value.supplier_id,
        slug: value.supplier_slug,
        name: value.supplier_name,
      },
      supplierModel: {
        id: value.supplier_model_id,
        key: value.supplier_model_key,
        name: value.supplier_model_name,
      },
      currentEmploymentCount: Number(value.current_employments ?? 0),
      currentAppointmentCount: Number(value.current_appointments ?? 0),
      currentDutyCount: Number(value.current_duties ?? 0),
      firstSeenAt: value.first_seen_at,
    }));
  }

  employeeDossier(employeeId: string): Row | null {
    const identity = row(
      this.db
        .prepare(
          `SELECT e.*,s.slug supplier_slug,s.name supplier_name,
                  sm.supplier_model_key,sm.display_name supplier_model_name
           FROM v2_employees e
           JOIN v2_suppliers s ON s.id=e.supplier_id
           JOIN v2_supplier_models sm ON sm.id=e.supplier_model_id
           WHERE e.id=?`,
        )
        .get(employeeId),
    );
    if (!identity) return null;
    const employments = rows(
      this.db
        .prepare(
          `SELECT em.*,a.name agreement_name,a.lifecycle agreement_lifecycle,a.external_account_ref
           FROM v2_employments em JOIN v2_supply_agreements a ON a.id=em.supply_agreement_id
           WHERE em.employee_id=? ORDER BY em.effective_from DESC`,
        )
        .all(employeeId),
    );
    const appointments = rows(
      this.db
        .prepare(
          `SELECT a.*,p.name position_name,p.slug position_slug,p.kind position_kind,
                  ws.name work_scope_name,ws.slug work_scope_slug
           FROM v2_appointments a
           JOIN v2_positions p ON p.id=a.position_id
           LEFT JOIN v2_work_scopes ws ON ws.id=p.work_scope_id
           WHERE a.employee_id=? ORDER BY a.effective_from DESC`,
        )
        .all(employeeId),
    );
    const currentWork = rows(
      this.db
        .prepare(
          `SELECT ss.*,d.current_activity,d.lifecycle duty_lifecycle,
                  p.id position_id,p.name position_name,p.slug position_slug,
                  r.id run_id,r.title run_title,r.status run_status
           FROM v2_staffing_segments ss
           JOIN v2_duty_sessions d ON d.id=ss.duty_session_id
           JOIN v2_positions p ON p.id=d.position_id
           JOIN v2_runs r ON r.id=d.run_id
           WHERE ss.employee_id=? AND ss.ended_at IS NULL
           ORDER BY ss.started_at DESC`,
        )
        .all(employeeId),
    );
    const usage =
      row(
        this.db
          .prepare(
            `SELECT COUNT(*) requests,
                    COALESCE(SUM(input_tokens),0) input_tokens,
                    COALESCE(SUM(output_tokens),0) output_tokens,
                    COALESCE(SUM(cache_read_tokens),0) cache_read_tokens,
                    COALESCE(SUM(cache_write_tokens),0) cache_write_tokens,
                    COALESCE(SUM(reasoning_tokens),0) reasoning_tokens,
                    COALESCE(SUM(actual_cost),0) actual_cost,
                    COALESCE(SUM(allocated_cost),0) allocated_cost,
                    COALESCE(SUM(market_value),0) market_value
             FROM v2_usage_entries WHERE employee_id=?`,
          )
          .get(employeeId),
      ) ?? {};
    const derivedMarketValue = Number(
      row(
        this.db
          .prepare(
            `SELECT COALESCE(SUM(v.amount),0) amount
             FROM v2_usage_market_valuations v
             JOIN v2_usage_entries u ON u.id=v.usage_entry_id
             WHERE u.employee_id=? AND v.superseded_at IS NULL`,
          )
          .get(employeeId),
      )?.amount ?? 0,
    );
    const derivedAllocatedCost = Number(
      row(
        this.db
          .prepare(
            `SELECT COALESCE(SUM(e.amount),0) amount
             FROM v2_cost_allocation_entries e
             JOIN v2_cost_allocation_runs r ON r.id=e.allocation_run_id
             JOIN v2_usage_entries u ON u.id=e.usage_entry_id
             WHERE u.employee_id=? AND r.status='COMPLETED' AND r.superseded_at IS NULL`,
          )
          .get(employeeId),
      )?.amount ?? 0,
    );
    return {
      identity: {
        id: identity.id,
        displayName: identity.display_name,
        lifecycle: identity.record_lifecycle,
        firstSeenAt: identity.first_seen_at,
        supplier: {
          id: identity.supplier_id,
          slug: identity.supplier_slug,
          name: identity.supplier_name,
        },
        supplierModel: {
          id: identity.supplier_model_id,
          key: identity.supplier_model_key,
          name: identity.supplier_model_name,
        },
      },
      cooperation: {
        state: employments.some((item) => item.status === 'CURRENT' && item.effective_to == null)
          ? 'EMPLOYED'
          : 'DORMANT',
        currentEmployments: employments.filter(
          (item) => item.status === 'CURRENT' && item.effective_to == null,
        ),
        employmentHistory: employments,
      },
      organization: {
        currentAppointments: appointments.filter(
          (item) => item.status === 'CURRENT' && item.effective_to == null,
        ),
        appointmentHistory: appointments,
      },
      currentWork,
      career: {
        staffingSegments: Number(
          row(
            this.db
              .prepare('SELECT COUNT(*) count FROM v2_staffing_segments WHERE employee_id=?')
              .get(employeeId),
          )?.count ?? 0,
        ),
        usage: {
          requests: Number(usage.requests ?? 0),
          inputTokens: Number(usage.input_tokens ?? 0),
          outputTokens: Number(usage.output_tokens ?? 0),
          cacheReadTokens: Number(usage.cache_read_tokens ?? 0),
          cacheWriteTokens: Number(usage.cache_write_tokens ?? 0),
          reasoningTokens: Number(usage.reasoning_tokens ?? 0),
          actualCost: Number(usage.actual_cost ?? 0),
          allocatedCost: Number(usage.allocated_cost ?? 0) + derivedAllocatedCost,
          marketValue: Number(usage.market_value ?? 0) + derivedMarketValue,
        },
      },
    };
  }

  workforceProjection(): Row {
    const employees: Row[] = this.listEmployees().map((employee): Row => {
      const dossier = this.employeeDossier(String(employee.id));
      const organization = (dossier?.organization ?? {}) as Row;
      const career = (dossier?.career ?? {}) as Row;
      const usage = (career.usage ?? {}) as Row;
      const currentAppointments = Array.isArray(organization.currentAppointments)
        ? (organization.currentAppointments as Row[])
        : [];
      const currentWork = Array.isArray(dossier?.currentWork) ? (dossier.currentWork as Row[]) : [];
      return {
        ...employee,
        currentAppointments: currentAppointments.map((appointment) => ({
          id: appointment.id,
          positionId: appointment.position_id,
          positionName: appointment.position_name,
          positionSlug: appointment.position_slug,
          positionKind: appointment.position_kind,
          workScopeName: appointment.work_scope_name,
          workScopeSlug: appointment.work_scope_slug,
          class: appointment.appointment_class,
          priority: Number(appointment.priority ?? 0),
        })),
        currentWork: currentWork.map((work) => ({
          staffingSegmentId: work.id,
          dutySessionId: work.duty_session_id,
          positionId: work.position_id,
          positionName: work.position_name,
          positionSlug: work.position_slug,
          runId: work.run_id,
          runTitle: work.run_title,
          activity: work.current_activity,
          startedAt: work.started_at,
        })),
        career: {
          staffingSegments: Number(career.staffingSegments ?? 0),
          usage: {
            requests: Number(usage.requests ?? 0),
            inputTokens: Number(usage.inputTokens ?? 0),
            outputTokens: Number(usage.outputTokens ?? 0),
            cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
            cacheWriteTokens: Number(usage.cacheWriteTokens ?? 0),
            reasoningTokens: Number(usage.reasoningTokens ?? 0),
            actualCost: Number(usage.actualCost ?? 0),
            allocatedCost: Number(usage.allocatedCost ?? 0),
            marketValue: Number(usage.marketValue ?? 0),
          },
        },
      };
    });
    const gateways = this.listGateways();
    const totalUsage = employees.reduce<{
      requests: number;
      inputTokens: number;
      outputTokens: number;
      actualCost: number;
      marketValue: number;
    }>(
      (totals, employee) => {
        const usage = (employee.career as Row).usage as Row;
        totals.requests += Number(usage.requests ?? 0);
        totals.inputTokens += Number(usage.inputTokens ?? 0);
        totals.outputTokens += Number(usage.outputTokens ?? 0);
        totals.actualCost += Number(usage.actualCost ?? 0);
        totals.marketValue += Number(usage.marketValue ?? 0);
        return totals;
      },
      { requests: 0, inputTokens: 0, outputTokens: 0, actualCost: 0, marketValue: 0 },
    );
    return {
      projectionVersion: 2,
      generatedAt: now(),
      employees,
      gateways,
      summary: {
        employees: employees.length,
        employed: employees.filter((item) => item['cooperationState'] === 'EMPLOYED').length,
        dormant: employees.filter((item) => item['cooperationState'] === 'DORMANT').length,
        currentDuties: employees.reduce(
          (sum, item) => sum + Number(item['currentDutyCount'] ?? 0),
          0,
        ),
        ...totalUsage,
      },
    };
  }

  getPosition(positionId: string): Row | null {
    return row(
      this.db
        .prepare(
          `SELECT p.*,ws.slug work_scope_slug,ws.name work_scope_name
           FROM v2_positions p LEFT JOIN v2_work_scopes ws ON ws.id=p.work_scope_id
           WHERE p.id=?`,
        )
        .get(positionId),
    );
  }

  findPositionBySlug(slug: string, workScopeSlug?: string): Row | null {
    return row(
      this.db
        .prepare(
          `SELECT p.*,ws.slug work_scope_slug,ws.name work_scope_name
           FROM v2_positions p LEFT JOIN v2_work_scopes ws ON ws.id=p.work_scope_id
           WHERE p.slug=? AND (? IS NULL OR ws.slug=?)
           ORDER BY p.created_at LIMIT 1`,
        )
        .get(slug, workScopeSlug ?? null, workScopeSlug ?? null),
    );
  }

  createRun(input: CreateRunInput): Row {
    if (input.externalRunRef) {
      const existing = row(
        this.db.prepare('SELECT * FROM v2_runs WHERE external_run_ref=?').get(input.externalRunRef),
      );
      if (existing) return existing;
    }
    const timestamp = now();
    const id = newId('run', timestamp);
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO v2_runs(id,work_scope_id,external_run_ref,title,status,started_at,metadata_json,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.workScopeId,
          input.externalRunRef ?? null,
          input.title,
          'RUNNING',
          timestamp,
          encode(input.metadata),
          timestamp,
          timestamp,
        );
      this.emit({
        type: 'run.started',
        entityType: 'Run',
        entityId: id,
        runId: id,
        payload: { workScopeId: input.workScopeId, title: input.title },
      });
    });
    return row(this.db.prepare('SELECT * FROM v2_runs WHERE id=?').get(id))!;
  }

  getRun(runId: string): Row | null {
    return row(this.db.prepare('SELECT * FROM v2_runs WHERE id=?').get(runId));
  }

  listRuns(limit = 100): Row[] {
    return rows(
      this.db
        .prepare(
          `SELECT r.*,ws.slug work_scope_slug,ws.name work_scope_name
           FROM v2_runs r LEFT JOIN v2_work_scopes ws ON ws.id=r.work_scope_id
           ORDER BY r.started_at DESC LIMIT ?`,
        )
        .all(limit),
    ).map((value) => ({
      id: value.id,
      workScope: value.work_scope_id
        ? { id: value.work_scope_id, slug: value.work_scope_slug, name: value.work_scope_name }
        : null,
      externalRunRef: value.external_run_ref,
      title: value.title,
      status: value.status,
      startedAt: value.started_at,
      completedAt: value.completed_at,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
  }

  openDuty(input: OpenDutyInput): Row {
    const run = this.getRun(input.runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    const position = this.getPosition(input.positionId);
    if (!position) throw new Error('POSITION_NOT_FOUND');
    const existing = row(
      this.db
        .prepare(
          `SELECT * FROM v2_duty_sessions
           WHERE run_id=? AND position_id=? AND lifecycle IN ('PLANNED','ACTIVE')
           ORDER BY opened_at DESC LIMIT 1`,
        )
        .get(input.runId, input.positionId),
    );
    if (existing) return existing;
    const timestamp = now();
    const id = newId('duty', timestamp);
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO v2_duty_sessions(id,run_id,position_id,lifecycle,current_activity,opened_at,metadata_json)
           VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.runId,
          input.positionId,
          'PLANNED',
          input.activity ?? 'IDLE',
          timestamp,
          encode(input.metadata),
        );
      this.emit({
        type: 'duty.opened',
        entityType: 'DutySession',
        entityId: id,
        runId: input.runId,
        dutySessionId: id,
        payload: { positionId: input.positionId },
      });
    });
    return row(this.db.prepare('SELECT * FROM v2_duty_sessions WHERE id=?').get(id))!;
  }

  getDuty(dutySessionId: string): Row | null {
    return row(
      this.db
        .prepare(
          `SELECT d.*,p.name position_name,p.slug position_slug,p.kind position_kind,
                  r.title run_title,r.status run_status,r.work_scope_id
           FROM v2_duty_sessions d
           JOIN v2_positions p ON p.id=d.position_id
           JOIN v2_runs r ON r.id=d.run_id
           WHERE d.id=?`,
        )
        .get(dutySessionId),
    );
  }

  listDuties(filters: { runId?: string; activeOnly?: boolean } = {}): Row[] {
    return rows(
      this.db
        .prepare(
          `SELECT d.*,p.name position_name,p.slug position_slug,p.kind position_kind,
                  r.title run_title,r.status run_status,
                  ss.id staffing_segment_id,ss.employee_id,e.display_name employee_name
           FROM v2_duty_sessions d
           JOIN v2_positions p ON p.id=d.position_id
           JOIN v2_runs r ON r.id=d.run_id
           LEFT JOIN v2_staffing_segments ss ON ss.duty_session_id=d.id AND ss.ended_at IS NULL
           LEFT JOIN v2_employees e ON e.id=ss.employee_id
           WHERE (? IS NULL OR d.run_id=?)
             AND (?=0 OR d.lifecycle IN ('PLANNED','ACTIVE'))
           ORDER BY d.opened_at DESC`,
        )
        .all(filters.runId ?? null, filters.runId ?? null, filters.activeOnly ? 1 : 0),
    ).map((value) => ({
      id: value.id,
      runId: value.run_id,
      runTitle: value.run_title,
      runStatus: value.run_status,
      positionId: value.position_id,
      positionName: value.position_name,
      positionSlug: value.position_slug,
      positionKind: value.position_kind,
      lifecycle: value.lifecycle,
      currentActivity: value.current_activity,
      openedAt: value.opened_at,
      closedAt: value.closed_at,
      closeReason: value.close_reason,
      currentStaffing: value.staffing_segment_id
        ? {
            segmentId: value.staffing_segment_id,
            employeeId: value.employee_id,
            employeeName: value.employee_name,
          }
        : null,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
  }

  dispatchCandidates(positionId: string): DispatchCandidate[] {
    const raw = rows(
      this.db
        .prepare(
          `SELECT a.id appointment_id,a.appointment_class,a.priority appointment_priority,
                  e.id employee_id,e.display_name employee_name,e.record_lifecycle,
                  em.id employment_id,em.supply_agreement_id,em.status employment_status,
                  agr.lifecycle agreement_lifecycle,
                  b.id gateway_binding_id,b.external_route_ref,b.protocol,b.priority binding_priority,
                  g.slug gateway_slug,g.lifecycle gateway_lifecycle
           FROM v2_appointments a
           JOIN v2_employees e ON e.id=a.employee_id
           LEFT JOIN v2_employments em
             ON em.employee_id=e.id AND em.status='CURRENT' AND em.effective_to IS NULL
           LEFT JOIN v2_supply_agreements agr ON agr.id=em.supply_agreement_id
           LEFT JOIN v2_gateway_bindings b
             ON b.employment_id=em.id AND b.lifecycle='ACTIVE'
           LEFT JOIN v2_gateways g ON g.id=b.gateway_id AND g.lifecycle='ACTIVE'
           WHERE a.position_id=? AND a.status='CURRENT' AND a.effective_to IS NULL
           ORDER BY CASE a.appointment_class WHEN 'PRIMARY' THEN 0 WHEN 'BACKUP' THEN 1 ELSE 2 END,
                    a.priority DESC,b.priority DESC,em.effective_from ASC`,
        )
        .all(positionId),
    );
    const byAppointment = new Map<string, DispatchCandidate>();
    for (const value of raw) {
      const appointmentId = String(value.appointment_id);
      let candidate = byAppointment.get(appointmentId);
      if (!candidate) {
        const lifecycleEligible = value.record_lifecycle === 'ACTIVE';
        candidate = {
          employeeId: String(value.employee_id),
          employeeName: String(value.employee_name),
          employeeLifecycle: String(value.record_lifecycle),
          appointmentId,
          appointmentClass: String(
            value.appointment_class,
          ) as DispatchCandidate['appointmentClass'],
          appointmentPriority: Number(value.appointment_priority ?? 0),
          qualified: true,
          eligible: lifecycleEligible,
          reasons: lifecycleEligible
            ? ['CURRENT_APPOINTMENT', 'FIRST_SLICE_STATIC_QUALIFICATION']
            : ['EMPLOYEE_NOT_ACTIVE'],
          routes: [],
        };
        byAppointment.set(appointmentId, candidate);
      }
      if (
        candidate.eligible &&
        value.employment_id &&
        value.supply_agreement_id &&
        value.employment_status === 'CURRENT' &&
        value.agreement_lifecycle === 'ACTIVE' &&
        value.gateway_binding_id &&
        value.gateway_slug &&
        value.gateway_lifecycle === 'ACTIVE'
      ) {
        candidate.routes.push({
          employmentId: String(value.employment_id),
          supplyAgreementId: String(value.supply_agreement_id),
          gatewayId: String(value.gateway_slug),
          gatewayBindingId: String(value.gateway_binding_id),
          externalRouteRef: String(value.external_route_ref),
          protocol: String(value.protocol) as GatewayProtocol,
          bindingPriority: Number(value.binding_priority ?? 0),
        });
      }
    }
    return [...byAppointment.values()];
  }

  recordDispatch(input: RecordDispatchInput): Row {
    const duty = this.getDuty(input.dutySessionId);
    if (!duty) throw new Error('DUTY_NOT_FOUND');
    if (!['PLANNED', 'ACTIVE'].includes(String(duty.lifecycle))) {
      throw new Error('DUTY_NOT_DISPATCHABLE');
    }
    const timestamp = now();
    const decisionId = newId('disp', timestamp);
    return this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO v2_dispatch_decisions(id,duty_session_id,selected_employee_id,selected_appointment_id,selected_employment_id,candidate_results_json,reasons_json,policy_version,trigger,correlation_id,decided_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          decisionId,
          input.dutySessionId,
          input.selected?.employeeId ?? null,
          input.selected?.appointmentId ?? null,
          input.selected?.employmentId ?? null,
          encode(input.candidateResults),
          encode(input.reasons ?? []),
          input.policyVersion,
          input.trigger,
          input.correlationId ?? null,
          timestamp,
        );

      let segmentId: string | null = null;
      let replacedSegmentId: string | null = null;
      const open = row(
        this.db
          .prepare(
            'SELECT * FROM v2_staffing_segments WHERE duty_session_id=? AND ended_at IS NULL',
          )
          .get(input.dutySessionId),
      );
      if (input.selected) {
        if (open && open.employee_id === input.selected.employeeId) {
          segmentId = String(open.id);
        } else {
          if (open) {
            replacedSegmentId = String(open.id);
            this.db
              .prepare(
                `UPDATE v2_staffing_segments SET ended_at=?,ended_reason='REPLACED' WHERE id=?`,
              )
              .run(timestamp, String(open.id));
            this.emit({
              type: 'staffing_segment.ended',
              entityType: 'StaffingSegment',
              entityId: String(open.id),
              runId: String(duty.run_id),
              dutySessionId: input.dutySessionId,
              correlationId: input.correlationId,
              payload: { reason: 'REPLACED', employeeId: open.employee_id },
            });
          }
          segmentId = newId('seg', timestamp);
          this.db
            .prepare(
              `INSERT INTO v2_staffing_segments(id,duty_session_id,employee_id,appointment_id,dispatch_decision_id,started_at,metadata_json)
               VALUES(?,?,?,?,?,?,?)`,
            )
            .run(
              segmentId,
              input.dutySessionId,
              input.selected.employeeId,
              input.selected.appointmentId,
              decisionId,
              timestamp,
              '{}',
            );
          this.emit({
            type: 'staffing_segment.started',
            entityType: 'StaffingSegment',
            entityId: segmentId,
            runId: String(duty.run_id),
            dutySessionId: input.dutySessionId,
            correlationId: input.correlationId,
            payload: {
              employeeId: input.selected.employeeId,
              employmentId: input.selected.employmentId,
              appointmentId: input.selected.appointmentId,
            },
          });
        }
        this.db
          .prepare(
            "UPDATE v2_duty_sessions SET lifecycle='ACTIVE',current_activity='IDLE' WHERE id=?",
          )
          .run(input.dutySessionId);
      } else {
        if (open) {
          this.db
            .prepare(
              `UPDATE v2_staffing_segments SET ended_at=?,ended_reason='UNAVAILABLE' WHERE id=?`,
            )
            .run(timestamp, String(open.id));
          this.emit({
            type: 'staffing_segment.ended',
            entityType: 'StaffingSegment',
            entityId: String(open.id),
            runId: String(duty.run_id),
            dutySessionId: input.dutySessionId,
            correlationId: input.correlationId,
            payload: { reason: 'UNAVAILABLE', employeeId: open.employee_id },
          });
        }
        this.db
          .prepare("UPDATE v2_duty_sessions SET current_activity='BLOCKED' WHERE id=?")
          .run(input.dutySessionId);
      }
      this.emit({
        type: input.selected ? 'dispatch.decided' : 'dispatch.failed',
        entityType: 'DispatchDecision',
        entityId: decisionId,
        runId: String(duty.run_id),
        dutySessionId: input.dutySessionId,
        correlationId: input.correlationId,
        payload: {
          selectedEmployeeId: input.selected?.employeeId ?? null,
          selectedEmploymentId: input.selected?.employmentId ?? null,
          candidateCount: input.candidateResults.length,
          reasons: input.reasons ?? [],
        },
      });
      return {
        decisionId,
        dutySessionId: input.dutySessionId,
        selected: input.selected ?? null,
        staffingSegmentId: segmentId,
        replacedStaffingSegmentId: replacedSegmentId,
        decidedAt: timestamp,
      };
    });
  }

  listDispatchDecisions(dutySessionId?: string): Row[] {
    return rows(
      this.db
        .prepare(
          `SELECT * FROM v2_dispatch_decisions
           WHERE (? IS NULL OR duty_session_id=?) ORDER BY decided_at DESC,rowid DESC`,
        )
        .all(dutySessionId ?? null, dutySessionId ?? null),
    ).map((value) => ({
      id: value.id,
      dutySessionId: value.duty_session_id,
      selectedEmployeeId: value.selected_employee_id,
      selectedAppointmentId: value.selected_appointment_id,
      selectedEmploymentId: value.selected_employment_id,
      candidateResults: decode<unknown[]>(value.candidate_results_json, []),
      reasons: decode<string[]>(value.reasons_json, []),
      policyVersion: value.policy_version,
      trigger: value.trigger,
      correlationId: value.correlation_id,
      decidedAt: value.decided_at,
    }));
  }

  invocationContext(dutySessionId: string): InvocationContext | null {
    const value = row(
      this.db
        .prepare(
          `SELECT d.id duty_session_id,d.run_id,d.position_id,d.lifecycle duty_lifecycle,
                  ss.id staffing_segment_id,ss.employee_id,
                  dd.selected_employment_id employment_id,
                  em.supply_agreement_id,
                  e.supplier_id,e.supplier_model_id,
                  b.id gateway_binding_id,b.external_route_ref,b.protocol,
                  g.id gateway_db_id,g.slug gateway_slug
           FROM v2_duty_sessions d
           JOIN v2_staffing_segments ss ON ss.duty_session_id=d.id AND ss.ended_at IS NULL
           JOIN v2_dispatch_decisions dd ON dd.id=(
             SELECT latest.id FROM v2_dispatch_decisions latest
             WHERE latest.duty_session_id=d.id
               AND latest.selected_employee_id=ss.employee_id
               AND latest.selected_employment_id IS NOT NULL
             ORDER BY latest.decided_at DESC,latest.rowid DESC LIMIT 1
           )
           JOIN v2_employees e ON e.id=ss.employee_id
           JOIN v2_employments em
             ON em.id=dd.selected_employment_id AND em.employee_id=e.id
                AND em.status='CURRENT' AND em.effective_to IS NULL
           JOIN v2_supply_agreements agr
             ON agr.id=em.supply_agreement_id AND agr.lifecycle='ACTIVE'
           JOIN v2_gateway_bindings b
             ON b.employment_id=em.id AND b.lifecycle='ACTIVE'
           JOIN v2_gateways g ON g.id=b.gateway_id AND g.lifecycle='ACTIVE'
           WHERE d.id=? AND d.lifecycle='ACTIVE'
           ORDER BY b.priority DESC,b.created_at ASC LIMIT 1`,
        )
        .get(dutySessionId),
    );
    if (!value) return null;
    return {
      dutySessionId: String(value.duty_session_id),
      runId: String(value.run_id),
      positionId: String(value.position_id),
      staffingSegmentId: String(value.staffing_segment_id),
      employeeId: String(value.employee_id),
      employmentId: String(value.employment_id),
      supplyAgreementId: String(value.supply_agreement_id),
      supplierId: String(value.supplier_id),
      supplierModelId: String(value.supplier_model_id),
      gatewayDbId: String(value.gateway_db_id),
      gatewayId: String(value.gateway_slug),
      gatewayBindingId: String(value.gateway_binding_id),
      externalRouteRef: String(value.external_route_ref),
      protocol: String(value.protocol) as GatewayProtocol,
    };
  }

  setDutyActivity(dutySessionId: string, activity: string, correlationId?: string): void {
    const duty = this.getDuty(dutySessionId);
    if (!duty) throw new Error('DUTY_NOT_FOUND');
    this.transaction(() => {
      this.db
        .prepare('UPDATE v2_duty_sessions SET current_activity=? WHERE id=?')
        .run(activity, dutySessionId);
      this.emit({
        type: 'duty.activity.changed',
        entityType: 'DutySession',
        entityId: dutySessionId,
        runId: String(duty.run_id),
        dutySessionId,
        correlationId,
        payload: { activity },
      });
    });
  }

  startInvocation(input: {
    context: InvocationContext;
    runtimeSessionRef?: string;
    correlationId?: string;
    metadata?: JsonRecord;
  }): Row {
    const timestamp = now();
    const id = newId('inv', timestamp);
    return this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO v2_model_invocations(id,run_id,duty_session_id,runtime_session_ref,logical_position_id,status,requested_at,correlation_id,metadata_json)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.context.runId,
          input.context.dutySessionId,
          input.runtimeSessionRef ?? null,
          input.context.positionId,
          'PENDING',
          timestamp,
          input.correlationId ?? null,
          encode(input.metadata),
        );
      this.db
        .prepare("UPDATE v2_duty_sessions SET current_activity='THINKING' WHERE id=?")
        .run(input.context.dutySessionId);
      this.emit({
        type: 'invocation.started',
        entityType: 'ModelInvocation',
        entityId: id,
        correlationId: input.correlationId,
        runId: input.context.runId,
        dutySessionId: input.context.dutySessionId,
        invocationId: id,
        payload: {
          employeeId: input.context.employeeId,
          employmentId: input.context.employmentId,
          externalRouteRef: input.context.externalRouteRef,
        },
      });
      return row(this.db.prepare('SELECT * FROM v2_model_invocations WHERE id=?').get(id))!;
    });
  }

  startInvocationAttempt(input: {
    invocationId: string;
    context: InvocationContext;
    correlationId?: string;
  }): Row {
    const invocation = row(
      this.db.prepare('SELECT * FROM v2_model_invocations WHERE id=?').get(input.invocationId),
    );
    if (!invocation) throw new Error('INVOCATION_NOT_FOUND');
    const timestamp = now();
    const attemptNumber = Number(
      row(
        this.db
          .prepare(
            'SELECT COALESCE(MAX(attempt_number),0)+1 next_number FROM v2_invocation_attempts WHERE invocation_id=?',
          )
          .get(input.invocationId),
      )?.next_number ?? 1,
    );
    const id = newId('attempt', timestamp);
    return this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO v2_invocation_attempts(id,invocation_id,attempt_number,employee_id,employment_id,supply_agreement_id,gateway_id,gateway_binding_id,external_route_ref,outcome,started_at,metadata_json)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.invocationId,
          attemptNumber,
          input.context.employeeId,
          input.context.employmentId,
          input.context.supplyAgreementId,
          input.context.gatewayDbId,
          input.context.gatewayBindingId,
          input.context.externalRouteRef,
          'STARTED',
          timestamp,
          '{}',
        );
      this.db
        .prepare("UPDATE v2_model_invocations SET status='STREAMING' WHERE id=?")
        .run(input.invocationId);
      this.emit({
        type: 'invocation.attempt.started',
        entityType: 'InvocationAttempt',
        entityId: id,
        correlationId: input.correlationId,
        runId: input.context.runId,
        dutySessionId: input.context.dutySessionId,
        invocationId: input.invocationId,
        payload: {
          attemptNumber,
          employeeId: input.context.employeeId,
          employmentId: input.context.employmentId,
          gatewayId: input.context.gatewayId,
          externalRouteRef: input.context.externalRouteRef,
        },
      });
      return row(this.db.prepare('SELECT * FROM v2_invocation_attempts WHERE id=?').get(id))!;
    });
  }

  completeInvocationAttempt(input: {
    attemptId: string;
    gatewayRequestId: string;
    externalDeploymentRef?: string;
    latencyMs: number;
    metadata?: JsonRecord;
    correlationId?: string;
  }): Row {
    const attempt = row(
      this.db
        .prepare(
          `SELECT a.*,i.run_id,i.duty_session_id FROM v2_invocation_attempts a
           JOIN v2_model_invocations i ON i.id=a.invocation_id WHERE a.id=?`,
        )
        .get(input.attemptId),
    );
    if (!attempt) throw new Error('INVOCATION_ATTEMPT_NOT_FOUND');
    const timestamp = now();
    return this.transaction(() => {
      this.db
        .prepare(
          `UPDATE v2_invocation_attempts
           SET outcome='SUCCEEDED',gateway_request_id=?,external_deployment_ref=?,latency_ms=?,ended_at=?,metadata_json=?
           WHERE id=?`,
        )
        .run(
          input.gatewayRequestId,
          input.externalDeploymentRef ?? null,
          Math.round(input.latencyMs),
          timestamp,
          encode(input.metadata),
          input.attemptId,
        );
      this.emit({
        type: 'invocation.attempt.succeeded',
        entityType: 'InvocationAttempt',
        entityId: input.attemptId,
        correlationId: input.correlationId,
        runId: String(attempt.run_id),
        dutySessionId: String(attempt.duty_session_id),
        invocationId: String(attempt.invocation_id),
        payload: {
          gatewayRequestId: input.gatewayRequestId,
          externalDeploymentRef: input.externalDeploymentRef ?? null,
          latencyMs: input.latencyMs,
        },
      });
      return row(
        this.db.prepare('SELECT * FROM v2_invocation_attempts WHERE id=?').get(input.attemptId),
      )!;
    });
  }

  failInvocationAttempt(input: {
    attemptId: string;
    errorClass: string;
    correlationId?: string;
  }): Row {
    const attempt = row(
      this.db
        .prepare(
          `SELECT a.*,i.run_id,i.duty_session_id FROM v2_invocation_attempts a
           JOIN v2_model_invocations i ON i.id=a.invocation_id WHERE a.id=?`,
        )
        .get(input.attemptId),
    );
    if (!attempt) throw new Error('INVOCATION_ATTEMPT_NOT_FOUND');
    const timestamp = now();
    return this.transaction(() => {
      this.db
        .prepare(
          `UPDATE v2_invocation_attempts SET outcome='FAILED',error_class=?,ended_at=? WHERE id=?`,
        )
        .run(input.errorClass, timestamp, input.attemptId);
      this.emit({
        type: 'invocation.attempt.failed',
        entityType: 'InvocationAttempt',
        entityId: input.attemptId,
        correlationId: input.correlationId,
        runId: String(attempt.run_id),
        dutySessionId: String(attempt.duty_session_id),
        invocationId: String(attempt.invocation_id),
        payload: { errorClass: input.errorClass },
      });
      return row(
        this.db.prepare('SELECT * FROM v2_invocation_attempts WHERE id=?').get(input.attemptId),
      )!;
    });
  }

  recordUsage(input: {
    attemptId: string;
    context: InvocationContext;
    usage: UsageInput;
    source: string;
    correlationId?: string;
    metadata?: JsonRecord;
  }): Row {
    const existing = row(
      this.db
        .prepare('SELECT * FROM v2_usage_entries WHERE invocation_attempt_id=?')
        .get(input.attemptId),
    );
    if (existing) return existing;
    const timestamp = now();
    const id = newId('usage', timestamp);
    return this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO v2_usage_entries(id,invocation_attempt_id,run_id,duty_session_id,position_id,employee_id,supplier_id,employment_id,supply_agreement_id,supplier_model_id,gateway_id,external_route_ref,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,actual_cost,allocated_cost,market_value,currency,occurred_at,source,metadata_json)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.attemptId,
          input.context.runId,
          input.context.dutySessionId,
          input.context.positionId,
          input.context.employeeId,
          input.context.supplierId,
          input.context.employmentId,
          input.context.supplyAgreementId,
          input.context.supplierModelId,
          input.context.gatewayDbId,
          input.context.externalRouteRef,
          Math.max(0, Math.round(input.usage.inputTokens)),
          Math.max(0, Math.round(input.usage.outputTokens)),
          Math.max(0, Math.round(input.usage.cacheReadTokens)),
          Math.max(0, Math.round(input.usage.cacheWriteTokens)),
          Math.max(0, Math.round(input.usage.reasoningTokens)),
          input.usage.actualCost ?? 0,
          input.usage.allocatedCost ?? 0,
          input.usage.marketValue ?? 0,
          input.usage.currency ?? 'USD',
          timestamp,
          input.source,
          encode(input.metadata),
        );
      this.emit({
        type: 'usage.recorded',
        entityType: 'UsageEntry',
        entityId: id,
        correlationId: input.correlationId,
        runId: input.context.runId,
        dutySessionId: input.context.dutySessionId,
        payload: {
          invocationAttemptId: input.attemptId,
          employeeId: input.context.employeeId,
          employmentId: input.context.employmentId,
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          actualCost: input.usage.actualCost ?? 0,
        },
      });
      return row(this.db.prepare('SELECT * FROM v2_usage_entries WHERE id=?').get(id))!;
    });
  }

  completeInvocation(input: {
    invocationId: string;
    status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
    correlationId?: string;
  }): Row {
    const invocation = row(
      this.db.prepare('SELECT * FROM v2_model_invocations WHERE id=?').get(input.invocationId),
    );
    if (!invocation) throw new Error('INVOCATION_NOT_FOUND');
    const timestamp = now();
    return this.transaction(() => {
      this.db
        .prepare('UPDATE v2_model_invocations SET status=?,completed_at=? WHERE id=?')
        .run(input.status, timestamp, input.invocationId);
      this.emit({
        type: input.status === 'SUCCEEDED' ? 'invocation.completed' : 'invocation.failed',
        entityType: 'ModelInvocation',
        entityId: input.invocationId,
        correlationId: input.correlationId,
        runId: String(invocation.run_id),
        dutySessionId: String(invocation.duty_session_id),
        invocationId: input.invocationId,
        payload: { status: input.status },
      });
      return row(
        this.db.prepare('SELECT * FROM v2_model_invocations WHERE id=?').get(input.invocationId),
      )!;
    });
  }

  completeDuty(input: {
    dutySessionId: string;
    outcome?: 'COMPLETED' | 'FAILED' | 'CANCELLED';
    reason?: string;
    correlationId?: string;
  }): Row {
    const duty = this.getDuty(input.dutySessionId);
    if (!duty) throw new Error('DUTY_NOT_FOUND');
    const outcome = input.outcome ?? 'COMPLETED';
    const timestamp = now();
    return this.transaction(() => {
      const open = row(
        this.db
          .prepare(
            'SELECT * FROM v2_staffing_segments WHERE duty_session_id=? AND ended_at IS NULL',
          )
          .get(input.dutySessionId),
      );
      if (open) {
        this.db
          .prepare('UPDATE v2_staffing_segments SET ended_at=?,ended_reason=? WHERE id=?')
          .run(timestamp, outcome, String(open.id));
        this.emit({
          type: 'staffing_segment.ended',
          entityType: 'StaffingSegment',
          entityId: String(open.id),
          correlationId: input.correlationId,
          runId: String(duty.run_id),
          dutySessionId: input.dutySessionId,
          payload: { employeeId: open.employee_id, reason: outcome },
        });
      }
      this.db
        .prepare(
          `UPDATE v2_duty_sessions SET lifecycle=?,current_activity='IDLE',closed_at=?,close_reason=? WHERE id=?`,
        )
        .run(outcome, timestamp, input.reason ?? outcome, input.dutySessionId);
      this.emit({
        type:
          outcome === 'COMPLETED'
            ? 'duty.completed'
            : outcome === 'FAILED'
              ? 'duty.failed'
              : 'duty.cancelled',
        entityType: 'DutySession',
        entityId: input.dutySessionId,
        correlationId: input.correlationId,
        runId: String(duty.run_id),
        dutySessionId: input.dutySessionId,
        payload: { outcome, reason: input.reason ?? outcome },
      });
      const openDuties = Number(
        row(
          this.db
            .prepare(
              `SELECT COUNT(*) count FROM v2_duty_sessions
               WHERE run_id=? AND lifecycle IN ('PLANNED','ACTIVE')`,
            )
            .get(String(duty.run_id)),
        )?.count ?? 0,
      );
      if (openDuties === 0) {
        this.db
          .prepare('UPDATE v2_runs SET status=?,completed_at=?,updated_at=? WHERE id=?')
          .run(outcome, timestamp, timestamp, String(duty.run_id));
        this.emit({
          type:
            outcome === 'COMPLETED'
              ? 'run.completed'
              : outcome === 'FAILED'
                ? 'run.failed'
                : 'run.cancelled',
          entityType: 'Run',
          entityId: String(duty.run_id),
          correlationId: input.correlationId,
          runId: String(duty.run_id),
          payload: { outcome },
        });
      }
      return this.getDuty(input.dutySessionId)!;
    });
  }

  listInvocations(filters: { dutySessionId?: string; runId?: string } = {}): Row[] {
    return rows(
      this.db
        .prepare(
          `SELECT i.*,
                  (SELECT COUNT(*) FROM v2_invocation_attempts a WHERE a.invocation_id=i.id) attempt_count
           FROM v2_model_invocations i
           WHERE (? IS NULL OR i.duty_session_id=?) AND (? IS NULL OR i.run_id=?)
           ORDER BY i.requested_at DESC`,
        )
        .all(
          filters.dutySessionId ?? null,
          filters.dutySessionId ?? null,
          filters.runId ?? null,
          filters.runId ?? null,
        ),
    ).map((value) => ({
      id: value.id,
      runId: value.run_id,
      dutySessionId: value.duty_session_id,
      runtimeSessionRef: value.runtime_session_ref,
      logicalPositionId: value.logical_position_id,
      status: value.status,
      requestedAt: value.requested_at,
      completedAt: value.completed_at,
      correlationId: value.correlation_id,
      attemptCount: Number(value.attempt_count ?? 0),
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
  }

  listUsage(filters: { employeeId?: string; dutySessionId?: string; runId?: string } = {}): Row[] {
    return rows(
      this.db
        .prepare(
          `SELECT u.* FROM v2_usage_entries u
           WHERE (? IS NULL OR u.employee_id=?)
             AND (? IS NULL OR u.duty_session_id=?)
             AND (? IS NULL OR u.run_id=?)
           ORDER BY u.occurred_at DESC`,
        )
        .all(
          filters.employeeId ?? null,
          filters.employeeId ?? null,
          filters.dutySessionId ?? null,
          filters.dutySessionId ?? null,
          filters.runId ?? null,
          filters.runId ?? null,
        ),
    ).map((value) => ({
      id: value.id,
      invocationAttemptId: value.invocation_attempt_id,
      runId: value.run_id,
      dutySessionId: value.duty_session_id,
      positionId: value.position_id,
      employeeId: value.employee_id,
      employmentId: value.employment_id,
      supplyAgreementId: value.supply_agreement_id,
      gatewayId: value.gateway_id,
      externalRouteRef: value.external_route_ref,
      inputTokens: Number(value.input_tokens ?? 0),
      outputTokens: Number(value.output_tokens ?? 0),
      cacheReadTokens: Number(value.cache_read_tokens ?? 0),
      cacheWriteTokens: Number(value.cache_write_tokens ?? 0),
      reasoningTokens: Number(value.reasoning_tokens ?? 0),
      actualCost: Number(value.actual_cost ?? 0),
      allocatedCost: Number(value.allocated_cost ?? 0),
      marketValue: Number(value.market_value ?? 0),
      currency: value.currency,
      occurredAt: value.occurred_at,
      source: value.source,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
  }

  findSupplierBySlug(slug: string): Row | null {
    return row(this.db.prepare('SELECT * FROM v2_suppliers WHERE slug=?').get(slug));
  }

  findSupplierModel(supplierId: string, supplierModelKey: string): Row | null {
    return row(
      this.db
        .prepare('SELECT * FROM v2_supplier_models WHERE supplier_id=? AND supplier_model_key=?')
        .get(supplierId, supplierModelKey),
    );
  }

  findEmployee(supplierId: string, supplierModelId: string): Row | null {
    return row(
      this.db
        .prepare('SELECT * FROM v2_employees WHERE supplier_id=? AND supplier_model_id=?')
        .get(supplierId, supplierModelId),
    );
  }

  findAgreementByExternalRef(supplierId: string, externalAccountRef: string): Row | null {
    return row(
      this.db
        .prepare(
          `SELECT * FROM v2_supply_agreements
           WHERE supplier_id=? AND external_account_ref=? ORDER BY created_at LIMIT 1`,
        )
        .get(supplierId, externalAccountRef),
    );
  }

  findUniqueActiveAgreementForSupplier(supplierId: string): Row | null {
    const values = rows(
      this.db
        .prepare(
          `SELECT * FROM v2_supply_agreements
           WHERE supplier_id=? AND lifecycle='ACTIVE'
           ORDER BY created_at`,
        )
        .all(supplierId),
    );
    return values.length === 1 ? values[0]! : null;
  }

  findCurrentEmployment(employeeId: string, supplyAgreementId: string): Row | null {
    return row(
      this.db
        .prepare(
          `SELECT * FROM v2_employments
           WHERE employee_id=? AND supply_agreement_id=?
             AND status='CURRENT' AND effective_to IS NULL
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(employeeId, supplyAgreementId),
    );
  }

  findGatewayBySlug(slug: string): Row | null {
    return row(this.db.prepare('SELECT * FROM v2_gateways WHERE slug=?').get(slug));
  }

  findGatewayBindingByRoute(gatewaySlug: string, externalRouteRef: string): Row | null {
    return row(
      this.db
        .prepare(
          `SELECT b.*,g.slug gateway_slug,em.supply_agreement_id,em.employee_id
           FROM v2_gateway_bindings b
           JOIN v2_gateways g ON g.id=b.gateway_id
           JOIN v2_employments em ON em.id=b.employment_id
           WHERE g.slug=? AND b.external_route_ref=? AND b.lifecycle='ACTIVE'
           ORDER BY b.priority DESC,b.created_at LIMIT 1`,
        )
        .get(gatewaySlug, externalRouteRef),
    );
  }

  findGatewayBinding(
    employmentId: string,
    gatewayId: string,
    externalRouteRef: string,
  ): Row | null {
    return row(
      this.db
        .prepare(
          `SELECT * FROM v2_gateway_bindings
           WHERE employment_id=? AND gateway_id=? AND external_route_ref=?`,
        )
        .get(employmentId, gatewayId, externalRouteRef),
    );
  }

  markGatewaySeen(gatewayId: string, observedAt: number): void {
    this.db
      .prepare('UPDATE v2_gateways SET last_seen_at=?,updated_at=? WHERE id=?')
      .run(observedAt, observedAt, gatewayId);
  }

  upsertChannelObservation(input: ChannelObservationInput): ChannelObservationResult {
    const existing = row(
      this.db
        .prepare('SELECT * FROM v2_channels WHERE gateway_id=? AND external_route_ref=?')
        .get(input.gatewayId, input.externalRouteRef),
    );
    const timestamp = now();
    if (!existing) {
      const id = newId('chn', timestamp);
      this.db
        .prepare(
          `INSERT INTO v2_channels(id,gateway_id,supply_agreement_id,external_route_ref,name,protocol,lifecycle,health,supplier_hint,supplier_model_hint,capabilities_json,metadata_json,first_seen_at,last_seen_at,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.gatewayId,
          input.supplyAgreementId ?? null,
          input.externalRouteRef,
          input.name,
          input.protocol,
          input.lifecycle ?? 'ENABLED',
          input.health,
          input.supplierHint ?? null,
          input.supplierModelHint ?? null,
          encode(input.capabilities ?? []),
          encode(input.metadata),
          input.observedAt,
          input.observedAt,
          timestamp,
          timestamp,
        );
      this.emit({
        type: 'channel.discovered',
        entityType: 'Channel',
        entityId: id,
        actorRef: `gateway:${input.gatewayId}`,
        payload: {
          externalRouteRef: input.externalRouteRef,
          health: input.health,
          supplierHint: input.supplierHint ?? null,
          supplierModelHint: input.supplierModelHint ?? null,
        },
      });
      return {
        channel: row(this.db.prepare('SELECT * FROM v2_channels WHERE id=?').get(id))!,
        created: true,
        healthChanged: false,
      };
    }
    const previousHealth = String(existing.health);
    this.db
      .prepare(
        `UPDATE v2_channels
         SET supply_agreement_id=COALESCE(?,supply_agreement_id),name=?,protocol=?,lifecycle=?,health=?,
             supplier_hint=COALESCE(?,supplier_hint),supplier_model_hint=COALESCE(?,supplier_model_hint),
             capabilities_json=?,metadata_json=?,last_seen_at=?,updated_at=?
         WHERE id=?`,
      )
      .run(
        input.supplyAgreementId ?? null,
        input.name,
        input.protocol,
        input.lifecycle ?? String(existing.lifecycle),
        input.health,
        input.supplierHint ?? null,
        input.supplierModelHint ?? null,
        encode(input.capabilities ?? []),
        encode(input.metadata),
        input.observedAt,
        timestamp,
        String(existing.id),
      );
    const healthChanged = previousHealth !== input.health;
    if (healthChanged) {
      this.emit({
        type: 'channel.health.changed',
        entityType: 'Channel',
        entityId: String(existing.id),
        actorRef: `gateway:${input.gatewayId}`,
        payload: {
          externalRouteRef: input.externalRouteRef,
          previousHealth,
          health: input.health,
        },
      });
    }
    return {
      channel: row(
        this.db.prepare('SELECT * FROM v2_channels WHERE id=?').get(String(existing.id)),
      )!,
      created: false,
      healthChanged,
      previousHealth,
    };
  }

  startDiscoveryRun(gatewayId: string, observedAt: number): Row {
    const timestamp = now();
    const id = newId('disc', timestamp);
    this.db
      .prepare(
        `INSERT INTO v2_discovery_runs(id,gateway_id,observed_at,started_at,status,metadata_json)
         VALUES(?,?,?,?,?,?)`,
      )
      .run(id, gatewayId, observedAt, timestamp, 'RUNNING', '{}');
    this.emit({
      type: 'gateway.discovery.started',
      entityType: 'DiscoveryRun',
      entityId: id,
      actorRef: `gateway:${gatewayId}`,
      payload: { gatewayId, observedAt },
    });
    return row(this.db.prepare('SELECT * FROM v2_discovery_runs WHERE id=?').get(id))!;
  }

  completeDiscoveryRun(discoveryRunId: string, summary: DiscoveryRunSummary): Row {
    const timestamp = now();
    return this.transaction(() => {
      this.db
        .prepare(
          `UPDATE v2_discovery_runs
           SET completed_at=?,status='COMPLETED',route_count=?,created_suppliers=?,
               created_supplier_models=?,created_employees=?,created_agreements=?,
               created_employments=?,created_bindings=?,issues_json=?
           WHERE id=?`,
        )
        .run(
          timestamp,
          summary.routeCount,
          summary.createdSuppliers,
          summary.createdSupplierModels,
          summary.createdEmployees,
          summary.createdAgreements,
          summary.createdEmployments,
          summary.createdBindings,
          encode(summary.issues),
          discoveryRunId,
        );
      this.emit({
        type: 'gateway.discovery.completed',
        entityType: 'DiscoveryRun',
        entityId: discoveryRunId,
        payload: summary,
      });
      return row(
        this.db.prepare('SELECT * FROM v2_discovery_runs WHERE id=?').get(discoveryRunId),
      )!;
    });
  }

  failDiscoveryRun(discoveryRunId: string, errorCode: string): Row {
    const timestamp = now();
    return this.transaction(() => {
      this.db
        .prepare(
          `UPDATE v2_discovery_runs
           SET completed_at=?,status='FAILED',error_code=? WHERE id=?`,
        )
        .run(timestamp, errorCode, discoveryRunId);
      this.emit({
        type: 'gateway.discovery.failed',
        entityType: 'DiscoveryRun',
        entityId: discoveryRunId,
        payload: { errorCode },
      });
      return row(
        this.db.prepare('SELECT * FROM v2_discovery_runs WHERE id=?').get(discoveryRunId),
      )!;
    });
  }

  upsertGatewayUsageEvidence(gatewayId: string, evidence: GatewayUsageEvidence): Row {
    const timestamp = now();
    const evidenceKind = evidence.kind === 'request' ? 'REQUEST' : 'AGGREGATE';
    const evidenceKey =
      evidence.kind === 'request' ? evidence.gatewayRequestId : evidence.aggregateKey;
    const existing = row(
      this.db
        .prepare(
          `SELECT * FROM v2_gateway_usage_evidence
           WHERE gateway_id=? AND evidence_kind=? AND evidence_key=?`,
        )
        .get(gatewayId, evidenceKind, evidenceKey),
    );
    const values = {
      externalDeploymentRef:
        evidence.kind === 'request' ? (evidence.externalDeploymentRef ?? null) : null,
      gatewayRequestId: evidence.kind === 'request' ? evidence.gatewayRequestId : null,
      window: evidence.kind === 'aggregate' ? evidence.window : null,
      generatedAt: evidence.kind === 'aggregate' ? evidence.generatedAt : null,
      startedAt: evidence.kind === 'request' ? evidence.startedAt : null,
      completedAt: evidence.kind === 'request' ? (evidence.completedAt ?? null) : null,
      requestStatus: evidence.kind === 'request' ? evidence.status : null,
      errorClass: evidence.kind === 'request' ? (evidence.errorClass ?? null) : null,
      requests: evidence.kind === 'aggregate' ? evidence.requests : 1,
      failedRequests:
        evidence.kind === 'aggregate'
          ? evidence.failedRequests
          : evidence.status === 'failed'
            ? 1
            : 0,
    };
    if (!existing) {
      const id = newId('uev', timestamp);
      this.db
        .prepare(
          `INSERT INTO v2_gateway_usage_evidence(
             id,gateway_id,evidence_kind,evidence_key,external_route_ref,gateway_request_id,
             external_deployment_ref,model,provider,window,generated_at,started_at,completed_at,
             request_status,error_class,requests,failed_requests,input_tokens,output_tokens,
             cache_read_tokens,cache_write_tokens,reasoning_tokens,actual_cost,currency,metadata_json,
             first_seen_at,last_seen_at,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          gatewayId,
          evidenceKind,
          evidenceKey,
          evidence.externalRouteRef,
          values.gatewayRequestId,
          values.externalDeploymentRef,
          evidence.model ?? null,
          evidence.provider ?? null,
          values.window,
          values.generatedAt,
          values.startedAt,
          values.completedAt,
          values.requestStatus,
          values.errorClass,
          values.requests,
          values.failedRequests,
          Math.max(0, Math.round(evidence.inputTokens)),
          Math.max(0, Math.round(evidence.outputTokens)),
          Math.max(0, Math.round(evidence.cacheReadTokens)),
          Math.max(0, Math.round(evidence.cacheWriteTokens)),
          Math.max(0, Math.round(evidence.reasoningTokens)),
          evidence.actualCost ?? 0,
          evidence.currency ?? 'USD',
          encode(evidence.metadata),
          timestamp,
          timestamp,
          timestamp,
          timestamp,
        );
      return row(this.db.prepare('SELECT * FROM v2_gateway_usage_evidence WHERE id=?').get(id))!;
    }
    this.db
      .prepare(
        `UPDATE v2_gateway_usage_evidence SET
           external_route_ref=?,gateway_request_id=?,external_deployment_ref=?,model=?,provider=?,
           window=?,generated_at=?,started_at=?,completed_at=?,request_status=?,error_class=?,
           requests=?,failed_requests=?,input_tokens=?,output_tokens=?,cache_read_tokens=?,
           cache_write_tokens=?,reasoning_tokens=?,actual_cost=?,currency=?,metadata_json=?,
           last_seen_at=?,updated_at=? WHERE id=?`,
      )
      .run(
        evidence.externalRouteRef,
        values.gatewayRequestId,
        values.externalDeploymentRef,
        evidence.model ?? null,
        evidence.provider ?? null,
        values.window,
        values.generatedAt,
        values.startedAt,
        values.completedAt,
        values.requestStatus,
        values.errorClass,
        values.requests,
        values.failedRequests,
        Math.max(0, Math.round(evidence.inputTokens)),
        Math.max(0, Math.round(evidence.outputTokens)),
        Math.max(0, Math.round(evidence.cacheReadTokens)),
        Math.max(0, Math.round(evidence.cacheWriteTokens)),
        Math.max(0, Math.round(evidence.reasoningTokens)),
        evidence.actualCost ?? 0,
        evidence.currency ?? 'USD',
        encode(evidence.metadata),
        timestamp,
        timestamp,
        String(existing.id),
      );
    return row(
      this.db
        .prepare('SELECT * FROM v2_gateway_usage_evidence WHERE id=?')
        .get(String(existing.id)),
    )!;
  }

  reconcileRequestUsageEvidence(
    gatewayId: string,
    evidence: GatewayRequestUsageEvidence,
  ): RequestUsageReconciliationResult {
    const attempt = row(
      this.db
        .prepare(
          `SELECT a.*,i.run_id,i.duty_session_id,i.logical_position_id,
                  e.supplier_id,e.supplier_model_id,g.slug gateway_slug,
                  COALESCE(b.protocol,'unknown') gateway_protocol
           FROM v2_invocation_attempts a
           JOIN v2_model_invocations i ON i.id=a.invocation_id
           JOIN v2_employees e ON e.id=a.employee_id
           JOIN v2_gateways g ON g.id=a.gateway_id
           LEFT JOIN v2_gateway_bindings b ON b.id=a.gateway_binding_id
           WHERE a.gateway_id=? AND a.gateway_request_id=?
           ORDER BY a.started_at DESC LIMIT 1`,
        )
        .get(gatewayId, evidence.gatewayRequestId),
    );
    if (!attempt) return { status: 'UNMATCHED' };

    if (!attempt.external_deployment_ref && evidence.externalDeploymentRef) {
      this.db
        .prepare('UPDATE v2_invocation_attempts SET external_deployment_ref=? WHERE id=?')
        .run(evidence.externalDeploymentRef, String(attempt.id));
    }

    const existingUsage = row(
      this.db
        .prepare('SELECT * FROM v2_usage_entries WHERE invocation_attempt_id=?')
        .get(String(attempt.id)),
    );
    if (!existingUsage) {
      const context: InvocationContext = {
        dutySessionId: String(attempt.duty_session_id),
        runId: String(attempt.run_id),
        positionId: String(attempt.logical_position_id),
        staffingSegmentId: '',
        employeeId: String(attempt.employee_id),
        employmentId: String(attempt.employment_id),
        supplyAgreementId: String(attempt.supply_agreement_id),
        supplierId: String(attempt.supplier_id),
        supplierModelId: String(attempt.supplier_model_id),
        gatewayDbId: gatewayId,
        gatewayId: String(attempt.gateway_slug),
        gatewayBindingId: String(attempt.gateway_binding_id ?? ''),
        externalRouteRef: String(attempt.external_route_ref),
        protocol: String(attempt.gateway_protocol) as GatewayProtocol,
      };
      const usage = this.recordUsage({
        attemptId: String(attempt.id),
        context,
        source: `gateway-reconciliation:${String(attempt.gateway_slug)}`,
        usage: {
          inputTokens: evidence.inputTokens,
          outputTokens: evidence.outputTokens,
          cacheReadTokens: evidence.cacheReadTokens,
          cacheWriteTokens: evidence.cacheWriteTokens,
          reasoningTokens: evidence.reasoningTokens,
          actualCost: evidence.actualCost,
          currency: evidence.currency,
        },
        metadata: {
          reconciled: true,
          gatewayRequestId: evidence.gatewayRequestId,
          externalDeploymentRef: evidence.externalDeploymentRef ?? null,
          evidenceStartedAt: evidence.startedAt,
          evidenceCompletedAt: evidence.completedAt ?? null,
        },
      });
      return {
        status: 'USAGE_CREATED',
        attemptId: String(attempt.id),
        usageEntryId: String(usage.id),
      };
    }

    const differences: Record<string, { ledger: number | string; evidence: number | string }> = {};
    const compareNumber = (name: string, ledger: unknown, observed: number): void => {
      const left = Number(ledger ?? 0);
      if (left !== observed) differences[name] = { ledger: left, evidence: observed };
    };
    compareNumber('inputTokens', existingUsage.input_tokens, evidence.inputTokens);
    compareNumber('outputTokens', existingUsage.output_tokens, evidence.outputTokens);
    compareNumber('cacheReadTokens', existingUsage.cache_read_tokens, evidence.cacheReadTokens);
    compareNumber('cacheWriteTokens', existingUsage.cache_write_tokens, evidence.cacheWriteTokens);
    compareNumber('reasoningTokens', existingUsage.reasoning_tokens, evidence.reasoningTokens);
    if (evidence.actualCost !== undefined) {
      const ledger = Number(existingUsage.actual_cost ?? 0);
      if (Math.abs(ledger - evidence.actualCost) > 1e-9) {
        differences.actualCost = { ledger, evidence: evidence.actualCost };
      }
    }
    if (evidence.currency && String(existingUsage.currency) !== evidence.currency) {
      differences.currency = {
        ledger: String(existingUsage.currency),
        evidence: evidence.currency,
      };
    }
    return {
      status: Object.keys(differences).length ? 'MISMATCH' : 'MATCHED',
      attemptId: String(attempt.id),
      usageEntryId: String(existingUsage.id),
      ...(Object.keys(differences).length ? { differences } : {}),
    };
  }

  startUsageReconciliationRun(gatewayId: string, cursor?: string): Row {
    const timestamp = now();
    const id = newId('urec', timestamp);
    this.db
      .prepare(
        `INSERT INTO v2_usage_reconciliation_runs(id,gateway_id,cursor,started_at,status,metadata_json)
         VALUES(?,?,?,?,?,?)`,
      )
      .run(id, gatewayId, cursor ?? null, timestamp, 'RUNNING', '{}');
    this.emit({
      type: 'gateway.usage_reconciliation.started',
      entityType: 'UsageReconciliationRun',
      entityId: id,
      actorRef: `gateway:${gatewayId}`,
      payload: { gatewayId, cursor: cursor ?? null },
    });
    return row(this.db.prepare('SELECT * FROM v2_usage_reconciliation_runs WHERE id=?').get(id))!;
  }

  completeUsageReconciliationRun(
    reconciliationRunId: string,
    summary: UsageReconciliationSummary,
  ): Row {
    const timestamp = now();
    return this.transaction(() => {
      this.db
        .prepare(
          `UPDATE v2_usage_reconciliation_runs SET completed_at=?,status='COMPLETED',next_cursor=?,
             evidence_count=?,request_matched=?,request_unmatched=?,request_usage_created=?,
             request_mismatched=?,aggregate_count=?,issues_json=? WHERE id=?`,
        )
        .run(
          timestamp,
          summary.nextCursor ?? null,
          summary.evidenceCount,
          summary.requestMatched,
          summary.requestUnmatched,
          summary.requestUsageCreated,
          summary.requestMismatched,
          summary.aggregateCount,
          encode(summary.issues),
          reconciliationRunId,
        );
      this.emit({
        type: 'gateway.usage_reconciliation.completed',
        entityType: 'UsageReconciliationRun',
        entityId: reconciliationRunId,
        payload: summary,
      });
      return row(
        this.db
          .prepare('SELECT * FROM v2_usage_reconciliation_runs WHERE id=?')
          .get(reconciliationRunId),
      )!;
    });
  }

  failUsageReconciliationRun(reconciliationRunId: string, errorCode: string): Row {
    const timestamp = now();
    return this.transaction(() => {
      this.db
        .prepare(
          `UPDATE v2_usage_reconciliation_runs
           SET completed_at=?,status='FAILED',error_code=? WHERE id=?`,
        )
        .run(timestamp, errorCode, reconciliationRunId);
      this.emit({
        type: 'gateway.usage_reconciliation.failed',
        entityType: 'UsageReconciliationRun',
        entityId: reconciliationRunId,
        payload: { errorCode },
      });
      return row(
        this.db
          .prepare('SELECT * FROM v2_usage_reconciliation_runs WHERE id=?')
          .get(reconciliationRunId),
      )!;
    });
  }

  listGatewayUsageEvidence(
    filters: { gatewaySlug?: string; kind?: string; limit?: number } = {},
  ): Row[] {
    const kind = filters.kind?.toUpperCase();
    const limit = Math.min(1_000, Math.max(1, filters.limit ?? 200));
    return rows(
      this.db
        .prepare(
          `SELECT e.*,g.slug gateway_slug,g.display_name gateway_name
           FROM v2_gateway_usage_evidence e JOIN v2_gateways g ON g.id=e.gateway_id
           WHERE (? IS NULL OR g.slug=?) AND (? IS NULL OR e.evidence_kind=?)
           ORDER BY e.last_seen_at DESC LIMIT ?`,
        )
        .all(
          filters.gatewaySlug ?? null,
          filters.gatewaySlug ?? null,
          kind ?? null,
          kind ?? null,
          limit,
        ),
    ).map((value) => ({
      id: value.id,
      gatewayId: value.gateway_id,
      gatewaySlug: value.gateway_slug,
      gatewayName: value.gateway_name,
      kind: String(value.evidence_kind).toLowerCase(),
      evidenceKey: value.evidence_key,
      externalRouteRef: value.external_route_ref,
      gatewayRequestId: value.gateway_request_id,
      externalDeploymentRef: value.external_deployment_ref,
      model: value.model,
      provider: value.provider,
      window: value.window,
      generatedAt: value.generated_at,
      startedAt: value.started_at,
      completedAt: value.completed_at,
      status: value.request_status,
      errorClass: value.error_class,
      requests: Number(value.requests ?? 0),
      failedRequests: Number(value.failed_requests ?? 0),
      inputTokens: Number(value.input_tokens ?? 0),
      outputTokens: Number(value.output_tokens ?? 0),
      cacheReadTokens: Number(value.cache_read_tokens ?? 0),
      cacheWriteTokens: Number(value.cache_write_tokens ?? 0),
      reasoningTokens: Number(value.reasoning_tokens ?? 0),
      actualCost: Number(value.actual_cost ?? 0),
      currency: value.currency,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
      firstSeenAt: value.first_seen_at,
      lastSeenAt: value.last_seen_at,
    }));
  }

  listUsageReconciliationRuns(gatewaySlug?: string, limit = 50): Row[] {
    return rows(
      this.db
        .prepare(
          `SELECT r.*,g.slug gateway_slug,g.display_name gateway_name
           FROM v2_usage_reconciliation_runs r JOIN v2_gateways g ON g.id=r.gateway_id
           WHERE (? IS NULL OR g.slug=?) ORDER BY r.started_at DESC LIMIT ?`,
        )
        .all(gatewaySlug ?? null, gatewaySlug ?? null, Math.min(500, Math.max(1, limit))),
    ).map((value) => ({
      id: value.id,
      gatewayId: value.gateway_id,
      gatewaySlug: value.gateway_slug,
      gatewayName: value.gateway_name,
      cursor: value.cursor,
      nextCursor: value.next_cursor,
      startedAt: value.started_at,
      completedAt: value.completed_at,
      status: value.status,
      evidenceCount: Number(value.evidence_count ?? 0),
      requestMatched: Number(value.request_matched ?? 0),
      requestUnmatched: Number(value.request_unmatched ?? 0),
      requestUsageCreated: Number(value.request_usage_created ?? 0),
      requestMismatched: Number(value.request_mismatched ?? 0),
      aggregateCount: Number(value.aggregate_count ?? 0),
      issues: decode<unknown[]>(value.issues_json, []),
      errorCode: value.error_code,
    }));
  }

  listChannels(gatewaySlug?: string): Row[] {
    return rows(
      this.db
        .prepare(
          `SELECT c.*,g.slug gateway_slug,g.display_name gateway_name,
                  a.name agreement_name
           FROM v2_channels c
           JOIN v2_gateways g ON g.id=c.gateway_id
           LEFT JOIN v2_supply_agreements a ON a.id=c.supply_agreement_id
           WHERE (? IS NULL OR g.slug=?)
           ORDER BY g.display_name,c.name`,
        )
        .all(gatewaySlug ?? null, gatewaySlug ?? null),
    ).map((value) => ({
      id: value.id,
      gatewayId: value.gateway_id,
      gatewaySlug: value.gateway_slug,
      gatewayName: value.gateway_name,
      supplyAgreementId: value.supply_agreement_id,
      agreementName: value.agreement_name,
      externalRouteRef: value.external_route_ref,
      name: value.name,
      protocol: value.protocol,
      lifecycle: value.lifecycle,
      health: value.health,
      supplierHint: value.supplier_hint,
      supplierModelHint: value.supplier_model_hint,
      capabilities: decode<string[]>(value.capabilities_json, []),
      metadata: decode<JsonRecord>(value.metadata_json, {}),
      firstSeenAt: value.first_seen_at,
      lastSeenAt: value.last_seen_at,
    }));
  }

  listDiscoveryRuns(gatewayId?: string, limit = 50): Row[] {
    return rows(
      this.db
        .prepare(
          `SELECT * FROM v2_discovery_runs
           WHERE (? IS NULL OR gateway_id=?)
           ORDER BY started_at DESC,rowid DESC LIMIT ?`,
        )
        .all(gatewayId ?? null, gatewayId ?? null, limit),
    ).map((value) => ({
      id: value.id,
      gatewayId: value.gateway_id,
      observedAt: value.observed_at,
      startedAt: value.started_at,
      completedAt: value.completed_at,
      status: value.status,
      routeCount: Number(value.route_count ?? 0),
      createdSuppliers: Number(value.created_suppliers ?? 0),
      createdSupplierModels: Number(value.created_supplier_models ?? 0),
      createdEmployees: Number(value.created_employees ?? 0),
      createdAgreements: Number(value.created_agreements ?? 0),
      createdEmployments: Number(value.created_employments ?? 0),
      createdBindings: Number(value.created_bindings ?? 0),
      issues: decode<unknown[]>(value.issues_json, []),
      errorCode: value.error_code,
    }));
  }

  listGateways(): Row[] {
    return rows(
      this.db
        .prepare(
          `SELECT g.*,
                  (SELECT COUNT(*) FROM v2_gateway_bindings b
                    WHERE b.gateway_id=g.id AND b.lifecycle='ACTIVE') active_bindings,
                  (SELECT COUNT(*) FROM v2_channels c
                    WHERE c.gateway_id=g.id AND c.lifecycle!='ARCHIVED') route_count
           FROM v2_gateways g ORDER BY g.display_name`,
        )
        .all(),
    ).map((value) => ({
      id: value.id,
      slug: value.slug,
      kind: value.kind,
      displayName: value.display_name,
      lifecycle: value.lifecycle,
      baseUrlHint: value.base_url_hint,
      activeBindings: Number(value.active_bindings ?? 0),
      routeCount: Number(value.route_count ?? 0),
      lastSeenAt: value.last_seen_at,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
  }

  listPositions(): Row[] {
    return rows(
      this.db
        .prepare(
          `SELECT p.*,ws.slug work_scope_slug,ws.name work_scope_name,
                  (SELECT COUNT(*) FROM v2_appointments a
                    WHERE a.position_id=p.id AND a.status='CURRENT' AND a.effective_to IS NULL) current_appointments,
                  (SELECT COUNT(*) FROM v2_duty_sessions d
                    WHERE d.position_id=p.id AND d.lifecycle='ACTIVE') current_duties
           FROM v2_positions p
           LEFT JOIN v2_work_scopes ws ON ws.id=p.work_scope_id
           ORDER BY ws.name,p.name`,
        )
        .all(),
    ).map((value) => ({
      id: value.id,
      slug: value.slug,
      name: value.name,
      kind: value.kind,
      lifecycle: value.lifecycle,
      runtimeKind: value.runtime_kind,
      workScope: value.work_scope_id
        ? { id: value.work_scope_id, slug: value.work_scope_slug, name: value.work_scope_name }
        : null,
      currentAppointmentCount: Number(value.current_appointments ?? 0),
      currentDutyCount: Number(value.current_duties ?? 0),
      requirements: decode<JsonRecord>(value.requirements_json, {}),
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
  }

  listEmployments(employeeId?: string): Row[] {
    return rows(
      this.db
        .prepare(
          `SELECT em.*,a.name agreement_name,a.lifecycle agreement_lifecycle,a.external_account_ref,
                  e.display_name employee_name
           FROM v2_employments em
           JOIN v2_supply_agreements a ON a.id=em.supply_agreement_id
           JOIN v2_employees e ON e.id=em.employee_id
           WHERE (? IS NULL OR em.employee_id=?)
           ORDER BY em.effective_from DESC`,
        )
        .all(employeeId ?? null, employeeId ?? null),
    ).map((value) => ({
      id: value.id,
      employeeId: value.employee_id,
      employeeName: value.employee_name,
      supplyAgreementId: value.supply_agreement_id,
      agreementName: value.agreement_name,
      agreementLifecycle: value.agreement_lifecycle,
      externalAccountRef: value.external_account_ref,
      status: value.status,
      effectiveFrom: value.effective_from,
      effectiveTo: value.effective_to,
      endedReason: value.ended_reason,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
  }

  listAppointments(filters: { employeeId?: string; positionId?: string } = {}): Row[] {
    return rows(
      this.db
        .prepare(
          `SELECT a.*,e.display_name employee_name,p.name position_name,p.slug position_slug,
                  ws.name work_scope_name,ws.slug work_scope_slug
           FROM v2_appointments a
           JOIN v2_employees e ON e.id=a.employee_id
           JOIN v2_positions p ON p.id=a.position_id
           LEFT JOIN v2_work_scopes ws ON ws.id=p.work_scope_id
           WHERE (? IS NULL OR a.employee_id=?) AND (? IS NULL OR a.position_id=?)
           ORDER BY a.effective_from DESC`,
        )
        .all(
          filters.employeeId ?? null,
          filters.employeeId ?? null,
          filters.positionId ?? null,
          filters.positionId ?? null,
        ),
    ).map((value) => ({
      id: value.id,
      employeeId: value.employee_id,
      employeeName: value.employee_name,
      positionId: value.position_id,
      positionName: value.position_name,
      positionSlug: value.position_slug,
      workScopeName: value.work_scope_name,
      workScopeSlug: value.work_scope_slug,
      class: value.appointment_class,
      priority: value.priority,
      status: value.status,
      effectiveFrom: value.effective_from,
      effectiveTo: value.effective_to,
      source: value.source,
      endedReason: value.ended_reason,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
  }

  eventsAfter(seq = 0, limit = 500): Row[] {
    return rows(
      this.db
        .prepare('SELECT * FROM v2_events WHERE seq>? ORDER BY seq ASC LIMIT ?')
        .all(seq, limit),
    ).map((value) => ({
      seq: value.seq,
      eventId: value.event_id,
      type: value.type,
      schemaVersion: value.schema_version,
      entity: { type: value.entity_type, id: value.entity_id },
      correlation: {
        correlationId: value.correlation_id,
        causationId: value.causation_id,
        runId: value.run_id,
        dutySessionId: value.duty_session_id,
        invocationId: value.invocation_id,
      },
      actor: { kind: value.actor_kind, ref: value.actor_ref },
      payload: decode<JsonRecord>(value.payload_json, {}),
      occurredAt: value.occurred_at,
      recordedAt: value.recorded_at,
    }));
  }
}

export class RepositoryGatewayBindingSource implements GatewayBindingSource {
  readonly #repository: V2Repository;
  readonly #gatewaySlug?: string;

  constructor(repository: V2Repository, gatewaySlug?: string) {
    this.#repository = repository;
    this.#gatewaySlug = gatewaySlug;
  }

  async findByEmploymentId(employmentId: string): Promise<GatewayBinding | null> {
    return this.#repository.findActiveGatewayBinding(employmentId, this.#gatewaySlug);
  }
}
