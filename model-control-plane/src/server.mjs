import Fastify from 'fastify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';
import { ControlPlaneStore } from './store.mjs';
import { CpaAdapter } from './adapters/cpa.mjs';
import { CpaUsageAdapter } from './adapters/cpaUsage.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbFile = process.env.MODEL_CP_DB ?? path.resolve(here, '../data/control-plane.sqlite');
const host = process.env.MODEL_CP_HOST ?? '127.0.0.1';
const port = Number(process.env.MODEL_CP_PORT ?? 8320);
const app = Fastify({ logger: true });
const store = new ControlPlaneStore(openDb(dbFile));
const cpa = new CpaAdapter({
  gatewayctl: process.env.GATEWAYCTL ?? '/usr/local/sbin/gatewayctl',
  sudo: process.env.MODEL_CP_CPA_SUDO !== '0',
});
const cpaUsage = new CpaUsageAdapter({
  baseUrl: process.env.CPA_BASE_URL ?? 'http://127.0.0.1:8317',
  keyFile: process.env.CPA_MANAGEMENT_KEY_FILE ?? '/opt/cpa/.mgmt_password',
});
const listeners = new Set();
async function reconcilePositionAliases(cpaChannels, snapshot) {
  if (process.env.MODEL_CP_MANAGE_POSITION_ALIASES === '0') return;
  const workers = new Map(snapshot.workers.map((worker) => [worker.id, worker]));
  const channels = new Map(snapshot.channels.map((channel) => [channel.id, channel]));
  for (const position of snapshot.positions) {
    const alias = `position:${position.id}`;
    const assignment = snapshot.assignments.find(
      (item) => item.positionId === position.id && item.status === 'active',
    );
    const worker = assignment ? workers.get(assignment.workerId) : null;
    const selectedChannel = worker ? channels.get(worker.channelId) : null;
    for (const c of cpaChannels) {
      const shouldBind = Boolean(
        worker && selectedChannel?.name === c.name && c.models.includes(worker.modelId),
      );
      const isBound = (c.logicalAliases ?? []).includes(alias);
      if (shouldBind && !isBound) {
        await cpa.bindAlias(c.name, worker.modelId, alias);
        store.emit('position.route_bound', 'position', position.id, {
          alias,
          workerId: worker.id,
          channelId: worker.channelId,
        });
      } else if (!shouldBind && isBound) {
        await cpa.unbindAlias(c.name, alias);
        store.emit('position.route_unbound', 'position', position.id, {
          alias,
          channelName: c.name,
        });
      }
    }
  }
}
async function refreshCpa() {
  const channels = await cpa.status();
  store.syncCpa(channels);
  const usage = await cpaUsage
    .snapshot(process.env.MODEL_CP_USAGE_RANGE ?? '30d')
    .catch(() => null);
  if (usage) store.syncExternalUsage(usage);
  const snapshot = store.autoAssignDefaults();
  await reconcilePositionAliases(channels, snapshot);
  return snapshot;
}

const originalEmit = store.emit.bind(store);
store.emit = (...args) => {
  const event = originalEmit(...args);
  for (const send of listeners) send(event);
  return event;
};

app.get('/api/health', async () => ({
  status: 'ok',
  service: 'hermes-model-control-plane',
  db: dbFile,
}));
app.get('/api/v1/snapshot', async () => store.snapshot());
app.get('/api/v1/providers', async () => store.snapshot().providers);
app.get('/api/v1/channels', async () => store.snapshot().channels);
app.get('/api/v1/workers', async () => store.snapshot().workers);
app.get('/api/v1/profiles', async () => store.snapshot().profiles);
app.get('/api/v1/positions', async () => store.snapshot().positions);
app.get('/api/v1/assignments', async () => store.snapshot().assignments);
app.get('/api/v1/quotas', async () => store.snapshot().quotas);
app.get('/api/v1/contracts', async () => store.snapshot().contracts);
app.get('/api/v1/prices', async () => store.snapshot().prices);
app.get('/api/v1/dashboard/workforce', async () => store.snapshot());
app.get('/api/v1/events/history', async (req) =>
  store.eventsAfter(Number(req.query?.after ?? 0), Number(req.query?.limit ?? 500)),
);
app.get('/api/v1/events', async (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  let last = Number(req.query?.after ?? 0);
  for (const e of store.eventsAfter(last)) {
    reply.raw.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    last = e.seq;
  }
  const send = (e) => {
    reply.raw.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  };
  listeners.add(send);
  const timer = setInterval(() => reply.raw.write(': ping\n\n'), 15000);
  req.raw.on('close', () => {
    listeners.delete(send);
    clearInterval(timer);
  });
  return reply;
});

app.post('/api/v1/providers', async (req) => store.upsertProvider(req.body ?? {}));
app.post('/api/v1/channels', async (req) => store.upsertChannel(req.body ?? {}));
app.post('/api/v1/models', async (req) => store.upsertModel(req.body ?? {}));
app.post('/api/v1/workers', async (req) => store.upsertWorker(req.body ?? {}));
app.post('/api/v1/profiles', async (req) => store.upsertProfile(req.body ?? {}));
app.post('/api/v1/positions', async (req) => store.upsertPosition(req.body ?? {}));
app.post('/api/v1/assignments', async (req) => store.assign(req.body ?? {}));
app.post('/api/v1/quotas', async (req) => store.upsertQuota(req.body ?? {}));
app.post('/api/v1/contracts', async (req) => store.upsertContract(req.body ?? {}));
app.post('/api/v1/prices', async (req) => store.upsertPrice(req.body ?? {}));
app.post('/api/v1/usage', async (req, reply) => {
  try {
    return store.recordUsage(req.body ?? {});
  } catch (e) {
    reply.code(400);
    return { error: e.message };
  }
});
app.post('/api/v1/resolve/:positionId', async (req) => store.resolve(req.params.positionId));
app.post('/api/v1/adapters/cpa/sync', async (req, reply) => {
  try {
    return await refreshCpa();
  } catch (e) {
    reply.code(502);
    return { error: 'cpa-sync-failed', message: e.message };
  }
});
app.post('/api/v1/adapters/cpa/channels', async (req, reply) => {
  try {
    const body = req.body ?? {};
    const name = String(body.name ?? '').trim(),
      protocol = String(body.protocol ?? '').trim(),
      baseUrl = String(body.baseUrl ?? '').trim(),
      apiKey = String(body.apiKey ?? '');
    if (!name || !protocol || !baseUrl || !apiKey)
      throw new Error('name, protocol, baseUrl and apiKey are required');
    if (!['openai-compatible', 'codex-responses', 'anthropic-messages'].includes(protocol))
      throw new Error('unsupported protocol');
    const models = Array.isArray(body.models) ? body.models : [];
    await cpa.addChannel({
      name,
      protocol,
      baseUrl,
      models,
      apiKey,
      weight: Number(body.weight ?? 100),
      priority: Number(body.priority ?? 0),
      proxyUrl: String(body.proxyUrl ?? 'direct'),
    });
    let testPassed = false;
    if (body.test !== false) {
      try {
        await cpa.test(name);
        testPassed = true;
      } catch (e) {
        app.log.warn({ channel: name, err: e }, 'new CPA channel test failed');
      }
    }
    if (body.enable === true) {
      if (!testPassed)
        throw new Error('channel was added disabled because its upstream test did not pass');
      await cpa.enable(name, 'model-control-plane-new-channel');
    }
    const snapshot = await refreshCpa();
    return { channel: name, testPassed, enabled: body.enable === true && testPassed, snapshot };
  } catch (e) {
    reply.code(400);
    return { error: e.message };
  }
});
app.post('/api/v1/adapters/cpa/usage/sync', async (req, reply) => {
  try {
    const usage = await cpaUsage.snapshot(String(req.body?.range ?? '30d'));
    return store.syncExternalUsage(usage);
  } catch (e) {
    reply.code(502);
    return { error: 'cpa-usage-sync-failed', message: e.message };
  }
});
app.post('/api/v1/assignments/reconcile', async () => store.autoAssignDefaults());
app.patch('/api/v1/channels/:channelId/policy', async (req, reply) => {
  try {
    const result = store.updateChannelPolicy(req.params.channelId, req.body ?? {});
    await refreshCpa();
    return result;
  } catch (e) {
    reply.code(400);
    return { error: e.message };
  }
});
app.patch('/api/v1/assignments/:assignmentId/policy', async (req, reply) => {
  try {
    const result = store.updateAssignmentPolicy(req.params.assignmentId, req.body ?? {});
    await refreshCpa();
    return result;
  } catch (e) {
    reply.code(400);
    return { error: e.message };
  }
});
app.post('/api/v1/channels/:channelId/actions/:action', async (req, reply) => {
  try {
    const channel = store.getChannel(req.params.channelId);
    if (!channel) throw new Error('unknown channel');
    if (channel.providerId !== 'cpa' || channel.metadata?.source === 'usage-discovery')
      throw new Error('channel lifecycle is not managed by gatewayctl');
    const action = req.params.action;
    const reason = String(req.body?.reason ?? 'model-control-plane');
    if (action === 'enable') await cpa.enable(channel.name, reason);
    else if (action === 'disable') await cpa.disable(channel.name, reason);
    else if (action === 'test') await cpa.test(channel.name);
    else if (action === 'quarantine')
      await cpa.quarantine(channel.name, Number(req.body?.minutes ?? 30), reason);
    else throw new Error('unsupported action');
    return { action, channel: channel.name, snapshot: await refreshCpa() };
  } catch (e) {
    reply.code(400);
    return { error: e.message };
  }
});
app.get('/api/v1/stats/:dimension', async (req, reply) => {
  try {
    return store.statsBy(req.params.dimension);
  } catch (e) {
    reply.code(400);
    return { error: e.message };
  }
});

async function seed() {
  store.upsertProfile({ id: 'hermes', name: 'Hermes' });
  store.upsertProfile({ id: 'development', name: 'Development' });
  store.upsertPosition({
    id: 'hermes-brain',
    profileId: 'hermes',
    name: 'Hermes Brain',
    kind: 'brain',
    requiredCapabilities: ['reasoning', 'tools'],
    weights: { quality: 30, reliability: 30, cost: 20, latency: 5, quota: 15 },
    metadata: { routeProtocol: 'openai-compatible', logicalAlias: 'position:hermes-brain' },
  });
  store.upsertPosition({
    id: 'codex-general',
    profileId: 'development',
    name: 'Codex General Developer',
    kind: 'developer',
    requiredCapabilities: ['coding', 'tools'],
    weights: { quality: 30, reliability: 20, cost: 20, latency: 10, quota: 20 },
    metadata: { routeProtocol: 'openai-compatible', logicalAlias: 'position:codex-general' },
  });
  store.upsertPosition({
    id: 'coding-review',
    profileId: 'development',
    name: 'Coding Reviewer',
    kind: 'reviewer',
    requiredCapabilities: ['review', 'reasoning'],
    weights: { quality: 40, reliability: 25, cost: 15, latency: 5, quota: 15 },
    metadata: { routeProtocol: 'openai-compatible', logicalAlias: 'position:coding-review' },
  });
  if (process.env.MODEL_CP_SYNC_CPA !== '0') {
    try {
      await refreshCpa();
    } catch (e) {
      app.log.warn({ err: e }, 'CPA bootstrap sync failed');
    }
  }
}
await seed();
await app.listen({ host, port });
const syncInterval = Number(process.env.MODEL_CP_SYNC_INTERVAL_MS ?? 60000);
if (syncInterval > 0) {
  setInterval(async () => {
    try {
      await refreshCpa();
    } catch (e) {
      app.log.warn({ err: e }, 'periodic CPA sync failed');
    }
  }, syncInterval).unref();
}
const healthInterval = Number(process.env.MODEL_CP_HEALTH_CHECK_INTERVAL_MS ?? 1800000);
if (healthInterval > 0) {
  setInterval(async () => {
    try {
      const channels = await cpa.status();
      for (const channel of channels.filter((item) => item.enabled)) {
        try {
          await cpa.test(channel.name);
        } catch (e) {
          app.log.warn({ channel: channel.name, err: e }, 'CPA channel health probe failed');
        }
      }
      await refreshCpa();
    } catch (e) {
      app.log.warn({ err: e }, 'periodic CPA health check failed');
    }
  }, healthInterval).unref();
}
