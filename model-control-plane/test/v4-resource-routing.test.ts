import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  COMMUNITY_SUSPENSION_MS,
  DEFAULT_AFFINITY_POLICY,
  PAID_TRANSIENT_COOLDOWN_MS,
  capabilityForPhase,
  deriveResourceTier,
  normalizeResourceFailure,
  transitionResourceState,
  transitionResourceStateOnSuccess,
  validateAffinityPolicy,
  validateExecutionResource,
  validateExecutionResourceSelection,
  type ExecutionResource,
  type ExecutionResourceSelection,
  type ExecutableProfile,
  type ResourceStatePolicyInput,
} from '../src/v4/domain/resourceRouting.js';
import { V4Error } from '../src/v4/domain/errors.js';
import {
  selectExecutableProfile,
  ResourceSelector,
} from '../src/v4/orchestration/resourceSelector.js';
import { openV4Database, SCHEMA_VERSION } from '../src/v4/persistence/database.js';
import { createRepositories } from '../src/v4/persistence/repositories.js';

const NOW = '2026-09-03T00:00:00.000Z';

function resource(
  input: Partial<ExecutionResource> &
    Pick<ExecutionResource, 'resourceId' | 'resourceTier' | 'resourceSequence' | 'bindings'>,
): ExecutionResource {
  const commercialType =
    input.commercialType ??
    (input.resourceTier === 'FREE'
      ? 'FREE'
      : input.resourceTier === 'PROMOTIONAL'
        ? 'FREE'
        : input.resourceTier);
  const resourceLifecycle =
    input.resourceLifecycle ?? (input.resourceTier === 'PROMOTIONAL' ? 'PROMOTIONAL' : 'RECURRING');
  return {
    resourceId: input.resourceId,
    resourceTier: input.resourceTier,
    resourceSequence: input.resourceSequence,
    state: input.state ?? 'ACTIVE',
    ready: input.ready ?? true,
    commercialType,
    supplyOrigin:
      input.supplyOrigin ?? (commercialType === 'FREE' ? 'COMMUNITY_RELAY' : 'COMMERCIAL_RELAY'),
    resourceLifecycle,
    bindings: input.bindings,
    ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    ...(input.requiresPolicy === undefined ? {} : { requiresPolicy: input.requiresPolicy }),
  };
}

function binding(
  bindingId: string,
  modelFamily: string,
  input: Partial<ExecutionResource['bindings'][number]> = {},
) {
  return {
    bindingId,
    modelFamily,
    transport: input.transport ?? 'LITELLM_MANAGED',
    enabled: input.enabled ?? true,
    ready: input.ready ?? true,
    ...(input.agentBackend === undefined ? {} : { agentBackend: input.agentBackend }),
    ...(input.deploymentId === undefined ? {} : { deploymentId: input.deploymentId }),
    ...(input.routeModel === undefined ? {} : { routeModel: input.routeModel }),
    ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
    ...(input.requiresPolicy === undefined ? {} : { requiresPolicy: input.requiresPolicy }),
  } as const;
}

test('the default affinity policy is versioned, ranked, native-profile-safe, and duplicate-proof', () => {
  validateAffinityPolicy(DEFAULT_AFFINITY_POLICY);
  assert.equal(DEFAULT_AFFINITY_POLICY.version, 1);
  assert.deepEqual(
    DEFAULT_AFFINITY_POLICY.capabilities.IMPLEMENTATION.map(
      ({ modelFamily, modelRank, agentBackend }) => [modelFamily, modelRank, agentBackend],
    ),
    [
      ['deepseek-v4-flash', 10, 'dsh-acp'],
      ['glm-current', 20, 'zcode-acp'],
      ['gpt-5.6-luna', 30, 'codex-acp'],
    ],
  );
  assert.deepEqual(
    DEFAULT_AFFINITY_POLICY.capabilities.REASONING.map(
      ({ modelFamily, modelRank, agentBackend }) => [modelFamily, modelRank, agentBackend],
    ),
    [
      ['gpt-5.6-sol', 10, 'codex-acp'],
      ['claude-opus-5', 20, 'claude-code-acp'],
      ['claude-opus-4-8', 30, 'claude-code-acp'],
    ],
  );
  assert.deepEqual(
    DEFAULT_AFFINITY_POLICY.providerNativeProfiles.map(({ modelFamily, transport }) => [
      modelFamily,
      transport,
    ]),
    [
      ['gemini-3.8-flash-high', 'PROVIDER_NATIVE'],
      ['gemini-3.7-flash-high', 'PROVIDER_NATIVE'],
      ['gemini-3.1-pro-high', 'PROVIDER_NATIVE'],
    ],
  );
  assert.throws(
    () =>
      validateAffinityPolicy({
        ...DEFAULT_AFFINITY_POLICY,
        capabilities: {
          ...DEFAULT_AFFINITY_POLICY.capabilities,
          IMPLEMENTATION: [
            ...DEFAULT_AFFINITY_POLICY.capabilities.IMPLEMENTATION,
            {
              capability: 'IMPLEMENTATION',
              modelFamily: 'duplicate',
              modelRank: 10,
              agentBackend: 'zcode-acp',
            },
          ],
        },
      }),
    (error: unknown) =>
      error instanceof V4Error && error.code === 'AFFINITY_POLICY_IMPLEMENTATION_DUPLICATE_RANK',
  );
});

test('resource records validate derived tiers and provider-native bindings without secrets', () => {
  assert.equal(deriveResourceTier('SPONSORED', 'RECURRING'), 'FREE');
  assert.equal(deriveResourceTier('SUBSCRIPTION', 'PROMOTIONAL'), 'PROMOTIONAL');
  const nativeGemini = resource({
    resourceId: 'antigravity-primary',
    resourceTier: 'SUBSCRIPTION',
    resourceSequence: 121,
    bindings: [
      binding('gemini-primary', 'gemini-3.8-flash-high', {
        transport: 'PROVIDER_NATIVE',
        agentBackend: 'antigravity-worker',
        requiresPolicy: 'provider-native-trusted-input',
      }),
    ],
  });
  validateExecutionResource(nativeGemini);
  assert.throws(
    () => validateExecutionResource({ ...nativeGemini, resourceTier: 'FREE' }),
    (error: unknown) =>
      error instanceof V4Error && error.code === 'RESOURCE_TIER_DERIVATION_INVALID',
  );
});

test('selector uses tier, model rank, sequence and hard filters deterministically', () => {
  const candidates = [
    resource({
      resourceId: 'free-deepseek',
      resourceTier: 'FREE',
      resourceSequence: 1,
      bindings: [binding('deepseek-free', 'deepseek-v4-flash')],
    }),
    resource({
      resourceId: 'promo-luna',
      resourceTier: 'PROMOTIONAL',
      resourceSequence: 9,
      bindings: [
        binding('luna-promo', 'gpt-5.6-luna', {
          routeModel: 'resource--promo-luna--gpt-5-6-luna',
          protocol: 'openai-responses',
        }),
      ],
    }),
    resource({
      resourceId: 'free-glm',
      resourceTier: 'FREE',
      resourceSequence: 2,
      bindings: [binding('glm-free', 'glm-current')],
    }),
    resource({
      resourceId: 'disabled-deepseek',
      resourceTier: 'PROMOTIONAL',
      resourceSequence: 0 + 3,
      state: 'DISABLED',
      bindings: [binding('deepseek-disabled', 'deepseek-v4-flash')],
    }),
    resource({
      resourceId: 'unready-deepseek',
      resourceTier: 'PROMOTIONAL',
      resourceSequence: 4,
      bindings: [binding('deepseek-unready', 'deepseek-v4-flash', { ready: false })],
    }),
  ];
  const selected = selectExecutableProfile(candidates, { phase: 'IMPLEMENT' });
  assert.equal(selected.status, 'SELECTED');
  if (selected.status === 'SELECTED')
    assert.deepEqual(selected.profile, {
      capability: 'IMPLEMENTATION',
      phase: 'IMPLEMENT',
      modelFamily: 'gpt-5.6-luna',
      agentBackend: 'codex-acp',
      transport: 'LITELLM_MANAGED',
      resourceId: 'promo-luna',
      resourceTier: 'PROMOTIONAL',
      modelRank: 30,
      resourceSequence: 9,
      resourceState: 'ACTIVE',
      selectionReason: 'STATIC_POLICY',
      bindingId: 'luna-promo',
      routeModel: 'resource--promo-luna--gpt-5-6-luna',
      protocol: 'openai-responses',
    });

  const sameTier = selectExecutableProfile(
    [
      candidates[2]!,
      candidates[0]!,
      resource({
        resourceId: 'free-luna',
        resourceTier: 'FREE',
        resourceSequence: 3,
        bindings: [binding('luna-free', 'gpt-5.6-luna')],
      }),
    ],
    { phase: 'IMPLEMENT' },
  );
  assert.equal(sameTier.status, 'SELECTED');
  if (sameTier.status === 'SELECTED')
    assert.equal(sameTier.profile.modelFamily, 'deepseek-v4-flash');

  const sticky = selectExecutableProfile(
    [
      resource({
        resourceId: 'later',
        resourceTier: 'FREE',
        resourceSequence: 20,
        bindings: [binding('later-b', 'deepseek-v4-flash')],
      }),
      resource({
        resourceId: 'earlier',
        resourceTier: 'FREE',
        resourceSequence: 10,
        bindings: [binding('earlier-b', 'deepseek-v4-flash')],
      }),
    ],
    { phase: 'IMPLEMENT' },
  );
  assert.equal(sticky.status, 'SELECTED');
  if (sticky.status === 'SELECTED') assert.equal(sticky.profile.resourceId, 'earlier');

  const retry = selectExecutableProfile(candidates, {
    phase: 'IMPLEMENT',
    priorAttempts: [{ resourceId: 'promo-luna', bindingId: 'luna-promo' }],
  });
  assert.equal(retry.status, 'SELECTED');
  if (retry.status === 'SELECTED') assert.equal(retry.profile.resourceId, 'free-deepseek');
  assert.equal(
    selectExecutableProfile(candidates, {
      phase: 'IMPLEMENT',
      excludedResourceIds: candidates.map(({ resourceId }) => resourceId),
    }).status,
    'WAITING_FOR_RESOURCE',
  );
  assert.equal(
    selectExecutableProfile(candidates, { phase: 'FINALIZE' }).status,
    'WAITING_FOR_RESOURCE',
  );
});

test('selector hard-gates executable profiles on runtime admission readiness', () => {
  const resources = [
    resource({
      resourceId: 'cheap-deepseek',
      resourceTier: 'FREE',
      resourceSequence: 1,
      bindings: [binding('cheap-deepseek-binding', 'deepseek-v4-flash')],
    }),
    resource({
      resourceId: 'later-glm',
      resourceTier: 'FREE',
      resourceSequence: 2,
      bindings: [binding('later-glm-binding', 'glm-current')],
    }),
  ];
  const readiness = {
    isReady(
      candidate: import('../src/v4/orchestration/resourceSelector.js').ResourceSelectionCandidate,
    ) {
      return candidate.profile.agentBackend === 'zcode-acp';
    },
  };
  const selected = selectExecutableProfile(
    resources,
    { phase: 'IMPLEMENT' },
    DEFAULT_AFFINITY_POLICY,
    readiness,
  );
  assert.equal(selected.status, 'SELECTED');
  if (selected.status === 'SELECTED') {
    assert.equal(selected.profile.resourceId, 'later-glm');
    assert.equal(selected.profile.agentBackend, 'zcode-acp');
  }

  const blocked = new ResourceSelector(resources, DEFAULT_AFFINITY_POLICY, {
    isReady: () => false,
  }).select({ phase: 'IMPLEMENT' });
  assert.deepEqual(blocked, {
    status: 'WAITING_FOR_RESOURCE',
    capability: 'IMPLEMENTATION',
    reason: 'NO_ELIGIBLE_RESOURCE',
  });
});

test('selector admits provider-native Business normally and Gemini only with explicit trust policy', () => {
  const business = resource({
    resourceId: 'business',
    resourceTier: 'SUBSCRIPTION',
    resourceSequence: 120,
    bindings: [
      binding('business-sol', 'gpt-5.6-sol', {
        transport: 'PROVIDER_NATIVE',
        agentBackend: 'codex-business-headless',
      }),
    ],
  });
  const antigravity = resource({
    resourceId: 'antigravity',
    resourceTier: 'SUBSCRIPTION',
    resourceSequence: 121,
    bindings: [
      binding('agy-38', 'gemini-3.8-flash-high', {
        transport: 'PROVIDER_NATIVE',
        agentBackend: 'antigravity-worker',
        requiresPolicy: 'provider-native-trusted-input',
      }),
    ],
  });
  const reasoning = new ResourceSelector([business, antigravity]).select({ phase: 'REVIEW' });
  assert.equal(reasoning.status, 'SELECTED');
  if (reasoning.status === 'SELECTED')
    assert.equal(reasoning.profile.agentBackend, 'codex-business-headless');
  const withoutTrust = new ResourceSelector([antigravity]).select({
    phase: 'IMPLEMENT',
    includeProviderNativeProfiles: true,
  });
  assert.equal(withoutTrust.status, 'WAITING_FOR_RESOURCE');
  const withTrust = new ResourceSelector([antigravity]).select({
    phase: 'IMPLEMENT',
    includeProviderNativeProfiles: true,
    policy: { allowedPolicyKeys: ['provider-native-trusted-input'] },
  });
  assert.equal(withTrust.status, 'SELECTED');
  if (withTrust.status === 'SELECTED')
    assert.equal(withTrust.profile.modelFamily, 'gemini-3.8-flash-high');
  const antigravityReview = new ResourceSelector([
    resource({
      resourceId: 'antigravity-review',
      resourceTier: 'SUBSCRIPTION',
      resourceSequence: 121,
      bindings: [
        binding('agy-pro', 'gemini-3.1-pro-high', {
          transport: 'PROVIDER_NATIVE',
          agentBackend: 'antigravity-review',
          requiresPolicy: 'provider-native-trusted-input',
        }),
      ],
    }),
  ]).select({
    phase: 'REVIEW',
    includeProviderNativeProfiles: true,
    policy: { allowedPolicyKeys: ['provider-native-trusted-input'] },
  });
  assert.equal(antigravityReview.status, 'SELECTED');
  if (antigravityReview.status === 'SELECTED')
    assert.equal(antigravityReview.profile.modelFamily, 'gemini-3.1-pro-high');
});

test('selection is validated and runtime immutable', () => {
  const profile: ExecutableProfile = {
    capability: 'IMPLEMENTATION',
    phase: 'IMPLEMENT',
    modelFamily: 'gpt-5.6-luna',
    agentBackend: 'codex-acp',
    transport: 'LITELLM_MANAGED',
    resourceId: 'resource',
    resourceTier: 'METERED',
    modelRank: 30,
    resourceSequence: 42,
    resourceState: 'ACTIVE',
    selectionReason: 'STATIC_POLICY',
  };
  const result = selectExecutableProfile(
    [
      resource({
        resourceId: 'resource',
        resourceTier: 'METERED',
        resourceSequence: 42,
        bindings: [binding('luna', 'gpt-5.6-luna')],
      }),
    ],
    { phase: 'IMPLEMENT', executionId: 'execution', selectedAt: NOW },
  );
  assert.equal(result.status, 'SELECTED');
  if (result.status !== 'SELECTED' || !result.selection) throw new Error('selection missing');
  validateExecutionResourceSelection(result.selection);
  assert.equal(Object.isFrozen(result.selection), true);
  assert.throws(
    () => ((result.selection as unknown as Record<string, unknown>).resourceId = 'changed'),
    TypeError,
  );
  assert.deepEqual({ ...profile, bindingId: 'luna' }, { ...result.profile });
});

function lifecycle(overrides: Partial<ResourceStatePolicyInput> = {}): ResourceStatePolicyInput {
  return {
    state: 'ACTIVE',
    resourceTier: 'FREE',
    commercialType: 'FREE',
    supplyOrigin: 'COMMUNITY_RELAY',
    resourceLifecycle: 'RECURRING',
    ...overrides,
  };
}

test('fault classification and pure resource state policy follow the V4 lifecycle rules', () => {
  assert.equal(
    normalizeResourceFailure({ status: 429, message: 'monthly usage limit reached' }).failureClass,
    'QUOTA_EXHAUSTED',
  );
  assert.equal(
    normalizeResourceFailure({
      status: 403,
      message: 'Unable to reserve quota. Remaining balance: $0.003; required amount: $0.11',
    }).failureClass,
    'QUOTA_EXHAUSTED',
  );
  assert.equal(
    normalizeResourceFailure({ status: 403, message: '预扣费额度失败, 用户剩余额度不足' })
      .failureClass,
    'QUOTA_EXHAUSTED',
  );
  assert.equal(
    normalizeResourceFailure({ status: 400, message: 'unknown provider for model review' })
      .failureClass,
    'ROUTE_MISCONFIGURED',
  );
  assert.equal(
    normalizeResourceFailure({
      status: 403,
      message: 'litellm.PermissionDeniedError: key not allowed to access model route-x',
    }).failureClass,
    'POLICY_DISALLOWED',
  );
  assert.equal(
    normalizeResourceFailure({ status: 403, message: 'Model is blocked' }).failureClass,
    'POLICY_DISALLOWED',
  );
  assert.equal(
    normalizeResourceFailure({ status: 400, message: 'unknown provider for model review' }).scope,
    'BINDING',
  );
  assert.equal(
    normalizeResourceFailure({ status: 429, message: 'too many requests' }).failureClass,
    'RATE_LIMITED',
  );
  assert.equal(
    normalizeResourceFailure({ status: 401, message: 'invalid api key sk-do-not-persist' })
      .failureClass,
    'AUTH_REJECTED',
  );
  assert.equal(
    normalizeResourceFailure({ status: 404, message: 'model not found' }).scope,
    'BINDING',
  );
  assert.equal(
    normalizeResourceFailure(new Error('connect ETIMEDOUT')).failureClass,
    'CONNECTION_UNAVAILABLE',
  );
  assert.equal(
    normalizeResourceFailure({ status: 502, message: 'bad gateway' }).failureClass,
    'TEMPORARY_PROVIDER_FAILURE',
  );
  assert.equal(normalizeResourceFailure('promotion expired').failureClass, 'PROMOTION_EXPIRED');
  const auth = transitionResourceState(lifecycle(), normalizeResourceFailure({ status: 401 }), NOW);
  assert.deepEqual(auth, {
    state: 'DISABLED',
    probeRequired: false,
    reasonClass: 'AUTH_REJECTED',
    sanitizedReason: 'AUTH_REJECTED (HTTP 401)',
  });
  const exhausted = transitionResourceState(
    lifecycle({
      resourceTier: 'SUBSCRIPTION',
      commercialType: 'SUBSCRIPTION',
      supplyOrigin: 'OFFICIAL',
    }),
    normalizeResourceFailure({ message: 'quota exhausted' }),
    NOW,
  );
  assert.equal(exhausted.state, 'DISABLED');
  const suspended = transitionResourceState(
    lifecycle(),
    normalizeResourceFailure({ status: 429 }),
    NOW,
  );
  assert.equal(suspended.state, 'SUSPENDED');
  assert.equal(Date.parse(suspended.suspendedUntil!) - Date.parse(NOW), COMMUNITY_SUSPENSION_MS);
  assert.equal(suspended.probeRequired, true);
  const failedProbe = transitionResourceState(
    lifecycle({ state: 'SUSPENDED', suspendedUntil: suspended.suspendedUntil, probe: true }),
    normalizeResourceFailure({ status: 503 }),
    suspended.suspendedUntil!,
  );
  assert.equal(failedProbe.state, 'DISABLED');
  const paid = transitionResourceState(
    lifecycle({
      resourceTier: 'METERED',
      commercialType: 'METERED',
      supplyOrigin: 'COMMERCIAL_RELAY',
    }),
    normalizeResourceFailure({ status: 503 }),
    NOW,
  );
  assert.equal(Date.parse(paid.suspendedUntil!) - Date.parse(NOW), PAID_TRANSIENT_COOLDOWN_MS);
  assert.deepEqual(
    transitionResourceStateOnSuccess(
      lifecycle({ state: 'SUSPENDED', suspendedUntil: paid.suspendedUntil }),
    ),
    { state: 'ACTIVE', probeRequired: false },
  );
  assert.equal(
    transitionResourceState(
      lifecycle(),
      normalizeResourceFailure({ status: 404, message: 'model unsupported' }),
      NOW,
    ).bindingState,
    'DISABLED',
  );
  assert.equal(capabilityForPhase('PLAN'), 'REASONING');
  assert.equal(capabilityForPhase('FINALIZE'), undefined);
});

function databaseFile(prefix: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'pixel-v4.sqlite');
}

function seedExecution(db: DatabaseSync): string {
  const repositories = createRepositories(db);
  const plan = repositories.plans.createPlan({
    idempotencyKey: 'routing-plan',
    projectKey: 'routing',
    objective: 'routing',
    repositoryPath: '/repo',
    baseRevision: 'base',
  }).value!;
  return repositories.executions.create({
    idempotencyKey: 'routing-execution',
    identity: {
      executionId: 'routing-execution',
      planId: plan.planId,
      phase: 'IMPLEMENT',
      attempt: 1,
      route: 'legacy-route',
      sourceRevision: 'base',
    },
    objective: 'routing',
  }).value!.identity.executionId;
}

test('selection and state repositories enforce immutability, CAS, event safety, and restart durability', () => {
  const file = databaseFile('pixel-v4-routing-repository-');
  let db = openV4Database(file, { environment: 'test', env: { NODE_ENV: 'test' } });
  const repositories = createRepositories(db);
  const executionId = seedExecution(db);
  const selected = selectExecutableProfile(
    [
      resource({
        resourceId: 'resource',
        resourceTier: 'FREE',
        resourceSequence: 7,
        bindings: [
          binding('deepseek', 'deepseek-v4-flash', {
            routeModel: 'resource--resource--deepseek-v4-flash',
            protocol: 'openai-chat-completions',
          }),
        ],
      }),
    ],
    { phase: 'IMPLEMENT', executionId, selectedAt: NOW },
  );
  assert.equal(selected.status, 'SELECTED');
  if (selected.status !== 'SELECTED' || !selected.selection) throw new Error('selection missing');
  assert.equal(repositories.resourceSelections.create(selected.selection).status, 'created');
  assert.equal(repositories.resourceSelections.create(selected.selection).status, 'existing');
  assert.throws(
    () =>
      repositories.resourceSelections.create({
        ...selected.selection,
        modelFamily: 'gpt-5.6-luna',
      } as ExecutionResourceSelection),
    (error: unknown) =>
      error instanceof V4Error && error.code === 'EXECUTION_RESOURCE_SELECTION_IMMUTABLE',
  );
  const firstState = repositories.resourceStateOverrides.create({
    resourceId: 'resource',
    state: 'SUSPENDED',
    suspendedUntil: '2026-09-04T00:00:00.000Z',
    reasonClass: 'RATE_LIMITED',
    sanitizedReason: 'RATE_LIMITED (HTTP 429)',
    source: 'EXECUTION',
  });
  assert.equal(firstState.status, 'created');
  assert.equal(firstState.value?.version, 1);
  const stale = repositories.resourceStateOverrides.compareAndSet('resource', 0, {
    resourceId: 'resource',
    state: 'ACTIVE',
    source: 'OPERATOR',
  });
  assert.equal(stale.status, 'rejected');
  const updated = repositories.resourceStateOverrides.compareAndSet('resource', 1, {
    resourceId: 'resource',
    state: 'ACTIVE',
    source: 'OPERATOR',
  });
  assert.equal(updated.status, 'updated');
  assert.equal(updated.value?.version, 2);
  assert.equal(
    db.prepare('SELECT count(*) AS count FROM events WHERE aggregate_id=?').get('routing-execution')
      ?.count,
    2,
  );
  assert.equal(
    db.prepare('SELECT count(*) AS count FROM events WHERE aggregate_id=?').get('resource')?.count,
    2,
  );
  db.close();

  db = openV4Database(file, { environment: 'test', env: { NODE_ENV: 'test' } });
  const restarted = createRepositories(db);
  assert.equal(
    db.prepare("SELECT schema_version FROM schema_meta WHERE schema_id='pixel-v4'").get()
      ?.schema_version,
    SCHEMA_VERSION,
  );
  const restoredSelection = restarted.resourceSelections.require(executionId);
  assert.equal(restoredSelection.modelFamily, 'deepseek-v4-flash');
  assert.equal(restoredSelection.resourceState, 'ACTIVE');
  assert.equal(restoredSelection.selectionReason, 'STATIC_POLICY');
  assert.equal(restoredSelection.routeModel, 'resource--resource--deepseek-v4-flash');
  assert.equal(restoredSelection.protocol, 'openai-chat-completions');
  assert.equal(restarted.resourceStateOverrides.get('resource')?.version, 2);
  db.close();
});

test('v5 databases migrate additively to v6 and malformed routing tables fail closed', () => {
  const file = databaseFile('pixel-v4-routing-migration-');
  let db = openV4Database(file, { environment: 'test', env: { NODE_ENV: 'test' } });
  const executionId = seedExecution(db);
  const planCount = db.prepare('SELECT count(*) AS count FROM plans').get()?.count;
  db.exec(
    "DROP TABLE execution_resource_selections; DROP TABLE resource_state_overrides; UPDATE schema_meta SET schema_version=5 WHERE schema_id='pixel-v4';",
  );
  db.close();
  db = openV4Database(file, { environment: 'test', env: { NODE_ENV: 'test' } });
  assert.equal(
    db.prepare("SELECT schema_version FROM schema_meta WHERE schema_id='pixel-v4'").get()
      ?.schema_version,
    6,
  );
  assert.equal(db.prepare('SELECT count(*) AS count FROM plans').get()?.count, planCount);
  assert.ok(
    db
      .prepare('SELECT execution_id FROM execution_resource_selections WHERE execution_id=?')
      .get(executionId) === undefined,
  );
  db.close();

  const malformed = databaseFile('pixel-v4-routing-malformed-');
  db = openV4Database(malformed, { environment: 'test', env: { NODE_ENV: 'test' } });
  db.exec(
    "DROP TABLE execution_resource_selections; CREATE TABLE execution_resource_selections (execution_id TEXT PRIMARY KEY); UPDATE schema_meta SET schema_version=5 WHERE schema_id='pixel-v4';",
  );
  db.close();
  assert.throws(
    () => openV4Database(malformed, { environment: 'test', env: { NODE_ENV: 'test' } }),
    (error: unknown) => error instanceof V4Error && error.code === 'V4_SCHEMA_INCOMPLETE',
  );
  const raw = new DatabaseSync(malformed, { readOnly: true });
  assert.equal(
    raw.prepare("SELECT schema_version FROM schema_meta WHERE schema_id='pixel-v4'").get()
      ?.schema_version,
    5,
  );
  raw.close();
});
