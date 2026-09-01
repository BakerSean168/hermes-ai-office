import path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';

import { LocalGitWorkspaceAdapter } from './v4/adapters/gitWorkspace.js';
import { OpenHandsExecutionProvider, OpenHandsReviewProvider } from './v4/adapters/openHandsCoding.js';
import { HttpOpenHandsSupervisorClient, OpenHandsSupervisorAdapter } from './v4/adapters/openhands.js';
import { V4Error } from './v4/domain/errors.js';
import { DeliveryKernel, ExecutionKernel, PlanKernel, RecoveryKernel, ReviewKernel, WorkGraphKernel } from './v4/kernel/index.js';
import { ExecutionWorker, type ExecutionWorkerRoute } from './v4/orchestration/executionWorker.js';
import {
  PlanAutomationRuntime,
  StaticPlanAutomationPolicyResolver,
  type PlanAutomationPolicy,
} from './v4/orchestration/planAutomationRuntime.js';
import { bootstrapV4 } from './v4/persistence/bootstrap-v4.js';
import { createRepositories, type V4Repositories } from './v4/persistence/repositories.js';
import { SupervisorActionExecutor, type SupervisorKernelPort } from './v4/supervisor/executor.js';
import { buildBoundedProjection } from './v4/supervisor/projection.js';
import { HttpSupervisorDecisionClient, OpenAICompatibleSupervisorDecisionClient, SupervisorRuntime } from './v4/supervisor/runtime.js';
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
  workspace: LocalGitWorkspaceAdapter;
  worker: ExecutionWorker;
  plans: PlanAutomationRuntime;
  policy: StaticPlanAutomationPolicyResolver;
  implementationRoutes: string[];
  reviewRoutes: string[];
}

export interface ControlPlaneRuntime {
  app: FastifyInstance;
  db: ReturnType<typeof bootstrapV4>['db'];
  dbFile: string;
  host: string;
  port: number;
  repositories: V4Repositories;
  kernels: { plan: PlanKernel; graph: WorkGraphKernel; execution: ExecutionKernel; review: ReviewKernel; recovery: RecoveryKernel; delivery: DeliveryKernel };
  supervisor: { actions: SupervisorActionExecutor; openHands: OpenHandsSupervisorAdapter; scheduler: SupervisorWakeScheduler; runtime: SupervisorRuntime };
  automation?: ExecutionAutomationRuntime;
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new V4Error('REQUEST_OBJECT_REQUIRED');
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new V4Error(code);
  return value.trim();
}

interface RouteSpec { route: string; model: string; }

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
  return (value ?? '').split(path.delimiter).map((item) => item.trim()).filter(Boolean);
}

function integerValue(value: string | undefined, fallback: number, minimum: number, maximum: number, code: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new V4Error(code);
  return parsed;
}

function statusFor(error: V4Error): number {
  if (error.code.endsWith('_NOT_FOUND')) return 404;
  if (error.code.includes('STALE') || error.code.includes('DUPLICATE') || error.code.includes('CONFLICT') || error.code.includes('ACTIVE')) return 409;
  if (error.code.includes('UNAVAILABLE') || error.code.includes('DISABLED')) return 503;
  return 400;
}

function buildExecutionAutomation(
  env: NodeJS.ProcessEnv,
  repositories: V4Repositories,
  fetchImpl: typeof fetch,
): ExecutionAutomationRuntime | undefined {
  if (env.MODEL_CP_EXECUTION_RUNTIME_ENABLED !== 'true') return undefined;
  const openHandsUrl = requiredText(env.MODEL_CP_OPENHANDS_URL, 'OPENHANDS_BASE_URL_REQUIRED');
  const sessionApiKey = requiredText(env.SESSION_API_KEY, 'OPENHANDS_SESSION_KEY_REQUIRED');
  const liteLlmApiKey = requiredText(env.LITELLM_V3_KEY, 'OPENHANDS_LITELLM_KEY_REQUIRED');
  const liteLlmBaseUrl = requiredText(env.LITELLM_V3_BASE_URL ?? env.MODEL_CP_V3_LITELLM_URL, 'OPENHANDS_LITELLM_URL_REQUIRED');
  const allowedRepositoryRoots = rootList(env.MODEL_CP_V4_ALLOWED_REPOSITORY_ROOTS);
  if (allowedRepositoryRoots.length === 0) throw new V4Error('WORKSPACE_ALLOWED_ROOT_REQUIRED');
  const managedHostRoot = requiredText(env.MODEL_CP_V4_WORKSPACE_HOST_ROOT, 'WORKSPACE_MANAGED_ROOT_REQUIRED');
  const executionRoot = requiredText(env.MODEL_CP_V4_WORKSPACE_EXECUTION_ROOT ?? '/workspace', 'WORKSPACE_EXECUTION_ROOT_REQUIRED');
  const implementationSpecs = routeSpecs(env.MODEL_CP_V4_IMPLEMENTATION_ROUTES, ['gpt-5.6-luna', 'implementation-efficient', 'implementation-glm=glm-5.2']);
  const reviewSpecs = routeSpecs(env.MODEL_CP_V4_REVIEW_ROUTES, ['gpt-5.6-sol', 'codex-auto-review', 'review-glm=glm-5.2']);
  const implementationRoutes = implementationSpecs.map((item) => item.route);
  const reviewRoutes = reviewSpecs.map((item) => item.route);
  if (implementationRoutes.some((route) => reviewRoutes.includes(route))) throw new V4Error('EXECUTION_ROUTE_ROLE_CONFLICT');

  const common = {
    baseUrl: openHandsUrl,
    sessionApiKey,
    liteLlmApiKey,
    liteLlmBaseUrl,
    fetchImpl,
    requestTimeoutMs: integerValue(env.MODEL_CP_V4_PROVIDER_REQUEST_TIMEOUT_MS, 30_000, 1_000, 120_000, 'OPENHANDS_TIMEOUT_INVALID'),
    llmTimeoutSeconds: integerValue(env.MODEL_CP_V4_PROVIDER_LLM_TIMEOUT_SECONDS, 600, 30, 1_800, 'OPENHANDS_LLM_TIMEOUT_INVALID'),
    maxIterations: integerValue(env.MODEL_CP_V4_PROVIDER_MAX_ITERATIONS, 500, 1, 1_000, 'OPENHANDS_ITERATION_LIMIT_INVALID'),
  };
  const routes: ExecutionWorkerRoute[] = [
    ...implementationSpecs.map(({ route, model }) => ({
      route,
      provider: new OpenHandsExecutionProvider({ ...common, implementationModel: model }),
    })),
    ...reviewSpecs.map(({ route, model }) => ({
      route,
      provider: new OpenHandsReviewProvider({ ...common, reviewModel: model }),
    })),
  ];
  const workspace = new LocalGitWorkspaceAdapter({
    allowedRepositoryRoots,
    managedHostRoot,
    executionRoot,
    commandTimeoutMs: integerValue(env.MODEL_CP_V4_GIT_TIMEOUT_MS, 120_000, 1_000, 15 * 60_000, 'WORKSPACE_GIT_TIMEOUT_INVALID'),
    maxBufferBytes: integerValue(env.MODEL_CP_V4_GIT_MAX_BUFFER_BYTES, 8 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024, 'WORKSPACE_GIT_BUFFER_INVALID'),
    workspaceUid: integerValue(env.MODEL_CP_V4_WORKSPACE_UID, 10_001, 0, 2 ** 31 - 1, 'WORKSPACE_OWNER_INVALID'),
    workspaceGid: integerValue(env.MODEL_CP_V4_WORKSPACE_GID, 10_001, 0, 2 ** 31 - 1, 'WORKSPACE_OWNER_INVALID'),
  });
  const worker = new ExecutionWorker(repositories, workspace, routes, {
    leaseTtlMs: integerValue(env.MODEL_CP_V4_EXECUTION_LEASE_TTL_MS, 30_000, 1_000, 5 * 60_000, 'EXECUTION_LEASE_TTL_INVALID'),
    maxExecutionsPerCycle: integerValue(env.MODEL_CP_V4_MAX_EXECUTIONS_PER_CYCLE, 20, 1, 1_000, 'EXECUTION_CYCLE_LIMIT_INVALID'),
  });
  const defaultPolicy: PlanAutomationPolicy = {
    implementationRoutes,
    reviewRoutes,
    maxImplementationAttempts: integerValue(env.MODEL_CP_V4_MAX_IMPLEMENTATION_ATTEMPTS, 3, 1, 20, 'PLAN_AUTOMATION_LIMIT_INVALID'),
    maxReviewAttempts: integerValue(env.MODEL_CP_V4_MAX_REVIEW_ATTEMPTS, 2, 1, 20, 'PLAN_AUTOMATION_LIMIT_INVALID'),
    maxRepairCycles: integerValue(env.MODEL_CP_V4_MAX_REPAIR_CYCLES, 3, 1, 20, 'PLAN_AUTOMATION_LIMIT_INVALID'),
  };
  const policy = new StaticPlanAutomationPolicyResolver(defaultPolicy);
  const plans = new PlanAutomationRuntime(repositories, worker, workspace, policy);
  return { workspace, worker, plans, policy, implementationRoutes, reviewRoutes };
}

export async function buildControlPlane(options: BuildControlPlaneOptions = {}): Promise<ControlPlaneRuntime> {
  const env = options.env ?? process.env;
  const boot = bootstrapV4({ dbFile: options.dbFile, env, environment: options.environment, allowDataReset: options.allowDataReset });
  const db = boot.db;
  const repositories = createRepositories(db);
  const kernels = {
    plan: new PlanKernel(repositories),
    graph: new WorkGraphKernel(repositories),
    execution: new ExecutionKernel(repositories),
    review: new ReviewKernel(repositories),
    recovery: new RecoveryKernel(repositories),
    delivery: new DeliveryKernel(),
  };
  const automation = buildExecutionAutomation(env, repositories, options.fetchImpl ?? fetch);
  const requireAutomation = (): ExecutionAutomationRuntime => {
    if (!automation) throw new V4Error('EXECUTION_RUNTIME_DISABLED');
    return automation;
  };
  const policyForExecution = (executionId: string): PlanAutomationPolicy => {
    const execution = repositories.executions.get(executionId);
    const plan = repositories.plans.getPlan(execution.identity.planId);
    const policy = automation?.policy.resolve(plan.projectKey);
    if (!policy) throw new V4Error('PLAN_POLICY_UNAVAILABLE');
    return policy;
  };

  const supervisorKernel: SupervisorKernelPort = {
    createExecution: async (payload, planId) => {
      const runtime = requireAutomation();
      if (payload.route !== runtime.implementationRoutes[0]) throw new V4Error('INITIAL_ROUTE_POLICY_MISMATCH');
      const item = repositories.plans.getWorkItem(payload.workItemId);
      if (item.planId !== planId) throw new V4Error('EXECUTION_WORK_ITEM_MISMATCH');
      const result = await runtime.plans.runPlan(planId);
      if (result.workItemId && result.workItemId !== payload.workItemId) throw new V4Error('WORK_ITEM_NOT_RUNNABLE');
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
      if (execution.identity.phase === 'REVIEW') {
        const result = await runtime.plans.runPlan(execution.identity.planId);
        if (!result.executionId) throw new V4Error(result.code);
        return { code: result.code, linkedExecutionId: result.executionId };
      }
      const policy = policyForExecution(payload.executionId);
      const routes = policy.implementationRoutes;
      const currentIndex = Math.max(0, routes.indexOf(execution.identity.route));
      const route = routes[Math.min(currentIndex + 1, routes.length - 1)]!;
      const result = kernels.recovery.retry({
        executionId: payload.executionId,
        idempotencyKey: 'supervisor-retry:' + payload.executionId + ':' + execution.identity.attempt,
        route,
        maxAttempts: policy.maxImplementationAttempts ?? 3,
      });
      if (!result.value || result.status === 'rejected') throw new V4Error(result.reason ?? 'RETRY_NOT_CREATED');
      return { code: 'RETRY_QUEUED', linkedExecutionId: result.value.identity.executionId };
    },
    requestReview: (payload) => {
      const execution = repositories.executions.get(payload.executionId);
      if (!execution.resultRevision || execution.status !== 'SUCCEEDED') throw new V4Error('REVIEW_EXACT_RESULT_REQUIRED');
      if (!automation?.reviewRoutes.includes(payload.reviewerRoute)) throw new V4Error('REVIEW_ROUTE_UNAVAILABLE');
      const result = kernels.review.request({
        idempotencyKey: 'supervisor-review:' + payload.executionId,
        planId: execution.identity.planId,
        workItemId: execution.identity.workItemId,
        implementationExecutionId: execution.identity.executionId,
        sourceRevision: execution.resultRevision,
      });
      if (!result.value) throw new V4Error('REVIEW_NOT_CREATED');
      return { code: 'REVIEW_QUEUED', linkedExecutionId: result.value.implementationExecutionId };
    },
    switchRoute: (payload) => {
      const runtime = requireAutomation();
      const execution = repositories.executions.get(payload.executionId);
      if (execution.identity.phase === 'REVIEW') throw new V4Error('REVIEW_ROUTE_SWITCH_USE_AUTOMATION');
      if (!runtime.implementationRoutes.includes(payload.route)) throw new V4Error('EXECUTION_ROUTE_UNAVAILABLE');
      const policy = policyForExecution(payload.executionId);
      const result = kernels.recovery.retry({
        executionId: payload.executionId,
        idempotencyKey: 'supervisor-route:' + payload.executionId + ':' + payload.route,
        route: payload.route,
        maxAttempts: policy.maxImplementationAttempts ?? 3,
      });
      if (!result.value || result.status === 'rejected') throw new V4Error(result.reason ?? 'ROUTE_SWITCH_NOT_CREATED');
      return { code: 'ROUTE_SWITCH_QUEUED', linkedExecutionId: result.value.identity.executionId };
    },
    createRepair: (payload) => {
      const runtime = requireAutomation();
      const base = repositories.executions.get(payload.baseExecutionId);
      if (!base.resultRevision || base.status !== 'SUCCEEDED') throw new V4Error('REPAIR_EXACT_RESULT_REQUIRED');
      const route = runtime.implementationRoutes[0]!;
      const executionId = 'execution-repair-' + payload.baseExecutionId;
      const result = kernels.execution.queue({
        executionId,
        idempotencyKey: 'supervisor-repair:' + payload.baseExecutionId,
        identity: {
          ...base.identity,
          executionId,
          phase: 'IMPLEMENT_FIX',
          parentExecutionId: base.identity.executionId,
          attempt: base.identity.attempt + 1,
          route,
          sourceRevision: base.resultRevision,
        },
        objective: ['Repair work item ' + payload.workItemId, ...payload.findingRefs.map((finding) => '- ' + finding)].join('\n'),
      });
      if (!result.value) throw new V4Error('REPAIR_NOT_CREATED');
      return { code: 'REPAIR_QUEUED', linkedExecutionId: result.value.identity.executionId };
    },
    replanRemainder: (payload, planId) => {
      const supervisor = repositories.supervisors.getByPlanId(planId);
      kernels.graph.replanRemainder({ planId, reason: payload.reason, observationCursor: supervisor?.observationCursor ?? 0, items: payload.workItems });
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
      if (plan.status !== 'WAITING_FOR_EXTERNAL_EVIDENCE') kernels.plan.transition(planId, 'WAITING_FOR_EXTERNAL_EVIDENCE');
      return { code: 'EXTERNAL_GATE_PARKED' };
    },
    escalate: (_payload, planId) => {
      const plan = repositories.plans.getPlan(planId);
      if (plan.status !== 'SAFETY_HOLD') kernels.plan.transition(planId, 'SAFETY_HOLD');
      return { code: 'SAFETY_HOLD_ENTERED' };
    },
  };
  const supervisorActions = new SupervisorActionExecutor(repositories.actions, repositories.decisions, supervisorKernel, repositories.supervisors);
  const openHands = new OpenHandsSupervisorAdapter(env.MODEL_CP_OPENHANDS_URL
    ? new HttpOpenHandsSupervisorClient(env.MODEL_CP_OPENHANDS_URL, env.MODEL_CP_OPENHANDS_TOKEN ?? env.SESSION_API_KEY)
    : undefined);
  const scheduler = new SupervisorWakeScheduler(repositories.supervisors, db);
  const modelClient = env.MODEL_CP_SUPERVISOR_ENDPOINT
    ? new HttpSupervisorDecisionClient(env.MODEL_CP_SUPERVISOR_ENDPOINT, env.MODEL_CP_SUPERVISOR_TOKEN)
    : (env.MODEL_CP_V3_LITELLM_URL ?? env.LITELLM_V3_BASE_URL) && env.LITELLM_V3_KEY && env.MODEL_CP_SUPERVISOR_MODEL
      ? new OpenAICompatibleSupervisorDecisionClient(env.MODEL_CP_V3_LITELLM_URL ?? env.LITELLM_V3_BASE_URL!, env.MODEL_CP_SUPERVISOR_MODEL, env.LITELLM_V3_KEY)
      : undefined;
  const supervisorRuntime = new SupervisorRuntime(db, repositories.supervisors, scheduler, openHands, supervisorActions, modelClient);
  const app = Fastify({ logger: options.logger ?? true });

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'pixel-agent-v4-control-plane',
    apiVersion: 4,
    mode: 'greenfield',
    database: boot.dbFile,
    executionRuntime: {
      enabled: Boolean(automation),
      autonomousPolling: Boolean(automation && env.MODEL_CP_AUTOMATION_RUNTIME_ENABLED === 'true'),
      implementationRoutes: automation?.implementationRoutes ?? [],
      reviewRoutes: automation?.reviewRoutes ?? [],
    },
  }));

  app.post('/api/v4/plans', async (request, reply) => {
    const body = bodyRecord(request.body);
    const idempotencyKey = requiredText(request.headers['idempotency-key'] ?? body.idempotencyKey, 'PLAN_IDEMPOTENCY_REQUIRED');
    const planResult = kernels.plan.createPlan({
      idempotencyKey,
      projectKey: requiredText(body.projectKey, 'PLAN_PROJECT_REQUIRED'),
      objective: requiredText(body.objective, 'PLAN_OBJECTIVE_REQUIRED'),
      repositoryPath: requiredText(body.repositoryPath, 'PLAN_REPOSITORY_REQUIRED'),
      baseRevision: requiredText(body.baseRevision, 'PLAN_BASE_REVISION_REQUIRED'),
    });
    const plan = planResult.value;
    if (!plan) throw new V4Error('PLAN_CREATE_FAILED');
    const rawItems = Array.isArray(body.workItems) ? body.workItems : [{ itemKey: 'objective', title: 'Complete objective', objective: plan.objective, dependencies: [], acceptanceCriteria: [] }];
    const graph = kernels.plan.ensureReadyGraph(plan.planId, rawItems.map((item) => {
      const value = bodyRecord(item);
      return {
        itemKey: requiredText(value.itemKey, 'GRAPH_ITEM_KEY_REQUIRED'),
        title: requiredText(value.title, 'GRAPH_TITLE_REQUIRED'),
        objective: requiredText(value.objective, 'GRAPH_ITEM_OBJECTIVE_REQUIRED'),
        dependencies: Array.isArray(value.dependencies) ? value.dependencies.map((entry) => requiredText(entry, 'GRAPH_DEPENDENCY_INVALID')) : [],
        acceptanceCriteria: Array.isArray(value.acceptanceCriteria) ? value.acceptanceCriteria.map((entry) => requiredText(entry, 'GRAPH_ACCEPTANCE_INVALID')) : [],
      };
    }));
    const supervisor = repositories.supervisors.create({ planId: plan.planId }).value;
    if (!supervisor) throw new V4Error('SUPERVISOR_CREATE_FAILED');
    if (supervisor.status === 'CREATED') repositories.supervisors.updateStatus(supervisor.supervisorId, 'ACTIVE');
    reply.code(planResult.status === 'created' ? 201 : 200);
    return { plan: repositories.plans.getPlan(plan.planId), graph, supervisor: repositories.supervisors.getById(supervisor.supervisorId) };
  });

  app.get('/api/v4/plans/:planId', async (request) => {
    const planId = requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED');
    const plan = repositories.plans.getPlan(planId);
    const graph = repositories.plans.getActiveGraphVersion(planId);
    return {
      plan,
      graph,
      workItems: graph ? repositories.plans.listWorkItems(planId, graph.graphVersionId) : [],
      executions: repositories.executions.listByPlan(planId),
      reviews: repositories.reviews.listByPlan(planId),
      sessions: repositories.sessions.listByPlan(planId),
      supervisor: repositories.supervisors.getByPlanId(planId),
    };
  });

  app.post('/api/v4/plans/:planId/run', async (request) => {
    const planId = requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED');
    return await requireAutomation().plans.runPlan(planId);
  });

  app.get('/api/v4/executions/:executionId', async (request) => {
    const executionId = requiredText((request.params as { executionId?: string }).executionId, 'EXECUTION_ID_REQUIRED');
    return {
      execution: repositories.executions.get(executionId),
      session: repositories.sessions.getOptional(executionId),
      evidence: repositories.evidence.listByExecution(executionId),
      reviewAsImplementation: repositories.reviews.findByImplementationExecution(executionId),
      reviewAsReviewer: repositories.reviews.findByReviewerExecution(executionId),
    };
  });

  app.post('/api/v4/executions/:executionId/run', async (request) => {
    const executionId = requiredText((request.params as { executionId?: string }).executionId, 'EXECUTION_ID_REQUIRED');
    return await requireAutomation().worker.runExecution(executionId);
  });

  app.post('/api/v4/executions/:executionId/continue', async (request) => {
    const executionId = requiredText((request.params as { executionId?: string }).executionId, 'EXECUTION_ID_REQUIRED');
    const body = request.body === undefined ? {} : bodyRecord(request.body);
    const instruction = typeof body.instruction === 'string' && body.instruction.trim()
      ? body.instruction.trim()
      : undefined;
    return await requireAutomation().worker.continueExecution(executionId, instruction);
  });

  app.get('/api/v4/supervisors/:supervisorId/projection', async (request) => {
    const supervisorId = requiredText((request.params as { supervisorId?: string }).supervisorId, 'SUPERVISOR_ID_REQUIRED');
    return buildBoundedProjection(db, supervisorId);
  });

  app.post('/api/v4/supervisors/:supervisorId/decisions', async (request) => {
    const supervisorId = requiredText((request.params as { supervisorId?: string }).supervisorId, 'SUPERVISOR_ID_REQUIRED');
    const projection = buildBoundedProjection(db, supervisorId);
    const decisionBody = bodyRecord(request.body);
    const decision = (await import('./v4/supervisor/protocol.js')).parseSupervisorDecision(JSON.stringify(decisionBody));
    if (decision.supervisorId !== supervisorId) throw new V4Error('ACTION_SUPERVISOR_MISMATCH');
    return await supervisorActions.execute(decision, projection);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof V4Error) {
      void reply.code(statusFor(error)).send({ error: error.code, message: error.message });
      return;
    }
    void reply.code(500).send({ error: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) });
  });

  const supervisorInterval = env.MODEL_CP_SUPERVISOR_RUNTIME_ENABLED === 'true'
    ? setInterval(() => {
        void supervisorRuntime.runOnce().then((results) => {
          for (const result of results) if (result.status !== 'SKIPPED') app.log.info({ supervisorId: result.supervisorId, status: result.status, code: result.code }, 'supervisor runtime cycle');
        }).catch((error) => app.log.error({ error: error instanceof Error ? error.message : String(error) }, 'supervisor runtime cycle failed'));
      }, integerValue(env.MODEL_CP_SUPERVISOR_POLL_MS, 5_000, 1_000, 300_000, 'SUPERVISOR_POLL_INVALID'))
    : undefined;

  let automationCycleRunning = false;
  const automationInterval = automation && env.MODEL_CP_AUTOMATION_RUNTIME_ENABLED === 'true'
    ? setInterval(() => {
        if (automationCycleRunning) return;
        automationCycleRunning = true;
        void automation.plans.runOnce().then((results) => {
          for (const result of results) if (result.status !== 'SKIPPED') app.log.info({ planId: result.planId, workItemId: result.workItemId, executionId: result.executionId, status: result.status, code: result.code }, 'plan automation cycle');
        }).catch((error) => app.log.error({ error: error instanceof Error ? error.message : String(error) }, 'plan automation cycle failed'))
          .finally(() => { automationCycleRunning = false; });
      }, integerValue(env.MODEL_CP_AUTOMATION_POLL_MS, 5_000, 1_000, 300_000, 'AUTOMATION_POLL_INVALID'))
    : undefined;

  app.addHook('onClose', async () => {
    if (supervisorInterval) clearInterval(supervisorInterval);
    if (automationInterval) clearInterval(automationInterval);
    db.close();
  });

  const host = env.MODEL_CP_HOST ?? '127.0.0.1';
  const port = Number(env.MODEL_CP_PORT ?? 8320);
  return { app, db, dbFile: boot.dbFile, host, port, repositories, kernels, supervisor: { actions: supervisorActions, openHands, scheduler, runtime: supervisorRuntime }, ...(automation ? { automation } : {}) };
}
