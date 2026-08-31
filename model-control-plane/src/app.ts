import Fastify, { type FastifyInstance } from 'fastify';

import { V4Error } from './v4/domain/errors.js';
import { bootstrapV4 } from './v4/persistence/bootstrap-v4.js';
import { createRepositories, type V4Repositories } from './v4/persistence/repositories.js';
import { buildBoundedProjection } from './v4/supervisor/projection.js';
import { DeliveryKernel, ExecutionKernel, PlanKernel, RecoveryKernel, ReviewKernel, WorkGraphKernel } from './v4/kernel/index.js';
import { SupervisorActionExecutor, type SupervisorKernelPort } from './v4/supervisor/executor.js';
import { HttpOpenHandsSupervisorClient, OpenHandsSupervisorAdapter } from './v4/adapters/openhands.js';
import { SupervisorWakeScheduler } from './v4/supervisor/scheduler.js';
import { HttpSupervisorDecisionClient, SupervisorRuntime } from './v4/supervisor/runtime.js';

export interface BuildControlPlaneOptions {
  env?: NodeJS.ProcessEnv;
  dbFile?: string;
  logger?: boolean;
  environment?: 'test' | 'development' | 'staging' | 'production';
  allowDataReset?: boolean;
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
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new V4Error('REQUEST_OBJECT_REQUIRED');
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new V4Error(code);
  return value.trim();
}

function statusFor(error: V4Error): number {
  if (error.code.endsWith('_NOT_FOUND')) return 404;
  if (error.code.includes('STALE') || error.code.includes('DUPLICATE') || error.code.includes('CONFLICT')) return 409;
  return 400;
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
  const supervisorKernel: SupervisorKernelPort = {
    continueExecution: (payload) => {
      const execution = repositories.executions.get(payload.executionId);
      if (execution.status !== 'RUNNING') throw new V4Error('EXECUTION_NOT_RESUMABLE');
      return { code: 'CONTINUE_ACCEPTED', linkedExecutionId: execution.identity.executionId };
    },
    retryExecution: (payload) => {
      const result = kernels.recovery.retry({ executionId: payload.executionId, idempotencyKey: 'supervisor-retry:' + payload.executionId, route: 'policy-selected', maxAttempts: 3 });
      if (!result.value) throw new V4Error('RETRY_NOT_CREATED');
      return { code: 'RETRY_QUEUED', linkedExecutionId: result.value.identity.executionId };
    },
    requestReview: (payload) => {
      const execution = repositories.executions.get(payload.executionId);
      if (!execution.resultRevision) throw new V4Error('REVIEW_EXACT_RESULT_REQUIRED');
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
      const result = kernels.recovery.retry({
        executionId: payload.executionId,
        idempotencyKey: 'supervisor-route:' + payload.executionId + ':' + payload.route,
        route: payload.route,
        maxAttempts: 3,
      });
      if (!result.value) throw new V4Error('ROUTE_SWITCH_NOT_CREATED');
      return { code: 'ROUTE_SWITCH_QUEUED', linkedExecutionId: result.value.identity.executionId };
    },
    createRepair: (payload) => {
      const base = repositories.executions.get(payload.baseExecutionId);
      if (!base.resultRevision) throw new V4Error('REPAIR_EXACT_RESULT_REQUIRED');
      const result = kernels.execution.queue({
        idempotencyKey: 'supervisor-repair:' + payload.baseExecutionId,
        identity: { ...base.identity, executionId: 'execution-repair-' + payload.baseExecutionId, attempt: base.identity.attempt + 1, route: 'repair' },
        objective: 'Repair work item ' + payload.workItemId,
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
  const openHands = new OpenHandsSupervisorAdapter(env.MODEL_CP_OPENHANDS_URL ? new HttpOpenHandsSupervisorClient(env.MODEL_CP_OPENHANDS_URL, env.MODEL_CP_OPENHANDS_TOKEN) : undefined);
  const scheduler = new SupervisorWakeScheduler(repositories.supervisors, db);
  const modelClient = env.MODEL_CP_SUPERVISOR_ENDPOINT ? new HttpSupervisorDecisionClient(env.MODEL_CP_SUPERVISOR_ENDPOINT, env.MODEL_CP_SUPERVISOR_TOKEN) : undefined;
  const supervisorRuntime = new SupervisorRuntime(db, repositories.supervisors, scheduler, openHands, supervisorActions, modelClient);
  const app = Fastify({ logger: options.logger ?? true });

  app.get('/api/health', async () => ({
    status: 'ok', service: 'pixel-agent-v4-control-plane', apiVersion: 4, mode: 'greenfield', database: boot.dbFile,
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
    const params = request.params as { planId?: string };
    const planId = requiredText(params.planId, 'PLAN_ID_REQUIRED');
    const plan = repositories.plans.getPlan(planId);
    const graph = repositories.plans.getActiveGraphVersion(planId);
    return { plan, graph, workItems: graph ? repositories.plans.listWorkItems(planId, graph.graphVersionId) : [], supervisor: repositories.supervisors.getByPlanId(planId) };
  });

  app.get('/api/v4/supervisors/:supervisorId/projection', async (request) => {
    const params = request.params as { supervisorId?: string };
    return buildBoundedProjection(db, requiredText(params.supervisorId, 'SUPERVISOR_ID_REQUIRED'));
  });

  app.post('/api/v4/supervisors/:supervisorId/decisions', async (request) => {
    const params = request.params as { supervisorId?: string };
    const supervisorId = requiredText(params.supervisorId, 'SUPERVISOR_ID_REQUIRED');
    const projection = buildBoundedProjection(db, supervisorId);
    const decisionBody = bodyRecord(request.body);
    const decision = (await import('./v4/supervisor/protocol.js')).parseSupervisorDecision(JSON.stringify(decisionBody));
    if (decision.supervisorId !== supervisorId) throw new V4Error('ACTION_SUPERVISOR_MISMATCH');
    return supervisorActions.execute(decision, projection);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof V4Error) {
      void reply.code(statusFor(error)).send({ error: error.code, message: error.message });
      return;
    }
    void reply.code(500).send({ error: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) });
  });
  const runtimeInterval = env.MODEL_CP_SUPERVISOR_RUNTIME_ENABLED === 'true'
    ? setInterval(() => { void supervisorRuntime.runOnce().catch(() => undefined); }, Number(env.MODEL_CP_SUPERVISOR_POLL_MS ?? 5000))
    : undefined;
  app.addHook('onClose', async () => { if (runtimeInterval) clearInterval(runtimeInterval); db.close(); });

  const host = env.MODEL_CP_HOST ?? '127.0.0.1';
  const port = Number(env.MODEL_CP_PORT ?? 8320);
  return { app, db, dbFile: boot.dbFile, host, port, repositories, kernels, supervisor: { actions: supervisorActions, openHands, scheduler, runtime: supervisorRuntime } };
}
