import type { V2Repository, V2Row } from './repository.js';
import { ProviderHubRepository } from './providerHub.js';
import { RuntimeAccessRepository } from './runtimeAccess.js';
import { SupplyRepository } from './supply.js';
import { evaluateSupplyEconomics, type SupplyEconomicsEvaluation } from './supplyEconomics.js';

type JsonRecord = Record<string, unknown>;

export type ExecutionIntent =
  'PLAN' | 'REVIEW' | 'IMPLEMENT' | 'DEBUG' | 'TEST' | 'RESEARCH' | 'QUICK_FIX';

export type ExecutionHarness = 'CLAUDE_CODE' | 'CODEX' | 'DSH' | 'ZCODE' | 'OPENCODE';

type ModelFamily = 'ANTHROPIC' | 'OPENAI' | 'DEEPSEEK' | 'GLM' | 'OTHER';
type WorkClass = 'PREMIUM' | 'IMPLEMENTATION';

export interface RuntimeInventoryItem {
  kind: ExecutionHarness;
  path?: string;
  mode?: string;
}

export interface ExecutionResolveInput {
  intent: ExecutionIntent;
  requestedModel?: string;
  availableRuntimes?: RuntimeInventoryItem[];
  availableProviderConnectionIds?: string[];
  at?: number;
  timezone?: string;
  metadata?: JsonRecord;
}

interface Candidate {
  employee: V2Row;
  employment: V2Row;
  connection: V2Row | null;
  access: V2Row | null;
  model: string;
  family: ModelFamily;
  officialHarness: ExecutionHarness;
  officialHarnessRuntimeAvailable: boolean;
  fallbackReason: string | null;
  officialRoutePreferred: boolean;
  harness: ExecutionHarness;
  harnessPath: string | null;
  modelRank: number;
  rank: number;
  serviceabilityPriority: number;
  economics: SupplyEconomicsEvaluation;
  reasons: string[];
}

const PREMIUM_INTENTS = new Set<ExecutionIntent>(['PLAN', 'REVIEW', 'RESEARCH']);

function normalizedModel(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  const slash = raw.lastIndexOf('/');
  return slash >= 0 ? raw.slice(slash + 1) : raw;
}

function modelFamily(model: string): ModelFamily {
  if (model.startsWith('claude-')) return 'ANTHROPIC';
  if (model.startsWith('gpt-')) return 'OPENAI';
  if (model.startsWith('deepseek-')) return 'DEEPSEEK';
  if (model.startsWith('glm-')) return 'GLM';
  return 'OTHER';
}

function workClass(intent: ExecutionIntent): WorkClass {
  return PREMIUM_INTENTS.has(intent) ? 'PREMIUM' : 'IMPLEMENTATION';
}

const GPT_NON_AGENT_MARKERS = ['image', 'audio', 'realtime', 'tts', 'transcribe'];

function isGptExecutionModel(model: string): boolean {
  return (
    model.startsWith('gpt-') && !GPT_NON_AGENT_MARKERS.some((marker) => model.includes(marker))
  );
}

function modelClass(model: string): WorkClass | null {
  if (model.startsWith('claude-opus-') || model.startsWith('claude-sonnet-')) return 'PREMIUM';
  if (model.startsWith('gpt-5.6-luna')) return 'IMPLEMENTATION';
  if (isGptExecutionModel(model)) return 'PREMIUM';
  if (model.startsWith('deepseek-v4-flash')) return 'IMPLEMENTATION';
  if (model.startsWith('glm-5.2')) return 'IMPLEMENTATION';
  return null;
}

function harnessOrder(family: ModelFamily): ExecutionHarness[] {
  if (family === 'ANTHROPIC') return ['CLAUDE_CODE', 'DSH', 'OPENCODE'];
  if (family === 'OPENAI') return ['CODEX', 'OPENCODE'];
  if (family === 'DEEPSEEK') return ['DSH', 'OPENCODE'];
  if (family === 'GLM') return ['ZCODE', 'OPENCODE', 'DSH'];
  return ['OPENCODE'];
}

function officialHarness(family: ModelFamily): ExecutionHarness {
  return harnessOrder(family)[0]!;
}

function localHour(at: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hour12: false,
  });
  return Number(formatter.format(new Date(at))) % 24;
}

function isPeak(at: number, timezone: string): boolean {
  const hour = localHour(at, timezone);
  return hour >= 9 && hour < 18;
}

function supportsModel(connection: V2Row, model: string): boolean {
  const models = Array.isArray(connection.models) ? connection.models.map(normalizedModel) : [];
  return models.includes(model);
}

function connectionRoutable(connection: V2Row | null): boolean {
  if (!connection) return true;
  return (
    connection.routable !== false &&
    String(connection.adminState ?? connection.admin_state ?? 'ENABLED') !== 'DISABLED'
  );
}

function connectionEffectiveState(connection: V2Row | null): string {
  return String(
    connection?.effectiveState ?? connection?.availabilityState ?? connection?.health ?? 'UNKNOWN',
  ).toUpperCase();
}

function connectionSeverelyDegraded(connection: V2Row | null): boolean {
  const state = connectionEffectiveState(connection);
  return (
    state === 'DISABLED' ||
    state.includes('UNAVAILABLE') ||
    state.includes('DEGRADED') ||
    state.includes('CONGESTED')
  );
}

function isPeakSensitiveDeepSeek(
  connection: V2Row | null,
  employee: V2Row,
  model: string,
): boolean {
  if (!model.startsWith('deepseek-v4-flash')) return false;
  const supplier =
    employee.supplier && typeof employee.supplier === 'object' ? (employee.supplier as V2Row) : {};
  const supplierSlug = String(supplier.slug ?? '').toLowerCase();
  const providerKey = String(
    connection?.provider_key ?? connection?.providerKey ?? '',
  ).toLowerCase();
  const baseUrl = String(connection?.base_url ?? connection?.baseUrl ?? '').toLowerCase();
  return (
    providerKey === 'opencode-go' ||
    supplierSlug === 'opencode' ||
    providerKey === 'deepseek' ||
    supplierSlug === 'deepseek' ||
    baseUrl.includes('api.deepseek.com')
  );
}

function baseRank(work: WorkClass, model: string): number {
  if (work === 'PREMIUM') {
    if (model.startsWith('claude-opus-')) return 10;
    if (model.startsWith('gpt-5.6-sol')) return 20;
    if (model.startsWith('gpt-5.6-terra')) return 25;
    if (model === 'gpt-5.6') return 25;
    if (model.startsWith('claude-sonnet-')) return 30;
    return 100;
  }
  // Implementation models share one neutral baseline. Availability, reusable runtime
  // access, official-harness compatibility, and explicit commercial rules decide
  // between DeepSeek, Luna, and GLM for each execution. Job type must not imply a
  // fixed implementation model.
  if (model.startsWith('deepseek-v4-flash')) return 20;
  if (model.startsWith('gpt-5.6-luna')) return 20;
  if (model.startsWith('glm-5.2')) return 20;
  return 100;
}

function accessForHarness(accesses: V2Row[], harness: ExecutionHarness): V2Row | null {
  const runtimeKind = harness === 'CLAUDE_CODE' ? 'CLAUDE_CODE' : harness;
  return (
    accesses.find(
      (item) => String(item.runtimeKind ?? item.runtime_kind ?? '').toUpperCase() === runtimeKind,
    ) ?? null
  );
}

function connectionForAccess(
  access: V2Row | null,
  connections: V2Row[],
  model: string,
): V2Row | null {
  const config =
    access?.config && typeof access.config === 'object' ? (access.config as JsonRecord) : {};
  const connectionId = String(config.providerHubConnectionId ?? '').trim();
  if (connectionId) {
    const exact = connections.find((item) => String(item.id) === connectionId);
    if (exact) return exact;
  }
  const routable = connections.filter(
    (item) => supportsModel(item, model) && connectionRoutable(item),
  );
  return routable[0] ?? connections.find((item) => supportsModel(item, model)) ?? null;
}

function accessConfig(access: V2Row | null): JsonRecord {
  return access?.config && typeof access.config === 'object' ? (access.config as JsonRecord) : {};
}

function codexTransportMode(access: V2Row | null, protocol: string): string {
  const configured = String(accessConfig(access).transportMode ?? '')
    .trim()
    .toUpperCase();
  if (configured === 'BRIDGED_CHAT') {
    return protocol.includes('chat') ? 'BRIDGED_CHAT' : 'UNSUPPORTED';
  }
  if (
    protocol.includes('responses') ||
    protocol.includes('codex') ||
    protocol.includes('chatgpt')
  ) {
    return 'NATIVE_RESPONSES';
  }
  return 'UNSUPPORTED';
}

function harnessCompatible(
  family: ModelFamily,
  harness: ExecutionHarness,
  access: V2Row | null,
  connection: V2Row | null,
): boolean {
  const protocol = String(connection?.protocol ?? access?.protocol ?? '').toLowerCase();
  const baseUrl = String(
    connection?.base_url ?? connection?.baseUrl ?? access?.baseUrl ?? '',
  ).trim();
  const credentialRef = String(
    connection?.credential_ref ?? connection?.credentialRef ?? access?.credentialRef ?? '',
  ).trim();
  const hasManagedConnection = Boolean(baseUrl && credentialRef);

  if (harness === 'CLAUDE_CODE') {
    return (
      family === 'ANTHROPIC' &&
      (Boolean(access) || (hasManagedConnection && protocol === 'anthropic-messages'))
    );
  }
  if (harness === 'CODEX') {
    const transportMode = codexTransportMode(access, protocol);
    const bridgeExplicitlyRegistered =
      transportMode !== 'BRIDGED_CHAT' ||
      (Boolean(access) &&
        String(accessConfig(access).bridgeKind ?? '').toUpperCase() === 'CC_SWITCH_CODEX_CHAT');
    return (
      family === 'OPENAI' &&
      transportMode !== 'UNSUPPORTED' &&
      bridgeExplicitlyRegistered &&
      (Boolean(access) || hasManagedConnection)
    );
  }
  if (harness === 'DSH') {
    return (
      family === 'DEEPSEEK' &&
      hasManagedConnection &&
      (!protocol || protocol.includes('chat') || protocol.includes('openai'))
    );
  }
  if (harness === 'ZCODE') {
    return family === 'GLM' && hasManagedConnection;
  }
  if (harness === 'OPENCODE') {
    return (
      Boolean(access) ||
      (hasManagedConnection &&
        (!protocol ||
          protocol.includes('openai') ||
          protocol.includes('chat') ||
          protocol.includes('responses')))
    );
  }
  return false;
}

function routeRuntime(
  family: ModelFamily,
  inventory: RuntimeInventoryItem[],
  accesses: V2Row[],
  connections: V2Row[],
  model: string,
): {
  official: ExecutionHarness;
  officialRuntimeAvailable: boolean;
  fallbackReason: string | null;
  selected: ExecutionHarness;
  path: string | null;
  access: V2Row | null;
  connection: V2Row | null;
} | null {
  const order = harnessOrder(family);
  const official = order[0]!;
  const officialRuntimeAvailable =
    inventory.length === 0 || inventory.some((item) => item.kind === official);
  for (const kind of order) {
    const available =
      inventory.length === 0 ? undefined : inventory.find((item) => item.kind === kind);
    if (inventory.length > 0 && !available) continue;
    const access = accessForHarness(accesses, kind);
    const connection = connectionForAccess(access, connections, model);
    if (!connectionRoutable(connection)) continue;
    if (!harnessCompatible(family, kind, access, connection)) continue;
    return {
      official,
      officialRuntimeAvailable,
      fallbackReason:
        kind === official
          ? null
          : officialRuntimeAvailable
            ? 'OFFICIAL_ROUTE_INCOMPATIBLE_OR_UNROUTABLE'
            : 'OFFICIAL_RUNTIME_UNAVAILABLE',
      selected: kind,
      path: available?.path?.trim() || null,
      access,
      connection,
    };
  }
  return null;
}

function runtimeInstruction(candidate: Candidate): JsonRecord {
  const connection = candidate.connection;
  const access = candidate.access;
  const config = accessConfig(access);
  const protocol = String(connection?.protocol ?? access?.protocol ?? '').toLowerCase();
  const transportMode =
    candidate.harness === 'CODEX' ? codexTransportMode(access, protocol) : 'NATIVE';
  const providerRef = String(
    access?.providerRef ?? access?.provider_ref ?? connection?.provider_key ?? '',
  ).trim();
  const profileRef = String(access?.profileRef ?? access?.profile_ref ?? '').trim();
  const modelRef = normalizedModel(candidate.model);
  const reuseExisting = Boolean(access);
  const profileAction = reuseExisting ? 'REUSE_EXISTING' : 'CREATE_MANAGED';
  const executable = candidate.harnessPath || candidate.harness.toLowerCase().replace('_code', '');
  let commandTemplate: string | null = null;
  let launchMode = 'HEADLESS';
  if (candidate.harness === 'CODEX') {
    commandTemplate = profileRef
      ? `${executable} --profile ${profileRef} exec <task>`
      : `${executable} --model ${modelRef} exec <task>`;
  } else if (candidate.harness === 'CLAUDE_CODE') {
    commandTemplate = `${executable} <task>`;
  } else if (candidate.harness === 'DSH') {
    commandTemplate = `${executable} --profile headless <task>`;
  } else if (candidate.harness === 'OPENCODE') {
    const selected = providerRef ? `${providerRef}/${modelRef}` : modelRef;
    commandTemplate = `${executable} run --model ${selected} <task>`;
  } else if (candidate.harness === 'ZCODE') {
    launchMode = 'DESKTOP';
  }
  return {
    preferredHarness: candidate.officialHarness,
    selectedHarness: candidate.harness,
    officialHarnessAvailable: candidate.harness === candidate.officialHarness,
    officialHarnessRuntimeAvailable: candidate.officialHarnessRuntimeAvailable,
    officialHarnessUsableForSelectedRoute: candidate.harness === candidate.officialHarness,
    fallbackReason: candidate.fallbackReason,
    executable: candidate.harnessPath,
    launchMode,
    commandTemplate,
    profileAction,
    profileRef: profileRef || null,
    providerRef: providerRef || null,
    accessProfileId: access?.id ?? null,
    transportMode,
    bridgeKind: transportMode === 'BRIDGED_CHAT' ? String(config.bridgeKind ?? '') || null : null,
  };
}

function guidance(candidate: Candidate, intent: ExecutionIntent): string {
  const familyLabel = {
    ANTHROPIC: 'Anthropic/Claude',
    OPENAI: 'OpenAI/GPT',
    DEEPSEEK: 'DeepSeek',
    GLM: 'GLM',
    OTHER: 'model',
  }[candidate.family];
  const runtime = runtimeInstruction(candidate);
  const connectionId = String(candidate.connection?.id ?? 'unbound');
  const profileAction =
    runtime.profileAction === 'REUSE_EXISTING'
      ? 'Reuse the existing official runtime profile/access configuration.'
      : 'No matching runtime profile is registered; create a managed profile from this provider connection before launch.';
  const fallback =
    candidate.harness === candidate.officialHarness
      ? ''
      : candidate.officialHarnessRuntimeAvailable
        ? ` The preferred official harness ${candidate.officialHarness} is installed, but it is not usable for the selected provider route; use ${candidate.harness} for this execution. This does not mean the ${candidate.officialHarness} runtime is globally unavailable.`
        : ` The preferred official harness runtime ${candidate.officialHarness} is not installed in this execution environment, so use ${candidate.harness}.`;
  return [
    `For ${intent}, use ${candidate.model} from ${familyLabel} through AI Office connection ${connectionId}.`,
    'This is a per-execution placement: intent determines the work class, not a fixed model or harness.',
    `Prefer ${candidate.officialHarness} for this model family.${fallback}`,
    profileAction,
    'Do not generalize this selected model or harness into a permanent Job Type mapping or memory rule.',
    'Resolve credentials only through credentialRef/profile configuration; never place API keys in prompts or command text.',
    'Keep the selected provider/model fixed for this execution unless AI Office returns a new decision or the route becomes unavailable.',
  ].join(' ');
}

export class ExecutionPolicyService {
  readonly #domain: V2Repository;
  readonly #runtimeAccess: RuntimeAccessRepository;
  readonly #providerHub: ProviderHubRepository;
  readonly #supply: SupplyRepository;

  constructor(
    domain: V2Repository,
    runtimeAccess = new RuntimeAccessRepository(domain),
    providerHub = new ProviderHubRepository(domain),
    supply = new SupplyRepository(domain),
  ) {
    this.#domain = domain;
    this.#runtimeAccess = runtimeAccess;
    this.#providerHub = providerHub;
    this.#supply = supply;
  }

  resolve(input: ExecutionResolveInput): V2Row {
    const intent = String(input.intent ?? '').toUpperCase() as ExecutionIntent;
    if (
      !['PLAN', 'REVIEW', 'IMPLEMENT', 'DEBUG', 'TEST', 'RESEARCH', 'QUICK_FIX'].includes(intent)
    ) {
      throw new Error('EXECUTION_INTENT_INVALID');
    }
    const at = Number.isFinite(input.at) ? Number(input.at) : Date.now();
    const timezone = String(input.timezone || 'Asia/Shanghai');
    const peak = isPeak(at, timezone);
    const desiredClass = workClass(intent);
    const requested = input.requestedModel ? normalizedModel(input.requestedModel) : null;
    const inventory = Array.isArray(input.availableRuntimes) ? input.availableRuntimes : [];
    const availableConnectionIds = Array.isArray(input.availableProviderConnectionIds)
      ? new Set(input.availableProviderConnectionIds.map(String))
      : null;
    const connections = this.#providerHub
      .listConnections()
      .filter(
        (item) => availableConnectionIds === null || availableConnectionIds.has(String(item.id)),
      );
    const candidates: Candidate[] = [];
    const excludedCandidates: V2Row[] = [];

    for (const employee of this.#domain.listEmployees()) {
      if (String(employee.recordLifecycle ?? '') !== 'ACTIVE') continue;
      if (String(employee.cooperationState ?? '') !== 'EMPLOYED') continue;
      const supplierModel =
        employee.supplierModel && typeof employee.supplierModel === 'object'
          ? (employee.supplierModel as V2Row)
          : {};
      const model = normalizedModel(supplierModel.key);
      const candidateClass = modelClass(model);
      if (!model || !candidateClass) continue;
      if (requested && model !== requested) continue;
      if (!requested && candidateClass !== desiredClass) continue;
      const family = modelFamily(model);
      if (family === 'OTHER') continue;
      const employments = this.#domain
        .listEmployments(String(employee.id))
        .filter(
          (item) =>
            item.status === 'CURRENT' &&
            item.effectiveTo == null &&
            item.agreementLifecycle === 'ACTIVE',
        );
      const supplier =
        employee.supplier && typeof employee.supplier === 'object'
          ? (employee.supplier as V2Row)
          : {};
      const supplierConnections = connections.filter(
        (item) =>
          String(item.supplier_id ?? (item.supplier as V2Row | undefined)?.id ?? '') ===
          String(supplier.id ?? ''),
      );

      for (const employment of employments) {
        const economics = evaluateSupplyEconomics({
          supplier,
          employment,
          capacityPools: this.#supply.listCapacityPools(String(employment.supplyAgreementId)),
          at,
        });
        if (
          supplierConnections.length > 0 &&
          !supplierConnections.some((connection) => supportsModel(connection, model))
        ) {
          excludedCandidates.push({
            employeeId: employee.id,
            employeeName: employee.displayName,
            model,
            supplierId: supplier.id,
            supplierName: supplier.name,
            supplyEconomics: economics,
            reasons: [...economics.reasons, 'PROVIDER_MODEL_NOT_ADVERTISED'],
          });
          continue;
        }
        if (
          economics.routingPolicy !== 'AUTO' ||
          economics.spendTier === 'UNKNOWN' ||
          !economics.capacityEligible
        ) {
          const eligibilityReasons = [...economics.reasons];
          if (economics.spendTier === 'UNKNOWN') {
            eligibilityReasons.push('COMMERCIAL_CLASSIFICATION_REQUIRED');
          }
          excludedCandidates.push({
            employeeId: employee.id,
            employeeName: employee.displayName,
            model,
            supplierId: supplier.id,
            supplierName: supplier.name,
            supplyEconomics: economics,
            reasons: eligibilityReasons,
          });
          continue;
        }
        const accesses = this.#runtimeAccess
          .list(String(employment.id))
          .filter((item) => String(item.lifecycle ?? '') === 'ACTIVE');
        const runtime = routeRuntime(family, inventory, accesses, supplierConnections, model);
        if (!runtime) continue;
        if (availableConnectionIds !== null && !runtime.connection) continue;
        const selectedAccess = runtime.access;
        const connection = runtime.connection;
        if (connection && !supportsModel(connection, model)) {
          excludedCandidates.push({
            employeeId: employee.id,
            employeeName: employee.displayName,
            model,
            supplierId: supplier.id,
            supplierName: supplier.name,
            providerConnectionId: connection.id,
            supplyEconomics: economics,
            reasons: [...economics.reasons, 'PROVIDER_MODEL_NOT_ADVERTISED'],
          });
          continue;
        }
        const rankingClass = requested ? candidateClass : desiredClass;
        const modelRank = baseRank(rankingClass, model);
        let rank = 0;
        let serviceabilityPriority = 0;
        const reasons = [`MODEL_CLASS_${candidateClass}`, `FAMILY_${family}`, ...economics.reasons];
        if (requested && candidateClass !== desiredClass) {
          reasons.push(`EXPLICIT_MODEL_OVERRIDE_${desiredClass}_TO_${candidateClass}`);
        }
        if (connection) {
          const effective = connectionEffectiveState(connection);
          reasons.push(`PROVIDER_${effective}`);
          if (effective === 'AVAILABLE') rank -= 5;
          else if (effective === 'UNKNOWN') rank += 6;
          else if (effective.includes('DEGRADED') || effective.includes('CONGESTED')) {
            serviceabilityPriority = 1;
            rank += 8;
          }
        } else {
          rank += 12;
          reasons.push('PROVIDER_CONNECTION_UNBOUND');
        }
        if (runtime.selected === runtime.official) {
          rank -= 5;
          const protocol = String(
            connection?.protocol ?? selectedAccess?.protocol ?? '',
          ).toLowerCase();
          reasons.push(
            runtime.selected === 'CODEX' &&
              codexTransportMode(selectedAccess, protocol) === 'BRIDGED_CHAT'
              ? 'OFFICIAL_HARNESS_VIA_PROTOCOL_BRIDGE'
              : 'OFFICIAL_HARNESS_AVAILABLE',
          );
        } else {
          rank += 5;
          reasons.push(`OFFICIAL_HARNESS_UNAVAILABLE_OR_INCOMPATIBLE_USING_${runtime.selected}`);
        }
        if (selectedAccess) {
          rank -= 3;
          reasons.push('RUNTIME_PROFILE_REUSABLE');
        } else {
          reasons.push('RUNTIME_PROFILE_CREATE_MANAGED');
        }
        if (isPeakSensitiveDeepSeek(connection, employee, model)) {
          if (peak) {
            rank += 30;
            reasons.push('DEEPSEEK_PEAK_PRICE_PENALTY');
          } else {
            rank -= 12;
            reasons.push('DEEPSEEK_OFFPEAK_PREFERENCE');
          }
        } else if (model.startsWith('deepseek-v4-flash')) {
          reasons.push('DEEPSEEK_ROUTE_NOT_TIME_PRICED');
        }
        candidates.push({
          employee,
          employment,
          connection,
          access: selectedAccess,
          model,
          family,
          officialHarness: runtime.official,
          officialHarnessRuntimeAvailable: runtime.officialRuntimeAvailable,
          fallbackReason: runtime.fallbackReason,
          officialRoutePreferred:
            runtime.selected === runtime.official && !connectionSeverelyDegraded(connection),
          harness: runtime.selected,
          harnessPath: runtime.path,
          modelRank,
          rank,
          serviceabilityPriority,
          economics,
          reasons,
        });
      }
    }

    candidates.sort((left, right) => {
      const serviceability = left.serviceabilityPriority - right.serviceabilityPriority;
      if (serviceability !== 0) return serviceability;
      const spendPriority = left.economics.spendPriority - right.economics.spendPriority;
      if (spendPriority !== 0) return spendPriority;
      const expiryPriority = left.economics.expiryPriority - right.economics.expiryPriority;
      if (expiryPriority !== 0) return expiryPriority;
      if (left.economics.expiresAt != null && right.economics.expiresAt != null) {
        const expiry = left.economics.expiresAt - right.economics.expiresAt;
        if (expiry !== 0) return expiry;
      }
      const modelPriority = left.modelRank - right.modelRank;
      if (modelPriority !== 0) return modelPriority;
      if (
        left.model === right.model &&
        left.officialRoutePreferred !== right.officialRoutePreferred
      ) {
        return left.officialRoutePreferred ? -1 : 1;
      }
      return (
        left.rank - right.rank ||
        left.model.localeCompare(right.model) ||
        String(left.employee.id).localeCompare(String(right.employee.id))
      );
    });
    const selected = candidates[0] ?? null;
    return {
      status: selected ? 'SELECTED' : 'UNRESOLVED',
      policyVersion: 'economic-placement-v2',
      decisionScope: 'PER_EXECUTION',
      routingPrinciple: 'QUALITY_GATE_THEN_SPEND_TIER_THEN_ROUTE_FIT',
      intent,
      workClass: desiredClass,
      evaluatedAt: at,
      timezone,
      peakWindow: { active: peak, startHour: 9, endHour: 18 },
      requestedModel: requested,
      selected: selected
        ? {
            employee: selected.employee,
            employment: selected.employment,
            model: selected.model,
            family: selected.family,
            supplyEconomics: selected.economics,
            providerConnection: selected.connection
              ? {
                  id: selected.connection.id,
                  providerKey: selected.connection.provider_key,
                  displayName: selected.connection.display_name,
                  baseUrl: selected.connection.base_url,
                  protocol: selected.connection.protocol,
                  authKind: selected.connection.auth_kind,
                  credentialRef: selected.connection.credential_ref,
                  credentialScope: selected.connection.credential_scope,
                  sourceProfileId: selected.connection.source_profile_id,
                  availabilityState:
                    selected.connection.availabilityState ?? selected.connection.availability_state,
                  effectiveState: selected.connection.effectiveState,
                  routable: selected.connection.routable,
                }
              : null,
            runtime: runtimeInstruction(selected),
            reasons: selected.reasons,
            guidance: guidance(selected, intent),
          }
        : null,
      candidates: candidates.slice(0, 12).map((candidate) => ({
        employeeId: candidate.employee.id,
        employeeName: candidate.employee.displayName,
        model: candidate.model,
        family: candidate.family,
        providerConnectionId: candidate.connection?.id ?? null,
        harness: candidate.harness,
        preferredHarness: candidate.officialHarness,
        officialHarnessRuntimeAvailable: candidate.officialHarnessRuntimeAvailable,
        officialHarnessUsableForSelectedRoute: candidate.harness === candidate.officialHarness,
        fallbackReason: candidate.fallbackReason,
        supplyEconomics: candidate.economics,
        selectionKey: {
          serviceabilityPriority: candidate.serviceabilityPriority,
          spendPriority: candidate.economics.spendPriority,
          expiryPriority: candidate.economics.expiryPriority,
          expiresAt: candidate.economics.expiresAt,
          modelRank: candidate.modelRank,
          routeFitRank: candidate.rank,
        },
        transportMode:
          candidate.harness === 'CODEX'
            ? codexTransportMode(
                candidate.access,
                String(
                  candidate.connection?.protocol ?? candidate.access?.protocol ?? '',
                ).toLowerCase(),
              )
            : 'NATIVE',
        rank: candidate.rank,
        reasons: candidate.reasons,
      })),
      totalCandidates: candidates.length,
      excludedCandidates,
      metadata: input.metadata ?? {},
    };
  }
}
