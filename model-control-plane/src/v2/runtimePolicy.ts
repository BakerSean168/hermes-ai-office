import { newId } from './ids.js';
import { ProviderHubRepository } from './providerHub.js';
import type { V2Repository, V2Row } from './repository.js';
import { RuntimeAccessRepository } from './runtimeAccess.js';
import type { StaffingRepository } from './staffing.js';
import type { SupplyRepository } from './supply.js';

type JsonRecord = Record<string, unknown>;

export type RuntimeKind = 'OPENCODE' | 'CODEX';
export type RuntimePolicyMode = 'OBSERVE' | 'PREFER' | 'ENFORCE';
export type RuntimeLaunchStatus = 'SELECTED' | 'EXPLICIT_OVERRIDE' | 'UNRESOLVED' | 'BLOCKED';

export interface RuntimeSelector {
  model: string;
  profile?: string;
  provider?: string;
  accessProfileId?: string;
  adapterKind?: string;
  baseUrl?: string;
  credentialRef?: string;
  protocol?: string;
  config?: JsonRecord;
}

export interface RuntimeLaunchResolveInput {
  runtimeKind: RuntimeKind;
  policyMode?: RuntimePolicyMode;
  positionSlug?: string;
  workScopeSlug?: string;
  sessionId?: string;
  taskId?: string;
  toolCallId?: string;
  workdir?: string;
  commandName?: string;
  requestedModel?: string;
  metadata?: JsonRecord;
}

interface RawCandidate {
  appointmentId: string;
  appointmentClass: 'PRIMARY' | 'BACKUP' | 'RESERVE';
  appointmentPriority: number;
  employeeId: string;
  employeeName: string;
  employeeLifecycle: string;
  employmentId: string | null;
  supplyAgreementId: string | null;
  employmentStatus: string | null;
  agreementLifecycle: string | null;
  modelOfferingId: string | null;
  selector: RuntimeSelector | null;
  qualified: boolean;
  capacityAvailable: boolean;
  supplierEnabled: boolean;
  supplierPreferred: boolean;
  providerRoutable: boolean;
  reasons: string[];
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

function appointmentRank(value: string): number {
  if (value === 'PRIMARY') return 0;
  if (value === 'BACKUP') return 1;
  return 2;
}

function selectorFromAccess(value: V2Row | null, runtimeKind: RuntimeKind): RuntimeSelector | null {
  if (!value) return null;
  const modelRef = typeof value.modelRef === 'string' ? value.modelRef.trim() : '';
  if (!modelRef) return null;
  const provider = typeof value.providerRef === 'string' ? value.providerRef.trim() : '';
  const profile = typeof value.profileRef === 'string' ? value.profileRef.trim() : '';
  const model = runtimeKind === 'OPENCODE' && provider ? `${provider}/${modelRef}` : modelRef;
  return {
    model,
    ...(profile ? { profile } : {}),
    ...(provider ? { provider } : {}),
    accessProfileId: String(value.id),
    adapterKind: String(value.adapterKind ?? ''),
    ...(value.baseUrl ? { baseUrl: String(value.baseUrl) } : {}),
    ...(value.credentialRef ? { credentialRef: String(value.credentialRef) } : {}),
    ...(value.protocol ? { protocol: String(value.protocol) } : {}),
    config:
      value.config && typeof value.config === 'object' && !Array.isArray(value.config)
        ? (value.config as JsonRecord)
        : {},
  };
}

function selectorFromMetadata(value: unknown, runtimeKind: RuntimeKind): RuntimeSelector | null {
  const metadata = decode<JsonRecord>(value, {});
  const selectors = metadata.runtimeSelectors;
  if (!selectors || typeof selectors !== 'object' || Array.isArray(selectors)) return null;
  const candidate = (selectors as JsonRecord)[runtimeKind];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const selector = candidate as JsonRecord;
  const model = typeof selector.model === 'string' ? selector.model.trim() : '';
  if (!model || model.length > 240) return null;
  const profile = typeof selector.profile === 'string' ? selector.profile.trim() : '';
  const provider = typeof selector.provider === 'string' ? selector.provider.trim() : '';
  return {
    model,
    ...(profile ? { profile: profile.slice(0, 120) } : {}),
    ...(provider ? { provider: provider.slice(0, 120) } : {}),
  };
}

function normalizeRequestedModel(value?: string): string | null {
  const model = value?.trim();
  return model ? model.slice(0, 240) : null;
}

export class RuntimePolicyService {
  readonly #domain: V2Repository;
  readonly #supply: SupplyRepository;
  readonly #staffing: StaffingRepository;
  readonly #runtimeAccess: RuntimeAccessRepository;
  readonly #providerHub: ProviderHubRepository;

  constructor(
    domain: V2Repository,
    supply: SupplyRepository,
    staffing: StaffingRepository,
    runtimeAccess = new RuntimeAccessRepository(domain),
    providerHub = new ProviderHubRepository(domain),
  ) {
    this.#domain = domain;
    this.#supply = supply;
    this.#staffing = staffing;
    this.#runtimeAccess = runtimeAccess;
    this.#providerHub = providerHub;
  }

  resolve(input: RuntimeLaunchResolveInput): V2Row {
    const existing = input.toolCallId
      ? row(
          this.#domain.db
            .prepare('SELECT * FROM v2_runtime_launch_decisions WHERE tool_call_id=?')
            .get(input.toolCallId),
        )
      : null;
    if (existing) return this.#present(existing);

    const policyMode = input.policyMode ?? 'PREFER';
    const requestedModel = normalizeRequestedModel(input.requestedModel);
    const position = this.#resolvePosition(input);
    const candidateResults = position
      ? this.#candidates(String(position.id), input.runtimeKind)
      : [];
    const eligible = candidateResults.filter(
      (candidate) =>
        candidate.qualified &&
        candidate.capacityAvailable &&
        candidate.supplierEnabled &&
        candidate.providerRoutable &&
        candidate.selector !== null &&
        candidate.employmentId !== null &&
        candidate.employeeLifecycle === 'ACTIVE' &&
        candidate.employmentStatus === 'CURRENT' &&
        candidate.agreementLifecycle === 'ACTIVE',
    );

    let selected: RawCandidate | null = null;
    let status: RuntimeLaunchStatus;
    const reasons: string[] = [];

    if (!position) reasons.push('NO_MATCHING_POSITION');
    if (position && candidateResults.length === 0) reasons.push('NO_CURRENT_APPOINTMENT');

    if (requestedModel) {
      selected = eligible.find((candidate) => candidate.selector?.model === requestedModel) ?? null;
      if (selected) {
        status = 'SELECTED';
        reasons.push('EXPLICIT_MODEL_MATCHED_APPOINTED_EMPLOYEE');
      } else if (policyMode === 'ENFORCE' && eligible[0]) {
        selected = eligible[0];
        status = 'SELECTED';
        reasons.push('EXPLICIT_MODEL_REPLACED_BY_ENFORCED_POLICY');
      } else {
        status = 'EXPLICIT_OVERRIDE';
        reasons.push('EXPLICIT_MODEL_HAS_NO_APPOINTED_EMPLOYEE_MATCH');
      }
    } else if (eligible[0]) {
      selected = eligible[0];
      status = 'SELECTED';
      reasons.push('APPOINTMENT_AND_RUNTIME_SELECTOR_SELECTED');
    } else {
      status = policyMode === 'ENFORCE' ? 'BLOCKED' : 'UNRESOLVED';
      reasons.push('NO_ELIGIBLE_RUNTIME_EMPLOYEE');
    }

    const timestamp = Date.now();
    const id = newId('rlaunch', timestamp);
    const decision = this.#domain.transaction(() => {
      this.#domain.db
        .prepare(
          `INSERT INTO v2_runtime_launch_decisions(
             id,runtime_kind,policy_mode,status,position_id,employee_id,employment_id,
             model_offering_id,appointment_id,session_id,task_id,tool_call_id,work_scope_hint,
             position_hint,workdir_hint,requested_model,selected_model,selected_profile,
             selected_access_profile_id,selected_provider,selected_adapter_kind,selected_base_url,
             selected_credential_ref,selected_protocol,selected_access_config_json,command_name,
             reasons_json,candidate_results_json,metadata_json,decided_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.runtimeKind,
          policyMode,
          status,
          position?.id ? String(position.id) : null,
          selected?.employeeId ?? null,
          selected?.employmentId ?? null,
          selected?.modelOfferingId ?? null,
          selected?.appointmentId ?? null,
          input.sessionId?.slice(0, 240) ?? null,
          input.taskId?.slice(0, 240) ?? null,
          input.toolCallId?.slice(0, 240) ?? null,
          input.workScopeSlug?.slice(0, 160) ?? null,
          input.positionSlug?.slice(0, 160) ?? null,
          input.workdir?.slice(0, 1000) ?? null,
          requestedModel,
          selected?.selector?.model ?? requestedModel,
          selected?.selector?.profile ?? null,
          selected?.selector?.accessProfileId ?? null,
          selected?.selector?.provider ?? null,
          selected?.selector?.adapterKind ?? null,
          selected?.selector?.baseUrl ?? null,
          selected?.selector?.credentialRef ?? null,
          selected?.selector?.protocol ?? null,
          JSON.stringify(selected?.selector?.config ?? {}),
          input.commandName?.slice(0, 120) ?? null,
          JSON.stringify(reasons),
          JSON.stringify(candidateResults),
          JSON.stringify(input.metadata ?? {}),
          timestamp,
        );
      this.#domain.emit({
        type: status === 'SELECTED' ? 'runtime_launch.selected' : 'runtime_launch.unresolved',
        entityType: 'RuntimeLaunchDecision',
        entityId: id,
        actorRef: 'plugin:hermes-ai-office',
        payload: {
          runtimeKind: input.runtimeKind,
          policyMode,
          status,
          positionId: position?.id ?? null,
          employeeId: selected?.employeeId ?? null,
          employmentId: selected?.employmentId ?? null,
          requestedModel,
          selectedModel: selected?.selector?.model ?? requestedModel,
          selectedAccessProfileId: selected?.selector?.accessProfileId ?? null,
          selectedAdapterKind: selected?.selector?.adapterKind ?? null,
          reasons,
        },
      });
      return row(
        this.#domain.db.prepare('SELECT * FROM v2_runtime_launch_decisions WHERE id=?').get(id),
      )!;
    });
    return this.#present(decision);
  }

  list(limit = 100): V2Row[] {
    return rows(
      this.#domain.db
        .prepare(
          `SELECT d.*,p.name position_name,p.slug position_slug,ws.name work_scope_name,
                  e.display_name employee_name,a.name agreement_name
           FROM v2_runtime_launch_decisions d
           LEFT JOIN v2_positions p ON p.id=d.position_id
           LEFT JOIN v2_work_scopes ws ON ws.id=p.work_scope_id
           LEFT JOIN v2_employees e ON e.id=d.employee_id
           LEFT JOIN v2_employments em ON em.id=d.employment_id
           LEFT JOIN v2_supply_agreements a ON a.id=em.supply_agreement_id
           ORDER BY d.decided_at DESC LIMIT ?`,
        )
        .all(Math.min(500, Math.max(1, limit))),
    ).map((value) => this.#present(value));
  }

  #resolvePosition(input: RuntimeLaunchResolveInput): V2Row | null {
    const positionSlug = input.positionSlug?.trim() || null;
    const workScopeSlug = input.workScopeSlug?.trim() || null;
    const exact = row(
      this.#domain.db
        .prepare(
          `SELECT p.*,ws.slug work_scope_slug,ws.name work_scope_name
           FROM v2_positions p
           LEFT JOIN v2_work_scopes ws ON ws.id=p.work_scope_id
           WHERE p.lifecycle='ACTIVE' AND UPPER(COALESCE(p.runtime_kind,''))=?
             AND (? IS NULL OR p.slug=?)
             AND (? IS NULL OR ws.slug=? OR ws.external_profile_ref=?)
           ORDER BY
             CASE WHEN ? IS NOT NULL AND (ws.slug=? OR ws.external_profile_ref=?) THEN 0 ELSE 1 END,
             CASE WHEN ? IS NOT NULL AND p.slug=? THEN 0 ELSE 1 END,
             CASE WHEN p.lifecycle_policy='STANDING' THEN 0 ELSE 1 END,
             p.created_at
           LIMIT 1`,
        )
        .get(
          input.runtimeKind,
          positionSlug,
          positionSlug,
          workScopeSlug,
          workScopeSlug,
          workScopeSlug,
          workScopeSlug,
          workScopeSlug,
          workScopeSlug,
          positionSlug,
          positionSlug,
        ),
    );
    if (exact) return exact;
    if (positionSlug || workScopeSlug) return null;
    return row(
      this.#domain.db
        .prepare(
          `SELECT p.*,ws.slug work_scope_slug,ws.name work_scope_name
           FROM v2_positions p LEFT JOIN v2_work_scopes ws ON ws.id=p.work_scope_id
           WHERE p.lifecycle='ACTIVE' AND UPPER(COALESCE(p.runtime_kind,''))=?
           ORDER BY CASE WHEN p.lifecycle_policy='STANDING' THEN 0 ELSE 1 END,p.created_at LIMIT 1`,
        )
        .get(input.runtimeKind),
    );
  }

  #candidates(positionId: string, runtimeKind: RuntimeKind): RawCandidate[] {
    const values = rows(
      this.#domain.db
        .prepare(
          `SELECT a.id appointment_id,a.appointment_class,a.priority appointment_priority,
                  e.id employee_id,e.display_name employee_name,e.record_lifecycle,
                  em.id employment_id,em.supply_agreement_id,em.status employment_status,
                  agr.lifecycle agreement_lifecycle,em.model_offering_id,
                  mo.commercial_metadata_json,s.metadata_json supplier_metadata_json
           FROM v2_appointments a
           JOIN v2_employees e ON e.id=a.employee_id
           JOIN v2_suppliers s ON s.id=e.supplier_id
           LEFT JOIN v2_employments em
             ON em.employee_id=e.id AND em.status='CURRENT' AND em.effective_to IS NULL
           LEFT JOIN v2_supply_agreements agr ON agr.id=em.supply_agreement_id
           LEFT JOIN v2_model_offerings mo ON mo.id=em.model_offering_id AND mo.lifecycle='ACTIVE'
           WHERE a.position_id=? AND a.status='CURRENT' AND a.effective_to IS NULL
           ORDER BY CASE a.appointment_class WHEN 'PRIMARY' THEN 0 WHEN 'BACKUP' THEN 1 ELSE 2 END,
                    a.priority DESC,em.effective_from ASC,e.id`,
        )
        .all(positionId),
    );
    const candidates = values.map((value): RawCandidate => {
      const employmentId = value.employment_id ? String(value.employment_id) : null;
      const access = employmentId ? this.#runtimeAccess.resolve(employmentId, runtimeKind) : null;
      const selector =
        selectorFromAccess(access, runtimeKind) ??
        selectorFromMetadata(value.commercial_metadata_json, runtimeKind);
      const supplierMetadata = decode<JsonRecord>(value.supplier_metadata_json, {});
      const rawPreferences = supplierMetadata.staffingPreferences;
      const preferences =
        rawPreferences && typeof rawPreferences === 'object' && !Array.isArray(rawPreferences)
          ? (rawPreferences as JsonRecord)
          : null;
      const enabledEmployeeIds =
        preferences && Array.isArray(preferences.enabledEmployeeIds)
          ? preferences.enabledEmployeeIds.map(String)
          : null;
      const employeeId = String(value.employee_id);
      const supplierEnabled =
        enabledEmployeeIds === null || enabledEmployeeIds.includes(employeeId);
      const supplierPreferred =
        preferences != null && String(preferences.defaultEmployeeId ?? '') === employeeId;
      const qualification = this.#staffing.assessQualification(
        String(value.employee_id),
        positionId,
      );
      const capacity = value.supply_agreement_id
        ? this.#supply.capacityForAgreement(String(value.supply_agreement_id))
        : { available: false, reasons: ['NO_CURRENT_EMPLOYMENT'], pools: [] };

      const accessConfig =
        access?.config && typeof access.config === 'object' && !Array.isArray(access.config)
          ? (access.config as JsonRecord)
          : {};
      const selectorConfig = selector?.config ?? {};
      const providerConnectionId =
        accessConfig.providerHubConnectionId != null
          ? String(accessConfig.providerHubConnectionId)
          : selectorConfig.providerHubConnectionId != null
            ? String(selectorConfig.providerHubConnectionId)
            : null;

      let providerRoutable = true;
      const providerReasons: string[] = [];

      if (providerConnectionId) {
        const connection = this.#providerHub.getConnection(providerConnectionId);
        if (!connection) {
          providerRoutable = false;
          providerReasons.push('PROVIDER_CONNECTION_NOT_FOUND');
        } else {
          const adminState = String(connection.adminState ?? connection.admin_state ?? 'ENABLED');
          const availabilityState = String(
            connection.availabilityState ?? connection.availability_state ?? 'UNKNOWN',
          );
          const retryAfterAt =
            connection.retryAfterAt != null
              ? Number(connection.retryAfterAt)
              : connection.retry_after_at != null
                ? Number(connection.retry_after_at)
                : null;
          const now = Date.now();
          const inBackoff = retryAfterAt !== null && retryAfterAt > now;

          if (adminState === 'DISABLED') {
            providerRoutable = false;
            providerReasons.push('PROVIDER_CONNECTION_DISABLED');
          } else if (availabilityState === 'UNAVAILABLE') {
            providerRoutable = false;
            providerReasons.push('PROVIDER_CONNECTION_UNAVAILABLE');
          } else if (availabilityState === 'TEMP_UNAVAILABLE') {
            if (inBackoff) {
              providerRoutable = false;
              providerReasons.push('PROVIDER_CONNECTION_TEMP_UNAVAILABLE');
            }
          } else if (availabilityState === 'CONGESTED') {
            if (inBackoff) {
              providerRoutable = false;
              providerReasons.push('PROVIDER_CONNECTION_BACKOFF');
            }
          }
        }
      }

      const reasons = [
        ...(qualification.reasons ?? []),
        ...capacity.reasons,
        ...providerReasons,
        ...(selector ? [] : ['RUNTIME_SELECTOR_MISSING']),
        ...(supplierEnabled ? [] : ['SUPPLIER_EMPLOYEE_DISABLED']),
        ...(value.record_lifecycle === 'ACTIVE' ? [] : ['EMPLOYEE_NOT_ACTIVE']),
        ...(value.employment_status === 'CURRENT' ? [] : ['EMPLOYMENT_NOT_CURRENT']),
        ...(value.agreement_lifecycle === 'ACTIVE' ? [] : ['AGREEMENT_NOT_ACTIVE']),
      ];
      return {
        appointmentId: String(value.appointment_id),
        appointmentClass: String(value.appointment_class) as RawCandidate['appointmentClass'],
        appointmentPriority: Number(value.appointment_priority ?? 0),
        employeeId,
        employeeName: String(value.employee_name),
        employeeLifecycle: String(value.record_lifecycle),
        employmentId,
        supplyAgreementId: value.supply_agreement_id ? String(value.supply_agreement_id) : null,
        employmentStatus: value.employment_status ? String(value.employment_status) : null,
        agreementLifecycle: value.agreement_lifecycle ? String(value.agreement_lifecycle) : null,
        modelOfferingId: value.model_offering_id ? String(value.model_offering_id) : null,
        selector,
        qualified: qualification.qualified,
        capacityAvailable: capacity.available,
        supplierEnabled,
        supplierPreferred,
        providerRoutable,
        reasons,
      };
    });
    return candidates.sort(
      (left, right) =>
        appointmentRank(left.appointmentClass) - appointmentRank(right.appointmentClass) ||
        right.appointmentPriority - left.appointmentPriority ||
        Number(right.supplierPreferred) - Number(left.supplierPreferred) ||
        left.employeeId.localeCompare(right.employeeId),
    );
  }

  #present(value: V2Row): V2Row {
    return {
      id: value.id,
      runtimeKind: value.runtime_kind,
      policyMode: value.policy_mode,
      status: value.status,
      position: value.position_id
        ? {
            id: value.position_id,
            name: value.position_name ?? null,
            slug: value.position_slug ?? null,
            workScopeName: value.work_scope_name ?? null,
          }
        : null,
      employee: value.employee_id
        ? { id: value.employee_id, name: value.employee_name ?? null }
        : null,
      employment: value.employment_id
        ? {
            id: value.employment_id,
            agreementName: value.agreement_name ?? null,
          }
        : null,
      modelOfferingId: value.model_offering_id,
      appointmentId: value.appointment_id,
      sessionId: value.session_id,
      taskId: value.task_id,
      toolCallId: value.tool_call_id,
      workScopeHint: value.work_scope_hint,
      positionHint: value.position_hint,
      workdirHint: value.workdir_hint,
      requestedModel: value.requested_model,
      selectedModel: value.selected_model,
      selectedProfile: value.selected_profile,
      selectedAccess: value.selected_access_profile_id
        ? {
            id: value.selected_access_profile_id,
            providerRef: value.selected_provider,
            adapterKind: value.selected_adapter_kind,
            baseUrl: value.selected_base_url,
            credentialRef: value.selected_credential_ref,
            protocol: value.selected_protocol,
            config: decode<JsonRecord>(value.selected_access_config_json, {}),
          }
        : null,
      commandName: value.command_name,
      reasons: decode<string[]>(value.reasons_json, []),
      candidateResults: decode<unknown[]>(value.candidate_results_json, []),
      metadata: decode<JsonRecord>(value.metadata_json, {}),
      decidedAt: value.decided_at,
    };
  }
}
