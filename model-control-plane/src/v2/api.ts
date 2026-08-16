import type { FastifyInstance } from 'fastify';

import type { DispatchService } from './dispatch.js';
import type { InvocationService } from './invocation.js';
import type { V2Event, V2Repository } from './repository.js';

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function registerV2Routes(
  app: FastifyInstance,
  repository: V2Repository,
  services: { dispatchService?: DispatchService; invocationService?: InvocationService } = {},
): void {
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

  app.post('/api/v2/commands/runs/create', async (request, reply) => {
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
      return { error: { code: error instanceof Error ? error.message : 'RUN_CREATE_FAILED' } };
    }
  });

  app.post('/api/v2/commands/duties/open', async (request, reply) => {
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
      return { error: { code: error instanceof Error ? error.message : 'DUTY_OPEN_FAILED' } };
    }
  });

  app.post<{ Params: { dutySessionId: string } }>(
    '/api/v2/commands/duties/:dutySessionId/dispatch',
    async (request, reply) => {
      if (!services.dispatchService) {
        reply.code(503);
        return { error: { code: 'DISPATCH_SERVICE_UNAVAILABLE' } };
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      try {
        const result = await services.dispatchService.dispatchDuty(request.params.dutySessionId, {
          trigger: body.trigger ? String(body.trigger) : undefined,
          correlationId: body.correlationId ? String(body.correlationId) : undefined,
        });
        if (!result.selected) reply.code(422);
        return result;
      } catch (error) {
        const code = error instanceof Error ? error.message : 'DISPATCH_FAILED';
        reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
        return { error: { code } };
      }
    },
  );

  app.post<{ Params: { dutySessionId: string } }>(
    '/api/v2/internal/duties/:dutySessionId/invoke',
    async (request, reply) => {
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
            runtimeSessionRef: body.runtimeSessionRef ? String(body.runtimeSessionRef) : undefined,
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
