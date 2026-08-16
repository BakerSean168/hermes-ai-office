import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { DispatchService } from './dispatch.js';
import type { GatewayDiscoveryService } from './discovery.js';
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  type IdempotencyService,
} from './idempotency.js';
import type { InvocationService } from './invocation.js';
import type { WorkforceLifecycleService } from './lifecycle.js';
import type { V2Event, V2Repository } from './repository.js';

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
