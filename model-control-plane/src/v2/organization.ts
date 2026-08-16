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
function slugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

export class OrganizationRepository {
  readonly #domain: V2Repository;

  constructor(domain: V2Repository) {
    this.#domain = domain;
  }

  createRole(input: {
    slug: string;
    name: string;
    purpose?: string;
    defaultRequirementSetId?: string;
    metadata?: JsonRecord;
  }): V2Row {
    const existing = row(
      this.#domain.db.prepare('SELECT * FROM v2_role_definitions WHERE slug=?').get(input.slug),
    );
    if (existing) return existing;
    const timestamp = now();
    const id = newId('role', timestamp);
    return this.#domain.transaction(() => {
      this.#domain.db
        .prepare(
          `INSERT INTO v2_role_definitions(
             id,slug,name,purpose,default_requirement_set_id,lifecycle,metadata_json,created_at,updated_at)
           VALUES(?,?,?,?,?,'ACTIVE',?,?,?)`,
        )
        .run(
          id,
          input.slug,
          input.name,
          input.purpose ?? null,
          input.defaultRequirementSetId ?? null,
          encode(input.metadata),
          timestamp,
          timestamp,
        );
      this.#domain.emit({
        type: 'role.created',
        entityType: 'RoleDefinition',
        entityId: id,
        payload: { slug: input.slug },
      });
      return row(this.#domain.db.prepare('SELECT * FROM v2_role_definitions WHERE id=?').get(id))!;
    });
  }

  listRoles(): V2Row[] {
    return rows(
      this.#domain.db.prepare('SELECT * FROM v2_role_definitions ORDER BY name,slug').all(),
    ).map((value) => ({
      id: value.id,
      slug: value.slug,
      name: value.name,
      purpose: value.purpose,
      defaultRequirementSetId: value.default_requirement_set_id,
      lifecycle: value.lifecycle,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
  }

  createPositionTemplate(input: {
    slug: string;
    name: string;
    roleId: string;
    runtimePolicy?: JsonRecord;
    defaultRequirementSetId?: string;
    lifecyclePolicy: 'STANDING' | 'RUN_SCOPED';
    defaultRelations?: JsonRecord[];
    defaultConstraints?: JsonRecord[];
    metadata?: JsonRecord;
  }): V2Row {
    const existing = row(
      this.#domain.db.prepare('SELECT * FROM v2_position_templates WHERE slug=?').get(input.slug),
    );
    if (existing) return existing;
    if (
      !row(
        this.#domain.db.prepare('SELECT id FROM v2_role_definitions WHERE id=?').get(input.roleId),
      )
    ) {
      throw new Error('ROLE_NOT_FOUND');
    }
    const timestamp = now();
    const id = newId('ptpl', timestamp);
    return this.#domain.transaction(() => {
      this.#domain.db
        .prepare(
          `INSERT INTO v2_position_templates(
             id,slug,name,role_id,runtime_policy_json,default_requirement_set_id,lifecycle_policy,
             default_relations_json,default_constraints_json,enabled,metadata_json,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?)`,
        )
        .run(
          id,
          input.slug,
          input.name,
          input.roleId,
          encode(input.runtimePolicy),
          input.defaultRequirementSetId ?? null,
          input.lifecyclePolicy,
          encode(input.defaultRelations ?? []),
          encode(input.defaultConstraints ?? []),
          encode(input.metadata),
          timestamp,
          timestamp,
        );
      this.#domain.emit({
        type: 'position_template.created',
        entityType: 'PositionTemplate',
        entityId: id,
        payload: { slug: input.slug, lifecyclePolicy: input.lifecyclePolicy },
      });
      return row(
        this.#domain.db.prepare('SELECT * FROM v2_position_templates WHERE id=?').get(id),
      )!;
    });
  }

  listPositionTemplates(): V2Row[] {
    return rows(
      this.#domain.db
        .prepare(
          `SELECT t.*,r.slug role_slug,r.name role_name
           FROM v2_position_templates t JOIN v2_role_definitions r ON r.id=t.role_id
           ORDER BY t.name,t.slug`,
        )
        .all(),
    ).map((value) => ({
      id: value.id,
      slug: value.slug,
      name: value.name,
      roleId: value.role_id,
      roleSlug: value.role_slug,
      roleName: value.role_name,
      runtimePolicy: decode<JsonRecord>(value.runtime_policy_json, {}),
      defaultRequirementSetId: value.default_requirement_set_id,
      lifecyclePolicy: value.lifecycle_policy,
      defaultRelations: decode<JsonRecord[]>(value.default_relations_json, []),
      defaultConstraints: decode<JsonRecord[]>(value.default_constraints_json, []),
      enabled: Number(value.enabled) === 1,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
  }

  instantiatePosition(input: {
    templateId: string;
    workScopeId: string;
    name?: string;
    slug?: string;
    originRunId?: string;
    metadata?: JsonRecord;
  }): V2Row {
    const template = row(
      this.#domain.db
        .prepare(
          `SELECT t.*,r.slug role_slug,r.name role_name
           FROM v2_position_templates t JOIN v2_role_definitions r ON r.id=t.role_id
           WHERE t.id=?`,
        )
        .get(input.templateId),
    );
    if (!template) throw new Error('POSITION_TEMPLATE_NOT_FOUND');
    if (Number(template.enabled) !== 1) throw new Error('POSITION_TEMPLATE_DISABLED');
    if (
      !row(
        this.#domain.db.prepare('SELECT id FROM v2_work_scopes WHERE id=?').get(input.workScopeId),
      )
    ) {
      throw new Error('WORK_SCOPE_NOT_FOUND');
    }
    const lifecyclePolicy = String(template.lifecycle_policy) as 'STANDING' | 'RUN_SCOPED';
    let run: V2Row | null = null;
    if (lifecyclePolicy === 'RUN_SCOPED') {
      if (!input.originRunId) throw new Error('ORIGIN_RUN_REQUIRED');
      run = row(this.#domain.db.prepare('SELECT * FROM v2_runs WHERE id=?').get(input.originRunId));
      if (!run) throw new Error('RUN_NOT_FOUND');
      if (String(run.work_scope_id) !== input.workScopeId) throw new Error('RUN_SCOPE_MISMATCH');
      if (!['QUEUED', 'PLANNING', 'RUNNING', 'BLOCKED', 'FINALIZING'].includes(String(run.status)))
        throw new Error('RUN_NOT_ACTIVE');
    }
    const runtimePolicy = decode<JsonRecord>(template.runtime_policy_json, {});
    const runtimeKind = runtimePolicy.kind ? String(runtimePolicy.kind) : null;
    const baseSlug = input.slug ? slugPart(input.slug) : slugPart(String(template.slug));
    let slug = baseSlug;
    if (lifecyclePolicy === 'RUN_SCOPED') {
      const suffix = slugPart(String(input.originRunId)).slice(-10) || 'run';
      const count = Number(
        row(
          this.#domain.db
            .prepare(
              'SELECT COUNT(*) count FROM v2_positions WHERE origin_run_id=? AND template_id=?',
            )
            .get(String(input.originRunId), input.templateId),
        )?.count ?? 0,
      );
      slug = `${baseSlug}-${suffix}-${String(count + 1).padStart(2, '0')}`;
    }
    const duplicate = row(
      this.#domain.db
        .prepare('SELECT * FROM v2_positions WHERE work_scope_id=? AND slug=?')
        .get(input.workScopeId, slug),
    );
    if (duplicate) return duplicate;
    const timestamp = now();
    const id = newId('pos', timestamp);
    return this.#domain.transaction(() => {
      this.#domain.db
        .prepare(
          `INSERT INTO v2_positions(
             id,work_scope_id,slug,name,kind,lifecycle,runtime_kind,requirements_json,metadata_json,
             created_at,updated_at,requirement_set_id,role_id,template_id,lifecycle_policy,origin_run_id,
             runtime_policy_json)
           VALUES(?,?,?,?,?,'ACTIVE',?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.workScopeId,
          slug,
          input.name ?? String(template.name),
          String(template.role_slug).toUpperCase(),
          runtimeKind,
          '{}',
          encode(input.metadata),
          timestamp,
          timestamp,
          template.default_requirement_set_id == null
            ? null
            : String(template.default_requirement_set_id),
          String(template.role_id),
          input.templateId,
          lifecyclePolicy,
          input.originRunId ?? null,
          encode(runtimePolicy),
        );
      this.#domain.emit({
        type: 'position.instantiated',
        entityType: 'Position',
        entityId: id,
        runId: input.originRunId,
        payload: {
          templateId: input.templateId,
          roleId: template.role_id,
          lifecyclePolicy,
          originRunId: input.originRunId ?? null,
        },
      });
      return row(this.#domain.db.prepare('SELECT * FROM v2_positions WHERE id=?').get(id))!;
    });
  }

  createPositionRelation(input: {
    fromPositionId: string;
    toPositionId: string;
    relationType: 'SUPERVISES' | 'DELEGATES_TO' | 'REVIEWS' | 'DEPENDS_ON' | 'ESCALATES_TO';
    source?: 'MANUAL' | 'TEMPLATE' | 'POLICY' | 'MIGRATION';
    effectiveFrom?: number;
    effectiveTo?: number;
    metadata?: JsonRecord;
  }): V2Row {
    if (input.fromPositionId === input.toPositionId)
      throw new Error('POSITION_RELATION_SELF_REFERENCE');
    const existing = row(
      this.#domain.db
        .prepare(
          `SELECT * FROM v2_position_relations
           WHERE from_position_id=? AND to_position_id=? AND relation_type=? AND effective_to IS NULL`,
        )
        .get(input.fromPositionId, input.toPositionId, input.relationType),
    );
    if (existing) return existing;
    const timestamp = input.effectiveFrom ?? now();
    const id = newId('prel', timestamp);
    return this.#domain.transaction(() => {
      this.#domain.db
        .prepare(
          `INSERT INTO v2_position_relations(
             id,from_position_id,to_position_id,relation_type,effective_from,effective_to,source,metadata_json,created_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.fromPositionId,
          input.toPositionId,
          input.relationType,
          timestamp,
          input.effectiveTo ?? null,
          input.source ?? 'MANUAL',
          encode(input.metadata),
          now(),
        );
      this.#domain.emit({
        type: 'position_relation.created',
        entityType: 'PositionRelation',
        entityId: id,
        payload: {
          fromPositionId: input.fromPositionId,
          toPositionId: input.toPositionId,
          relationType: input.relationType,
        },
      });
      return row(
        this.#domain.db.prepare('SELECT * FROM v2_position_relations WHERE id=?').get(id),
      )!;
    });
  }

  listPositionRelations(): V2Row[] {
    return rows(
      this.#domain.db
        .prepare(
          `SELECT r.*,fp.name from_position_name,tp.name to_position_name
           FROM v2_position_relations r
           JOIN v2_positions fp ON fp.id=r.from_position_id
           JOIN v2_positions tp ON tp.id=r.to_position_id
           ORDER BY r.effective_from,r.id`,
        )
        .all(),
    ).map((value) => ({
      id: value.id,
      fromPositionId: value.from_position_id,
      fromPositionName: value.from_position_name,
      toPositionId: value.to_position_id,
      toPositionName: value.to_position_name,
      relationType: value.relation_type,
      effectiveFrom: value.effective_from,
      effectiveTo: value.effective_to,
      source: value.source,
      metadata: decode<JsonRecord>(value.metadata_json, {}),
    }));
  }

  topology(): V2Row {
    return {
      roles: this.listRoles(),
      templates: this.listPositionTemplates(),
      positions: this.#domain.listPositions(),
      relations: this.listPositionRelations(),
    };
  }
}
