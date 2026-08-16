import { createServer, type Server } from 'node:http';

import Fastify from 'fastify';
import { expect, it } from 'vitest';

import { registerModelControlPlaneRoutes } from '../src/httpServer.js';

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('missing test address'));
      else resolve(address.port);
    });
  });
}

it('Pixel backend proxies V2 workforce and employee dossier without exposing upstream URL', async () => {
  const upstream = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/v2/projections/workforce') {
      response.end(
        JSON.stringify({
          projectionVersion: 2,
          summary: { employees: 1, employed: 1, currentDuties: 0 },
          employees: [{ id: 'emp_1', displayName: 'DeepSeek @ Planner Pool' }],
          gateways: [],
        }),
      );
      return;
    }
    if (request.url === '/api/v2/projections/employees/emp_1/dossier') {
      response.end(
        JSON.stringify({
          identity: { id: 'emp_1', displayName: 'DeepSeek @ Planner Pool' },
          cooperation: { state: 'EMPLOYED' },
        }),
      );
      return;
    }
    if (request.url === '/api/v2/projections/office') {
      response.end(
        JSON.stringify({ projectionVersion: 2, summary: { positions: 1 }, positions: [] }),
      );
      return;
    }
    if (request.url === '/api/v2/incidents?limit=20') {
      response.end(JSON.stringify({ items: [{ id: 'inc_1', lifecycle: 'OPEN' }] }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: 'not-found' }));
  });
  const port = await listen(upstream);
  const previousUrl = process.env.MODEL_CONTROL_PLANE_URL;
  process.env.MODEL_CONTROL_PLANE_URL = `http://127.0.0.1:${port}`;
  const app = Fastify();
  registerModelControlPlaneRoutes(app);

  try {
    const workforce = await app.inject({ method: 'GET', url: '/api/model/v2/workforce' });
    expect(workforce.statusCode).toBe(200);
    expect(workforce.json().employees[0].id).toBe('emp_1');
    expect(JSON.stringify(workforce.json())).not.toContain(String(port));

    const dossier = await app.inject({
      method: 'GET',
      url: '/api/model/v2/employees/emp_1/dossier',
    });
    expect(dossier.statusCode).toBe(200);
    expect(dossier.json().cooperation.state).toBe('EMPLOYED');

    const office = await app.inject({
      method: 'GET',
      url: '/api/model/v2/projections/office',
    });
    expect(office.statusCode).toBe(200);
    expect(office.json().summary.positions).toBe(1);

    const incidents = await app.inject({
      method: 'GET',
      url: '/api/model/v2/incidents?limit=20',
    });
    expect(incidents.statusCode).toBe(200);
    expect(incidents.json().items[0].id).toBe('inc_1');

    const missing = await app.inject({
      method: 'GET',
      url: '/api/model/v2/employees/emp_missing/dossier',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('model-control-plane-v2-employee-not-found');

    for (const retired of [
      { method: 'GET' as const, url: '/api/model/workforce' },
      { method: 'GET' as const, url: '/api/model/config' },
      { method: 'GET' as const, url: '/api/model/events' },
      { method: 'POST' as const, url: '/api/model/admin/channels' },
    ]) {
      const response = await app.inject(retired);
      expect(response.statusCode).toBe(404);
    }
  } finally {
    if (previousUrl === undefined) delete process.env.MODEL_CONTROL_PLANE_URL;
    else process.env.MODEL_CONTROL_PLANE_URL = previousUrl;
    await app.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
