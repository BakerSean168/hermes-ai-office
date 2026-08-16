import type { DatabaseSync } from 'node:sqlite';

import type { GatewayBinding, GatewayBindingSource, GatewayProtocol } from '../gateway/ports.js';
import { newId } from './ids.js';

interface JsonRecord {
  [key: string]: unknown;
}

type Row = Record<string, unknown>;

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

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The original error is authoritative.
      }
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
  }): Row {
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
    return {
      seq: Number(result.lastInsertRowid),
      eventId,
      type: input.type,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      payload: input.payload ?? {},
      occurredAt: input.occurredAt ?? recordedAt,
      recordedAt,
    };
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
          allocatedCost: Number(usage.allocated_cost ?? 0),
          marketValue: Number(usage.market_value ?? 0),
        },
      },
    };
  }

  workforceProjection(): Row {
    const employees = this.listEmployees();
    const gateways = rows(
      this.db
        .prepare(
          `SELECT g.*,
                  COUNT(DISTINCT b.id) active_bindings
           FROM v2_gateways g
           LEFT JOIN v2_gateway_bindings b ON b.gateway_id=g.id AND b.lifecycle='ACTIVE'
           GROUP BY g.id ORDER BY g.display_name`,
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
      lastSeenAt: value.last_seen_at,
    }));
    return {
      projectionVersion: 1,
      generatedAt: now(),
      employees,
      gateways,
      summary: {
        employees: employees.length,
        employed: employees.filter((item) => item.cooperationState === 'EMPLOYED').length,
        dormant: employees.filter((item) => item.cooperationState === 'DORMANT').length,
        currentDuties: employees.reduce((sum, item) => sum + Number(item.currentDutyCount ?? 0), 0),
      },
    };
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
