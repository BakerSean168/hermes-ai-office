import fs from 'node:fs';

import { V4Error, failClosed } from '../domain/errors.js';
import {
  deriveResourceTier,
  normalizeResourceFailure,
  transitionResourceState,
  transitionResourceStateOnSuccess,
  validateExecutionResource,
  type ExecutionResource,
  type ExecutionResourceBinding,
  type ExecutionResourceSelection,
  type ResourceCommercialType,
  type ResourceLifecycle,
  type ResourceState,
  type ResourceStateOverride,
  type ResourceStateOverrideSource,
  type ResourceSupplyOrigin,
  type ResourceTier,
} from '../domain/resourceRouting.js';
import type { ResourceDirectoryPort } from '../orchestration/resourceSelector.js';
import type {
  MutationResult,
  ResourceStateOverrideInput,
  ResourceStateOverrideRepository,
} from '../persistence/repositories.js';

interface JsonRecord {
  [key: string]: unknown;
}
const record = (value: unknown): JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
const number = (value: unknown): number | undefined =>
  Number.isFinite(Number(value)) ? Number(value) : undefined;
const bool = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

function readEnvValue(file: string, key: string): string {
  const content = fs.readFileSync(file, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1 || trimmed.slice(0, index) !== key) continue;
    const value = trimmed
      .slice(index + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
    if (value) return value;
  }
  throw new V4Error('LITELLM_RESOURCE_KEY_MISSING');
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], code: string): T {
  if (typeof value !== 'string' || !allowed.includes(value.toUpperCase() as T))
    throw new V4Error(code);
  return value.toUpperCase() as T;
}

function commercial(value: unknown): ResourceCommercialType {
  return enumValue(
    value,
    ['FREE', 'SPONSORED', 'SUBSCRIPTION', 'METERED', 'OTHER'] as const,
    'RESOURCE_DIRECTORY_COMMERCIAL_INVALID',
  );
}
function origin(value: unknown): ResourceSupplyOrigin {
  return enumValue(
    value,
    ['COMMUNITY_RELAY', 'COMMERCIAL_RELAY', 'OFFICIAL', 'UNKNOWN'] as const,
    'RESOURCE_DIRECTORY_ORIGIN_INVALID',
  );
}
function lifecycle(value: unknown): ResourceLifecycle {
  return enumValue(
    value,
    ['STABLE', 'RECURRING', 'PROMOTIONAL'] as const,
    'RESOURCE_DIRECTORY_LIFECYCLE_INVALID',
  );
}

function selectorModelFamily(value: string): string {
  return value.toLowerCase() === 'glm-5.2' ? 'glm-current' : value;
}

function overrideResource(
  resource: ExecutionResource,
  override: ResourceStateOverride | undefined,
): ExecutionResource {
  if (!override) return resource;
  const bindings = resource.bindings.map((binding) => ({
    ...binding,
    ready: override.state === 'ACTIVE' && binding.ready,
  }));
  const projected = Object.freeze({
    ...resource,
    state: override.state,
    ready: override.state === 'ACTIVE' && bindings.some((item) => item.ready),
    bindings,
  });
  validateExecutionResource(projected);
  return projected;
}

export interface LiteLlmResourceDirectoryOptions {
  baseUrl: string;
  envFile: string;
  keyName?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  overrides?: ResourceStateOverrideRepository;
}

export class LiteLlmResourceDirectory implements ResourceDirectoryPort {
  readonly #baseUrl: string;
  readonly #envFile: string;
  readonly #keyName: string;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  readonly #overrides?: ResourceStateOverrideRepository;
  #resources: readonly ExecutionResource[] = Object.freeze([]);

  constructor(options: LiteLlmResourceDirectoryOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#envFile = options.envFile;
    this.#keyName = options.keyName ?? 'LITELLM_MASTER_KEY';
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeout = Math.max(1_000, options.requestTimeoutMs ?? 10_000);
    this.#overrides = options.overrides;
  }

  listResources(): readonly ExecutionResource[] {
    return this.#resources;
  }

  async refresh(): Promise<readonly ExecutionResource[]> {
    const key = readEnvValue(this.#envFile, this.#keyName);
    const response = await this.#fetch(this.#baseUrl + '/model/info', {
      headers: { ['Author' + 'ization']: 'Bearer ' + key },
      signal: AbortSignal.timeout(this.#timeout),
    });
    if (!response.ok) throw new V4Error('LITELLM_RESOURCE_DIRECTORY_HTTP_' + response.status);
    const root = record(await response.json());
    const rows = Array.isArray(root.data) ? root.data : [];
    const grouped = new Map<
      string,
      { base: Omit<ExecutionResource, 'bindings' | 'ready'>; bindings: ExecutionResourceBinding[] }
    >();
    for (const raw of rows) {
      const row = record(raw);
      const info = record(row.model_info);
      const metadata = record(info.metadata);
      if (metadata.automatic_core !== true) continue;
      const params = record(row.litellm_params);
      const resourceId = text(metadata.resource_id);
      const sequence = number(metadata.resource_sequence);
      const family = text(metadata.model_family);
      const routeModel = text(metadata.route_model) ?? text(row.model_name);
      const deploymentId = text(info.id);
      if (
        !resourceId ||
        !sequence ||
        !Number.isInteger(sequence) ||
        sequence <= 0 ||
        !family ||
        !routeModel ||
        !deploymentId
      ) {
        throw new V4Error('LITELLM_RESOURCE_DIRECTORY_ROW_INVALID');
      }
      const commercialType = commercial(metadata.commercial_type ?? 'OTHER');
      const supplyOrigin = origin(metadata.supply_origin ?? 'UNKNOWN');
      const resourceLifecycle = lifecycle(metadata.resource_lifecycle ?? 'STABLE');
      const resourceTier = deriveResourceTier(commercialType, resourceLifecycle);
      const protocol = text(metadata.protocol);
      const blocked = bool(info.blocked) === true;
      const existing = grouped.get(resourceId);
      const base = {
        resourceId,
        resourceTier,
        resourceSequence: sequence,
        state: 'ACTIVE' as const,
        commercialType,
        supplyOrigin,
        resourceLifecycle,
        ...(text(metadata.supplier_slug) || text(params.litellm_credential_name)
          ? { providerId: text(metadata.supplier_slug) ?? text(params.litellm_credential_name)! }
          : {}),
        ...(text(metadata.display_name) || text(metadata.provider_display_name)
          ? { displayName: text(metadata.display_name) ?? text(metadata.provider_display_name)! }
          : {}),
      };
      if (
        existing &&
        (existing.base.resourceSequence !== sequence || existing.base.resourceTier !== resourceTier)
      )
        throw new V4Error('LITELLM_RESOURCE_DIRECTORY_RESOURCE_CONFLICT');
      const binding: ExecutionResourceBinding = Object.freeze({
        bindingId: deploymentId,
        modelFamily: selectorModelFamily(family),
        transport: 'LITELLM_MANAGED',
        enabled: !blocked,
        ready: !blocked,
        deploymentId,
        routeModel,
        ...(protocol ? { protocol } : {}),
      });
      if (existing) existing.bindings.push(binding);
      else grouped.set(resourceId, { base, bindings: [binding] });
    }
    const resources = [...grouped.values()]
      .map(({ base, bindings }) => {
        const resource: ExecutionResource = Object.freeze({
          ...base,
          ready: bindings.some((item) => item.ready),
          bindings: Object.freeze(bindings),
        });
        validateExecutionResource(resource);
        return overrideResource(resource, this.#overrides?.get(resource.resourceId));
      })
      .sort(
        (a, b) =>
          a.resourceSequence - b.resourceSequence || a.resourceId.localeCompare(b.resourceId),
      );
    this.#resources = Object.freeze(resources);
    return this.#resources;
  }
}

export interface ProviderNativeResourceOptions {
  businessEnabled?: boolean;
  businessReady?: boolean;
  antigravityEnabled?: boolean;
  antigravityReady?: boolean;
}

export function providerNativeResources(
  options: ProviderNativeResourceOptions = {},
): readonly ExecutionResource[] {
  const trusted = 'provider-native-trusted-input';
  const native = (
    resourceId: string,
    sequence: number,
    enabled: boolean,
    ready: boolean,
    bindings: Array<Omit<ExecutionResourceBinding, 'transport' | 'enabled' | 'ready'>>,
    requiresPolicy?: string,
  ): ExecutionResource => {
    const projectedBindings = bindings.map((binding) =>
      Object.freeze({
        ...binding,
        transport: 'PROVIDER_NATIVE' as const,
        enabled,
        ready: enabled && ready,
        ...(requiresPolicy ? { requiresPolicy } : {}),
      }),
    );
    const resource: ExecutionResource = Object.freeze({
      resourceId,
      resourceTier: 'SUBSCRIPTION',
      resourceSequence: sequence,
      state: 'ACTIVE',
      ready: projectedBindings.some((item) => item.ready),
      commercialType: 'SUBSCRIPTION',
      supplyOrigin: 'OFFICIAL',
      resourceLifecycle: 'RECURRING',
      ...(requiresPolicy ? { requiresPolicy } : {}),
      providerId: resourceId,
      displayName: resourceId === 'chatgpt-business-primary' ? 'ChatGPT Business' : 'Antigravity',
      bindings: Object.freeze(projectedBindings),
    });
    validateExecutionResource(resource);
    return resource;
  };
  return Object.freeze([
    native(
      'chatgpt-business-primary',
      120,
      options.businessEnabled === true,
      options.businessReady === true,
      [
        {
          bindingId: 'chatgpt-business-luna',
          modelFamily: 'gpt-5.6-luna',
          agentBackend: 'codex-acp',
        },
        {
          bindingId: 'chatgpt-business-sol',
          modelFamily: 'gpt-5.6-sol',
          agentBackend: 'codex-acp',
        },
      ],
    ),
    native(
      'antigravity-primary',
      121,
      options.antigravityEnabled === true,
      options.antigravityReady === true,
      [
        {
          bindingId: 'antigravity-gemini-3.8-flash-high',
          modelFamily: 'gemini-3.8-flash-high',
          agentBackend: 'antigravity-worker',
        },
        {
          bindingId: 'antigravity-gemini-3.7-flash-high',
          modelFamily: 'gemini-3.7-flash-high',
          agentBackend: 'antigravity-worker',
        },
        {
          bindingId: 'antigravity-gemini-3.1-pro-high',
          modelFamily: 'gemini-3.1-pro-high',
          agentBackend: 'antigravity-review',
        },
      ],
      trusted,
    ),
  ]);
}

export class CompositeResourceDirectory implements ResourceDirectoryPort {
  constructor(
    readonly directories: readonly ResourceDirectoryPort[],
    readonly overrides?: ResourceStateOverrideRepository,
  ) {}
  listResources(): readonly ExecutionResource[] {
    const seen = new Set<string>();
    return Object.freeze(
      this.directories
        .flatMap((directory) => directory.listResources())
        .map((resource) => {
          if (seen.has(resource.resourceId))
            throw new V4Error('RESOURCE_DIRECTORY_DUPLICATE_RESOURCE');
          seen.add(resource.resourceId);
          return overrideResource(resource, this.overrides?.get(resource.resourceId));
        })
        .sort(
          (a, b) =>
            a.resourceSequence - b.resourceSequence || a.resourceId.localeCompare(b.resourceId),
        ),
    );
  }
}

export class StaticResourceDirectory implements ResourceDirectoryPort {
  constructor(readonly resources: readonly ExecutionResource[]) {
    resources.forEach(validateExecutionResource);
  }
  listResources(): readonly ExecutionResource[] {
    return this.resources;
  }
}

export interface ResourceFeedbackPort {
  success(selection: ExecutionResourceSelection): void;
  failure(selection: ExecutionResourceSelection, error: unknown): void;
}

export interface ResourceStateEffectPort {
  apply(resource: ExecutionResource, state: ResourceState): Promise<void> | void;
  applyBinding?(
    resource: ExecutionResource,
    binding: ExecutionResourceBinding,
    state: 'ACTIVE' | 'DISABLED',
  ): Promise<void> | void;
}

export class LiteLlmResourceStateEffect implements ResourceStateEffectPort {
  readonly #baseUrl: string;
  readonly #envFile: string;
  readonly #keyName: string;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;

  constructor(options: LiteLlmResourceDirectoryOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#envFile = options.envFile;
    this.#keyName = options.keyName ?? 'LITELLM_MASTER_KEY';
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeout = Math.max(1_000, options.requestTimeoutMs ?? 10_000);
  }

  async #patch(deploymentId: string, blocked: boolean): Promise<void> {
    const key = readEnvValue(this.#envFile, this.#keyName);
    const response = await this.#fetch(
      this.#baseUrl + '/model/' + encodeURIComponent(deploymentId) + '/update',
      {
        method: 'PATCH',
        headers: {
          ['Author' + 'ization']: 'Bearer ' + key,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ blocked }),
        signal: AbortSignal.timeout(this.#timeout),
      },
    );
    if (!response.ok) throw new V4Error('LITELLM_RESOURCE_STATE_HTTP_' + response.status);
  }

  async apply(resource: ExecutionResource, state: ResourceState): Promise<void> {
    const deploymentIds = [
      ...new Set(
        resource.bindings
          .map((binding) => binding.deploymentId)
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    if (deploymentIds.length === 0) return;
    for (const deploymentId of deploymentIds) await this.#patch(deploymentId, state !== 'ACTIVE');
  }

  async applyBinding(
    _resource: ExecutionResource,
    binding: ExecutionResourceBinding,
    state: 'ACTIVE' | 'DISABLED',
  ): Promise<void> {
    if (!binding.deploymentId) throw new V4Error('LITELLM_BINDING_DEPLOYMENT_ID_REQUIRED');
    await this.#patch(binding.deploymentId, state === 'DISABLED');
  }
}

export class ResourceStateService implements ResourceFeedbackPort {
  constructor(
    readonly directory: ResourceDirectoryPort,
    readonly overrides: ResourceStateOverrideRepository,
    readonly maxCasRetries = 3,
    readonly effect?: ResourceStateEffectPort,
  ) {}
  #resource(id: string): ExecutionResource {
    const value = this.directory.listResources().find((item) => item.resourceId === id);
    if (!value) throw new V4Error('RESOURCE_NOT_FOUND');
    return value;
  }
  #effect(resource: ExecutionResource, state: ResourceState): void {
    if (!this.effect) return;
    void Promise.resolve(this.effect.apply(resource, state)).catch(() => {
      // The durable local override remains authoritative for Pixel routing. The
      // next lifecycle/management reconcile can retry a failed remote projection.
    });
  }
  #write(input: ResourceStateOverrideInput): MutationResult<ResourceStateOverride> {
    for (let attempt = 0; attempt < this.maxCasRetries; attempt += 1) {
      const current = this.overrides.get(input.resourceId);
      const result = this.overrides.compareAndSet(
        input.resourceId,
        current?.version ?? null,
        input,
      );
      if (result.status !== 'rejected') return result;
    }
    throw new V4Error('RESOURCE_OVERRIDE_CAS_EXHAUSTED');
  }
  failure(selection: ExecutionResourceSelection, error: unknown): void {
    const resource = this.#resource(selection.resourceId);
    const failure = normalizeResourceFailure(error);
    const transition = transitionResourceState(
      {
        state: resource.state,
        resourceTier: resource.resourceTier,
        commercialType: resource.commercialType,
        supplyOrigin: resource.supplyOrigin,
        resourceLifecycle: resource.resourceLifecycle,
      },
      failure,
      new Date().toISOString(),
    );
    if (failure.scope === 'BINDING') {
      const binding = resource.bindings.find(
        (item) =>
          item.bindingId === selection.bindingId ||
          (selection.deploymentId !== undefined && item.deploymentId === selection.deploymentId),
      );
      if (binding && this.effect?.applyBinding)
        void Promise.resolve(this.effect.applyBinding(resource, binding, 'DISABLED')).catch(
          () => {},
        );
      return;
    }
    const result = this.#write({
      resourceId: resource.resourceId,
      state: transition.state,
      source: 'EXECUTION',
      ...(transition.reasonClass ? { reasonClass: transition.reasonClass } : {}),
      ...(transition.sanitizedReason ? { sanitizedReason: transition.sanitizedReason } : {}),
      ...(transition.suspendedUntil ? { suspendedUntil: transition.suspendedUntil } : {}),
    });
    if (result.value) this.#effect(resource, result.value.state);
  }
  success(selection: ExecutionResourceSelection): void {
    const resource = this.#resource(selection.resourceId);
    const current = this.overrides.get(resource.resourceId);
    if (!current || current.state === 'ACTIVE' || current.state === 'DISABLED') return;
    const transition = transitionResourceStateOnSuccess({
      state: current.state,
      resourceTier: resource.resourceTier,
    });
    const result = this.#write({
      resourceId: resource.resourceId,
      state: transition.state,
      source: 'EXECUTION',
    });
    if (result.value) this.#effect(resource, result.value.state);
  }
  manual(
    resourceId: string,
    state: ResourceState,
    options: { reason?: string; suspendedUntil?: string; expectedVersion?: number | null } = {},
  ): MutationResult<ResourceStateOverride> {
    if (state === 'SUSPENDED')
      failClosed(
        Boolean(options.suspendedUntil) && Date.parse(options.suspendedUntil!) > Date.now(),
        'RESOURCE_OVERRIDE_SUSPENSION_REQUIRED',
      );
    const resource = this.#resource(resourceId);
    const result = this.overrides.compareAndSet(
      resourceId,
      options.expectedVersion ?? this.overrides.get(resourceId)?.version ?? null,
      {
        resourceId,
        state,
        source: 'OPERATOR',
        ...(options.reason ? { sanitizedReason: options.reason.slice(0, 2_000) } : {}),
        ...(state === 'SUSPENDED' ? { suspendedUntil: options.suspendedUntil! } : {}),
      },
    );
    if (result.value && result.status !== 'rejected') this.#effect(resource, result.value.state);
    return result;
  }
}

export interface ResourceProbePort {
  probe(resource: ExecutionResource): Promise<boolean>;
}
export class ResourceLifecycleManager {
  constructor(
    readonly directory: ResourceDirectoryPort,
    readonly overrides: ResourceStateOverrideRepository,
    readonly probe: ResourceProbePort,
    readonly effect?: ResourceStateEffectPort,
  ) {}
  async reconcileOnce(now = new Date()): Promise<number> {
    let changed = 0;
    for (const current of this.overrides.list()) {
      if (
        current.state !== 'SUSPENDED' ||
        !current.suspendedUntil ||
        Date.parse(current.suspendedUntil) > now.getTime()
      )
        continue;
      const resource = this.directory
        .listResources()
        .find((item) => item.resourceId === current.resourceId);
      if (!resource) continue;
      let active = resource.resourceTier !== 'FREE';
      if (!active) active = await this.probe.probe(resource);
      const result = this.overrides.compareAndSet(resource.resourceId, current.version, {
        resourceId: resource.resourceId,
        state: active ? 'ACTIVE' : 'DISABLED',
        source: 'PROBE',
        ...(active
          ? {}
          : { reasonClass: 'CONNECTION_UNAVAILABLE', sanitizedReason: 'CONNECTION_UNAVAILABLE' }),
      });
      if (result.status !== 'rejected') {
        changed += 1;
        if (result.value && this.effect) await this.effect.apply(resource, result.value.state);
      }
    }
    return changed;
  }
}
