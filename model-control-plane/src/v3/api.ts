import type { FastifyInstance } from 'fastify';

import type { DevelopmentPolicy } from './policy.js';
import type { ModelRegistryPort } from './ports.js';
import { PLAN_LIMITS } from './planConstants.js';
import type { DevelopmentExecutionService } from './service.js';
import { buildV3ReadinessReport, type V3ReadinessEvidence } from './readiness.js';
import {
  DEVELOPMENT_PHASES,
  TRANSPORT_MODES,
  type DevelopmentPhase,
  type StartDevelopmentExecutionInput,
  type TransportMode,
} from './types.js';

function errorStatus(code: string): number {
  if (code.endsWith('_NOT_FOUND') || code === 'EXECUTION_NOT_FOUND') return 404;
  if (code.includes('UNAVAILABLE')) return 503;
  if (
    code.endsWith('_REQUIRED') ||
    code.endsWith('_INVALID') ||
    code.includes('NOT_ALLOWED') ||
    code.includes('UNSUPPORTED')
  )
    return 400;
  if (
    code.includes('CONCURRENCY') ||
    code.includes('LEASE_CONFLICT') ||
    code.includes('NOT_CONTINUABLE')
  )
    return 409;
  if (
    code.includes('NO_ELIGIBLE') ||
    code.includes('NOT_IMPLEMENTED') ||
    code.startsWith('PREVIOUS_EXECUTION_') ||
    code.startsWith('REVIEW_IMPLEMENTATION_')
  )
    return 422;
  if (code.includes('TIMEOUT')) return 504;
  return 500;
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(':', 1)[0] || 'V3_INTERNAL_ERROR';
}

export function registerV3Routes(
  app: FastifyInstance,
  service: DevelopmentExecutionService,
  policy: DevelopmentPolicy,
  readinessEvidence?: V3ReadinessEvidence,
  modelRegistry?: ModelRegistryPort,
): void {
  app.get('/api/v3/health', async () => ({
    status: 'ok',
    service: 'hermes-ai-office-v3',
    apiVersion: 3,
    mode: 'production',
  }));

  app.get('/api/v3/development/runtime-summary', async () => service.runtimeSummary());

  app.post('/api/v3/development/plans', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const header = request.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(header) ? header[0] : header;
    if (!idempotencyKey?.trim()) {
      reply.code(400);
      return { error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } };
    }
    const repository =
      body.repository && typeof body.repository === 'object' && !Array.isArray(body.repository)
        ? (body.repository as Record<string, unknown>)
        : {};
    const source =
      body.source && typeof body.source === 'object' && !Array.isArray(body.source)
        ? (body.source as Record<string, unknown>)
        : undefined;
    const delivery =
      body.delivery && typeof body.delivery === 'object' && !Array.isArray(body.delivery)
        ? (body.delivery as Record<string, unknown>)
        : undefined;
    try {
      const result = await service.createPlan(
        {
          projectKey: String(body.projectKey ?? ''),
          objective: String(body.objective ?? ''),
          analysisSummary: String(body.analysisSummary ?? ''),
          repository: {
            path: String(repository.path ?? ''),
            baseRevision: repository.baseRevision ? String(repository.baseRevision) : undefined,
          },
          source: source
            ? {
                kind: String(source.kind ?? '').toUpperCase() as 'TASK' | 'EXTERNAL_CHANGE',
                ...(source.revision ? { revision: String(source.revision) } : {}),
              } as import('./plans.js').PlanSource
            : undefined,
          delivery: delivery
            ? {
                remote: delivery.remote ? String(delivery.remote) : undefined,
                branch: String(delivery.branch ?? ''),
                targetBranch: delivery.targetBranch ? String(delivery.targetBranch) : undefined,
                autoMerge: delivery.autoMerge === true,
                mergeMethod: delivery.mergeMethod
                  ? (String(delivery.mergeMethod) as 'merge' | 'squash' | 'rebase')
                  : undefined,
              }
            : undefined,
          batches: Array.isArray(body.batches)
            ? body.batches.map((rawBatch) => {
                const batch = rawBatch as Record<string, unknown>;
                return {
                  key: String(batch.key ?? ''),
                  title: String(batch.title ?? batch.key ?? ''),
                  dependsOn: Array.isArray(batch.dependsOn)
                    ? batch.dependsOn.map(String)
                    : undefined,
                  workItems: Array.isArray(batch.workItems)
                    ? batch.workItems.map((rawItem) => {
                        const item = rawItem as Record<string, unknown>;
                        return {
                          key: String(item.key ?? ''),
                          title: String(item.title ?? item.key ?? ''),
                          objective: String(item.objective ?? ''),
                          acceptanceCriteria: Array.isArray(item.acceptanceCriteria)
                            ? item.acceptanceCriteria.map(String)
                            : undefined,
                        };
                      })
                    : [],
                };
              })
            : [],
        },
        idempotencyKey,
      );
      reply.code(201);
      return result;
    } catch (error) {
      const code = errorCode(error);
      reply.code(errorStatus(code));
      return { error: { code } };
    }
  });

  app.get<{ Params: { planId: string }; Querystring: { hydrate?: string } }>(
    '/api/v3/development/plans/:planId',
    async (request, reply) => {
      const plan = await service.getPlan(
        request.params.planId,
        request.query?.hydrate === '1' || request.query?.hydrate === 'true',
      );
      if (!plan) {
        reply.code(404);
        return { error: { code: 'PLAN_NOT_FOUND' } };
      }
      return plan;
    },
  );

  app.get('/api/v3/development/plans', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return { items: await service.listPlans(Number(query.limit ?? PLAN_LIMITS.listResults)) };
  });

  app.post<{ Params: { planId: string }; Body?: { mode?: string } }>(
    '/api/v3/development/plans/:planId/reconcile',
    async (request, reply) => {
      const plan = await service.getPlan(request.params.planId, false);
      if (!plan) {
        reply.code(404);
        return { error: { code: 'PLAN_NOT_FOUND' } };
      }
      const requestedMode = String(request.body?.mode ?? 'auto')
        .trim()
        .toLowerCase();
      if (!['auto', 'retry_review', 'retry_delivery'].includes(requestedMode)) {
        reply.code(400);
        return { error: { code: 'PLAN_RECOVERY_MODE_INVALID' } };
      }
      const recoveryMode =
        requestedMode === 'retry_review'
          ? 'RETRY_REVIEW'
          : requestedMode === 'retry_delivery'
            ? 'RETRY_DELIVERY'
            : 'AUTO';
      void service
        .reconcilePlans(request.params.planId, true, recoveryMode)
        .catch((error) => request.log.error(error, 'V3 requested plan reconciliation failed'));
      reply.code(202);
      return {
        planId: plan.planId,
        accepted: true,
        status: plan.status,
        statusUrl: `/api/v3/development/plans/${plan.planId}`,
      };
    },
  );

  app.post<{ Params: { planId: string } }>(
    '/api/v3/development/plans/:planId/cancel',
    async (request, reply) => {
      const plan = await service.cancelPlan(request.params.planId);
      if (!plan) {
        reply.code(404);
        return { error: { code: 'PLAN_NOT_FOUND' } };
      }
      return plan;
    },
  );

  app.get('/api/v3/development/model-registry', async (_request, reply) => {
    if (!modelRegistry) {
      reply.code(503);
      return {
        authority: 'LITELLM',
        health: 'UNAVAILABLE',
        credentials: { count: 0, items: [] },
        deployments: { count: 0, active: 0, paused: 0, groups: {}, items: [] },
        aliases: {},
        upstream: { error: 'LITELLM_REGISTRY_UNCONFIGURED' },
      };
    }
    const summary = await modelRegistry.summary();
    if (summary.health !== 'OK') reply.code(503);
    return summary;
  });

  app.get('/api/v3/development/readiness', async (_request, reply) => {
    if (!readinessEvidence) {
      reply.code(503);
      return { error: { code: 'V3_READINESS_EVIDENCE_UNCONFIGURED' } };
    }
    return buildV3ReadinessReport(service, readinessEvidence);
  });

  app.get('/api/v3/development/policy', async () => ({
    version: policy.config.version,
    concurrency: policy.config.concurrency,
    phases: policy.config.phases,
    backends: Object.fromEntries(
      Object.entries(policy.config.backends).map(([name, backend]) => [
        name,
        {
          kind: backend.kind,
          enabled: backend.enabled,
          acpServer: backend.acp_server,
          supports: backend.supports,
        },
      ]),
    ),
  }));

  app.post('/api/v3/development/executions', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const phase = String(body.phase ?? '').toUpperCase();
    if (!DEVELOPMENT_PHASES.includes(phase as DevelopmentPhase)) {
      reply.code(400);
      return { error: { code: 'V3_PHASE_INVALID' } };
    }
    if (phase === 'ORCHESTRATE') {
      reply.code(400);
      return { error: { code: 'V3_ORCHESTRATE_REQUIRES_DURABLE_PLAN' } };
    }
    if (phase === 'ADOPT_CHANGE') {
      reply.code(400);
      return { error: { code: 'V3_ADOPT_CHANGE_REQUIRES_DURABLE_PLAN' } };
    }
    const header = request.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(header) ? header[0] : header;
    if (!idempotencyKey?.trim()) {
      reply.code(400);
      return { error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } };
    }
    const repository =
      body.repository && typeof body.repository === 'object' && !Array.isArray(body.repository)
        ? (body.repository as Record<string, unknown>)
        : {};
    const hermes =
      body.hermes && typeof body.hermes === 'object' && !Array.isArray(body.hermes)
        ? (body.hermes as Record<string, unknown>)
        : undefined;
    const context =
      body.context && typeof body.context === 'object' && !Array.isArray(body.context)
        ? (body.context as Record<string, unknown>)
        : undefined;
    const override =
      body.override && typeof body.override === 'object' && !Array.isArray(body.override)
        ? (body.override as Record<string, unknown>)
        : undefined;
    const hints =
      body.hints && typeof body.hints === 'object' && !Array.isArray(body.hints)
        ? (body.hints as Record<string, unknown>)
        : undefined;
    const requestedTransport = override?.transportMode
      ? String(override.transportMode).toUpperCase()
      : undefined;
    if (requestedTransport && !TRANSPORT_MODES.includes(requestedTransport as TransportMode)) {
      reply.code(400);
      return { error: { code: 'V3_TRANSPORT_MODE_INVALID' } };
    }

    const input: StartDevelopmentExecutionInput = {
      phase: phase as DevelopmentPhase,
      objective: String(body.objective ?? ''),
      projectKey: String(body.projectKey ?? ''),
      repository: {
        path: String(repository.path ?? ''),
        baseRevision: repository.baseRevision ? String(repository.baseRevision) : undefined,
      },
      context: context
        ? {
            previousExecutionId: context.previousExecutionId
              ? String(context.previousExecutionId)
              : undefined,
            previousResult: context.previousResult ? String(context.previousResult) : undefined,
            acceptanceCriteria: Array.isArray(context.acceptanceCriteria)
              ? context.acceptanceCriteria.map(String)
              : undefined,
          }
        : undefined,
      hints: hints
        ? {
            complexity: hints.complexity
              ? (String(hints.complexity).toUpperCase() as 'LOW' | 'MEDIUM' | 'HIGH')
              : undefined,
            risk: hints.risk
              ? (String(hints.risk).toUpperCase() as 'LOW' | 'MEDIUM' | 'HIGH')
              : undefined,
            parallelism: hints.parallelism == null ? undefined : Number(hints.parallelism),
            quality: hints.quality
              ? (String(hints.quality).toUpperCase() as 'FAST' | 'STANDARD' | 'PREMIUM')
              : undefined,
            budget: hints.budget
              ? (String(hints.budget).toUpperCase() as 'LOW' | 'NORMAL' | 'HIGH')
              : undefined,
          }
        : undefined,
      override: override
        ? {
            backend: override.backend ? String(override.backend) : undefined,
            modelClass: override.modelClass ? String(override.modelClass) : undefined,
            transportMode: requestedTransport as TransportMode | undefined,
          }
        : undefined,
      hermes: hermes
        ? {
            profile: hermes.profile ? String(hermes.profile) : undefined,
            sessionId: hermes.sessionId ? String(hermes.sessionId) : undefined,
            turnId: hermes.turnId ? String(hermes.turnId) : undefined,
          }
        : undefined,
      await: body.await == null ? true : body.await !== false,
      timeoutMs: body.timeoutMs == null ? undefined : Number(body.timeoutMs),
    };

    try {
      const snapshot = await service.start(input, idempotencyKey);
      reply.code(201);
      return snapshot;
    } catch (error) {
      const code = errorCode(error);
      request.log.warn({ err: error, code, phase }, 'V3 development execution failed');
      reply.code(errorStatus(code));
      return { error: { code } };
    }
  });

  app.get<{ Params: { executionId: string } }>(
    '/api/v3/development/executions/:executionId',
    async (request, reply) => {
      try {
        const snapshot = await service.get(request.params.executionId);
        if (!snapshot) {
          reply.code(404);
          return { error: { code: 'EXECUTION_NOT_FOUND' } };
        }
        return snapshot;
      } catch (error) {
        const code = errorCode(error);
        reply.code(errorStatus(code));
        return { error: { code } };
      }
    },
  );

  app.post<{ Params: { executionId: string } }>(
    '/api/v3/development/executions/:executionId/cancel',
    async (request, reply) => {
      try {
        const snapshot = await service.cancel(request.params.executionId);
        if (!snapshot) {
          reply.code(404);
          return { error: { code: 'EXECUTION_NOT_FOUND' } };
        }
        return snapshot;
      } catch (error) {
        const code = errorCode(error);
        reply.code(errorStatus(code));
        return { error: { code } };
      }
    },
  );

  app.get('/api/v3/development/executions', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items: await service.list({
        projectKey: typeof query.projectKey === 'string' ? query.projectKey : undefined,
        limit: query.limit == null ? undefined : Number(query.limit),
        offset: query.offset == null ? undefined : Number(query.offset),
        hydrate: query.hydrate === '1' || query.hydrate === 'true',
      }),
    };
  });
}
