import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

import type { GitHubPullRequestIntakePort } from './githubPrIntake.js';
import type { JulesApiPort } from './jules.js';
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
  if (code.includes('UNAVAILABLE') || code.includes('UNCONFIGURED')) return 503;
  if (code === 'GITHUB_PR_COMMAND_FAILED') return 502;
  if (
    code.endsWith('_REQUIRED') ||
    code.endsWith('_INVALID') ||
    code.includes('NOT_ALLOWED') ||
    code.includes('UNSUPPORTED')
  )
    return 400;
  if (
    code.includes('CONCURRENCY') ||
    code.includes('CHANGED_DURING') ||
    code.includes('MISMATCH') ||
    code.endsWith('_NOT_OPEN') ||
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
  pullRequestIntake?: GitHubPullRequestIntakePort,
  githubEventToken?: string,
  jules?: JulesApiPort,
): void {
  app.get('/api/v3/health', async () => ({
    status: 'ok',
    service: 'hermes-ai-office-v3',
    apiVersion: 3,
    mode: 'production',
  }));

  app.get('/api/v3/development/runtime-summary', async () => service.runtimeSummary());

  app.get('/api/v3/development/jules/source', async (request, reply) => {
    if (!jules) {
      reply.code(503);
      return { error: { code: 'JULES_API_UNCONFIGURED' } };
    }
    const query = (request.query ?? {}) as Record<string, unknown>;
    try {
      const source = await jules.findSource(String(query.repository ?? ''));
      if (!source) {
        reply.code(404);
        return { error: { code: 'JULES_SOURCE_NOT_FOUND' } };
      }
      return source;
    } catch (error) {
      const code = errorCode(error);
      reply.code(errorStatus(code));
      return { error: { code } };
    }
  });

  app.post('/api/v3/development/jules/sessions', async (request, reply) => {
    if (!jules) {
      reply.code(503);
      return { error: { code: 'JULES_API_UNCONFIGURED' } };
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const session = await jules.createSession({
        repository: String(body.repository ?? ''),
        startingBranch: String(body.startingBranch ?? ''),
        prompt: String(body.prompt ?? ''),
        title: body.title ? String(body.title) : undefined,
        requirePlanApproval: body.requirePlanApproval === true,
        autoCreatePullRequest: body.autoCreatePullRequest === true,
      });
      reply.code(201);
      return session;
    } catch (error) {
      const code = errorCode(error);
      reply.code(errorStatus(code));
      return { error: { code } };
    }
  });

  app.get<{ Params: { sessionId: string } }>(
    '/api/v3/development/jules/sessions/:sessionId',
    async (request, reply) => {
      if (!jules) {
        reply.code(503);
        return { error: { code: 'JULES_API_UNCONFIGURED' } };
      }
      try {
        return await jules.getSession(`sessions/${request.params.sessionId}`);
      } catch (error) {
        const code = errorCode(error);
        reply.code(errorStatus(code));
        return { error: { code } };
      }
    },
  );

  const createGitHubGovernancePlan = async (input: {
    projectKey: string;
    repositoryPath: string;
    remote?: string;
    pullRequestNumber: number;
    expectedRepository?: string;
    reviewBackend?: string;
    repairBackend?: string;
    acceptanceCriteria?: string[];
  }) => {
    if (!pullRequestIntake) throw new Error('GITHUB_PR_INTAKE_UNCONFIGURED');
    if (!input.projectKey.trim()) throw new Error('PROJECT_KEY_REQUIRED');
    if (!input.repositoryPath.trim()) throw new Error('REPOSITORY_PATH_REQUIRED');
    const source = await pullRequestIntake.resolve({
      repositoryPath: input.repositoryPath,
      pullRequestNumber: input.pullRequestNumber,
      remote: input.remote,
    });
    if (input.expectedRepository && source.repository !== input.expectedRepository) {
      throw new Error('GITHUB_PR_REPOSITORY_MISMATCH');
    }
    for (const backend of [input.reviewBackend, input.repairBackend].filter(Boolean) as string[]) {
      if (!policy.backend(backend)?.enabled) throw new Error('GITHUB_PR_BACKEND_INVALID');
    }
    const acceptanceCriteria = [
      'The claimed problem is supported by repository evidence; otherwise return INVALID without starting a repair writer.',
      'The proposed change preserves existing public contracts and architecture boundaries.',
      'Focused verification covers the behavior changed by the pull request.',
      ...(input.acceptanceCriteria ?? []),
    ];
    return service.createPlan(
      {
        projectKey: input.projectKey,
        objective: `Govern GitHub pull request ${source.repository}#${source.number} at its exact head revision.`,
        analysisSummary:
          'GitHub PR intake resolved and fetched exact base/head revisions. Pull-request prose is retained only as metadata; repository evidence is authoritative.',
        repository: { path: input.repositoryPath, baseRevision: source.baseRevision },
        source: {
          kind: 'EXTERNAL_CHANGE',
          revision: source.headRevision,
          reviewBackend: input.reviewBackend,
          repairBackend: input.repairBackend,
          origin: {
            kind: 'GITHUB_PULL_REQUEST',
            repository: source.repository,
            pullRequestNumber: source.number,
            pullRequestUrl: source.url,
            title: source.title,
            author: source.author,
            headRef: source.headRef,
            baseRef: source.baseRef,
            headRepository: source.headRepository,
            producer: source.author === 'google-labs-jules[bot]' ? 'JULES' : 'UNKNOWN',
          },
        },
        batches: [
          {
            key: 'external-pr',
            title: 'Validate external pull request',
            workItems: [
              {
                key: 'external-pr-change',
                title: 'Validate and review external change',
                objective:
                  'Independently verify whether the claimed problem exists, then review the exact Git diff for correctness, regressions, contract preservation, and architectural quality.',
                acceptanceCriteria,
              },
            ],
          },
        ],
      },
      `github-pr:${source.repository}:${source.number}:${source.headRevision}`,
    );
  };

  app.post('/api/v3/development/external-changes/github', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const repository =
      body.repository && typeof body.repository === 'object' && !Array.isArray(body.repository)
        ? (body.repository as Record<string, unknown>)
        : {};
    const pullRequest =
      body.pullRequest && typeof body.pullRequest === 'object' && !Array.isArray(body.pullRequest)
        ? (body.pullRequest as Record<string, unknown>)
        : {};
    try {
      const plan = await createGitHubGovernancePlan({
        projectKey: String(body.projectKey ?? '').trim(),
        repositoryPath: String(repository.path ?? '').trim(),
        remote: repository.remote ? String(repository.remote) : undefined,
        pullRequestNumber: Number(pullRequest.number),
        reviewBackend: body.reviewBackend ? String(body.reviewBackend).trim() : undefined,
        repairBackend: body.repairBackend ? String(body.repairBackend).trim() : undefined,
        acceptanceCriteria: Array.isArray(body.acceptanceCriteria)
          ? body.acceptanceCriteria.map(String)
          : undefined,
      });
      reply.code(201);
      return plan;
    } catch (error) {
      const code = errorCode(error);
      reply.code(errorStatus(code));
      return { error: { code } };
    }
  });

  const validEventToken = (header: string | string[] | undefined): boolean => {
    const expected = githubEventToken?.trim();
    const supplied = (Array.isArray(header) ? header[0] : header)?.trim();
    if (!expected || !supplied) return false;
    const expectedBytes = Buffer.from(expected);
    const suppliedBytes = Buffer.from(supplied);
    return (
      expectedBytes.length === suppliedBytes.length &&
      timingSafeEqual(expectedBytes, suppliedBytes)
    );
  };

  app.post('/api/v3/development/external-changes/github/events', async (request, reply) => {
    if (!githubEventToken?.trim()) {
      reply.code(503);
      return { error: { code: 'GITHUB_EVENT_BRIDGE_UNCONFIGURED' } };
    }
    if (!validEventToken(request.headers['x-hermes-event-token'])) {
      reply.code(401);
      return { error: { code: 'GITHUB_EVENT_BRIDGE_UNAUTHORIZED' } };
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const event = String(body.event ?? '').trim().toLowerCase();
    const action = String(body.action ?? '').trim().toLowerCase();
    if (event !== 'pull_request') {
      reply.code(202);
      return { accepted: false, ignored: true, reason: 'EVENT_NOT_GOVERNED' };
    }
    if (!['opened', 'reopened', 'synchronize'].includes(action)) {
      reply.code(202);
      return { accepted: false, ignored: true, reason: 'PULL_REQUEST_ACTION_NOT_GOVERNED' };
    }
    const repository =
      body.repository && typeof body.repository === 'object' && !Array.isArray(body.repository)
        ? (body.repository as Record<string, unknown>)
        : {};
    const pullRequest =
      body.pullRequest && typeof body.pullRequest === 'object' && !Array.isArray(body.pullRequest)
        ? (body.pullRequest as Record<string, unknown>)
        : {};
    try {
      const eventHeadRevision = pullRequest.headSha ? String(pullRequest.headSha).trim() : undefined;
      const plan = await createGitHubGovernancePlan({
        projectKey: String(body.projectKey ?? '').trim(),
        repositoryPath: String(repository.path ?? '').trim(),
        remote: repository.remote ? String(repository.remote) : undefined,
        expectedRepository: repository.fullName ? String(repository.fullName).trim() : undefined,
        pullRequestNumber: Number(pullRequest.number),
        reviewBackend: body.reviewBackend ? String(body.reviewBackend).trim() : undefined,
        repairBackend: body.repairBackend ? String(body.repairBackend).trim() : undefined,
        acceptanceCriteria: Array.isArray(body.acceptanceCriteria)
          ? body.acceptanceCriteria.map(String)
          : undefined,
      });
      const governedHeadRevision =
        plan.source.kind === 'EXTERNAL_CHANGE' ? plan.source.revision : undefined;
      reply.code(202);
      return {
        accepted: true,
        action,
        planId: plan.planId,
        eventHeadRevision,
        governedHeadRevision,
        coalescedToCurrentHead: Boolean(
          eventHeadRevision && governedHeadRevision && eventHeadRevision !== governedHeadRevision,
        ),
      };
    } catch (error) {
      const code = errorCode(error);
      reply.code(errorStatus(code));
      return { error: { code } };
    }
  });

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
                ...(source.reviewBackend ? { reviewBackend: String(source.reviewBackend) } : {}),
                ...(source.repairBackend ? { repairBackend: String(source.repairBackend) } : {}),
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
