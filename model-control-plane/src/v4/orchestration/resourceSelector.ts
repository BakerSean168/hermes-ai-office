import {
  affinitiesForCapability,
  capabilityForPhase,
  createExecutionResourceSelection,
  DEFAULT_AFFINITY_POLICY,
  resourceTierRank,
  validateAffinityPolicy,
  validateExecutionResource,
  validateExecutableProfile,
  type AffinityPolicy,
  type ExecutableProfile,
  type ExecutionResource,
  type ExecutionResourceBinding,
  type ExecutionResourceSelection,
  type ExecutionCapability,
  type ResourceTransport,
  type RoutingExecutionPhase,
} from '../domain/resourceRouting.js';
import { V4Error } from '../domain/errors.js';

export interface ResourceDirectoryPort {
  listResources(): readonly ExecutionResource[];
}

export type ResourceDirectory = ResourceDirectoryPort | readonly ExecutionResource[];

export interface ResourceSelectionCandidate {
  readonly affinity: import('../domain/resourceRouting.js').ModelAffinity;
  readonly resource: ExecutionResource;
  readonly binding: ExecutionResourceBinding;
  readonly profile: ExecutableProfile;
}

export interface ResourceSelectionPolicy {
  readonly allowProviderNative?: boolean;
  readonly allowedResourceIds?: Iterable<string>;
  readonly disallowedResourceIds?: Iterable<string>;
  readonly allowedPolicyKeys?: Iterable<string>;
  readonly allowedTransports?: Iterable<ResourceTransport>;
  readonly isAllowed?: (candidate: ResourceSelectionCandidate) => boolean;
}

export interface ResourceSelectionExclusion {
  readonly resourceId: string;
  readonly bindingId?: string;
  readonly modelFamily?: string;
}

export interface ResourceSelectionRequest {
  readonly phase: RoutingExecutionPhase;
  readonly executionId?: string;
  readonly selectedAt?: string;
  readonly includeProviderNativeProfiles?: boolean;
  readonly policy?: ResourceSelectionPolicy;
  readonly excludedResourceIds?: Iterable<string>;
  readonly excludeResourceIds?: Iterable<string>;
  readonly excludedBindingIds?: Iterable<string>;
  readonly excludeBindingIds?: Iterable<string>;
  readonly excludedCandidates?: Iterable<ResourceSelectionExclusion>;
  readonly priorAttempts?: readonly ResourceSelectionExclusion[];
}

export interface SelectedResourceResult {
  readonly status: 'SELECTED';
  readonly capability: ExecutionCapability;
  readonly profile: ExecutableProfile;
  readonly selection?: ExecutionResourceSelection;
  readonly candidate: ResourceSelectionCandidate;
}

export interface WaitingForResourceResult {
  readonly status: 'WAITING_FOR_RESOURCE';
  readonly capability?: ExecutionCapability;
  readonly reason: 'NO_MODEL_REQUIRED' | 'NO_ELIGIBLE_RESOURCE';
}

export type ResourceSelectionResult = SelectedResourceResult | WaitingForResourceResult;

function resourcesFrom(directory: ResourceDirectory): readonly ExecutionResource[] {
  return Array.isArray(directory)
    ? directory
    : (directory as ResourceDirectoryPort).listResources();
}

function setOf(values: Iterable<string> | undefined): ReadonlySet<string> {
  return new Set(values ?? []);
}

function hasRequiredPolicy(
  resource: ExecutionResource,
  binding: ExecutionResourceBinding,
  affinityPolicy: string | undefined,
  allowed: ReadonlySet<string>,
): boolean {
  const required = affinityPolicy ?? binding.requiresPolicy ?? resource.requiresPolicy;
  return required === undefined || allowed.has(required);
}

function excluded(
  candidate: ResourceSelectionCandidate,
  exclusions: readonly ResourceSelectionExclusion[],
): boolean {
  return exclusions.some(
    (item) =>
      item.resourceId === candidate.resource.resourceId &&
      (item.bindingId === undefined || item.bindingId === candidate.binding.bindingId) &&
      (item.modelFamily === undefined || item.modelFamily === candidate.profile.modelFamily),
  );
}

function compareCandidates(
  left: ResourceSelectionCandidate,
  right: ResourceSelectionCandidate,
): number {
  const leftKey = [
    resourceTierRank(left.profile.resourceTier),
    left.profile.modelRank,
    left.profile.resourceSequence,
  ];
  const rightKey = [
    resourceTierRank(right.profile.resourceTier),
    right.profile.modelRank,
    right.profile.resourceSequence,
  ];
  for (let index = 0; index < leftKey.length; index += 1) {
    if (leftKey[index] !== rightKey[index]) return leftKey[index]! - rightKey[index]!;
  }
  const resourceOrder = left.resource.resourceId.localeCompare(right.resource.resourceId);
  if (resourceOrder !== 0) return resourceOrder;
  return left.binding.bindingId.localeCompare(right.binding.bindingId);
}

export function selectExecutableProfile(
  directory: ResourceDirectory,
  request: ResourceSelectionRequest,
  affinityPolicy: AffinityPolicy = DEFAULT_AFFINITY_POLICY,
): ResourceSelectionResult {
  validateAffinityPolicy(affinityPolicy);
  const capability = capabilityForPhase(request.phase);
  if (!capability) return { status: 'WAITING_FOR_RESOURCE', reason: 'NO_MODEL_REQUIRED' };
  const selectionPolicy = request.policy ?? {};
  const allowedResources = selectionPolicy.allowedResourceIds
    ? setOf(selectionPolicy.allowedResourceIds)
    : undefined;
  const disallowedResources = setOf(selectionPolicy.disallowedResourceIds);
  const allowedPolicyKeys = setOf(selectionPolicy.allowedPolicyKeys);
  const allowedTransports = selectionPolicy.allowedTransports
    ? new Set(selectionPolicy.allowedTransports)
    : undefined;
  const excludedResources = new Set([
    ...setOf(request.excludedResourceIds),
    ...setOf(request.excludeResourceIds),
  ]);
  const excludedBindings = new Set([
    ...setOf(request.excludedBindingIds),
    ...setOf(request.excludeBindingIds),
  ]);
  const exclusions = [...(request.excludedCandidates ?? []), ...(request.priorAttempts ?? [])];
  const candidates: ResourceSelectionCandidate[] = [];
  const affinities = affinitiesForCapability(
    affinityPolicy,
    capability,
    request.includeProviderNativeProfiles === true,
  );
  for (const resource of resourcesFrom(directory)) {
    validateExecutionResource(resource);
    if (
      resource.state !== 'ACTIVE' ||
      !resource.ready ||
      excludedResources.has(resource.resourceId) ||
      disallowedResources.has(resource.resourceId)
    )
      continue;
    if (allowedResources && !allowedResources.has(resource.resourceId)) continue;
    for (const affinity of affinities) {
      if (affinity.requiresPolicy !== undefined && !allowedPolicyKeys.has(affinity.requiresPolicy))
        continue;
      for (const binding of resource.bindings) {
        if (binding.modelFamily !== affinity.modelFamily || !binding.enabled || !binding.ready)
          continue;
        if (excludedBindings.has(binding.bindingId)) continue;
        if (
          selectionPolicy.allowProviderNative === false &&
          binding.transport === 'PROVIDER_NATIVE'
        )
          continue;
        if (allowedTransports && !allowedTransports.has(binding.transport)) continue;
        if (!hasRequiredPolicy(resource, binding, affinity.requiresPolicy, allowedPolicyKeys))
          continue;
        const profile: ExecutableProfile = {
          capability,
          phase: request.phase,
          modelFamily: affinity.modelFamily,
          agentBackend:
            binding.agentBackend ?? binding.backend ?? affinity.agentBackend ?? affinity.backend!,
          transport: binding.transport,
          resourceId: resource.resourceId,
          resourceTier: resource.resourceTier,
          modelRank: affinity.modelRank,
          resourceSequence: resource.resourceSequence,
          resourceState: resource.state,
          selectionReason: 'STATIC_POLICY',
          bindingId: binding.bindingId,
          ...(binding.deploymentId === undefined ? {} : { deploymentId: binding.deploymentId }),
          ...(binding.routeModel === undefined ? {} : { routeModel: binding.routeModel }),
          ...(binding.protocol === undefined ? {} : { protocol: binding.protocol }),
        };
        validateExecutableProfile(profile);
        const candidate = {
          affinity,
          resource,
          binding,
          profile,
        } satisfies ResourceSelectionCandidate;
        if (excluded(candidate, exclusions)) continue;
        if (selectionPolicy.isAllowed && !selectionPolicy.isAllowed(candidate)) continue;
        candidates.push(candidate);
      }
    }
  }
  candidates.sort(compareCandidates);
  const candidate = candidates[0];
  if (!candidate)
    return { status: 'WAITING_FOR_RESOURCE', capability, reason: 'NO_ELIGIBLE_RESOURCE' };
  const profile = candidate.profile;
  return {
    status: 'SELECTED',
    capability,
    profile,
    candidate,
    ...(request.executionId === undefined
      ? {}
      : {
          selection: createExecutionResourceSelection(
            request.executionId,
            profile,
            request.selectedAt,
          ),
        }),
  };
}

export class ResourceSelector {
  constructor(
    readonly directory: ResourceDirectory,
    readonly affinityPolicy: AffinityPolicy = DEFAULT_AFFINITY_POLICY,
  ) {
    if (!this.affinityPolicy) throw new V4Error('AFFINITY_POLICY_REQUIRED');
  }

  select(request: ResourceSelectionRequest): ResourceSelectionResult {
    return selectExecutableProfile(this.directory, request, this.affinityPolicy);
  }
}

export class DeterministicResourceSelector extends ResourceSelector {}
