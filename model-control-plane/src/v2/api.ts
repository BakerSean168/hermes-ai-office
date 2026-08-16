import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { DispatchService } from './dispatch.js';
import type { GatewayDiscoveryService } from './discovery.js';
import type { FinanceRepository } from './finance.js';
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  type IdempotencyService,
} from './idempotency.js';
import type { InvocationService } from './invocation.js';
import type { WorkforceLifecycleService } from './lifecycle.js';
import type { V2Event, V2Repository } from './repository.js';
import type { SupplyRepository } from './supply.js';
import type { UsageReconciliationService } from './usageReconciliation.js';

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function registerV2Routes(
  app: FastifyInstance,
  repository: V2Repository,
  services: {
    dispatchService?: DispatchService;
    invocationService?: InvocationService;
    lifecycleService?: WorkforceLifecycleService;
    discoveryService?: GatewayDiscoveryService;
    usageReconciliationService?: UsageReconciliationService;
    supply?: SupplyRepository;
    finance?: FinanceRepository;
    idempotencyService?: IdempotencyService;
  } = {},
): void {
  const runCommand = async <T>(input: {
    request: FastifyRequest;
    reply: FastifyReply;
    commandType: string;
    operation: () => Promise<T> | T;
  }): Promise<T | { error: { code: string } }> => {
    const header = input.request.headers['idempotency-key'];
    const key = Array.isArray(header) ? header[0] : header;
    if (!services.idempotencyService) return input.operation();
    try {
      const outcome = await services.idempotencyService.execute({
        key,
        commandType: input.commandType,
        request: {
          params: input.request.params ?? {},
          body: input.request.body ?? null,
        },
        operation: async () => {
          const body = await input.operation();
          return { statusCode: input.reply.statusCode, body };
        },
      });
      input.reply.code(outcome.statusCode);
      if (outcome.replayed) input.reply.header('Idempotency-Replayed', 'true');
      return outcome.body as T;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        input.reply.code(409);
        return { error: { code: 'IDEMPOTENCY_CONFLICT' } };
      }
      if (error instanceof IdempotencyInProgressError) {
        input.reply.code(409);
        return { error: { code: 'IDEMPOTENCY_IN_PROGRESS' } };
      }
      const code = error instanceof Error ? error.message : 'IDEMPOTENCY_FAILED';
      input.reply.code(code === 'IDEMPOTENCY_KEY_TOO_LONG' ? 400 : 500);
      return { error: { code } };
    }
  };

  app.get('/api/v2/health', async () => ({
    status: 'ok',
    service: 'hermes-ai-workforce-domain',
    apiVersion: 2,
    schemaMigrations: repository.db
      .prepare('SELECT id,checksum,applied_at FROM v2_schema_migrations ORDER BY id')
      .all(),
  }));

  app.get('/api/v2/employees', async () => ({ items: repository.listEmployees() }));
  app.get<{ Params: { employeeId: string } }>(
    '/api/v2/employees/:employeeId',
    async (request, reply) => {
      const dossier = repository.employeeDossier(request.params.employeeId);
      if (!dossier) {
        reply.code(404);
        return { error: { code: 'EMPLOYEE_NOT_FOUND' } };
      }
      return dossier;
    },
  );
  app.get<{ Params: { employeeId: string } }>(
    '/api/v2/employees/:employeeId/employments',
    async (request) => ({ items: repository.listEmployments(request.params.employeeId) }),
  );
  app.get<{ Params: { employeeId: string } }>(
    '/api/v2/employees/:employeeId/appointments',
    async (request) => ({
      items: repository.listAppointments({ employeeId: request.params.employeeId }),
    }),
  );
  app.get('/api/v2/employments', async () => ({ items: repository.listEmployments() }));
  app.get('/api/v2/appointments', async () => ({ items: repository.listAppointments() }));
  app.get('/api/v2/positions', async () => ({ items: repository.listPositions() }));
  app.get('/api/v2/gateways', async () => ({ items: repository.listGateways() }));
  app.get('/api/v2/channels', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items: repository.listChannels(
        typeof query.gatewayId === 'string' ? query.gatewayId : undefined,
      ),
    };
  });
  app.get('/api/v2/discovery-runs', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const limit = Math.min(500, Math.max(1, number(query.limit, 50)));
    return {
      items: repository.listDiscoveryRuns(
        typeof query.gatewayDbId === 'string' ? query.gatewayDbId : undefined,
        limit,
      ),
    };
  });

  app.get('/api/v2/supply-agreements', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.supply?.listSupplyAgreements(
          typeof query.supplierId === 'string' ? query.supplierId : undefined,
        ) ?? [],
    };
  });
  app.get('/api/v2/plans', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.supply?.listPlans(
          typeof query.supplierId === 'string' ? query.supplierId : undefined,
        ) ?? [],
    };
  });
  app.get('/api/v2/model-offerings', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.supply?.listModelOfferings({
          supplierId: typeof query.supplierId === 'string' ? query.supplierId : undefined,
          agreementId: typeof query.agreementId === 'string' ? query.agreementId : undefined,
        }) ?? [],
    };
  });
  app.get('/api/v2/capacity-pools', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.supply?.listCapacityPools(
          typeof query.agreementId === 'string' ? query.agreementId : undefined,
        ) ?? [],
    };
  });

  app.get('/api/v2/reference-prices', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.finance?.listReferencePrices(
          typeof query.supplierModelId === 'string' ? query.supplierModelId : undefined,
        ) ?? [],
    };
  });

  app.get('/api/v2/cost-allocation-runs', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.finance?.listAllocationRuns(
          typeof query.agreementId === 'string' ? query.agreementId : undefined,
        ) ?? [],
    };
  });

  app.get('/api/v2/evaluations', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.finance?.listEvaluations({
          employeeId: typeof query.employeeId === 'string' ? query.employeeId : undefined,
          positionId: typeof query.positionId === 'string' ? query.positionId : undefined,
          limit: Math.min(1_000, Math.max(1, number(query.limit, 100))),
        }) ?? [],
    };
  });

  app.get<{ Params: { employeeId: string } }>(
    '/api/v2/employees/:employeeId/performance',
    async (request) => ({
      items: services.finance?.performanceByPosition(request.params.employeeId) ?? [],
    }),
  );

  app.get('/api/v2/usage-evidence', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items: repository.listGatewayUsageEvidence({
        gatewaySlug: typeof query.gatewayId === 'string' ? query.gatewayId : undefined,
        kind: typeof query.kind === 'string' ? query.kind : undefined,
        limit: Math.min(1_000, Math.max(1, number(query.limit, 200))),
      }),
    };
  });

  app.get('/api/v2/usage-reconciliation-runs', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items: repository.listUsageReconciliationRuns(
        typeof query.gatewayId === 'string' ? query.gatewayId : undefined,
        Math.min(500, Math.max(1, number(query.limit, 50))),
      ),
    };
  });

  app.get('/api/v2/runs', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const limit = Math.min(500, Math.max(1, number(query.limit, 100)));
    return { items: repository.listRuns(limit) };
  });
  app.get('/api/v2/duties', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items: repository.listDuties({
        runId: typeof query.runId === 'string' ? query.runId : undefined,
        activeOnly: query.activeOnly === '1' || query.activeOnly === 'true',
      }),
    };
  });
  app.get('/api/v2/invocations', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items: repository.listInvocations({
        dutySessionId: typeof query.dutySessionId === 'string' ? query.dutySessionId : undefined,
        runId: typeof query.runId === 'string' ? query.runId : undefined,
      }),
    };
  });
  app.get('/api/v2/usage', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items: repository.listUsage({
        employeeId: typeof query.employeeId === 'string' ? query.employeeId : undefined,
        dutySessionId: typeof query.dutySessionId === 'string' ? query.dutySessionId : undefined,
        runId: typeof query.runId === 'string' ? query.runId : undefined,
      }),
    };
  });

  app.get('/api/v2/dispatch-decisions', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items: repository.listDispatchDecisions(
        typeof query.dutySessionId === 'string' ? query.dutySessionId : undefined,
      ),
    };
  });

  app.post('/api/v2/commands/runs/create', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'run.create',
      operation: () => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.workScopeId || !body.title) {
          reply.code(400);
          return { error: { code: 'WORK_SCOPE_AND_TITLE_REQUIRED' } };
        }
        try {
          return repository.createRun({
            workScopeId: String(body.workScopeId),
            title: String(body.title),
            externalRunRef: body.externalRunRef ? String(body.externalRunRef) : undefined,
            metadata:
              body.metadata && typeof body.metadata === 'object'
                ? (body.metadata as Record<string, unknown>)
                : undefined,
          });
        } catch (error) {
          reply.code(422);
          return {
            error: { code: error instanceof Error ? error.message : 'RUN_CREATE_FAILED' },
          };
        }
      },
    }),
  );

  app.post('/api/v2/commands/duties/open', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'duty.open',
      operation: () => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.runId || !body.positionId) {
          reply.code(400);
          return { error: { code: 'RUN_AND_POSITION_REQUIRED' } };
        }
        try {
          return repository.openDuty({
            runId: String(body.runId),
            positionId: String(body.positionId),
            activity: body.activity ? String(body.activity) : undefined,
            metadata:
              body.metadata && typeof body.metadata === 'object'
                ? (body.metadata as Record<string, unknown>)
                : undefined,
          });
        } catch (error) {
          reply.code(422);
          return {
            error: { code: error instanceof Error ? error.message : 'DUTY_OPEN_FAILED' },
          };
        }
      },
    }),
  );

  app.post<{ Params: { dutySessionId: string } }>(
    '/api/v2/commands/duties/:dutySessionId/dispatch',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'duty.dispatch',
        operation: async () => {
          if (!services.dispatchService) {
            reply.code(503);
            return { error: { code: 'DISPATCH_SERVICE_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          try {
            const result = await services.dispatchService.dispatchDuty(
              request.params.dutySessionId,
              {
                trigger: body.trigger ? String(body.trigger) : undefined,
                correlationId: body.correlationId ? String(body.correlationId) : undefined,
              },
            );
            if (!result.selected) reply.code(422);
            return result;
          } catch (error) {
            const code = error instanceof Error ? error.message : 'DISPATCH_FAILED';
            reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
            return { error: { code } };
          }
        },
      }),
  );

  app.post('/api/v2/commands/plans/create', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'plan.create',
      operation: () => {
        if (!services.supply) {
          reply.code(503);
          return { error: { code: 'SUPPLY_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.supplierId || !body.slug || !body.name) {
          reply.code(400);
          return { error: { code: 'SUPPLIER_SLUG_AND_NAME_REQUIRED' } };
        }
        return services.supply.getOrCreatePlan({
          supplierId: String(body.supplierId),
          slug: String(body.slug),
          name: String(body.name),
          commercialType: body.commercialType
            ? (String(body.commercialType) as
                'FREE' | 'SUBSCRIPTION' | 'PREPAID' | 'METERED' | 'SPONSORED' | 'OTHER')
            : undefined,
          terms:
            body.terms && typeof body.terms === 'object'
              ? (body.terms as Record<string, unknown>)
              : undefined,
        });
      },
    }),
  );

  app.post('/api/v2/commands/model-offerings/create', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'model-offering.create',
      operation: () => {
        if (!services.supply) {
          reply.code(503);
          return { error: { code: 'SUPPLY_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.supplierId || !body.supplierModelId) {
          reply.code(400);
          return { error: { code: 'SUPPLIER_AND_MODEL_REQUIRED' } };
        }
        return services.supply.getOrCreateModelOffering({
          supplierId: String(body.supplierId),
          supplierModelId: String(body.supplierModelId),
          planId: body.planId ? String(body.planId) : undefined,
          supplyAgreementId: body.supplyAgreementId ? String(body.supplyAgreementId) : undefined,
          advertisedCapabilities: Array.isArray(body.advertisedCapabilities)
            ? body.advertisedCapabilities.map(String)
            : undefined,
          protocolOptions: Array.isArray(body.protocolOptions)
            ? body.protocolOptions.map(String)
            : undefined,
          commercialMetadata:
            body.commercialMetadata && typeof body.commercialMetadata === 'object'
              ? (body.commercialMetadata as Record<string, unknown>)
              : undefined,
        });
      },
    }),
  );

  app.post('/api/v2/commands/capacity-pools/upsert', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'capacity-pool.upsert',
      operation: () => {
        if (!services.supply) {
          reply.code(503);
          return { error: { code: 'SUPPLY_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.supplyAgreementId || !body.name || !body.dimension || !body.source) {
          reply.code(400);
          return { error: { code: 'CAPACITY_POOL_FIELDS_REQUIRED' } };
        }
        return services.supply.upsertCapacityPool({
          supplyAgreementId: String(body.supplyAgreementId),
          name: String(body.name),
          dimension: String(body.dimension) as
            'TOKENS' | 'REQUESTS' | 'COST' | 'CONCURRENCY' | 'CUSTOM',
          limit: body.limit == null ? undefined : Number(body.limit),
          remaining: body.remaining == null ? undefined : Number(body.remaining),
          unit: body.unit ? String(body.unit) : undefined,
          resetAt: body.resetAt == null ? undefined : Number(body.resetAt),
          lifecycle: body.lifecycle
            ? (String(body.lifecycle) as 'ACTIVE' | 'SUSPENDED' | 'RETIRED')
            : undefined,
          source: String(body.source),
          metadata:
            body.metadata && typeof body.metadata === 'object'
              ? (body.metadata as Record<string, unknown>)
              : undefined,
          observedAt: body.observedAt == null ? undefined : Number(body.observedAt),
        });
      },
    }),
  );

  app.post<{ Params: { agreementId: string } }>(
    '/api/v2/commands/supply-agreements/:agreementId/set-plan',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'supply-agreement.set-plan',
        operation: () => {
          if (!services.supply) {
            reply.code(503);
            return { error: { code: 'SUPPLY_SERVICE_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          if (!body.planId) {
            reply.code(400);
            return { error: { code: 'PLAN_REQUIRED' } };
          }
          try {
            return services.supply.assignPlanToAgreement(
              request.params.agreementId,
              String(body.planId),
            );
          } catch (error) {
            const code = error instanceof Error ? error.message : 'PLAN_ASSIGNMENT_FAILED';
            reply.code(code.endsWith('_NOT_FOUND') ? 404 : 409);
            return { error: { code } };
          }
        },
      }),
  );

  app.post<{ Params: { employmentId: string } }>(
    '/api/v2/commands/employments/:employmentId/set-offering',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'employment.set-offering',
        operation: () => {
          if (!services.supply) {
            reply.code(503);
            return { error: { code: 'SUPPLY_SERVICE_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          if (!body.offeringId) {
            reply.code(400);
            return { error: { code: 'OFFERING_REQUIRED' } };
          }
          try {
            return services.supply.assignOfferingToEmployment(
              request.params.employmentId,
              String(body.offeringId),
            );
          } catch (error) {
            const code = error instanceof Error ? error.message : 'OFFERING_ASSIGNMENT_FAILED';
            reply.code(code.endsWith('_NOT_FOUND') ? 404 : 409);
            return { error: { code } };
          }
        },
      }),
  );

  app.post('/api/v2/commands/reference-prices/create', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'reference-price.create',
      operation: () => {
        if (!services.finance) {
          reply.code(503);
          return { error: { code: 'FINANCE_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.supplierModelId || !body.name || !body.source) {
          reply.code(400);
          return { error: { code: 'REFERENCE_PRICE_FIELDS_REQUIRED' } };
        }
        try {
          return services.finance.createReferencePrice({
            supplierModelId: String(body.supplierModelId),
            name: String(body.name),
            inputPerMillion:
              body.inputPerMillion == null ? undefined : Number(body.inputPerMillion),
            outputPerMillion:
              body.outputPerMillion == null ? undefined : Number(body.outputPerMillion),
            cacheReadPerMillion:
              body.cacheReadPerMillion == null ? undefined : Number(body.cacheReadPerMillion),
            cacheWritePerMillion:
              body.cacheWritePerMillion == null ? undefined : Number(body.cacheWritePerMillion),
            reasoningPerMillion:
              body.reasoningPerMillion == null ? undefined : Number(body.reasoningPerMillion),
            currency: body.currency ? String(body.currency) : undefined,
            source: String(body.source),
            effectiveFrom: body.effectiveFrom == null ? undefined : Number(body.effectiveFrom),
            effectiveTo: body.effectiveTo == null ? undefined : Number(body.effectiveTo),
            metadata:
              body.metadata && typeof body.metadata === 'object'
                ? (body.metadata as Record<string, unknown>)
                : undefined,
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : 'REFERENCE_PRICE_CREATE_FAILED';
          reply.code(code.includes('FOREIGN KEY') ? 404 : 422);
          return { error: { code } };
        }
      },
    }),
  );

  app.post<{ Params: { priceId: string } }>(
    '/api/v2/commands/reference-prices/:priceId/apply',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'reference-price.apply',
        operation: () => {
          if (!services.finance) {
            reply.code(503);
            return { error: { code: 'FINANCE_SERVICE_UNAVAILABLE' } };
          }
          try {
            return services.finance.applyReferencePrice(request.params.priceId);
          } catch (error) {
            const code = error instanceof Error ? error.message : 'REFERENCE_PRICE_APPLY_FAILED';
            reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
            return { error: { code } };
          }
        },
      }),
  );

  app.post<{ Params: { agreementId: string } }>(
    '/api/v2/commands/supply-agreements/:agreementId/commercial-terms',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'supply-agreement.commercial-terms',
        operation: () => {
          if (!services.supply) {
            reply.code(503);
            return { error: { code: 'SUPPLY_SERVICE_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          try {
            return services.supply.updateAgreementCommercialTerms(request.params.agreementId, {
              fixedCost:
                body.fixedCost === undefined
                  ? undefined
                  : body.fixedCost === null
                    ? null
                    : Number(body.fixedCost),
              currency:
                body.currency === undefined
                  ? undefined
                  : body.currency === null
                    ? null
                    : String(body.currency),
              billingPeriod:
                body.billingPeriod === undefined
                  ? undefined
                  : body.billingPeriod === null
                    ? null
                    : String(body.billingPeriod),
            });
          } catch (error) {
            const code = error instanceof Error ? error.message : 'COMMERCIAL_TERMS_UPDATE_FAILED';
            reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
            return { error: { code } };
          }
        },
      }),
  );

  app.post<{ Params: { agreementId: string } }>(
    '/api/v2/commands/supply-agreements/:agreementId/allocate-cost',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'supply-agreement.allocate-cost',
        operation: () => {
          if (!services.finance) {
            reply.code(503);
            return { error: { code: 'FINANCE_SERVICE_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          if (body.periodStart == null || body.periodEnd == null) {
            reply.code(400);
            return { error: { code: 'ALLOCATION_PERIOD_REQUIRED' } };
          }
          try {
            return services.finance.allocateAgreementCost({
              supplyAgreementId: request.params.agreementId,
              periodStart: Number(body.periodStart),
              periodEnd: Number(body.periodEnd),
              basis: body.basis ? (String(body.basis) as 'TOKENS' | 'REQUESTS') : undefined,
              fixedCost: body.fixedCost == null ? undefined : Number(body.fixedCost),
              currency: body.currency ? String(body.currency) : undefined,
              policy:
                body.policy && typeof body.policy === 'object'
                  ? (body.policy as Record<string, unknown>)
                  : undefined,
            });
          } catch (error) {
            const code = error instanceof Error ? error.message : 'COST_ALLOCATION_FAILED';
            reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
            return { error: { code } };
          }
        },
      }),
  );

  app.post('/api/v2/commands/evaluations/record', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'evaluation.record',
      operation: () => {
        if (!services.finance) {
          reply.code(503);
          return { error: { code: 'FINANCE_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (
          !body.subjectType ||
          !body.subjectId ||
          !body.source ||
          !body.dimensions ||
          typeof body.dimensions !== 'object' ||
          Array.isArray(body.dimensions)
        ) {
          reply.code(400);
          return { error: { code: 'EVALUATION_FIELDS_REQUIRED' } };
        }
        try {
          return services.finance.recordEvaluation({
            subjectType: String(body.subjectType),
            subjectId: String(body.subjectId),
            roleId: body.roleId ? String(body.roleId) : undefined,
            positionId: body.positionId ? String(body.positionId) : undefined,
            employeeId: body.employeeId ? String(body.employeeId) : undefined,
            dimensions: body.dimensions as Record<string, number | boolean | string>,
            source: String(body.source),
            recordedAt: body.recordedAt == null ? undefined : Number(body.recordedAt),
            metadata:
              body.metadata && typeof body.metadata === 'object'
                ? (body.metadata as Record<string, unknown>)
                : undefined,
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : 'EVALUATION_RECORD_FAILED';
          reply.code(code.includes('FOREIGN KEY') ? 404 : 422);
          return { error: { code } };
        }
      },
    }),
  );

  app.post<{ Params: { gatewayId: string } }>(
    '/api/v2/internal/gateways/:gatewayId/discover',
    async (request, reply) => {
      if (!services.discoveryService) {
        reply.code(503);
        return { error: { code: 'GATEWAY_DISCOVERY_SERVICE_UNAVAILABLE' } };
      }
      try {
        return await services.discoveryService.reconcile(request.params.gatewayId);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'GATEWAY_DISCOVERY_FAILED';
        reply.code(code === 'GATEWAY_DISCOVERY_UNAVAILABLE' ? 404 : 502);
        return { error: { code } };
      }
    },
  );

  app.post('/api/v2/internal/gateways/discover', async (_request, reply) => {
    if (!services.discoveryService) {
      reply.code(503);
      return { error: { code: 'GATEWAY_DISCOVERY_SERVICE_UNAVAILABLE' } };
    }
    try {
      return { items: await services.discoveryService.reconcileAll() };
    } catch (error) {
      reply.code(502);
      return {
        error: {
          code: error instanceof Error ? error.message : 'GATEWAY_DISCOVERY_FAILED',
        },
      };
    }
  });

  app.post<{ Params: { gatewayId: string } }>(
    '/api/v2/internal/gateways/:gatewayId/reconcile-usage',
    async (request, reply) => {
      if (!services.usageReconciliationService) {
        reply.code(503);
        return { error: { code: 'USAGE_RECONCILIATION_SERVICE_UNAVAILABLE' } };
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      try {
        return await services.usageReconciliationService.reconcile(
          request.params.gatewayId,
          typeof body.cursor === 'string' ? body.cursor : undefined,
        );
      } catch (error) {
        const code = error instanceof Error ? error.message : 'USAGE_RECONCILIATION_FAILED';
        reply.code(
          code === 'GATEWAY_USAGE_UNAVAILABLE' || code === 'GATEWAY_NOT_REGISTERED' ? 404 : 502,
        );
        return { error: { code } };
      }
    },
  );

  app.post('/api/v2/internal/gateways/reconcile-usage', async (_request, reply) => {
    if (!services.usageReconciliationService) {
      reply.code(503);
      return { error: { code: 'USAGE_RECONCILIATION_SERVICE_UNAVAILABLE' } };
    }
    try {
      return { items: await services.usageReconciliationService.reconcileAll() };
    } catch (error) {
      reply.code(502);
      return {
        error: { code: error instanceof Error ? error.message : 'USAGE_RECONCILIATION_FAILED' },
      };
    }
  });

  const lifecycleError = (error: unknown): { status: number; code: string } => {
    const code = error instanceof Error ? error.message : 'LIFECYCLE_COMMAND_FAILED';
    if (code.endsWith('_NOT_FOUND')) return { status: 404, code };
    if (
      code.endsWith('_NOT_SUSPENDABLE') ||
      code.endsWith('_NOT_RESUMABLE') ||
      code.endsWith('_NOT_ENDABLE')
    ) {
      return { status: 409, code };
    }
    return { status: 422, code };
  };

  for (const action of ['suspend', 'resume', 'end'] as const) {
    app.post<{ Params: { employmentId: string } }>(
      `/api/v2/commands/employments/:employmentId/${action}`,
      async (request, reply) => {
        if (!services.lifecycleService) {
          reply.code(503);
          return { error: { code: 'LIFECYCLE_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        try {
          if (action === 'suspend') {
            return await services.lifecycleService.suspendEmployment(request.params.employmentId, {
              reason: body.reason ? String(body.reason) : undefined,
              correlationId: body.correlationId ? String(body.correlationId) : undefined,
            });
          }
          if (action === 'resume') {
            return await services.lifecycleService.resumeEmployment(request.params.employmentId, {
              correlationId: body.correlationId ? String(body.correlationId) : undefined,
            });
          }
          return await services.lifecycleService.endEmployment(request.params.employmentId, {
            reason: body.reason ? String(body.reason) : undefined,
            correlationId: body.correlationId ? String(body.correlationId) : undefined,
          });
        } catch (error) {
          const failure = lifecycleError(error);
          reply.code(failure.status);
          return { error: { code: failure.code } };
        }
      },
    );
  }

  for (const action of ['suspend', 'resume', 'end'] as const) {
    app.post<{ Params: { appointmentId: string } }>(
      `/api/v2/commands/appointments/:appointmentId/${action}`,
      async (request, reply) => {
        if (!services.lifecycleService) {
          reply.code(503);
          return { error: { code: 'LIFECYCLE_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        try {
          if (action === 'suspend') {
            return await services.lifecycleService.suspendAppointment(
              request.params.appointmentId,
              {
                reason: body.reason ? String(body.reason) : undefined,
                correlationId: body.correlationId ? String(body.correlationId) : undefined,
              },
            );
          }
          if (action === 'resume') {
            return await services.lifecycleService.resumeAppointment(request.params.appointmentId, {
              correlationId: body.correlationId ? String(body.correlationId) : undefined,
            });
          }
          return await services.lifecycleService.endAppointment(request.params.appointmentId, {
            reason: body.reason ? String(body.reason) : undefined,
            correlationId: body.correlationId ? String(body.correlationId) : undefined,
          });
        } catch (error) {
          const failure = lifecycleError(error);
          reply.code(failure.status);
          return { error: { code: failure.code } };
        }
      },
    );
  }

  app.post<{ Params: { dutySessionId: string } }>(
    '/api/v2/commands/duties/:dutySessionId/redispatch',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'duty.redispatch',
        operation: async () => {
          if (!services.dispatchService) {
            reply.code(503);
            return { error: { code: 'DISPATCH_SERVICE_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          try {
            const result = await services.dispatchService.dispatchDuty(
              request.params.dutySessionId,
              {
                trigger: body.trigger ? String(body.trigger) : 'OPERATOR_REDISPATCH',
                correlationId: body.correlationId ? String(body.correlationId) : undefined,
              },
            );
            if (!result.selected) reply.code(422);
            return result;
          } catch (error) {
            const code = error instanceof Error ? error.message : 'REDISPATCH_FAILED';
            reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
            return { error: { code } };
          }
        },
      }),
  );

  app.post<{ Params: { dutySessionId: string } }>(
    '/api/v2/internal/duties/:dutySessionId/invoke',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'duty.invoke',
        operation: async () => {
          if (!services.invocationService) {
            reply.code(503);
            return { error: { code: 'INVOCATION_SERVICE_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          if (typeof body.input !== 'string' || !body.input.trim()) {
            reply.code(400);
            return { error: { code: 'INVOCATION_INPUT_REQUIRED' } };
          }
          try {
            return await services.invocationService.invokeDuty(
              request.params.dutySessionId,
              body.input,
              {
                maxOutputTokens: body.maxOutputTokens
                  ? Math.max(1, Math.min(8_192, Number(body.maxOutputTokens)))
                  : undefined,
                correlationId: body.correlationId ? String(body.correlationId) : undefined,
                runtimeSessionRef: body.runtimeSessionRef
                  ? String(body.runtimeSessionRef)
                  : undefined,
                completeDuty: body.completeDuty !== false,
              },
            );
          } catch (error) {
            const code = error instanceof Error ? error.message : 'INVOCATION_FAILED';
            if (code.endsWith('_NOT_FOUND')) reply.code(404);
            else if (code === 'INVOCATION_INPUT_REQUIRED') reply.code(400);
            else if (
              code.startsWith('GATEWAY_') ||
              code.startsWith('LITELLM_') ||
              code === 'EMPLOYMENT_ROUTE_UNAVAILABLE'
            ) {
              reply.code(502);
            } else reply.code(422);
            return { error: { code } };
          }
        },
      }),
  );

  app.get('/api/v2/projections/workforce', async () => repository.workforceProjection());
  app.get<{ Params: { employeeId: string } }>(
    '/api/v2/projections/employees/:employeeId/dossier',
    async (request, reply) => {
      const dossier = repository.employeeDossier(request.params.employeeId);
      if (!dossier) {
        reply.code(404);
        return { error: { code: 'EMPLOYEE_NOT_FOUND' } };
      }
      return dossier;
    },
  );

  app.get('/api/v2/events/history', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const after = Math.max(0, number(query.after, 0));
    const limit = Math.min(1_000, Math.max(1, number(query.limit, 500)));
    return { items: repository.eventsAfter(after, limit) };
  });

  app.get('/api/v2/events', async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const header = request.headers['last-event-id'];
    const after = Math.max(
      0,
      number(query.after ?? (Array.isArray(header) ? header[0] : header), 0),
    );
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const write = (event: V2Event): void => {
      reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    for (const event of repository.eventsAfter(after, 500)) write(event as V2Event);
    const unsubscribe = repository.subscribe(write);
    const timer = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    request.raw.on('close', () => {
      clearInterval(timer);
      unsubscribe();
    });
  });
}
