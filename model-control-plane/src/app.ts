import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';

import {
  AntigravityExecutionProvider,
  AntigravityReviewProvider,
} from './v4/adapters/antigravity.js';
import { LocalGitWorkspaceAdapter } from './v4/adapters/gitWorkspace.js';
import { LiteralWorktreeWorkspaceAdapter } from './v4/adapters/literalWorktreeWorkspace.js';
import { PlanWorktreeManager } from './v4/adapters/planWorktrees.js';
import { ProjectScopedWorkspaceAdapter } from './v4/adapters/projectScopedWorkspace.js';
import { LiteLlmExecutionTelemetry } from './v4/adapters/liteLlmTelemetry.js';
import { GitHubCliDeliveryAdapter } from './v4/adapters/githubDelivery.js';
import {
  createOpenHandsProviderFactory,
  OpenHandsCodexBusinessReviewProvider,
  OpenHandsCodexManagedExecutionProvider,
  OpenHandsExecutionProvider,
  OpenHandsReviewProvider,
  type OpenHandsAgentBackend,
} from './v4/adapters/openHandsCoding.js';
import {
  HttpOpenHandsSupervisorClient,
  OpenHandsSupervisorAdapter,
} from './v4/adapters/openhands.js';
import {
  CompositeResourceDirectory,
  LiteLlmResourceDirectory,
  LiteLlmResourceStateEffect,
  ResourceLifecycleManager,
  ResourceStateService,
  StaticResourceDirectory,
  providerNativeResources,
  type ResourceProbePort,
} from './v4/adapters/resourceDirectory.js';
import type { PlanDeliveryConfig } from './v4/domain/delivery.js';
import { V4Error } from './v4/domain/errors.js';
import { EXECUTION_STATUSES, type ExecutionStatus } from './v4/domain/execution.js';
import { PLAN_STATUSES, type PlanStatus } from './v4/domain/plan.js';
import {
  DEFAULT_AFFINITY_POLICY,
  createExecutionResourceSelection,
  type ExecutionResource,
  type ExecutionResourceSelection,
  type ResourceState,
} from './v4/domain/resourceRouting.js';
import {
  DeliveryKernel,
  ExecutionKernel,
  PlanKernel,
  RecoveryKernel,
  ReviewKernel,
  WorkGraphKernel,
} from './v4/kernel/index.js';
import { ExecutionWorker, type ExecutionWorkerRoute } from './v4/orchestration/executionWorker.js';
import { ProjectPlanQueueRuntime } from './v4/orchestration/projectPlanQueueRuntime.js';
import type { ExecutionProviderPort, WorkspaceProviderPort } from './v4/orchestration/contracts.js';
import {
  ResourceSelector,
  selectExecutableProfile,
  type ResourceSelectionCandidate,
} from './v4/orchestration/resourceSelector.js';
import {
  RuntimeAdmissionRegistry,
  requiresAcpRuntimeAdmission,
  runtimeAdmissionKey,
} from './v4/orchestration/runtimeAdmission.js';
import {
  PlanAutomationRuntime,
  StaticPlanAutomationPolicyResolver,
  type PlanAutomationPolicy,
} from './v4/orchestration/planAutomationRuntime.js';
import { bootstrapV4 } from './v4/persistence/bootstrap-v4.js';
import { createRepositories, type V4Repositories } from './v4/persistence/repositories.js';
import { SupervisorActionExecutor, type SupervisorKernelPort } from './v4/supervisor/executor.js';
import { buildBoundedProjection } from './v4/supervisor/projection.js';
import {
  HttpSupervisorDecisionClient,
  OpenAICompatibleSupervisorDecisionClient,
  SupervisorRuntime,
} from './v4/supervisor/runtime.js';
import { SupervisorWakeScheduler } from './v4/supervisor/scheduler.js';

export interface BuildControlPlaneOptions {
  env?: NodeJS.ProcessEnv;
  dbFile?: string;
  logger?: boolean;
  environment?: 'test' | 'development' | 'staging' | 'production';
  allowDataReset?: boolean;
  fetchImpl?: typeof fetch;
}

export interface ExecutionAutomationRuntime {
  workspace: WorkspaceProviderPort;
  planWorktreeManager?: PlanWorktreeManager;
  workspaceUid: number;
  worker: ExecutionWorker;
  plans: PlanAutomationRuntime;
  policy: StaticPlanAutomationPolicyResolver;
  implementationRoutes: string[];
  reviewRoutes: string[];
  automationProjectKeys: string[];
  literalWorktreeProjectKeys: string[];
  requireDelivery: boolean;
  routeModels: Record<string, string>;
  resourceSelectorEnabled: boolean;
  resources: CompositeResourceDirectory;
  liteLlmResources: LiteLlmResourceDirectory;
  resourceSelector: ResourceSelector;
  resourceState: ResourceStateService;
  resourceStateEffect: LiteLlmResourceStateEffect;
  resourceLifecycle: ResourceLifecycleManager;
  runtimeAdmissionEnabled: boolean;
  runtimeAdmission: RuntimeAdmissionRegistry;
  reconcileRuntimeAdmission: () => Promise<void>;
}

export interface ControlPlaneRuntime {
  app: FastifyInstance;
  db: ReturnType<typeof bootstrapV4>['db'];
  dbFile: string;
  host: string;
  port: number;
  repositories: V4Repositories;
  kernels: {
    plan: PlanKernel;
    graph: WorkGraphKernel;
    execution: ExecutionKernel;
    review: ReviewKernel;
    recovery: RecoveryKernel;
    delivery: DeliveryKernel;
  };
  supervisor: {
    actions: SupervisorActionExecutor;
    openHands: OpenHandsSupervisorAdapter;
    scheduler: SupervisorWakeScheduler;
    runtime: SupervisorRuntime;
  };
  automation?: ExecutionAutomationRuntime;
  projectPlanQueue?: ProjectPlanQueueRuntime;
  singleActivePlanEnabled: boolean;
  literalWorktreesEnabled: boolean;
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new V4Error('REQUEST_OBJECT_REQUIRED');
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new V4Error(code);
  return value.trim();
}

function planDeliveryConfig(value: unknown): PlanDeliveryConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const body = bodyRecord(value);
  if (typeof body.autoMerge !== 'boolean') throw new V4Error('DELIVERY_AUTO_MERGE_INVALID');
  const mergeMethod = requiredText(body.mergeMethod ?? 'merge', 'DELIVERY_MERGE_METHOD_INVALID');
  if (mergeMethod !== 'merge' && mergeMethod !== 'squash' && mergeMethod !== 'rebase')
    throw new V4Error('DELIVERY_MERGE_METHOD_INVALID');
  const requiredChecks =
    body.requiredChecks === undefined
      ? []
      : Array.isArray(body.requiredChecks)
        ? body.requiredChecks.map((item) => requiredText(item, 'DELIVERY_REQUIRED_CHECKS_INVALID'))
        : (() => {
            throw new V4Error('DELIVERY_REQUIRED_CHECKS_INVALID');
          })();
  return {
    remote: requiredText(body.remote ?? 'origin', 'DELIVERY_REMOTE_REQUIRED'),
    branch: requiredText(body.branch, 'DELIVERY_BRANCH_REQUIRED'),
    targetBranch: requiredText(body.targetBranch ?? 'main', 'DELIVERY_TARGET_BRANCH_REQUIRED'),
    autoMerge: body.autoMerge,
    mergeMethod,
    requiredChecks,
  };
}

interface RouteSpec {
  route: string;
  model: string;
}

function routeSpecs(value: string | undefined, fallback: string[]): RouteSpec[] {
  const items = (value ? value.split(',') : fallback).map((item) => item.trim()).filter(Boolean);
  const seen = new Set<string>();
  return items.map((item) => {
    const separator = item.indexOf('=');
    const route = (separator < 0 ? item : item.slice(0, separator)).trim();
    const model = (separator < 0 ? item : item.slice(separator + 1)).trim();
    if (!route || !model) throw new V4Error('EXECUTION_ROUTE_SPEC_INVALID');
    if (seen.has(route)) throw new V4Error('EXECUTION_ROUTE_DUPLICATE');
    seen.add(route);
    return { route, model };
  });
}

function rootList(value: string | undefined): string[] {
  return (value ?? '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function commaList(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function integerValue(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  code: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new V4Error(code);
  return parsed;
}

type HostCacheMaintenanceProjection =
  | { status: 'DISABLED' | 'MISSING' | 'INVALID' }
  | {
      status: 'AVAILABLE';
      version: 1;
      checkedAt: string;
      action: string;
      reason: string;
      freeBytesBefore: number;
      freeBytesAfter: number;
      activeExecutions: number;
      triggerFreeBytes: number;
      targetFreeBytes: number;
      steps: string[];
    };

const HOST_CACHE_ACTIONS = new Set([
  'NOOP_CAPACITY_OK',
  'SKIPPED_RELEASE_ACTIVE',
  'SKIPPED_CONTROL_PLANE_UNAVAILABLE',
  'SKIPPED_ACTIVE_EXECUTION',
  'PRUNE_FAILED',
  'PRUNED_TARGET_REACHED',
  'PRUNED_PARTIAL',
  'CAPACITY_STILL_LOW',
]);
const HOST_CACHE_STEPS = new Set([
  'BUILDER_CACHE_OLDER_THAN_POLICY',
  'ALL_UNUSED_BUILDER_CACHE',
  'DANGLING_IMAGES',
  'OLD_UNUSED_IMAGES',
]);

const HOST_CACHE_REASONS = new Set([
  'FREE_SPACE_ABOVE_TRIGGER',
  'RELEASE_LOCK_HELD',
  'ACTIVE_EXECUTION_STATE_UNAVAILABLE',
  'PIXEL_EXECUTION_RUNNING',
  'SAFE_RECLAIM_COMPLETED',
  'ABOVE_TRIGGER_BELOW_TARGET',
  'SAFE_RECLAIM_EXHAUSTED',
  ...HOST_CACHE_STEPS,
]);

function readHostCacheMaintenance(file: string | undefined): HostCacheMaintenanceProjection {
  if (!file) return { status: 'DISABLED' };
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024)
      return { status: 'INVALID' };
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const numeric = [
      'freeBytesBefore',
      'freeBytesAfter',
      'activeExecutions',
      'triggerFreeBytes',
      'targetFreeBytes',
    ] as const;
    if (
      value.version !== 1 ||
      typeof value.checkedAt !== 'string' ||
      value.checkedAt.length > 64 ||
      !Number.isFinite(Date.parse(value.checkedAt)) ||
      typeof value.action !== 'string' ||
      !HOST_CACHE_ACTIONS.has(value.action) ||
      typeof value.reason !== 'string' ||
      !HOST_CACHE_REASONS.has(value.reason) ||
      !Array.isArray(value.steps) ||
      value.steps.some((item) => typeof item !== 'string' || !HOST_CACHE_STEPS.has(item)) ||
      numeric.some(
        (key) =>
          typeof value[key] !== 'number' ||
          !Number.isSafeInteger(value[key]) ||
          (value[key] as number) < 0,
      )
    )
      return { status: 'INVALID' };
    return {
      status: 'AVAILABLE',
      version: 1,
      checkedAt: value.checkedAt,
      action: value.action,
      reason: value.reason,
      freeBytesBefore: value.freeBytesBefore as number,
      freeBytesAfter: value.freeBytesAfter as number,
      activeExecutions: value.activeExecutions as number,
      triggerFreeBytes: value.triggerFreeBytes as number,
      targetFreeBytes: value.targetFreeBytes as number,
      steps: value.steps as string[],
    };
  } catch {
    return fs.existsSync(file) ? { status: 'INVALID' } : { status: 'MISSING' };
  }
}

function statusFor(error: V4Error): number {
  if (error.code.endsWith('_NOT_FOUND')) return 404;
  if (
    error.code.includes('STALE') ||
    error.code.includes('DUPLICATE') ||
    error.code.includes('CONFLICT') ||
    error.code.includes('ACTIVE')
  )
    return 409;
  if (error.code.includes('UNAVAILABLE') || error.code.includes('DISABLED')) return 503;
  return 400;
}

async function buildExecutionAutomation(
  env: NodeJS.ProcessEnv,
  repositories: V4Repositories,
  fetchImpl: typeof fetch,
): Promise<ExecutionAutomationRuntime | undefined> {
  if (env.MODEL_CP_EXECUTION_RUNTIME_ENABLED !== 'true') return undefined;
  const openHandsUrl = requiredText(env.MODEL_CP_OPENHANDS_URL, 'OPENHANDS_BASE_URL_REQUIRED');
  const sessionApiKey = requiredText(env.SESSION_API_KEY, 'OPENHANDS_SESSION_KEY_REQUIRED');
  const liteLlmApiKey = requiredText(env.LITELLM_V3_KEY, 'OPENHANDS_LITELLM_KEY_REQUIRED');
  const liteLlmBaseUrl = requiredText(
    env.LITELLM_V3_BASE_URL ?? env.MODEL_CP_V3_LITELLM_URL,
    'OPENHANDS_LITELLM_URL_REQUIRED',
  );
  const allowedRepositoryRoots = rootList(env.MODEL_CP_V4_ALLOWED_REPOSITORY_ROOTS);
  if (allowedRepositoryRoots.length === 0) throw new V4Error('WORKSPACE_ALLOWED_ROOT_REQUIRED');
  const managedHostRoot = requiredText(
    env.MODEL_CP_V4_WORKSPACE_HOST_ROOT,
    'WORKSPACE_MANAGED_ROOT_REQUIRED',
  );
  const executionRoot = requiredText(
    env.MODEL_CP_V4_WORKSPACE_EXECUTION_ROOT ?? '/workspace',
    'WORKSPACE_EXECUTION_ROOT_REQUIRED',
  );
  const automationProjectKeys = commaList(env.MODEL_CP_V4_AUTOMATION_PROJECTS);
  const literalWorktreesEnabled = env.MODEL_CP_V4_LITERAL_WORKTREES_ENABLED === 'true';
  const literalWorktreeProjectKeys = literalWorktreesEnabled
    ? commaList(env.MODEL_CP_V4_LITERAL_WORKTREE_PROJECTS)
    : [];
  if (literalWorktreesEnabled && literalWorktreeProjectKeys.length === 0)
    throw new V4Error('LITERAL_WORKTREE_PROJECTS_REQUIRED');
  if (
    automationProjectKeys.length > 0 &&
    literalWorktreeProjectKeys.some((projectKey) => !automationProjectKeys.includes(projectKey))
  )
    throw new V4Error('LITERAL_WORKTREE_PROJECT_NOT_AUTOMATED');
  // Resource-selected executions bypass this map and resolve their provider from
  // the immutable ExecutionResourceSelection. Keep only same-family emergency
  // compatibility routes for selector-disabled recovery; task aliases and
  // cross-model GLM fallbacks belong to the durable ResourceSelector instead.
  const implementationSpecs = routeSpecs(env.MODEL_CP_V4_IMPLEMENTATION_ROUTES, ['gpt-5.6-luna']);
  const reviewSpecs = routeSpecs(env.MODEL_CP_V4_REVIEW_ROUTES, [
    'codex-business-review=gpt-5.6-sol',
    'gpt-5.6-sol',
  ]);
  const implementationRoutes = implementationSpecs.map((item) => item.route);
  const reviewRoutes = reviewSpecs.map((item) => item.route);
  if (implementationRoutes.some((route) => reviewRoutes.includes(route)))
    throw new V4Error('EXECUTION_ROUTE_ROLE_CONFLICT');

  const common = {
    baseUrl: openHandsUrl,
    sessionApiKey,
    liteLlmApiKey,
    liteLlmBaseUrl,
    fetchImpl,
    requestTimeoutMs: integerValue(
      env.MODEL_CP_V4_PROVIDER_REQUEST_TIMEOUT_MS,
      30_000,
      1_000,
      120_000,
      'OPENHANDS_TIMEOUT_INVALID',
    ),
    llmTimeoutSeconds: integerValue(
      env.MODEL_CP_V4_PROVIDER_LLM_TIMEOUT_SECONDS,
      600,
      30,
      1_800,
      'OPENHANDS_LLM_TIMEOUT_INVALID',
    ),
    maxIterations: integerValue(
      env.MODEL_CP_V4_PROVIDER_MAX_ITERATIONS,
      500,
      1,
      1_000,
      'OPENHANDS_ITERATION_LIMIT_INVALID',
    ),
  };
  const resourceSelectorEnabled = env.MODEL_CP_V4_RESOURCE_SELECTOR_ENABLED === 'true';
  const liteLlmAdminBaseUrl = (
    env.MODEL_CP_V4_LITELLM_ADMIN_BASE_URL ??
    env.MODEL_CP_V3_LITELLM_URL ??
    liteLlmBaseUrl
  )
    .replace(/\/$/, '')
    .replace(/\/v1$/, '');
  const liteLlmResources = new LiteLlmResourceDirectory({
    baseUrl: liteLlmAdminBaseUrl,
    envFile: env.MODEL_CP_LITELLM_ADMIN_ENV_FILE ?? '/srv/hermes-personal/secrets/litellm.env',
    keyName: env.MODEL_CP_LITELLM_ADMIN_KEY_NAME ?? 'LITELLM_MASTER_KEY',
    fetchImpl,
    requestTimeoutMs: integerValue(
      env.MODEL_CP_V4_RESOURCE_DIRECTORY_TIMEOUT_MS,
      10_000,
      1_000,
      60_000,
      'RESOURCE_DIRECTORY_TIMEOUT_INVALID',
    ),
  });
  if (resourceSelectorEnabled) await liteLlmResources.refresh();

  const businessAuthFile =
    env.MODEL_CP_V4_BUSINESS_AUTH_FILE ??
    '/opt/data/hermes-ai-office-v3/openhands/codex-business/auth.json';
  const businessEnabled = env.MODEL_CP_V4_BUSINESS_RESOURCE_ENABLED !== 'false';
  const businessReady = businessEnabled && fs.existsSync(businessAuthFile);
  const antigravityBinary =
    env.MODEL_CP_V4_ANTIGRAVITY_BIN ??
    env.MODEL_CP_V3_ANTIGRAVITY_BIN ??
    '/home/dev/.local/bin/agy';
  const antigravityHome =
    env.MODEL_CP_V4_ANTIGRAVITY_HOME ?? env.MODEL_CP_V3_ANTIGRAVITY_HOME ?? '/home/dev';
  const antigravityAuthFile = path.join(
    antigravityHome,
    '.gemini/antigravity-cli/antigravity-oauth-token',
  );
  const antigravityEnabled = env.MODEL_CP_V4_ANTIGRAVITY_RESOURCE_ENABLED === 'true';
  const antigravityReady =
    antigravityEnabled && fs.existsSync(antigravityBinary) && fs.existsSync(antigravityAuthFile);
  const nativeResources = new StaticResourceDirectory(
    providerNativeResources({
      businessEnabled,
      businessReady,
      antigravityEnabled,
      antigravityReady,
    }),
  );
  const sourceResources = new CompositeResourceDirectory([liteLlmResources, nativeResources]);
  const resources = new CompositeResourceDirectory(
    [liteLlmResources, nativeResources],
    repositories.resourceStateOverrides,
  );
  const runtimeAdmissionEnabled =
    resourceSelectorEnabled &&
    (env.MODEL_CP_V4_RUNTIME_ADMISSION_ENABLED === 'true' ||
      (env.MODEL_CP_V4_RUNTIME_ADMISSION_ENABLED !== 'false' && env.NODE_ENV !== 'test'));
  const runtimeAdmissionTtlMs = integerValue(
    env.MODEL_CP_V4_RUNTIME_ADMISSION_TTL_MS,
    15 * 60_000,
    60_000,
    24 * 60 * 60_000,
    'RUNTIME_ADMISSION_TTL_INVALID',
  );
  const runtimeAdmissionTransientFailureTtlMs = integerValue(
    env.MODEL_CP_V4_RUNTIME_ADMISSION_TRANSIENT_FAILURE_TTL_MS,
    15_000,
    1_000,
    runtimeAdmissionTtlMs,
    'RUNTIME_ADMISSION_TRANSIENT_FAILURE_TTL_INVALID',
  );
  const runtimeAdmission = new RuntimeAdmissionRegistry();
  const resourceStateEffect = new LiteLlmResourceStateEffect({
    baseUrl: liteLlmAdminBaseUrl,
    envFile: env.MODEL_CP_LITELLM_ADMIN_ENV_FILE ?? '/srv/hermes-personal/secrets/litellm.env',
    keyName: env.MODEL_CP_LITELLM_ADMIN_KEY_NAME ?? 'LITELLM_MASTER_KEY',
    fetchImpl,
    requestTimeoutMs: integerValue(
      env.MODEL_CP_V4_RESOURCE_DIRECTORY_TIMEOUT_MS,
      10_000,
      1_000,
      60_000,
      'RESOURCE_DIRECTORY_TIMEOUT_INVALID',
    ),
  });
  const resourceState = new ResourceStateService(
    resources,
    repositories.resourceStateOverrides,
    3,
    resourceStateEffect,
  );
  const resourceProbe: ResourceProbePort = {
    probe: async (resource: ExecutionResource): Promise<boolean> => {
      if (resource.resourceId === 'chatgpt-business-primary') return businessReady;
      if (resource.resourceId === 'antigravity-primary') return antigravityReady;
      const binding = resource.bindings.find(
        (item) => item.enabled && item.routeModel && item.ready,
      );
      if (!binding?.routeModel) return false;
      try {
        const response = await fetchImpl(liteLlmBaseUrl.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST',
          headers: {
            ['Author' + 'ization']: 'Bearer ' + liteLlmApiKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: binding.routeModel,
            messages: [{ role: 'user', content: 'Reply with OK.' }],
            max_tokens: 1,
            user: 'pixel-v4-resource-probe',
          }),
          signal: AbortSignal.timeout(30_000),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
  const resourceLifecycle = new ResourceLifecycleManager(
    sourceResources,
    repositories.resourceStateOverrides,
    resourceProbe,
    resourceStateEffect,
  );
  const routes: ExecutionWorkerRoute[] = [
    ...implementationSpecs.map(({ route, model }) => ({
      route,
      provider:
        model === 'gpt-5.6-luna'
          ? new OpenHandsCodexManagedExecutionProvider({ ...common, implementationModel: model })
          : new OpenHandsExecutionProvider({ ...common, implementationModel: model }),
    })),
    ...reviewSpecs.map(({ route, model }) => ({
      route,
      provider:
        route === 'codex-business-review'
          ? new OpenHandsCodexBusinessReviewProvider({ ...common, reviewModel: model })
          : new OpenHandsReviewProvider({ ...common, reviewModel: model }),
    })),
  ];
  const workspaceUid = integerValue(
    env.MODEL_CP_V4_WORKSPACE_UID,
    10_001,
    0,
    2 ** 31 - 1,
    'WORKSPACE_OWNER_INVALID',
  );
  const workspaceGid = integerValue(
    env.MODEL_CP_V4_WORKSPACE_GID,
    10_001,
    0,
    2 ** 31 - 1,
    'WORKSPACE_OWNER_INVALID',
  );
  const gitTimeoutMs = integerValue(
    env.MODEL_CP_V4_GIT_TIMEOUT_MS,
    120_000,
    1_000,
    15 * 60_000,
    'WORKSPACE_GIT_TIMEOUT_INVALID',
  );
  const gitMaxBufferBytes = integerValue(
    env.MODEL_CP_V4_GIT_MAX_BUFFER_BYTES,
    8 * 1024 * 1024,
    64 * 1024,
    64 * 1024 * 1024,
    'WORKSPACE_GIT_BUFFER_INVALID',
  );
  const workspaceMinimumFreeBytes = integerValue(
    env.MODEL_CP_V4_WORKSPACE_MIN_FREE_BYTES,
    8 * 1024 * 1024 * 1024,
    0,
    1024 ** 5,
    'WORKSPACE_CAPACITY_THRESHOLD_INVALID',
  );
  const legacyWorkspace = new LocalGitWorkspaceAdapter({
    allowedRepositoryRoots,
    managedHostRoot,
    executionRoot,
    commandTimeoutMs: gitTimeoutMs,
    maxBufferBytes: gitMaxBufferBytes,
    minimumFreeBytes: workspaceMinimumFreeBytes,
    workspaceUid,
    workspaceGid,
  });
  const planWorktreeManager =
    literalWorktreeProjectKeys.length > 0
      ? new PlanWorktreeManager({
          repositories,
          allowedRepositoryRoots,
          managedHostRoot,
          executionRoot,
          commandTimeoutMs: gitTimeoutMs,
          maxBufferBytes: gitMaxBufferBytes,
          projectAdmission: (repositoryPath) => {
            const harnessctl =
              env.MODEL_CP_AGENT_HARNESS_CTL ??
              '/home/dev/projects/agent-harness/bin/harnessctl.py';
            try {
              execFileSync(
                '/usr/bin/python3',
                [harnessctl, 'plan', repositoryPath, '--profile', 'openhands', '--json'],
                {
                  cwd: repositoryPath,
                  encoding: 'utf8',
                  timeout: gitTimeoutMs,
                  maxBuffer: gitMaxBufferBytes,
                  stdio: ['ignore', 'pipe', 'pipe'],
                },
              );
            } catch (error) {
              throw new V4Error(
                'WORKTREE_AGENT_HARNESS_PROJECT_UNREGISTERED',
                'Literal worktree projects must resolve through Agent Harness before activation.',
                error,
              );
            }
          },
        })
      : undefined;
  const literalWorkspace = planWorktreeManager
    ? new LiteralWorktreeWorkspaceAdapter({
        repositories,
        manager: planWorktreeManager,
        managedHostRoot,
        executionRoot,
        workspaceUid,
        workspaceGid,
        minimumFreeBytes: workspaceMinimumFreeBytes,
        commandTimeoutMs: gitTimeoutMs,
        maxBufferBytes: gitMaxBufferBytes,
      })
    : undefined;
  const workspace: WorkspaceProviderPort = literalWorkspace
    ? new ProjectScopedWorkspaceAdapter({
        repositories,
        legacy: legacyWorkspace,
        literal: literalWorkspace,
        literalProjects: literalWorktreeProjectKeys,
      })
    : legacyWorkspace;
  const openHandsProviderFactory = createOpenHandsProviderFactory(common);
  const antigravityBase = {
    binary: antigravityBinary,
    stateRoot:
      env.MODEL_CP_V4_ANTIGRAVITY_STATE_ROOT ??
      '/srv/hermes-personal/data/model-control-plane/antigravity-v4',
    workspaceHostRoot: managedHostRoot,
    home: antigravityHome,
    uid: integerValue(
      env.MODEL_CP_V4_ANTIGRAVITY_UID ?? env.MODEL_CP_V3_ANTIGRAVITY_UID,
      1001,
      1,
      2 ** 31 - 1,
      'ANTIGRAVITY_UID_INVALID',
    ),
    gid: integerValue(
      env.MODEL_CP_V4_ANTIGRAVITY_GID ?? env.MODEL_CP_V3_ANTIGRAVITY_GID,
      1002,
      1,
      2 ** 31 - 1,
      'ANTIGRAVITY_GID_INVALID',
    ),
    workspaceGid,
    user: env.MODEL_CP_V4_ANTIGRAVITY_USER ?? env.MODEL_CP_V3_ANTIGRAVITY_USER ?? 'dev',
    printTimeout:
      env.MODEL_CP_V4_ANTIGRAVITY_PRINT_TIMEOUT ??
      env.MODEL_CP_V3_ANTIGRAVITY_PRINT_TIMEOUT ??
      '20m',
    sandboxWrapper:
      env.MODEL_CP_V4_ANTIGRAVITY_SANDBOX_WRAPPER ??
      path.join(process.cwd(), 'model-control-plane/scripts/run-antigravity-sandbox.sh'),
    systemdUnitTemplate:
      env.MODEL_CP_V4_ANTIGRAVITY_SYSTEMD_UNIT ?? 'hermes-antigravity-v4@%i.service',
  };
  const providerFactory = (selection: ExecutionResourceSelection): ExecutionProviderPort => {
    if (
      selection.agentBackend === 'antigravity-worker' ||
      selection.agentBackend === 'antigravity-review'
    ) {
      const options = { ...antigravityBase, model: selection.modelFamily };
      return selection.agentBackend === 'antigravity-review'
        ? new AntigravityReviewProvider(options)
        : new AntigravityExecutionProvider(options);
    }
    if (!['IMPLEMENT', 'IMPLEMENT_FIX', 'REVIEW'].includes(selection.phase))
      throw new V4Error('EXECUTION_RESOURCE_SELECTION_PHASE_UNSUPPORTED');
    return openHandsProviderFactory({
      backend: selection.agentBackend as OpenHandsAgentBackend,
      model: selection.routeModel ?? selection.modelFamily,
      transport: selection.transport,
      phase: selection.phase as 'IMPLEMENT' | 'IMPLEMENT_FIX' | 'REVIEW',
      capability: selection.capability,
      resourceId: selection.resourceId,
    });
  };
  const admissionCandidates = (): ResourceSelectionCandidate[] => {
    const selected = new Map<string, ResourceSelectionCandidate>();
    for (const phase of ['IMPLEMENT', 'REVIEW'] as const) {
      const priorAttempts: Array<{ resourceId: string; bindingId?: string; modelFamily?: string }> =
        [];
      for (let index = 0; index < 100; index += 1) {
        const result = selectExecutableProfile(resources, {
          phase,
          includeProviderNativeProfiles: true,
          policy: {
            allowProviderNative: true,
            allowedPolicyKeys: ['provider-native-trusted-input'],
          },
          priorAttempts,
        });
        if (result.status !== 'SELECTED') break;
        selected.set(runtimeAdmissionKey(result.candidate), result.candidate);
        priorAttempts.push({
          resourceId: result.profile.resourceId,
          ...(result.profile.bindingId ? { bindingId: result.profile.bindingId } : {}),
          modelFamily: result.profile.modelFamily,
        });
      }
    }
    return [...selected.values()].filter(requiresAcpRuntimeAdmission);
  };

  const createAdmissionWorkspace = (_candidate: ResourceSelectionCandidate, probeId: string) => {
    const executionsRoot = path.join(managedHostRoot, 'v4', 'executions');
    const root = path.join(executionsRoot, probeId);
    const repository = path.join(root, 'repo');
    fs.mkdirSync(executionsRoot, { recursive: true, mode: 0o755 });
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { mode: 0o750 });
    fs.chownSync(root, workspaceUid, workspaceGid);
    fs.mkdirSync(repository, { mode: 0o750 });
    fs.chownSync(repository, workspaceUid, workspaceGid);
    const git = (args: string[]) =>
      execFileSync('/usr/bin/git', ['-C', repository, ...args], {
        encoding: 'utf8',
        uid: workspaceUid,
        gid: workspaceGid,
        env: { ...process.env, HOME: '/tmp' },
      }).trim();
    git(['init', '-q', '-b', 'main']);
    const readme = path.join(repository, 'README.md');
    fs.writeFileSync(readme, '# Pixel runtime admission probe\n');
    fs.chownSync(readme, workspaceUid, workspaceGid);
    const harnessManifest = path.join(repository, '.agent-harness.json');
    fs.writeFileSync(
      harnessManifest,
      JSON.stringify(
        {
          version: 1,
          id: 'pixel-runtime-admission',
          sharedMcpProfile: 'common',
          packs: [],
          capabilities: [],
        },
        null,
        2,
      ) + '\n',
      { mode: 0o640 },
    );
    fs.chownSync(harnessManifest, workspaceUid, workspaceGid);
    git(['add', 'README.md', '.agent-harness.json']);
    git([
      '-c',
      'user.name=Pixel Runtime Probe',
      '-c',
      'user.email=pixel-runtime-probe@localhost',
      'commit',
      '-q',
      '-m',
      'chore: runtime admission probe',
    ]);
    const sourceRevision = git(['rev-parse', '--verify', 'HEAD^{commit}']);
    const executionPath = path.join(executionRoot, 'v4', 'executions', probeId, 'repo');
    return {
      root,
      sourceRevision,
      workspace: {
        executionId: probeId,
        hostPath: repository,
        executionPath,
        evidenceHostPath: path.join(root, 'completion-evidence.json'),
        evidenceExecutionPath: path.join(
          executionRoot,
          'v4',
          'executions',
          probeId,
          'completion-evidence.json',
        ),
        sourceRepositoryPath: repository,
        sourceRevision,
        createdAt: new Date().toISOString(),
      },
      git,
    };
  };

  const probeAdmissionCandidate = async (candidate: ResourceSelectionCandidate): Promise<void> => {
    const key = runtimeAdmissionKey(candidate);
    const probeId =
      'runtime-admission-' + createHash('sha256').update(key).digest('hex').slice(0, 20);
    let probeRoot: string | undefined;
    try {
      const prepared = createAdmissionWorkspace(candidate, probeId);
      probeRoot = prepared.root;
      const provider = providerFactory(
        createExecutionResourceSelection(probeId, candidate.profile, new Date().toISOString()),
      );
      if (!provider.probeRuntime) throw new V4Error('RUNTIME_ADMISSION_PROBE_UNSUPPORTED');
      const result = await provider.probeRuntime({
        probeId,
        workspace: prepared.workspace,
        sourceRevision: prepared.sourceRevision,
      });
      const clean = prepared.git(['status', '--porcelain=v1']) === '';
      const head = prepared.git(['rev-parse', '--verify', 'HEAD^{commit}']);
      const ready = result.ready && clean && head === prepared.sourceRevision;
      runtimeAdmission.record(candidate, {
        ready,
        ...(!ready
          ? {
              errorCode:
                result.errorCode ??
                (!clean
                  ? 'RUNTIME_PROBE_WORKSPACE_DIRTY'
                  : head !== prepared.sourceRevision
                    ? 'RUNTIME_PROBE_HEAD_DRIFT'
                    : 'RUNTIME_ADMISSION_PROBE_FAILED'),
            }
          : {}),
      });
    } catch (error) {
      runtimeAdmission.record(candidate, {
        ready: false,
        errorCode: error instanceof V4Error ? error.code : 'RUNTIME_ADMISSION_PROBE_FAILED',
      });
    } finally {
      if (probeRoot) fs.rmSync(probeRoot, { recursive: true, force: true });
    }
  };

  let runtimeAdmissionCycle: Promise<void> | undefined;
  const reconcileRuntimeAdmission = async (): Promise<void> => {
    if (!runtimeAdmissionEnabled) return;
    if (runtimeAdmissionCycle) return await runtimeAdmissionCycle;
    runtimeAdmissionCycle = (async () => {
      const now = Date.now();
      const queue = admissionCandidates().filter((candidate) =>
        runtimeAdmission.isStale(
          candidate,
          now,
          runtimeAdmissionTtlMs,
          runtimeAdmissionTransientFailureTtlMs,
        ),
      );
      // Admission is a readiness gate, not a startup dependency or throughput path.
      // Probe serially so provider-native OAuth homes and ACP runtime caches are never
      // mutated concurrently by sibling probes. The selector fails closed until a
      // candidate has a positive admission record.
      for (const candidate of queue) await probeAdmissionCandidate(candidate);
    })();
    try {
      await runtimeAdmissionCycle;
    } finally {
      runtimeAdmissionCycle = undefined;
    }
  };
  const resourceSelector = new ResourceSelector(
    resources,
    DEFAULT_AFFINITY_POLICY,
    runtimeAdmissionEnabled ? runtimeAdmission : undefined,
  );
  const worker = new ExecutionWorker(repositories, workspace, routes, {
    leaseTtlMs: integerValue(
      env.MODEL_CP_V4_EXECUTION_LEASE_TTL_MS,
      30_000,
      1_000,
      5 * 60_000,
      'EXECUTION_LEASE_TTL_INVALID',
    ),
    maxExecutionsPerCycle: integerValue(
      env.MODEL_CP_V4_MAX_EXECUTIONS_PER_CYCLE,
      20,
      1,
      1_000,
      'EXECUTION_CYCLE_LIMIT_INVALID',
    ),
    meaningfulProgressTimeoutMs: integerValue(
      env.MODEL_CP_V4_MEANINGFUL_PROGRESS_TIMEOUT_MS,
      15 * 60_000,
      30_000,
      24 * 60 * 60_000,
      'EXECUTION_MEANINGFUL_PROGRESS_TIMEOUT_INVALID',
    ),
    maxStallRecoveries: integerValue(
      env.MODEL_CP_V4_MAX_STALL_RECOVERIES,
      2,
      0,
      10,
      'EXECUTION_STALL_RECOVERY_LIMIT_INVALID',
    ),
    ...(resourceSelectorEnabled ? { providerFactory, resourceFeedback: resourceState } : {}),
  });
  const maxParallelWorkItems = integerValue(
    env.MODEL_CP_V4_MAX_PARALLEL_WORK_ITEMS,
    1,
    1,
    32,
    'PLAN_AUTOMATION_LIMIT_INVALID',
  );
  const defaultPolicy: PlanAutomationPolicy = {
    implementationRoutes,
    reviewRoutes,
    resourceSelection: {
      includeProviderNativeProfiles: false,
    },
    requireDelivery: env.MODEL_CP_V4_REQUIRE_DELIVERY !== 'false',
    maxImplementationAttempts: integerValue(
      env.MODEL_CP_V4_MAX_IMPLEMENTATION_ATTEMPTS,
      3,
      1,
      20,
      'PLAN_AUTOMATION_LIMIT_INVALID',
    ),
    maxReviewAttempts: integerValue(
      env.MODEL_CP_V4_MAX_REVIEW_ATTEMPTS,
      4,
      1,
      20,
      'PLAN_AUTOMATION_LIMIT_INVALID',
    ),
    maxRepairCycles: integerValue(
      env.MODEL_CP_V4_MAX_REPAIR_CYCLES,
      3,
      1,
      20,
      'PLAN_AUTOMATION_LIMIT_INVALID',
    ),
    maxParallelWorkItems: 1,
  };
  const antigravityProjectKeys = new Set(
    commaList(env.MODEL_CP_V4_ANTIGRAVITY_PROJECTS ?? 'digital-biome'),
  );
  const literalProjectSet = new Set(literalWorktreeProjectKeys);
  const policyOverrides = Object.fromEntries(
    automationProjectKeys
      .filter(
        (projectKey) =>
          literalProjectSet.has(projectKey) ||
          (antigravityEnabled && antigravityProjectKeys.has(projectKey)),
      )
      .map((projectKey) => [
        projectKey,
        {
          ...defaultPolicy,
          maxParallelWorkItems: literalProjectSet.has(projectKey) ? maxParallelWorkItems : 1,
          ...(antigravityEnabled && antigravityProjectKeys.has(projectKey)
            ? {
                resourceSelection: {
                  includeProviderNativeProfiles: true,
                  allowedPolicyKeys: ['provider-native-trusted-input'],
                },
              }
            : {}),
        } satisfies PlanAutomationPolicy,
      ]),
  );
  const policy = new StaticPlanAutomationPolicyResolver(
    defaultPolicy,
    policyOverrides,
    automationProjectKeys.length > 0 ? automationProjectKeys : undefined,
  );
  const delivery = new GitHubCliDeliveryAdapter({
    allowedRepositoryRoots,
    allowedWorkspaceRoots: [managedHostRoot],
    commandTimeoutMs: integerValue(
      env.MODEL_CP_V4_DELIVERY_TIMEOUT_MS,
      120_000,
      1_000,
      15 * 60_000,
      'DELIVERY_TIMEOUT_INVALID',
    ),
    maxBufferBytes: integerValue(
      env.MODEL_CP_V4_DELIVERY_MAX_BUFFER_BYTES,
      8 * 1024 * 1024,
      64 * 1024,
      64 * 1024 * 1024,
      'DELIVERY_BUFFER_INVALID',
    ),
  });
  const plans = new PlanAutomationRuntime(
    repositories,
    worker,
    workspace,
    policy,
    delivery,
    resourceSelectorEnabled ? resourceSelector : undefined,
  );
  return {
    workspace,
    ...(planWorktreeManager ? { planWorktreeManager } : {}),
    workspaceUid,
    worker,
    plans,
    policy,
    implementationRoutes,
    reviewRoutes,
    automationProjectKeys,
    literalWorktreeProjectKeys,
    requireDelivery: defaultPolicy.requireDelivery === true,
    routeModels: Object.fromEntries(
      [...implementationSpecs, ...reviewSpecs].map(({ route, model }) => [route, model]),
    ),
    resourceSelectorEnabled,
    resources,
    liteLlmResources,
    resourceSelector,
    resourceState,
    resourceStateEffect,
    resourceLifecycle,
    runtimeAdmissionEnabled,
    runtimeAdmission,
    reconcileRuntimeAdmission,
  };
}

export async function buildControlPlane(
  options: BuildControlPlaneOptions = {},
): Promise<ControlPlaneRuntime> {
  const env = options.env ?? process.env;
  const boot = bootstrapV4({
    dbFile: options.dbFile,
    env,
    environment: options.environment,
    allowDataReset: options.allowDataReset,
  });
  const db = boot.db;
  const repositories = createRepositories(db);
  const singleActivePlanEnabled = env.MODEL_CP_V4_SINGLE_ACTIVE_PLAN_ENABLED === 'true';
  const literalWorktreesEnabled = env.MODEL_CP_V4_LITERAL_WORKTREES_ENABLED === 'true';
  if (literalWorktreesEnabled && !singleActivePlanEnabled)
    throw new V4Error('LITERAL_WORKTREES_REQUIRE_SINGLE_ACTIVE_PLAN');
  const projectPlanQueue = singleActivePlanEnabled
    ? new ProjectPlanQueueRuntime(repositories)
    : undefined;
  const executionTelemetry = new LiteLlmExecutionTelemetry({
    baseUrl: requiredText(
      env.MODEL_CP_V3_LITELLM_URL ??
        env.LITELLM_V3_BASE_URL ??
        'https://oracle.taile92a8e.ts.net:10446',
      'LITELLM_TELEMETRY_URL_REQUIRED',
    ),
    envFile: env.MODEL_CP_LITELLM_ADMIN_ENV_FILE ?? '/srv/hermes-personal/secrets/litellm.env',
    keyName: env.MODEL_CP_LITELLM_ADMIN_KEY_NAME ?? 'LITELLM_MASTER_KEY',
    fetchImpl: options.fetchImpl ?? fetch,
    requestTimeoutMs: integerValue(
      env.MODEL_CP_LITELLM_TELEMETRY_TIMEOUT_MS,
      10_000,
      1_000,
      60_000,
      'LITELLM_TELEMETRY_TIMEOUT_INVALID',
    ),
  });
  const kernels = {
    plan: new PlanKernel(repositories),
    graph: new WorkGraphKernel(repositories),
    execution: new ExecutionKernel(repositories),
    review: new ReviewKernel(repositories),
    recovery: new RecoveryKernel(repositories),
    delivery: new DeliveryKernel(),
  };
  const automation = await buildExecutionAutomation(env, repositories, options.fetchImpl ?? fetch);
  if (projectPlanQueue) {
    projectPlanQueue.bootstrapExistingRootPlans();
    if (automation?.planWorktreeManager) {
      const literalProjects = new Set(automation.literalWorktreeProjectKeys);
      projectPlanQueue.setLifecycle({
        activate: async (rootPlanId) => {
          const plan = repositories.plans.getPlan(rootPlanId);
          if (literalProjects.has(plan.projectKey))
            await automation.planWorktreeManager!.ensurePlanActivated(rootPlanId);
        },
        retire: async (rootPlanId) => {
          const plan = repositories.plans.getPlan(rootPlanId);
          if (literalProjects.has(plan.projectKey))
            await automation.planWorktreeManager!.retirePlan(rootPlanId, automation.workspaceUid);
        },
      });
      for (const lease of repositories.projectPlans.listLeases()) {
        if (!lease.activeRootPlanId) continue;
        const plan = repositories.plans.getPlan(lease.activeRootPlanId);
        if (literalProjects.has(plan.projectKey))
          await automation.planWorktreeManager.ensurePlanActivated(lease.activeRootPlanId);
      }
    }
  }
  const requireAutomation = (): ExecutionAutomationRuntime => {
    if (!automation) throw new V4Error('EXECUTION_RUNTIME_DISABLED');
    return automation;
  };
  const requireProjectPlanQueue = (): ProjectPlanQueueRuntime => {
    if (!projectPlanQueue) throw new V4Error('PROJECT_PLAN_QUEUE_DISABLED');
    return projectPlanQueue;
  };
  const supervisorKernel: SupervisorKernelPort = {
    createExecution: async (payload, planId) => {
      const runtime = requireAutomation();
      const item = repositories.plans.getWorkItem(payload.workItemId);
      if (item.planId !== planId) throw new V4Error('EXECUTION_WORK_ITEM_MISMATCH');
      const result = await runtime.plans.runPlan(planId);
      if (result.workItemId && result.workItemId !== payload.workItemId)
        throw new V4Error('WORK_ITEM_NOT_RUNNABLE');
      if (!result.executionId) throw new V4Error(result.code);
      return { code: result.code, linkedExecutionId: result.executionId };
    },
    continueExecution: async (payload) => {
      const result = await requireAutomation().worker.continueExecution(payload.executionId);
      if (result.status === 'FAILED' || result.status === 'SKIPPED') throw new V4Error(result.code);
      return { code: 'CONTINUE_' + result.code, linkedExecutionId: payload.executionId };
    },
    retryExecution: async (payload) => {
      const runtime = requireAutomation();
      const execution = repositories.executions.get(payload.executionId);
      const plan = repositories.plans.getPlan(execution.identity.planId);
      const result =
        plan.status === 'FAILED'
          ? await runtime.plans.reconcilePlan(plan.planId, 'auto')
          : await runtime.plans.runPlan(plan.planId);
      if (!result.executionId) throw new V4Error(result.code);
      return { code: result.code, linkedExecutionId: result.executionId };
    },
    requestReview: async (payload) => {
      const execution = repositories.executions.get(payload.executionId);
      if (!execution.resultRevision || execution.status !== 'SUCCEEDED')
        throw new V4Error('REVIEW_EXACT_RESULT_REQUIRED');
      const result = await requireAutomation().plans.runPlan(execution.identity.planId);
      if (!result.executionId) throw new V4Error(result.code);
      return { code: result.code, linkedExecutionId: result.executionId };
    },
    switchRoute: async (payload) => {
      const execution = repositories.executions.get(payload.executionId);
      const result = await requireAutomation().plans.runPlan(execution.identity.planId);
      if (!result.executionId) throw new V4Error(result.code);
      return { code: result.code, linkedExecutionId: result.executionId };
    },
    createRepair: async (payload) => {
      const base = repositories.executions.get(payload.baseExecutionId);
      if (!base.resultRevision || base.status !== 'SUCCEEDED')
        throw new V4Error('REPAIR_EXACT_RESULT_REQUIRED');
      const result = await requireAutomation().plans.runPlan(base.identity.planId);
      if (!result.executionId) throw new V4Error(result.code);
      return { code: result.code, linkedExecutionId: result.executionId };
    },
    replanRemainder: (payload, planId) => {
      const supervisor = repositories.supervisors.getByPlanId(planId);
      kernels.graph.replanRemainder({
        planId,
        reason: payload.reason,
        observationCursor: supervisor?.observationCursor ?? 0,
        items: payload.workItems,
      });
      return { code: 'REPLAN_ACCEPTED', linkedPlanId: planId };
    },
    createChildPlan: (payload, parentPlanId) => {
      const result = kernels.plan.createChildPlan({
        parentPlanId,
        childPlanId: payload.childPlanId,
        repositoryPath: payload.repositoryPath,
        objective: payload.objective,
        relation: payload.relation,
      });
      return { code: 'CHILD_PLAN_CREATED', linkedPlanId: result.plan.planId };
    },
    pauseForResource: (payload, planId) => {
      kernels.recovery.waitForResource(planId, payload.resourceId);
      return { code: 'RESOURCE_GATE_PARKED' };
    },
    parkExternalGate: (_payload, planId) => {
      const plan = repositories.plans.getPlan(planId);
      if (plan.status !== 'WAITING_FOR_EXTERNAL_EVIDENCE')
        kernels.plan.transition(planId, 'WAITING_FOR_EXTERNAL_EVIDENCE');
      return { code: 'EXTERNAL_GATE_PARKED' };
    },
    escalate: (_payload, planId) => {
      const plan = repositories.plans.getPlan(planId);
      if (plan.status !== 'SAFETY_HOLD') kernels.plan.transition(planId, 'SAFETY_HOLD');
      return { code: 'SAFETY_HOLD_ENTERED' };
    },
  };
  const supervisorActions = new SupervisorActionExecutor(
    repositories.actions,
    repositories.decisions,
    supervisorKernel,
    repositories.supervisors,
  );
  const openHands = new OpenHandsSupervisorAdapter(
    env.MODEL_CP_OPENHANDS_URL
      ? new HttpOpenHandsSupervisorClient(
          env.MODEL_CP_OPENHANDS_URL,
          env.MODEL_CP_OPENHANDS_TOKEN ?? env.SESSION_API_KEY,
        )
      : undefined,
  );
  const scheduler = new SupervisorWakeScheduler(repositories.supervisors, db);
  const modelClient = env.MODEL_CP_SUPERVISOR_ENDPOINT
    ? new HttpSupervisorDecisionClient(
        env.MODEL_CP_SUPERVISOR_ENDPOINT,
        env.MODEL_CP_SUPERVISOR_TOKEN,
      )
    : (env.MODEL_CP_V3_LITELLM_URL ?? env.LITELLM_V3_BASE_URL) &&
        env.LITELLM_V3_KEY &&
        env.MODEL_CP_SUPERVISOR_MODEL
      ? new OpenAICompatibleSupervisorDecisionClient(
          env.MODEL_CP_V3_LITELLM_URL ?? env.LITELLM_V3_BASE_URL!,
          env.MODEL_CP_SUPERVISOR_MODEL,
          env.LITELLM_V3_KEY,
        )
      : undefined;
  const supervisorRuntime = new SupervisorRuntime(
    db,
    repositories.supervisors,
    scheduler,
    openHands,
    supervisorActions,
    modelClient,
  );
  const app = Fastify({ logger: options.logger ?? true });
  const affinityEntries = [
    ...DEFAULT_AFFINITY_POLICY.capabilities.IMPLEMENTATION,
    ...DEFAULT_AFFINITY_POLICY.capabilities.REASONING,
    ...(DEFAULT_AFFINITY_POLICY.providerNativeProfiles ?? []),
  ];
  const resourceProjection = (resource: ExecutionResource) => {
    const override = repositories.resourceStateOverrides.get(resource.resourceId);
    return {
      resourceId: resource.resourceId,
      displayName: resource.displayName ?? resource.providerId ?? resource.resourceId,
      providerKey: resource.providerId ?? null,
      resourceTier: resource.resourceTier,
      resourceSequence: resource.resourceSequence,
      state: resource.state,
      transport: resource.bindings[0]?.transport ?? 'LITELLM_MANAGED',
      modelBindings: resource.bindings.map((binding) => {
        const affinity = affinityEntries.find(
          (item) =>
            item.modelFamily === binding.modelFamily &&
            (!binding.agentBackend || item.agentBackend === binding.agentBackend),
        );
        return {
          modelFamily: binding.modelFamily,
          capability: affinity?.capability ?? null,
          agentBackend: binding.agentBackend ?? affinity?.agentBackend ?? null,
          modelRank: affinity?.modelRank ?? null,
          enabled: binding.enabled,
          ready: binding.ready,
          deploymentId: binding.deploymentId ?? null,
          routeModel: binding.routeModel ?? null,
          protocol: binding.protocol ?? null,
        };
      }),
      lastNormalizedFailure: override?.reasonClass
        ? {
            reasonClass: override.reasonClass,
            sanitizedReason: override.sanitizedReason ?? null,
            changedAt: override.updatedAt,
            source: override.source,
          }
        : null,
      suspendedUntil: override?.suspendedUntil ?? null,
      version: override?.version ?? 0,
    };
  };
  const executionProjection = (execution: ReturnType<V4Repositories['executions']['get']>) => ({
    ...execution,
    resourceSelection: repositories.resourceSelections.get(execution.identity.executionId) ?? null,
  });
  const workspaceStorage = () => automation?.workspace.storageStatus?.() ?? null;
  const hostCacheMaintenance = () =>
    readHostCacheMaintenance(env.MODEL_CP_V4_HOST_CACHE_STATE_FILE);
  const runWorkspaceStorageMaintenance = async () => {
    if (!automation?.workspace.storageStatus || !automation.workspace.pruneTerminalCaches)
      return null;
    const before = automation.workspace.storageStatus();
    if (!before.lowCapacity) return null;
    const terminal = repositories.executions.listByStatuses(
      ['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED'],
      1000,
    );
    const workspaces = terminal
      .map(
        (execution) => repositories.sessions.getOptional(execution.identity.executionId)?.workspace,
      )
      .filter((workspace): workspace is NonNullable<typeof workspace> => Boolean(workspace));
    const result = await automation.workspace.pruneTerminalCaches(workspaces);
    app.log.warn(
      {
        ...result,
        minimumFreeBytes: before.minimumFreeBytes,
        terminalExecutions: terminal.length,
      },
      'workspace storage high-watermark cleanup',
    );
    return result;
  };

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'pixel-agent-v4-control-plane',
    apiVersion: 4,
    mode: 'greenfield',
    database: boot.dbFile,
    workspaceStorage: workspaceStorage(),
    hostCacheMaintenance: hostCacheMaintenance(),
    planScheduling: {
      singleActivePlanEnabled,
      literalWorktreesEnabled,
      leases: projectPlanQueue
        ? repositories.projectPlans.listLeases().map((lease) => ({
            ...lease,
            queuedPlans: repositories.projectPlans.listQueue(lease.projectKey).length,
          }))
        : [],
    },
    executionRuntime: {
      enabled: Boolean(automation),
      autonomousPolling: Boolean(automation && env.MODEL_CP_AUTOMATION_RUNTIME_ENABLED === 'true'),
      resourceSelectorEnabled: automation?.resourceSelectorEnabled ?? false,
      resourceCount: automation?.resources.listResources().length ?? 0,
      runtimeAdmission: automation
        ? {
            enabled: automation.runtimeAdmissionEnabled,
            ...automation.runtimeAdmission.summary(),
          }
        : {
            enabled: false,
            checked: 0,
            ready: 0,
            unready: 0,
            implementationReady: 0,
            reviewReady: 0,
          },
      compatibilityImplementationRoutes: automation?.implementationRoutes ?? [],
      compatibilityReviewRoutes: automation?.reviewRoutes ?? [],
      implementationRoutes: automation?.implementationRoutes ?? [],
      reviewRoutes: automation?.reviewRoutes ?? [],
      automationProjectKeys: automation?.automationProjectKeys ?? [],
      literalWorktreeProjectKeys: automation?.literalWorktreeProjectKeys ?? [],
      requireDelivery: automation?.requireDelivery ?? false,
    },
  }));

  app.get('/api/v4/storage', async () => ({
    storage: workspaceStorage(),
    hostCacheMaintenance: hostCacheMaintenance(),
  }));

  app.post('/api/v4/storage/reconcile', async () => ({
    storage: workspaceStorage(),
    hostCacheMaintenance: hostCacheMaintenance(),
    cleanup: await runWorkspaceStorageMaintenance(),
  }));

  app.get('/api/v4/runtime-admission', async () => {
    const runtime = requireAutomation();
    return {
      enabled: runtime.runtimeAdmissionEnabled,
      summary: runtime.runtimeAdmission.summary(),
      items: runtime.runtimeAdmission.list().map((item) => ({
        agentBackend: item.agentBackend,
        transport: item.transport,
        resourceId: item.resourceId,
        bindingId: item.bindingId,
        modelFamily: item.modelFamily,
        routeModel: item.routeModel ?? null,
        ready: item.ready,
        checkedAt: item.checkedAt,
        errorCode: item.errorCode ?? null,
      })),
    };
  });

  app.get('/api/v4/resources', async () => {
    const runtime = requireAutomation();
    if (runtime.resourceSelectorEnabled) await runtime.liteLlmResources.refresh();
    return {
      items: runtime.resources.listResources().map(resourceProjection),
      count: runtime.resources.listResources().length,
    };
  });

  app.post('/api/v4/resources/:resourceId/state', async (request) => {
    const runtime = requireAutomation();
    const resourceId = requiredText(
      (request.params as { resourceId?: string }).resourceId,
      'RESOURCE_ID_REQUIRED',
    );
    const body = bodyRecord(request.body);
    const state = requiredText(body.state, 'RESOURCE_STATE_REQUIRED').toUpperCase();
    if (!['ACTIVE', 'SUSPENDED', 'DISABLED'].includes(state))
      throw new V4Error('RESOURCE_STATE_INVALID');
    const resource = runtime.resources
      .listResources()
      .find((item) => item.resourceId === resourceId);
    if (!resource) throw new V4Error('RESOURCE_NOT_FOUND');
    const expectedVersion =
      body.expectedVersion === undefined || body.expectedVersion === null
        ? undefined
        : integerValue(
            String(body.expectedVersion),
            0,
            0,
            Number.MAX_SAFE_INTEGER,
            'RESOURCE_OVERRIDE_VERSION_INVALID',
          );
    const result = runtime.resourceState.manual(resourceId, state as ResourceState, {
      ...(typeof body.reason === 'string' && body.reason.trim()
        ? { reason: body.reason.trim() }
        : {}),
      ...(typeof body.suspendedUntil === 'string' && body.suspendedUntil.trim()
        ? { suspendedUntil: body.suspendedUntil.trim() }
        : {}),
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
    if (result.status === 'rejected') throw new V4Error(result.reason ?? 'STALE_RESOURCE_STATE');
    const projected = runtime.resources
      .listResources()
      .find((item) => item.resourceId === resourceId);
    if (!projected) throw new V4Error('RESOURCE_NOT_FOUND');
    return { resource: resourceProjection(projected), mutation: result.status };
  });

  app.post('/api/v4/resources/:resourceId/bindings/:bindingId/state', async (request) => {
    const runtime = requireAutomation();
    const params = request.params as { resourceId?: string; bindingId?: string };
    const resourceId = requiredText(params.resourceId, 'RESOURCE_ID_REQUIRED');
    const bindingId = requiredText(params.bindingId, 'RESOURCE_BINDING_ID_REQUIRED');
    const body = bodyRecord(request.body);
    const state = requiredText(body.state, 'RESOURCE_BINDING_STATE_REQUIRED').toUpperCase();
    if (state !== 'ACTIVE' && state !== 'DISABLED')
      throw new V4Error('RESOURCE_BINDING_STATE_INVALID');
    const resource = runtime.resources
      .listResources()
      .find((item) => item.resourceId === resourceId);
    if (!resource) throw new V4Error('RESOURCE_NOT_FOUND');
    const binding = resource.bindings.find((item) => item.bindingId === bindingId);
    if (!binding) throw new V4Error('RESOURCE_BINDING_NOT_FOUND');
    if (!runtime.resourceStateEffect.applyBinding || !binding.deploymentId)
      throw new V4Error('RESOURCE_BINDING_STATE_UNSUPPORTED');
    await runtime.resourceStateEffect.applyBinding(resource, binding, state);
    await runtime.liteLlmResources.refresh();
    const projected = runtime.resources
      .listResources()
      .find((item) => item.resourceId === resourceId);
    if (!projected) throw new V4Error('RESOURCE_NOT_FOUND');
    return { resource: resourceProjection(projected), bindingId, state };
  });

  const planView = (planId: string) => {
    const plan = repositories.plans.getPlan(planId);
    const graph = repositories.plans.getActiveGraphVersion(planId);
    return {
      plan,
      delivery: plan.delivery ?? null,
      graph,
      workItems: graph ? repositories.plans.listWorkItems(planId, graph.graphVersionId) : [],
      executions: repositories.executions.listByPlan(planId).map(executionProjection),
      reviews: repositories.reviews.listByPlan(planId),
      sessions: repositories.sessions.listByPlan(planId),
      supervisor: repositories.supervisors.getByPlanId(planId),
    };
  };

  app.get('/api/v4/plans', async (request) => {
    const query = request.query as { limit?: string; status?: string; view?: string };
    const limit = integerValue(query.limit, 100, 1, 1000, 'PLAN_LIST_LIMIT_INVALID');
    const status = query.status;
    if (status && !(PLAN_STATUSES as readonly string[]).includes(status))
      throw new V4Error('PLAN_STATUS_INVALID');
    if (query.view && query.view !== 'full' && query.view !== 'summary')
      throw new V4Error('PLAN_LIST_VIEW_INVALID');
    const plans = repositories.plans.listPlans({
      limit,
      ...(status ? { status: status as PlanStatus } : {}),
    });
    const items =
      query.view === 'summary'
        ? plans.map((plan) => {
            const graph = repositories.plans.getActiveGraphVersion(plan.planId);
            return {
              plan,
              delivery: plan.delivery ?? null,
              graph,
              workItems: graph
                ? repositories.plans.listWorkItems(plan.planId, graph.graphVersionId)
                : [],
              executions: repositories.executions
                .listByPlan(plan.planId)
                .filter((execution) => ['QUEUED', 'RUNNING', 'BLOCKED'].includes(execution.status))
                .map(executionProjection),
            };
          })
        : plans.map((plan) => planView(plan.planId));
    return { items, count: items.length };
  });

  app.get('/api/v4/projects/:projectKey/plan-queue', async (request) => {
    requireProjectPlanQueue();
    const projectKey = requiredText(
      (request.params as { projectKey?: string }).projectKey,
      'PLAN_PROJECT_REQUIRED',
    );
    return {
      projectKey,
      lease: repositories.projectPlans.getLease(projectKey) ?? null,
      items: repositories.projectPlans.listQueue(projectKey),
    };
  });

  app.post('/api/v4/plans/:planId/reprioritize', async (request) => {
    requireProjectPlanQueue();
    const planId = requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED');
    const body = bodyRecord(request.body);
    const priority = body.priority;
    if (typeof priority !== 'number' || !Number.isInteger(priority))
      throw new V4Error('PROJECT_PLAN_PRIORITY_INVALID');
    const result = repositories.projectPlans.reprioritize(planId, priority);
    if (result.status === 'rejected')
      throw new V4Error(result.reason ?? 'PROJECT_PLAN_REPRIORITIZE_FAILED');
    return { queueEntry: result.value, mutation: result.status };
  });

  app.post('/api/v4/plans/:planId/cancel-queued', async (request) => {
    const runtime = requireProjectPlanQueue();
    const planId = requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED');
    runtime.cancelQueued(planId);
    return {
      plan: repositories.plans.getPlan(planId),
      queueEntry: repositories.projectPlans.getQueueEntry(planId) ?? null,
    };
  });

  app.post('/api/v4/plans', async (request, reply) => {
    const body = bodyRecord(request.body);
    const idempotencyKey = requiredText(
      request.headers['idempotency-key'] ?? body.idempotencyKey,
      'PLAN_IDEMPOTENCY_REQUIRED',
    );
    const delivery = planDeliveryConfig(body.delivery);
    const planResult = kernels.plan.createPlan({
      idempotencyKey,
      projectKey: requiredText(body.projectKey, 'PLAN_PROJECT_REQUIRED'),
      objective: requiredText(body.objective, 'PLAN_OBJECTIVE_REQUIRED'),
      repositoryPath: requiredText(body.repositoryPath, 'PLAN_REPOSITORY_REQUIRED'),
      baseRevision: requiredText(body.baseRevision, 'PLAN_BASE_REVISION_REQUIRED'),
      ...(delivery ? { delivery } : {}),
    });
    const plan = planResult.value;
    if (!plan) throw new V4Error('PLAN_CREATE_FAILED');
    const rawItems = Array.isArray(body.workItems)
      ? body.workItems
      : [
          {
            itemKey: 'objective',
            title: 'Complete objective',
            objective: plan.objective,
            dependencies: [],
            acceptanceCriteria: [],
          },
        ];
    const graph = kernels.plan.ensureReadyGraph(
      plan.planId,
      rawItems.map((item) => {
        const value = bodyRecord(item);
        return {
          itemKey: requiredText(value.itemKey, 'GRAPH_ITEM_KEY_REQUIRED'),
          title: requiredText(value.title, 'GRAPH_TITLE_REQUIRED'),
          objective: requiredText(value.objective, 'GRAPH_ITEM_OBJECTIVE_REQUIRED'),
          dependencies: Array.isArray(value.dependencies)
            ? value.dependencies.map((entry) => requiredText(entry, 'GRAPH_DEPENDENCY_INVALID'))
            : [],
          acceptanceCriteria: Array.isArray(value.acceptanceCriteria)
            ? value.acceptanceCriteria.map((entry) =>
                requiredText(entry, 'GRAPH_ACCEPTANCE_INVALID'),
              )
            : [],
          parallelSafe: value.parallelSafe === true,
          writeScopes: Array.isArray(value.writeScopes)
            ? value.writeScopes.map((entry) =>
                requiredText(entry, 'WORK_ITEM_WRITE_SCOPES_INVALID'),
              )
            : [],
          conflictKeys: Array.isArray(value.conflictKeys)
            ? value.conflictKeys.map((entry) =>
                requiredText(entry, 'WORK_ITEM_CONFLICT_KEYS_INVALID'),
              )
            : [],
        };
      }),
      { activate: !singleActivePlanEnabled },
    );
    const scheduling = projectPlanQueue
      ? projectPlanQueue.scheduleRootPlan(
          plan.planId,
          body.priority === undefined
            ? 0
            : typeof body.priority === 'number' && Number.isInteger(body.priority)
              ? body.priority
              : (() => {
                  throw new V4Error('PROJECT_PLAN_PRIORITY_INVALID');
                })(),
        )
      : undefined;
    if (
      scheduling?.status === 'ACTIVE' &&
      automation?.planWorktreeManager &&
      automation.literalWorktreeProjectKeys.includes(plan.projectKey)
    )
      await automation.planWorktreeManager.ensurePlanActivated(plan.planId);
    let supervisor = repositories.supervisors.getByPlanId(plan.planId);
    if (!projectPlanQueue) {
      supervisor = supervisor ?? repositories.supervisors.create({ planId: plan.planId }).value;
      if (!supervisor) throw new V4Error('SUPERVISOR_CREATE_FAILED');
      if (supervisor.status === 'CREATED')
        repositories.supervisors.updateStatus(supervisor.supervisorId, 'ACTIVE');
      supervisor = repositories.supervisors.getById(supervisor.supervisorId);
    } else if (scheduling?.status === 'ACTIVE') {
      supervisor = repositories.supervisors.getByPlanId(plan.planId);
    }
    reply.code(planResult.status === 'created' ? 201 : 200);
    return {
      plan: repositories.plans.getPlan(plan.planId),
      graph,
      supervisor: supervisor ?? null,
      ...(scheduling ? { scheduling } : {}),
    };
  });

  app.post('/api/v4/plans/:planId/children', async (request, reply) => {
    const parentPlanId = requiredText(
      (request.params as { planId?: string }).planId,
      'PLAN_ID_REQUIRED',
    );
    const body = bodyRecord(request.body);
    const relation = requiredText(body.relation ?? 'FOLLOW_UP', 'CHILD_RELATION_INVALID');
    if (
      relation !== 'SYSTEM_REPAIR' &&
      relation !== 'INFRASTRUCTURE_REPAIR' &&
      relation !== 'FOLLOW_UP'
    )
      throw new V4Error('CHILD_RELATION_INVALID');
    const parent = repositories.plans.getPlan(parentPlanId);
    const child = kernels.plan.createChildPlan({
      parentPlanId,
      childPlanId: requiredText(body.childPlanId, 'CHILD_PLAN_ID_REQUIRED'),
      repositoryPath: requiredText(
        body.repositoryPath ?? parent.repositoryPath,
        'CHILD_REPOSITORY_REQUIRED',
      ),
      objective: requiredText(body.objective, 'CHILD_OBJECTIVE_REQUIRED'),
      relation,
    });
    const rawItems = Array.isArray(body.workItems)
      ? body.workItems
      : [
          {
            itemKey: 'objective',
            title: 'Complete child objective',
            objective: child.plan.objective,
            dependencies: [],
            acceptanceCriteria: [],
          },
        ];
    const graph = kernels.plan.ensureReadyGraph(
      child.plan.planId,
      rawItems.map((item) => {
        const value = bodyRecord(item);
        return {
          itemKey: requiredText(value.itemKey, 'GRAPH_ITEM_KEY_REQUIRED'),
          title: requiredText(value.title, 'GRAPH_TITLE_REQUIRED'),
          objective: requiredText(value.objective, 'GRAPH_ITEM_OBJECTIVE_REQUIRED'),
          dependencies: Array.isArray(value.dependencies)
            ? value.dependencies.map((entry) => requiredText(entry, 'GRAPH_DEPENDENCY_INVALID'))
            : [],
          acceptanceCriteria: Array.isArray(value.acceptanceCriteria)
            ? value.acceptanceCriteria.map((entry) =>
                requiredText(entry, 'GRAPH_ACCEPTANCE_INVALID'),
              )
            : [],
          parallelSafe: value.parallelSafe === true,
          writeScopes: Array.isArray(value.writeScopes)
            ? value.writeScopes.map((entry) =>
                requiredText(entry, 'WORK_ITEM_WRITE_SCOPES_INVALID'),
              )
            : [],
          conflictKeys: Array.isArray(value.conflictKeys)
            ? value.conflictKeys.map((entry) =>
                requiredText(entry, 'WORK_ITEM_CONFLICT_KEYS_INVALID'),
              )
            : [],
        };
      }),
    );
    const delivery = planDeliveryConfig(body.delivery);
    if (delivery) repositories.plans.attachDelivery(child.plan.planId, delivery);
    let supervisor = repositories.supervisors.getByPlanId(child.plan.planId);
    if (!supervisor) {
      supervisor = repositories.supervisors.create({ planId: child.plan.planId }).value;
      if (!supervisor) throw new V4Error('SUPERVISOR_CREATE_FAILED');
      if (supervisor.status === 'CREATED')
        repositories.supervisors.updateStatus(supervisor.supervisorId, 'ACTIVE');
    }
    reply.code(201);
    return {
      plan: repositories.plans.getPlan(child.plan.planId),
      graph,
      relationshipId: child.relationshipId,
      supervisor: repositories.supervisors.getByPlanId(child.plan.planId),
      statusUrl: '/api/v4/plans/' + encodeURIComponent(child.plan.planId),
    };
  });

  app.post('/api/v4/plans/:planId/delivery', async (request, reply) => {
    const planId = requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED');
    const config = planDeliveryConfig(request.body);
    if (!config) throw new V4Error('PLAN_DELIVERY_REQUIRED');
    const result = repositories.plans.attachDelivery(planId, config);
    reply.code(result.status === 'created' ? 201 : 200);
    return {
      planId,
      delivery: result.value,
      statusUrl: '/api/v4/plans/' + encodeURIComponent(planId),
    };
  });

  app.get('/api/v4/plans/:planId', async (request) => {
    const planId = requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED');
    return planView(planId);
  });

  app.post('/api/v4/plans/:planId/run', async (request) => {
    const planId = requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED');
    return await requireAutomation().plans.runPlan(planId);
  });

  app.post('/api/v4/plans/:planId/reconcile', async (request, reply) => {
    const planId = requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED');
    const body = request.body === undefined ? {} : bodyRecord(request.body);
    const mode =
      body.mode === undefined ? 'auto' : requiredText(body.mode, 'PLAN_RECONCILE_MODE_INVALID');
    const result = await requireAutomation().plans.reconcilePlan(planId, mode);
    reply.code(202);
    return { ...result, statusUrl: '/api/v4/plans/' + encodeURIComponent(planId) };
  });

  app.get('/api/v4/executions', async (request) => {
    const query = request.query as {
      limit?: string;
      planId?: string;
      status?: string;
      view?: string;
    };
    const limit = integerValue(query.limit, 100, 1, 1000, 'EXECUTION_LIST_LIMIT_INVALID');
    const status = query.status;
    if (status && !(EXECUTION_STATUSES as readonly string[]).includes(status))
      throw new V4Error('EXECUTION_STATUS_INVALID');
    if (query.view && query.view !== 'dashboard') throw new V4Error('EXECUTION_LIST_VIEW_INVALID');
    const items = repositories.executions.list({
      limit,
      ...(query.planId ? { planId: requiredText(query.planId, 'EXECUTION_PLAN_REQUIRED') } : {}),
      ...(status ? { status: status as ExecutionStatus } : {}),
    });
    if (query.view !== 'dashboard') {
      const projected = items.map(executionProjection);
      return { items: projected, count: projected.length };
    }

    const enriched = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(8, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        const execution = items[index]!;
        const telemetry = await executionTelemetry.project({
          executionId: execution.identity.executionId,
          status: execution.status,
          createdAt: execution.createdAt,
          updatedAt: execution.updatedAt,
        });
        const selection = repositories.resourceSelections.get(execution.identity.executionId);
        const providerNativeRoute =
          selection?.transport === 'PROVIDER_NATIVE'
            ? {
                deploymentId: 'provider-native:' + selection.resourceId,
                providerKey: selection.resourceId,
                model: selection.modelFamily,
                modelGroup: selection.modelFamily,
                commercialType: 'SUBSCRIPTION',
                supplyOrigin: 'OFFICIAL',
              }
            : execution.identity.route === 'codex-business-review' && automation
              ? {
                  deploymentId: 'provider-native:openai-business',
                  providerKey: 'openai-business',
                  model:
                    automation.routeModels[execution.identity.route] ?? execution.identity.route,
                  modelGroup: execution.identity.route,
                  commercialType: 'SUBSCRIPTION',
                  supplyOrigin: 'OFFICIAL',
                }
              : undefined;
        enriched[index] = {
          ...executionProjection(execution),
          telemetry:
            telemetry.usage || telemetry.route || telemetry.routeUsage.length > 0
              ? telemetry
              : { ...telemetry, ...(providerNativeRoute ? { route: providerNativeRoute } : {}) },
        };
      }
    });
    await Promise.all(workers);
    return { items: enriched, count: enriched.length };
  });

  app.get('/api/v4/executions/:executionId', async (request) => {
    const executionId = requiredText(
      (request.params as { executionId?: string }).executionId,
      'EXECUTION_ID_REQUIRED',
    );
    return {
      execution: executionProjection(repositories.executions.get(executionId)),
      resourceSelection: repositories.resourceSelections.get(executionId) ?? null,
      session: repositories.sessions.getOptional(executionId),
      evidence: repositories.evidence.listByExecution(executionId),
      reviewAsImplementation: repositories.reviews.findByImplementationExecution(executionId),
      reviewAsReviewer: repositories.reviews.findByReviewerExecution(executionId),
    };
  });

  app.post('/api/v4/executions/:executionId/run', async (request) => {
    const executionId = requiredText(
      (request.params as { executionId?: string }).executionId,
      'EXECUTION_ID_REQUIRED',
    );
    return await requireAutomation().worker.runExecution(executionId);
  });

  app.post('/api/v4/executions/:executionId/continue', async (request) => {
    const executionId = requiredText(
      (request.params as { executionId?: string }).executionId,
      'EXECUTION_ID_REQUIRED',
    );
    const body = request.body === undefined ? {} : bodyRecord(request.body);
    const instruction =
      typeof body.instruction === 'string' && body.instruction.trim()
        ? body.instruction.trim()
        : undefined;
    if (body.interruptCurrent !== undefined && typeof body.interruptCurrent !== 'boolean')
      throw new V4Error('EXECUTION_CONTINUE_INTERRUPT_INVALID');
    return await requireAutomation().worker.continueExecution(executionId, instruction, {
      interruptCurrent: body.interruptCurrent === true,
    });
  });

  app.post('/api/v4/executions/:executionId/adopt-workspace', async (request) => {
    const executionId = requiredText(
      (request.params as { executionId?: string }).executionId,
      'EXECUTION_ID_REQUIRED',
    );
    const body = request.body === undefined ? {} : bodyRecord(request.body);
    const idempotencyKey = requiredText(
      request.headers['idempotency-key'] ?? body.idempotencyKey,
      'OPERATOR_ADOPTION_IDEMPOTENCY_REQUIRED',
    );
    const reason = requiredText(body.reason, 'OPERATOR_ADOPTION_REASON_INVALID');
    return await requireAutomation().worker.adoptPausedImplementation(
      executionId,
      idempotencyKey,
      reason,
    );
  });

  app.post('/api/v4/executions/:executionId/abort-paused-provider', async (request) => {
    const executionId = requiredText(
      (request.params as { executionId?: string }).executionId,
      'EXECUTION_ID_REQUIRED',
    );
    const body = request.body === undefined ? {} : bodyRecord(request.body);
    const idempotencyKey = requiredText(
      request.headers['idempotency-key'] ?? body.idempotencyKey,
      'PROVIDER_ABORT_IDEMPOTENCY_REQUIRED',
    );
    const reason = requiredText(body.reason, 'PROVIDER_ABORT_REASON_INVALID');
    return await requireAutomation().worker.abortPausedProviderAttempt(
      executionId,
      idempotencyKey,
      reason,
    );
  });

  app.post('/api/v4/executions/:executionId/replace-provider-session', async (request) => {
    const executionId = requiredText(
      (request.params as { executionId?: string }).executionId,
      'EXECUTION_ID_REQUIRED',
    );
    const body = request.body === undefined ? {} : bodyRecord(request.body);
    const idempotencyKey = requiredText(
      request.headers['idempotency-key'] ?? body.idempotencyKey,
      'PROVIDER_REPLACEMENT_IDEMPOTENCY_REQUIRED',
    );
    const instruction =
      typeof body.instruction === 'string' && body.instruction.trim()
        ? body.instruction.trim()
        : undefined;
    const reason =
      typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined;
    return await requireAutomation().worker.replaceStalledProviderSession(
      executionId,
      idempotencyKey,
      instruction,
      reason,
    );
  });

  app.get('/api/v4/supervisors/:supervisorId/projection', async (request) => {
    const supervisorId = requiredText(
      (request.params as { supervisorId?: string }).supervisorId,
      'SUPERVISOR_ID_REQUIRED',
    );
    return buildBoundedProjection(db, supervisorId);
  });

  app.post('/api/v4/supervisors/:supervisorId/decisions', async (request) => {
    const supervisorId = requiredText(
      (request.params as { supervisorId?: string }).supervisorId,
      'SUPERVISOR_ID_REQUIRED',
    );
    const projection = buildBoundedProjection(db, supervisorId);
    const decisionBody = bodyRecord(request.body);
    const decision = (await import('./v4/supervisor/protocol.js')).parseSupervisorDecision(
      JSON.stringify(decisionBody),
    );
    if (decision.supervisorId !== supervisorId) throw new V4Error('ACTION_SUPERVISOR_MISMATCH');
    return await supervisorActions.execute(decision, projection);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof V4Error) {
      void reply.code(statusFor(error)).send({ error: error.code, message: error.message });
      return;
    }
    void reply.code(500).send({
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error),
    });
  });

  const supervisorInterval =
    env.MODEL_CP_SUPERVISOR_RUNTIME_ENABLED === 'true'
      ? setInterval(
          () => {
            void supervisorRuntime
              .runOnce()
              .then((results) => {
                for (const result of results)
                  if (result.status !== 'SKIPPED')
                    app.log.info(
                      {
                        supervisorId: result.supervisorId,
                        status: result.status,
                        code: result.code,
                      },
                      'supervisor runtime cycle',
                    );
              })
              .catch((error) =>
                app.log.error(
                  { error: error instanceof Error ? error.message : String(error) },
                  'supervisor runtime cycle failed',
                ),
              );
          },
          integerValue(
            env.MODEL_CP_SUPERVISOR_POLL_MS,
            5_000,
            1_000,
            300_000,
            'SUPERVISOR_POLL_INVALID',
          ),
        )
      : undefined;

  if (automation?.runtimeAdmissionEnabled) {
    setImmediate(() => {
      void automation
        .reconcileRuntimeAdmission()
        .catch((error) =>
          app.log.error(
            { error: error instanceof Error ? error.message : String(error) },
            'runtime admission warmup failed',
          ),
        );
    });
  }

  let resourceCycleRunning = false;
  const resourceInterval = automation?.resourceSelectorEnabled
    ? setInterval(
        () => {
          if (resourceCycleRunning) return;
          resourceCycleRunning = true;
          void automation.liteLlmResources
            .refresh()
            .then(() => automation.resourceLifecycle.reconcileOnce())
            .then(() => automation.reconcileRuntimeAdmission())
            .catch((error) =>
              app.log.error(
                { error: error instanceof Error ? error.message : String(error) },
                'resource directory cycle failed',
              ),
            )
            .finally(() => {
              resourceCycleRunning = false;
            });
        },
        integerValue(
          env.MODEL_CP_V4_RESOURCE_REFRESH_MS,
          60_000,
          10_000,
          3_600_000,
          'RESOURCE_REFRESH_INVALID',
        ),
      )
    : undefined;

  let automationCycleRunning = false;
  const automationInterval =
    automation && env.MODEL_CP_AUTOMATION_RUNTIME_ENABLED === 'true'
      ? setInterval(
          () => {
            if (automationCycleRunning) return;
            automationCycleRunning = true;
            void runWorkspaceStorageMaintenance()
              .then(async () => {
                if (projectPlanQueue) await projectPlanQueue.reconcile();
                return await automation.plans.runOnce();
              })
              .then((results) => {
                for (const result of results)
                  if (result.status !== 'SKIPPED')
                    app.log.info(
                      {
                        planId: result.planId,
                        workItemId: result.workItemId,
                        executionId: result.executionId,
                        status: result.status,
                        code: result.code,
                      },
                      'plan automation cycle',
                    );
              })
              .catch((error) =>
                app.log.error(
                  { error: error instanceof Error ? error.message : String(error) },
                  'plan automation cycle failed',
                ),
              )
              .finally(() => {
                automationCycleRunning = false;
              });
          },
          integerValue(
            env.MODEL_CP_AUTOMATION_POLL_MS,
            5_000,
            1_000,
            300_000,
            'AUTOMATION_POLL_INVALID',
          ),
        )
      : undefined;

  app.addHook('onClose', async () => {
    if (supervisorInterval) clearInterval(supervisorInterval);
    if (resourceInterval) clearInterval(resourceInterval);
    if (automationInterval) clearInterval(automationInterval);
    db.close();
  });

  const host = env.MODEL_CP_HOST ?? '127.0.0.1';
  const port = Number(env.MODEL_CP_PORT ?? 8320);
  return {
    app,
    db,
    dbFile: boot.dbFile,
    host,
    port,
    repositories,
    kernels,
    supervisor: { actions: supervisorActions, openHands, scheduler, runtime: supervisorRuntime },
    ...(automation ? { automation } : {}),
    ...(projectPlanQueue ? { projectPlanQueue } : {}),
    singleActivePlanEnabled,
    literalWorktreesEnabled,
  };
}
