import type { FastifyInstance } from 'fastify';

import type { V2Event, V2Repository } from './repository.js';

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function registerV2Routes(app: FastifyInstance, repository: V2Repository): void {
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
