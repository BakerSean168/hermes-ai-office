import { newId } from './ids.js';
import type { V2Repository, V2Row } from './repository.js';

type JsonRecord = Record<string, unknown>;
type CapabilityValue = number | boolean | string;

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
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export interface Requirement {
  capability: string;
  operator: 'GTE' | 'LTE' | 'EQ' | 'IN';
  value: CapabilityValue | CapabilityValue[];
  hard?: boolean;
}

export interface QualificationResult {
  assessmentId: string;
  employeeId: string;
  positionId: string;
  requirementSetId: string | null;
  qualified: boolean;
  reasons: string[];
  effectiveCapabilities: Record<
    string,
    {
      value: CapabilityValue | null;
      valueType: string;
      confidence: number | null;
      claims: Array<{
        subjectType: string;
        subjectId: string;
        source: string;
        value: CapabilityValue;
      }>;
    }
  >;
}

export interface ConstraintEvaluation {
  eligible: boolean;
  hardReasons: string[];
  softReasons: string[];
  evaluations: Array<{
    constraintId: string;
    name: string;
    type: string;
    strength: string;
    violated: boolean;
    reason?: string;
  }>;
}

export class StaffingRepository {
  readonly #domain: V2Repository;

  constructor(domain: V2Repository) {
    this.#domain = domain;
  }

  createCapabilityDefinition(input: {
    slug: string;
    name: string;
    valueType: 'NUMERIC' | 'BOOLEAN' | 'TEXT';
    unit?: string;
    metadata?: JsonRecord;
  }): V2Row {
    const existing = row(
      this.#domain.db
        .prepare('SELECT * FROM v2_capability_definitions WHERE slug=?')
        .get(input.slug),
    );
    if (existing) return existing;
    const timestamp = now();
    const id = newId('cap', timestamp);
    return this.#domain.transaction(() => {
      this.#domain.db
        .prepare(
          `INSERT INTO v2_capability_definitions(id,slug,name,value_type,unit,metadata_json,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.slug,
          input.name,
          input.valueType,
          input.unit ?? null,
          encode(input.metadata),
          timestamp,
          timestamp,
        );
      this.#domain.emit({
        type: 'capability.created',
        entityType: 'CapabilityDefinition',
        entityId: id,
        payload: { slug: input.slug, valueType: input.valueType },
      });
      return row(
        this.#domain.db.prepare('SELECT * FROM v2_capability_definitions WHERE id=?').get(id),
      )!;
    });
  }

  listCapabilityDefinitions(): V2Row[] {
    return rows(
      this.#domain.db.prepare('SELECT * FROM v2_capability_definitions ORDER BY slug').all(),
    ).map((value) => ({
      id: value.id,
      slug: value.slug,
      name: value.name,
      valueType: value.value_type,
      unit: value.unit,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
  }

  addCapabilityClaim(input: {
    subjectType: 'SUPPLIER' | 'SUPPLIER_MODEL' | 'EMPLOYEE' | 'MODEL_OFFERING' | 'EMPLOYMENT';
    subjectId: string;
    capabilityId: string;
    value: CapabilityValue;
    source: 'DECLARED' | 'MEASURED' | 'MANUAL' | 'INFERRED' | 'IMPORTED';
    confidence?: number;
    observedAt?: number;
    expiresAt?: number;
    evidence?: JsonRecord;
  }): V2Row {
    const definition = row(
      this.#domain.db
        .prepare('SELECT * FROM v2_capability_definitions WHERE id=?')
        .get(input.capabilityId),
    );
    if (!definition) throw new Error('CAPABILITY_NOT_FOUND');
    if (
      (definition.value_type === 'NUMERIC' && typeof input.value !== 'number') ||
      (definition.value_type === 'BOOLEAN' && typeof input.value !== 'boolean') ||
      (definition.value_type === 'TEXT' && typeof input.value !== 'string')
    ) {
      throw new Error('CAPABILITY_VALUE_TYPE_MISMATCH');
    }
    const observedAt = input.observedAt ?? now();
    const id = newId('claim', observedAt);
    return this.#domain.transaction(() => {
      this.#domain.db
        .prepare(
          `INSERT INTO v2_capability_claims(
             id,subject_type,subject_id,capability_id,value_json,source,confidence,observed_at,
             expires_at,evidence_json,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.subjectType,
          input.subjectId,
          input.capabilityId,
          JSON.stringify(input.value),
          input.source,
          input.confidence ?? null,
          observedAt,
          input.expiresAt ?? null,
          encode(input.evidence),
          now(),
        );
      this.#domain.emit({
        type: 'capability.claimed',
        entityType: 'CapabilityClaim',
        entityId: id,
        payload: {
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          capabilityId: input.capabilityId,
        },
      });
      return row(this.#domain.db.prepare('SELECT * FROM v2_capability_claims WHERE id=?').get(id))!;
    });
  }

  listCapabilityClaims(filters: { subjectType?: string; subjectId?: string } = {}): V2Row[] {
    return rows(
      this.#domain.db
        .prepare(
          `SELECT c.*,d.slug capability_slug,d.name capability_name,d.value_type
           FROM v2_capability_claims c JOIN v2_capability_definitions d ON d.id=c.capability_id
           WHERE (? IS NULL OR c.subject_type=?) AND (? IS NULL OR c.subject_id=?)
           ORDER BY c.observed_at DESC,c.created_at DESC`,
        )
        .all(
          filters.subjectType ?? null,
          filters.subjectType ?? null,
          filters.subjectId ?? null,
          filters.subjectId ?? null,
        ),
    ).map((value) => ({
      id: value.id,
      subjectType: value.subject_type,
      subjectId: value.subject_id,
      capabilityId: value.capability_id,
      capabilitySlug: value.capability_slug,
      capabilityName: value.capability_name,
      valueType: value.value_type,
      value: decode<CapabilityValue>(value.value_json, ''),
      source: value.source,
      confidence: value.confidence == null ? null : Number(value.confidence),
      observedAt: value.observed_at,
      expiresAt: value.expires_at,
      evidence: decode<JsonRecord>(value.evidence_json, {}),
    }));
  }

  createRequirementSet(input: {
    name: string;
    requirements: Requirement[];
    version?: number;
    metadata?: JsonRecord;
  }): V2Row {
    const timestamp = now();
    const id = newId('req', timestamp);
    for (const requirement of input.requirements) {
      if (!requirement.capability || !['GTE', 'LTE', 'EQ', 'IN'].includes(requirement.operator)) {
        throw new Error('REQUIREMENT_INVALID');
      }
    }
    return this.#domain.transaction(() => {
      this.#domain.db
        .prepare(
          `INSERT INTO v2_requirement_sets(id,name,requirements_json,version,created_at,metadata_json)
           VALUES(?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.name,
          encode(input.requirements),
          input.version ?? 1,
          timestamp,
          encode(input.metadata),
        );
      this.#domain.emit({
        type: 'requirement_set.created',
        entityType: 'RequirementSet',
        entityId: id,
        payload: { name: input.name, version: input.version ?? 1 },
      });
      return row(this.#domain.db.prepare('SELECT * FROM v2_requirement_sets WHERE id=?').get(id))!;
    });
  }

  listRequirementSets(): V2Row[] {
    return rows(
      this.#domain.db.prepare('SELECT * FROM v2_requirement_sets ORDER BY created_at DESC').all(),
    ).map((value) => ({
      id: value.id,
      name: value.name,
      version: Number(value.version ?? 1),
      requirements: decode<Requirement[]>(value.requirements_json, []),
      metadata: decode<JsonRecord>(value.metadata_json, {}),
      createdAt: value.created_at,
    }));
  }

  assignRequirementSet(positionId: string, requirementSetId: string | null): V2Row {
    const position = row(
      this.#domain.db.prepare('SELECT * FROM v2_positions WHERE id=?').get(positionId),
    );
    if (!position) throw new Error('POSITION_NOT_FOUND');
    if (
      requirementSetId &&
      !row(
        this.#domain.db
          .prepare('SELECT id FROM v2_requirement_sets WHERE id=?')
          .get(requirementSetId),
      )
    ) {
      throw new Error('REQUIREMENT_SET_NOT_FOUND');
    }
    const timestamp = now();
    return this.#domain.transaction(() => {
      this.#domain.db
        .prepare('UPDATE v2_positions SET requirement_set_id=?,updated_at=? WHERE id=?')
        .run(requirementSetId, timestamp, positionId);
      this.#domain.emit({
        type: 'position.requirements.changed',
        entityType: 'Position',
        entityId: positionId,
        payload: { requirementSetId },
      });
      return row(this.#domain.db.prepare('SELECT * FROM v2_positions WHERE id=?').get(positionId))!;
    });
  }

  assessQualification(employeeId: string, positionId: string): QualificationResult {
    const identity = row(
      this.#domain.db
        .prepare(
          `SELECT e.id,e.supplier_id,e.supplier_model_id,p.requirement_set_id
           FROM v2_employees e CROSS JOIN v2_positions p
           WHERE e.id=? AND p.id=?`,
        )
        .get(employeeId, positionId),
    );
    if (!identity) throw new Error('EMPLOYEE_OR_POSITION_NOT_FOUND');
    const requirementSetId = identity.requirement_set_id
      ? String(identity.requirement_set_id)
      : null;
    const requirementSet = requirementSetId
      ? row(
          this.#domain.db
            .prepare('SELECT * FROM v2_requirement_sets WHERE id=?')
            .get(requirementSetId),
        )
      : null;
    const requirements = requirementSet
      ? decode<Requirement[]>(requirementSet.requirements_json, [])
      : [];
    const timestamp = now();
    const claimRows = rows(
      this.#domain.db
        .prepare(
          `SELECT c.*,d.slug capability_slug,d.value_type
           FROM v2_capability_claims c JOIN v2_capability_definitions d ON d.id=c.capability_id
           WHERE ((c.subject_type='SUPPLIER' AND c.subject_id=?)
              OR (c.subject_type='SUPPLIER_MODEL' AND c.subject_id=?)
              OR (c.subject_type='EMPLOYEE' AND c.subject_id=?))
             AND (c.expires_at IS NULL OR c.expires_at>?)
           ORDER BY c.capability_id,c.subject_type,c.observed_at DESC,c.created_at DESC`,
        )
        .all(
          String(identity.supplier_id),
          String(identity.supplier_model_id),
          employeeId,
          timestamp,
        ),
    );
    const latestBySubjectCapability = new Map<string, V2Row>();
    for (const claim of claimRows) {
      const key = `${String(claim.subject_type)}:${String(claim.capability_id)}`;
      if (!latestBySubjectCapability.has(key)) latestBySubjectCapability.set(key, claim);
    }
    const byCapability = new Map<string, V2Row[]>();
    for (const claim of latestBySubjectCapability.values()) {
      const slug = String(claim.capability_slug);
      const list = byCapability.get(slug) ?? [];
      list.push(claim);
      byCapability.set(slug, list);
    }
    const effectiveCapabilities: QualificationResult['effectiveCapabilities'] = {};
    for (const [slug, claims] of byCapability) {
      const valueType = String(claims[0]?.value_type ?? 'TEXT');
      const values = claims.map((claim) => decode<CapabilityValue>(claim.value_json, ''));
      let effective: CapabilityValue | null = null;
      if (valueType === 'NUMERIC') {
        const numeric = values.filter((value): value is number => typeof value === 'number');
        effective =
          numeric.length === values.length && numeric.length > 0 ? Math.min(...numeric) : null;
      } else if (valueType === 'BOOLEAN') {
        const booleans = values.filter((value): value is boolean => typeof value === 'boolean');
        effective =
          booleans.length === values.length && booleans.length > 0 ? booleans.every(Boolean) : null;
      } else {
        const text = values.filter((value): value is string => typeof value === 'string');
        effective = text.length === values.length && new Set(text).size === 1 ? text[0]! : null;
      }
      const confidences = claims
        .map((claim) => (claim.confidence == null ? null : Number(claim.confidence)))
        .filter((value): value is number => value !== null && Number.isFinite(value));
      effectiveCapabilities[slug] = {
        value: effective,
        valueType,
        confidence: confidences.length ? Math.min(...confidences) : null,
        claims: claims.map((claim) => ({
          subjectType: String(claim.subject_type),
          subjectId: String(claim.subject_id),
          source: String(claim.source),
          value: decode<CapabilityValue>(claim.value_json, ''),
        })),
      };
    }

    const reasons: string[] = [];
    let qualified = true;
    if (!requirementSet) reasons.push('NO_REQUIREMENT_SET');
    for (const requirement of requirements) {
      const effective = effectiveCapabilities[requirement.capability]?.value ?? null;
      let passed = false;
      if (effective !== null) {
        if (requirement.operator === 'GTE') {
          passed = typeof effective === 'number' && effective >= Number(requirement.value);
        } else if (requirement.operator === 'LTE') {
          passed = typeof effective === 'number' && effective <= Number(requirement.value);
        } else if (requirement.operator === 'EQ') {
          passed = effective === requirement.value;
        } else if (requirement.operator === 'IN') {
          passed = Array.isArray(requirement.value) && requirement.value.includes(effective);
        }
      }
      if (!passed) {
        const suffix = effective === null ? 'MISSING' : 'FAILED';
        const reason = `${requirement.hard === false ? 'SOFT_' : ''}REQUIREMENT_${requirement.capability}_${suffix}`;
        reasons.push(reason);
        if (requirement.hard !== false) qualified = false;
      }
    }
    if (qualified && requirementSet) reasons.push('REQUIREMENTS_SATISFIED');
    const assessmentId = newId('qual', timestamp);
    this.#domain.transaction(() => {
      this.#domain.db
        .prepare(
          `INSERT INTO v2_qualification_assessments(
             id,employee_id,position_id,requirement_set_id,qualified,reasons_json,
             effective_capabilities_json,input_version_refs_json,evaluated_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          assessmentId,
          employeeId,
          positionId,
          requirementSetId,
          qualified ? 1 : 0,
          encode(reasons),
          encode(effectiveCapabilities),
          encode({
            requirementSetVersion: requirementSet ? Number(requirementSet.version ?? 1) : null,
            claimIds: [...latestBySubjectCapability.values()].map((claim) => String(claim.id)),
          }),
          timestamp,
        );
      this.#domain.emit({
        type: 'qualification.assessed',
        entityType: 'QualificationAssessment',
        entityId: assessmentId,
        payload: { employeeId, positionId, requirementSetId, qualified, reasons },
      });
    });
    return {
      assessmentId,
      employeeId,
      positionId,
      requirementSetId,
      qualified,
      reasons,
      effectiveCapabilities,
    };
  }

  listQualificationAssessments(
    filters: { employeeId?: string; positionId?: string; limit?: number } = {},
  ): V2Row[] {
    const limit = Math.min(1_000, Math.max(1, filters.limit ?? 100));
    return rows(
      this.#domain.db
        .prepare(
          `SELECT q.*,e.display_name employee_name,p.name position_name,r.name requirement_set_name
           FROM v2_qualification_assessments q
           JOIN v2_employees e ON e.id=q.employee_id
           JOIN v2_positions p ON p.id=q.position_id
           LEFT JOIN v2_requirement_sets r ON r.id=q.requirement_set_id
           WHERE (? IS NULL OR q.employee_id=?) AND (? IS NULL OR q.position_id=?)
           ORDER BY q.evaluated_at DESC LIMIT ?`,
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
      employeeId: value.employee_id,
      employeeName: value.employee_name,
      positionId: value.position_id,
      positionName: value.position_name,
      requirementSetId: value.requirement_set_id,
      requirementSetName: value.requirement_set_name,
      qualified: Number(value.qualified) === 1,
      reasons: decode<string[]>(value.reasons_json, []),
      effectiveCapabilities: decode<JsonRecord>(value.effective_capabilities_json, {}),
      inputVersionRefs: decode<JsonRecord>(value.input_version_refs_json, {}),
      evaluatedAt: value.evaluated_at,
    }));
  }

  createStaffingRule(input: {
    name: string;
    employeeSelector?: JsonRecord;
    positionSelector?: JsonRecord;
    appointmentClass?: 'PRIMARY' | 'BACKUP' | 'RESERVE';
    priority?: number;
    effectiveFrom?: number;
    effectiveTo?: number;
    provenance?: JsonRecord;
  }): V2Row {
    const timestamp = now();
    const id = newId('rule', timestamp);
    return this.#domain.transaction(() => {
      this.#domain.db
        .prepare(
          `INSERT INTO v2_staffing_rules(
             id,name,employee_selector_json,position_selector_json,appointment_class,priority,effective_from,
             effective_to,lifecycle,provenance_json,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.name,
          encode(input.employeeSelector ?? {}),
          encode(input.positionSelector ?? {}),
          input.appointmentClass ?? 'PRIMARY',
          input.priority ?? 100,
          input.effectiveFrom ?? timestamp,
          input.effectiveTo ?? null,
          'ACTIVE',
          encode(input.provenance),
          timestamp,
          timestamp,
        );
      this.#domain.emit({
        type: 'staffing_rule.created',
        entityType: 'StaffingRule',
        entityId: id,
        payload: { name: input.name },
      });
      return row(this.#domain.db.prepare('SELECT * FROM v2_staffing_rules WHERE id=?').get(id))!;
    });
  }

  listStaffingRules(): V2Row[] {
    return rows(
      this.#domain.db.prepare('SELECT * FROM v2_staffing_rules ORDER BY created_at DESC').all(),
    ).map((value) => ({
      id: value.id,
      name: value.name,
      employeeSelector: decode<JsonRecord>(value.employee_selector_json, {}),
      positionSelector: decode<JsonRecord>(value.position_selector_json, {}),
      appointmentClass: value.appointment_class,
      priority: Number(value.priority ?? 0),
      effectiveFrom: value.effective_from,
      effectiveTo: value.effective_to,
      lifecycle: value.lifecycle,
      provenance: decode<JsonRecord>(value.provenance_json, {}),
    }));
  }

  materializeStaffingRule(ruleId: string): V2Row {
    const rule = row(
      this.#domain.db.prepare('SELECT * FROM v2_staffing_rules WHERE id=?').get(ruleId),
    );
    if (!rule) throw new Error('STAFFING_RULE_NOT_FOUND');
    const timestamp = now();
    if (
      rule.lifecycle !== 'ACTIVE' ||
      Number(rule.effective_from) > timestamp ||
      (rule.effective_to != null && Number(rule.effective_to) <= timestamp)
    ) {
      throw new Error('STAFFING_RULE_NOT_ACTIVE');
    }
    const employeeSelector = decode<JsonRecord>(rule.employee_selector_json, {});
    const positionSelector = decode<JsonRecord>(rule.position_selector_json, {});
    const employees = rows(
      this.#domain.db
        .prepare(
          `SELECT e.*,s.slug supplier_slug,sm.supplier_model_key
           FROM v2_employees e
           JOIN v2_suppliers s ON s.id=e.supplier_id
           JOIN v2_supplier_models sm ON sm.id=e.supplier_model_id
           WHERE e.record_lifecycle='ACTIVE'`,
        )
        .all(),
    );
    const positions = rows(
      this.#domain.db
        .prepare(
          `SELECT p.*,ws.slug scope_slug
           FROM v2_positions p LEFT JOIN v2_work_scopes ws ON ws.id=p.work_scope_id
           WHERE p.lifecycle='ACTIVE'`,
        )
        .all(),
    );
    const matchesEmployee = (employee: V2Row): boolean => {
      const tests: Array<[string[], string]> = [
        [strings(employeeSelector.employeeIds), String(employee.id)],
        [strings(employeeSelector.supplierIds), String(employee.supplier_id)],
        [strings(employeeSelector.supplierModelIds), String(employee.supplier_model_id)],
        [strings(employeeSelector.supplierSlugs), String(employee.supplier_slug)],
        [strings(employeeSelector.supplierModelKeys), String(employee.supplier_model_key)],
      ];
      return tests.every(([allowed, value]) => allowed.length === 0 || allowed.includes(value));
    };
    const matchesPosition = (position: V2Row): boolean => {
      const tests: Array<[string[], string]> = [
        [strings(positionSelector.positionIds), String(position.id)],
        [strings(positionSelector.scopeIds), String(position.work_scope_id ?? '')],
        [strings(positionSelector.scopeSlugs), String(position.scope_slug ?? '')],
        [strings(positionSelector.slugs), String(position.slug)],
        [strings(positionSelector.kinds), String(position.kind)],
        [strings(positionSelector.runtimeKinds), String(position.runtime_kind ?? '')],
      ];
      return tests.every(([allowed, value]) => allowed.length === 0 || allowed.includes(value));
    };
    const matchedEmployees = employees.filter(matchesEmployee);
    const matchedPositions = positions.filter(matchesPosition);
    let created = 0;
    let existing = 0;
    const appointmentIds: string[] = [];
    this.#domain.transaction(() => {
      for (const employee of matchedEmployees) {
        for (const position of matchedPositions) {
          const current = row(
            this.#domain.db
              .prepare(
                `SELECT * FROM v2_appointments
                 WHERE employee_id=? AND position_id=?
                   AND status IN ('SCHEDULED','CURRENT','SUSPENDED') AND effective_to IS NULL
                 ORDER BY created_at DESC LIMIT 1`,
              )
              .get(String(employee.id), String(position.id)),
          );
          if (current) {
            existing += 1;
            appointmentIds.push(String(current.id));
            continue;
          }
          const id = newId('apt', timestamp + created + 1);
          this.#domain.db
            .prepare(
              `INSERT INTO v2_appointments(
                 id,employee_id,position_id,appointment_class,priority,status,effective_from,source,
                 source_rule_id,metadata_json,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              id,
              String(employee.id),
              String(position.id),
              String(rule.appointment_class),
              Number(rule.priority ?? 0),
              'CURRENT',
              timestamp,
              'RULE',
              ruleId,
              '{}',
              timestamp,
              timestamp,
            );
          created += 1;
          appointmentIds.push(id);
          this.#domain.emit({
            type: 'appointment.started',
            entityType: 'Appointment',
            entityId: id,
            payload: { employeeId: employee.id, positionId: position.id, sourceRuleId: ruleId },
          });
        }
      }
      this.#domain.emit({
        type: 'staffing_rule.materialized',
        entityType: 'StaffingRule',
        entityId: ruleId,
        payload: {
          matchedEmployees: matchedEmployees.length,
          matchedPositions: matchedPositions.length,
          created,
          existing,
        },
      });
    });
    return {
      ruleId,
      matchedEmployees: matchedEmployees.length,
      matchedPositions: matchedPositions.length,
      created,
      existing,
      appointmentIds,
    };
  }

  createStaffingConstraint(input: {
    name: string;
    scopeType: 'GLOBAL' | 'WORK_SCOPE' | 'POSITION';
    scopeId?: string;
    constraintType: 'MAX_CONCURRENT_DUTIES' | 'SEPARATION_OF_DUTIES';
    strength?: 'HARD' | 'SOFT';
    expression: JsonRecord;
  }): V2Row {
    if (input.scopeType !== 'GLOBAL' && !input.scopeId)
      throw new Error('CONSTRAINT_SCOPE_ID_REQUIRED');
    const timestamp = now();
    const id = newId('con', timestamp);
    return this.#domain.transaction(() => {
      this.#domain.db
        .prepare(
          `INSERT INTO v2_staffing_constraints(
             id,name,scope_type,scope_id,constraint_type,strength,expression_json,lifecycle,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.name,
          input.scopeType,
          input.scopeId ?? null,
          input.constraintType,
          input.strength ?? 'HARD',
          encode(input.expression),
          'ACTIVE',
          timestamp,
          timestamp,
        );
      this.#domain.emit({
        type: 'staffing_constraint.created',
        entityType: 'StaffingConstraint',
        entityId: id,
        payload: { scopeType: input.scopeType, scopeId: input.scopeId ?? null },
      });
      return row(
        this.#domain.db.prepare('SELECT * FROM v2_staffing_constraints WHERE id=?').get(id),
      )!;
    });
  }

  listStaffingConstraints(): V2Row[] {
    return rows(
      this.#domain.db
        .prepare('SELECT * FROM v2_staffing_constraints ORDER BY created_at DESC')
        .all(),
    ).map((value) => ({
      id: value.id,
      name: value.name,
      scopeType: value.scope_type,
      scopeId: value.scope_id,
      constraintType: value.constraint_type,
      strength: value.strength,
      expression: decode<JsonRecord>(value.expression_json, {}),
      lifecycle: value.lifecycle,
    }));
  }

  evaluateConstraints(employeeId: string, dutySessionId: string): ConstraintEvaluation {
    const duty = row(
      this.#domain.db
        .prepare(
          `SELECT d.id,d.run_id,d.position_id,p.work_scope_id
           FROM v2_duty_sessions d JOIN v2_positions p ON p.id=d.position_id WHERE d.id=?`,
        )
        .get(dutySessionId),
    );
    if (!duty) throw new Error('DUTY_NOT_FOUND');
    const constraints = rows(
      this.#domain.db
        .prepare(
          `SELECT * FROM v2_staffing_constraints
           WHERE lifecycle='ACTIVE' AND (
             scope_type='GLOBAL'
             OR (scope_type='WORK_SCOPE' AND scope_id=?)
             OR (scope_type='POSITION' AND scope_id=?))
           ORDER BY created_at,id`,
        )
        .all(
          duty.work_scope_id == null ? null : String(duty.work_scope_id),
          String(duty.position_id),
        ),
    );
    const hardReasons: string[] = [];
    const softReasons: string[] = [];
    const evaluations: ConstraintEvaluation['evaluations'] = [];
    for (const constraint of constraints) {
      const expression = decode<JsonRecord>(constraint.expression_json, {});
      let violated = false;
      let reason: string | undefined;
      if (constraint.constraint_type === 'MAX_CONCURRENT_DUTIES') {
        const max = Number(expression.max ?? 1);
        const active = Number(
          row(
            this.#domain.db
              .prepare(
                `SELECT COUNT(*) count FROM v2_staffing_segments
                 WHERE employee_id=? AND ended_at IS NULL AND duty_session_id<>?`,
              )
              .get(employeeId, dutySessionId),
          )?.count ?? 0,
        );
        violated = active >= max;
        if (violated) reason = `MAX_CONCURRENT_DUTIES_${max}_REACHED`;
      } else if (constraint.constraint_type === 'SEPARATION_OF_DUTIES') {
        const active = rows(
          this.#domain.db
            .prepare(
              `SELECT ss.employee_id,p.id position_id,p.slug position_slug,p.kind position_kind
               FROM v2_staffing_segments ss
               JOIN v2_duty_sessions d ON d.id=ss.duty_session_id
               JOIN v2_positions p ON p.id=d.position_id
               WHERE ss.employee_id=? AND ss.ended_at IS NULL AND d.run_id=? AND d.id<>?`,
            )
            .all(employeeId, String(duty.run_id), dutySessionId),
        );
        const ids = strings(expression.positionIds);
        const slugs = strings(expression.positionSlugs);
        const kinds = strings(expression.positionKinds);
        violated = active.some((item) => {
          if (!ids.length && !slugs.length && !kinds.length) return true;
          return (
            ids.includes(String(item.position_id)) ||
            slugs.includes(String(item.position_slug)) ||
            kinds.includes(String(item.position_kind))
          );
        });
        if (violated) reason = 'SEPARATION_OF_DUTIES_VIOLATION';
      }
      if (violated && reason) {
        if (constraint.strength === 'HARD') hardReasons.push(reason);
        else softReasons.push(`SOFT_${reason}`);
      }
      evaluations.push({
        constraintId: String(constraint.id),
        name: String(constraint.name),
        type: String(constraint.constraint_type),
        strength: String(constraint.strength),
        violated,
        ...(reason ? { reason } : {}),
      });
    }
    return { eligible: hardReasons.length === 0, hardReasons, softReasons, evaluations };
  }
}
