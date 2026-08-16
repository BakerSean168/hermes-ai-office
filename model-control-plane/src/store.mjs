import crypto from 'node:crypto';
import { json } from './db.mjs';
import { eligible, normalizeCapabilities, scoreCandidate, stableWorkerId } from './domain.mjs';

const now = () => Date.now();
const enc = (v) => JSON.stringify(v ?? {});
const slug = (s) =>
  String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

export class ControlPlaneStore {
  constructor(db) {
    this.db = db;
  }
  emit(type, entityType, entityId, payload = {}) {
    const occurredAt = now();
    const r = this.db
      .prepare(
        'INSERT INTO events(type,entity_type,entity_id,payload,occurred_at) VALUES(?,?,?,?,?)',
      )
      .run(type, entityType, entityId, enc(payload), occurredAt);
    return { seq: Number(r.lastInsertRowid), type, entityType, entityId, payload, occurredAt };
  }
  upsertProvider(p) {
    const t = now();
    const id = p.id ?? slug(p.name);
    this.db
      .prepare(
        `INSERT INTO providers(id,name,kind,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,metadata=excluded.metadata,updated_at=excluded.updated_at`,
      )
      .run(id, p.name, p.kind ?? 'api', enc(p.metadata), t, t);
    this.emit('provider.changed', 'provider', id, { id, name: p.name });
    return this.getProvider(id);
  }
  getProvider(id) {
    const r = this.db.prepare('SELECT * FROM providers WHERE id=?').get(id);
    return r ? this.mapProvider(r) : null;
  }
  mapProvider(r) {
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      metadata: json(r.metadata),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  upsertChannel(c) {
    const t = now();
    const id = c.id ?? slug(c.name);
    const providerId = c.providerId ?? 'cpa';
    const existing = this.getChannel(id);
    if (!this.getProvider(providerId))
      this.upsertProvider({ id: providerId, name: providerId.toUpperCase(), kind: 'gateway' });
    const metadata = { ...(existing?.metadata ?? {}), ...(c.metadata ?? {}) };
    this.db
      .prepare(
        `INSERT INTO channels(id,provider_id,name,protocol,enabled,priority,weight,health,last_test,base_url_hint,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id,name=excluded.name,protocol=excluded.protocol,enabled=excluded.enabled,priority=excluded.priority,weight=excluded.weight,health=excluded.health,last_test=excluded.last_test,base_url_hint=excluded.base_url_hint,metadata=excluded.metadata,updated_at=excluded.updated_at`,
      )
      .run(
        id,
        providerId,
        c.name,
        c.protocol ?? existing?.protocol ?? null,
        c.enabled === undefined ? (existing?.enabled ?? 1) : c.enabled === false ? 0 : 1,
        c.priority ?? existing?.priority ?? 0,
        c.weight ?? existing?.weight ?? 100,
        c.health ?? existing?.health ?? 'unknown',
        c.lastTest ?? existing?.lastTest ?? null,
        c.baseUrlHint ?? existing?.baseUrlHint ?? null,
        enc(metadata),
        t,
        t,
      );
    this.emit('channel.changed', 'channel', id, {
      id,
      health: c.health ?? 'unknown',
      enabled: c.enabled !== false,
    });
    return this.getChannel(id);
  }
  getChannel(id) {
    const r = this.db.prepare('SELECT * FROM channels WHERE id=?').get(id);
    return r ? this.mapChannel(r) : null;
  }
  mapChannel(r) {
    return {
      id: r.id,
      providerId: r.provider_id,
      name: r.name,
      protocol: r.protocol,
      enabled: r.enabled,
      priority: r.priority,
      weight: r.weight,
      health: r.health,
      lastTest: r.last_test,
      baseUrlHint: r.base_url_hint,
      metadata: json(r.metadata),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  upsertModel(m) {
    const t = now();
    const id = m.id ?? slug(m.displayName);
    this.db
      .prepare(
        `INSERT INTO model_definitions(id,display_name,capabilities,context_window,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,capabilities=excluded.capabilities,context_window=COALESCE(excluded.context_window,model_definitions.context_window),metadata=excluded.metadata,updated_at=excluded.updated_at`,
      )
      .run(
        id,
        m.displayName ?? id,
        enc(normalizeCapabilities(m.capabilities)),
        m.contextWindow ?? null,
        enc(m.metadata),
        t,
        t,
      );
    return this.getModel(id);
  }
  getModel(id) {
    const r = this.db.prepare('SELECT * FROM model_definitions WHERE id=?').get(id);
    return r
      ? {
          id: r.id,
          displayName: r.display_name,
          capabilities: json(r.capabilities, []),
          contextWindow: r.context_window,
          metadata: json(r.metadata),
        }
      : null;
  }
  upsertWorker(w) {
    const t = now();
    const id = w.id ?? stableWorkerId(w.channelId, w.modelId);
    const model =
      this.getModel(w.modelId) ??
      this.upsertModel({
        id: w.modelId,
        displayName: w.modelId,
        capabilities: w.capabilities ?? [],
      });
    this.db
      .prepare(
        `INSERT INTO workers(id,channel_id,model_id,display_name,enabled,priority,capabilities,context_window,quality_score,reliability_score,latency_score,cost_score,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,enabled=excluded.enabled,priority=excluded.priority,capabilities=excluded.capabilities,context_window=COALESCE(excluded.context_window,workers.context_window),quality_score=COALESCE(excluded.quality_score,workers.quality_score),reliability_score=COALESCE(excluded.reliability_score,workers.reliability_score),latency_score=COALESCE(excluded.latency_score,workers.latency_score),cost_score=COALESCE(excluded.cost_score,workers.cost_score),metadata=excluded.metadata,updated_at=excluded.updated_at`,
      )
      .run(
        id,
        w.channelId,
        w.modelId,
        w.displayName ?? `${w.modelId} @ ${w.channelId}`,
        w.enabled === false ? 0 : 1,
        w.priority ?? 0,
        enc(normalizeCapabilities(w.capabilities ?? model.capabilities)),
        w.contextWindow ?? model.contextWindow ?? null,
        w.qualityScore ?? null,
        w.reliabilityScore ?? null,
        w.latencyScore ?? null,
        w.costScore ?? null,
        enc(w.metadata),
        t,
        t,
      );
    this.emit('worker.changed', 'worker', id, { id, channelId: w.channelId, modelId: w.modelId });
    return this.getWorker(id);
  }
  getWorker(id) {
    const r = this.db.prepare('SELECT * FROM workers WHERE id=?').get(id);
    return r ? this.mapWorker(r) : null;
  }
  mapWorker(r) {
    return {
      id: r.id,
      channelId: r.channel_id,
      modelId: r.model_id,
      displayName: r.display_name,
      enabled: r.enabled,
      priority: r.priority,
      capabilities: json(r.capabilities, []),
      contextWindow: r.context_window,
      qualityScore: r.quality_score,
      reliabilityScore: r.reliability_score,
      latencyScore: r.latency_score,
      costScore: r.cost_score,
      metadata: json(r.metadata),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  upsertProfile(p) {
    const t = now();
    const id = p.id ?? slug(p.name);
    this.db
      .prepare(
        `INSERT INTO profiles(id,name,metadata,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,metadata=excluded.metadata,updated_at=excluded.updated_at`,
      )
      .run(id, p.name, enc(p.metadata), t, t);
    this.emit('profile.changed', 'profile', id, { id, name: p.name });
    return { id, name: p.name, metadata: p.metadata ?? {} };
  }
  upsertPosition(p) {
    const t = now();
    const id = p.id ?? slug(p.name);
    this.db
      .prepare(
        `INSERT INTO positions(id,profile_id,name,kind,required_capabilities,min_context,weights,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id,name=excluded.name,kind=excluded.kind,required_capabilities=excluded.required_capabilities,min_context=excluded.min_context,weights=excluded.weights,metadata=excluded.metadata,updated_at=excluded.updated_at`,
      )
      .run(
        id,
        p.profileId ?? null,
        p.name,
        p.kind ?? 'generic',
        enc(normalizeCapabilities(p.requiredCapabilities)),
        p.minContext ?? null,
        enc(p.weights ?? {}),
        enc(p.metadata),
        t,
        t,
      );
    this.emit('position.changed', 'position', id, { id, name: p.name });
    return this.getPosition(id);
  }
  getPosition(id) {
    const r = this.db.prepare('SELECT * FROM positions WHERE id=?').get(id);
    return r
      ? {
          id: r.id,
          profileId: r.profile_id,
          name: r.name,
          kind: r.kind,
          requiredCapabilities: json(r.required_capabilities, []),
          minContext: r.min_context,
          weights: json(r.weights),
          metadata: json(r.metadata),
        }
      : null;
  }
  assign(a) {
    const id = a.id ?? `asg:${a.positionId}:${a.workerId}`;
    const t = now();
    this.db
      .prepare(
        `INSERT INTO assignments(id,position_id,worker_id,priority,weight,status,reason,effective_from,effective_to,metadata) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET priority=excluded.priority,weight=excluded.weight,status=excluded.status,reason=excluded.reason,effective_to=excluded.effective_to,metadata=excluded.metadata`,
      )
      .run(
        id,
        a.positionId,
        a.workerId,
        a.priority ?? 0,
        a.weight ?? 100,
        a.status ?? 'standby',
        a.reason ?? null,
        a.effectiveFrom ?? t,
        a.effectiveTo ?? null,
        enc(a.metadata),
      );
    this.emit('assignment.changed', 'assignment', id, {
      id,
      positionId: a.positionId,
      workerId: a.workerId,
      status: a.status ?? 'standby',
    });
    return { id, ...a };
  }
  upsertQuota(q) {
    const id = q.id ?? `quota:${q.workerId ?? q.channelId}:${q.kind ?? 'credits'}`;
    const t = now();
    this.db
      .prepare(
        `INSERT INTO quotas(id,channel_id,worker_id,kind,limit_value,remaining_value,unit,reset_at,source,metadata,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET limit_value=excluded.limit_value,remaining_value=excluded.remaining_value,unit=excluded.unit,reset_at=excluded.reset_at,source=excluded.source,metadata=excluded.metadata,updated_at=excluded.updated_at`,
      )
      .run(
        id,
        q.channelId ?? null,
        q.workerId ?? null,
        q.kind ?? 'credits',
        q.limit ?? null,
        q.remaining ?? null,
        q.unit ?? 'usd',
        q.resetAt ?? null,
        q.source ?? null,
        enc(q.metadata),
        t,
      );
    this.emit('quota.changed', 'quota', id, {
      id,
      remaining: q.remaining,
      limit: q.limit,
      unit: q.unit ?? 'usd',
    });
    return { id, ...q, updatedAt: t };
  }
  upsertContract(c) {
    const id = c.id ?? `contract:${c.channelId}`;
    const t = now();
    this.db
      .prepare(
        `INSERT INTO contracts(id,channel_id,billing_kind,fixed_cost,currency,billing_period,starts_at,resets_at,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET billing_kind=excluded.billing_kind,fixed_cost=excluded.fixed_cost,currency=excluded.currency,billing_period=excluded.billing_period,starts_at=excluded.starts_at,resets_at=excluded.resets_at,metadata=excluded.metadata,updated_at=excluded.updated_at`,
      )
      .run(
        id,
        c.channelId,
        c.billingKind ?? 'metered',
        c.fixedCost ?? 0,
        c.currency ?? 'USD',
        c.billingPeriod ?? 'month',
        c.startsAt ?? null,
        c.resetsAt ?? null,
        enc(c.metadata),
        t,
        t,
      );
    this.emit('contract.changed', 'contract', id, {
      id,
      channelId: c.channelId,
      billingKind: c.billingKind ?? 'metered',
    });
    this.reallocateExternalCosts();
    return { id, ...c, updatedAt: t };
  }
  upsertPrice(p) {
    const id = p.id ?? `price:${p.workerId ?? p.modelId}`;
    const t = now();
    this.db
      .prepare(
        `INSERT INTO prices(id,model_id,worker_id,input_per_million,output_per_million,cached_per_million,reasoning_per_million,currency,source,metadata,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET model_id=excluded.model_id,worker_id=excluded.worker_id,input_per_million=excluded.input_per_million,output_per_million=excluded.output_per_million,cached_per_million=excluded.cached_per_million,reasoning_per_million=excluded.reasoning_per_million,currency=excluded.currency,source=excluded.source,metadata=excluded.metadata,updated_at=excluded.updated_at`,
      )
      .run(
        id,
        p.modelId,
        p.workerId ?? null,
        p.inputPerMillion ?? 0,
        p.outputPerMillion ?? 0,
        p.cachedPerMillion ?? 0,
        p.reasoningPerMillion ?? 0,
        p.currency ?? 'USD',
        p.source ?? null,
        enc(p.metadata),
        t,
      );
    this.emit('price.changed', 'price', id, {
      id,
      modelId: p.modelId,
      workerId: p.workerId ?? null,
    });
    this.revalueExternalUsage();
    return { id, ...p, updatedAt: t };
  }
  priceFor(workerId, modelId) {
    return this.db
      .prepare(
        'SELECT * FROM prices WHERE worker_id=? OR (worker_id IS NULL AND model_id=?) ORDER BY worker_id IS NOT NULL DESC, updated_at DESC LIMIT 1',
      )
      .get(workerId, modelId);
  }
  estimateMarketValue(workerId, modelId, tokens) {
    const p = this.priceFor(workerId, modelId);
    if (!p) return 0;
    return (
      (Number(tokens.inputTokens ?? 0) * p.input_per_million +
        Number(tokens.outputTokens ?? 0) * p.output_per_million +
        Number(tokens.cachedTokens ?? 0) * p.cached_per_million +
        Number(tokens.reasoningTokens ?? 0) * p.reasoning_per_million) /
      1_000_000
    );
  }

  updateChannelPolicy(id, patch) {
    const channel = this.getChannel(id);
    if (!channel) throw new Error('unknown channel');
    return this.upsertChannel({
      ...channel,
      priority: patch.priority ?? channel.priority,
      weight: patch.weight ?? channel.weight,
      metadata: {
        ...channel.metadata,
        policy: { ...(channel.metadata?.policy ?? {}), ...(patch.metadata ?? {}) },
      },
    });
  }
  updateAssignmentPolicy(id, patch) {
    const row = this.db.prepare('SELECT * FROM assignments WHERE id=?').get(id);
    if (!row) throw new Error('unknown assignment');
    const priority = patch.priority ?? row.priority,
      weight = patch.weight ?? row.weight;
    this.db
      .prepare(
        "UPDATE assignments SET priority=?,weight=?,reason='manual-override',metadata=? WHERE id=?",
      )
      .run(priority, weight, enc({ ...json(row.metadata), manualOverride: true }), id);
    this.emit('assignment.policy_changed', 'assignment', id, {
      id,
      positionId: row.position_id,
      workerId: row.worker_id,
      priority,
      weight,
    });
    return {
      id,
      positionId: row.position_id,
      workerId: row.worker_id,
      priority,
      weight,
      status: row.status,
      reason: 'manual-override',
    };
  }

  revalueExternalUsage() {
    const rows = this.db
      .prepare(
        'SELECT source,range_key,provider_key,model_id,worker_id,input_tokens,output_tokens,cached_tokens,reasoning_tokens FROM external_usage_snapshots',
      )
      .all();
    const update = this.db.prepare(
      'UPDATE external_usage_snapshots SET market_value=? WHERE source=? AND range_key=? AND provider_key=? AND model_id=?',
    );
    for (const row of rows) {
      const value = this.estimateMarketValue(row.worker_id, row.model_id, {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cachedTokens: row.cached_tokens,
        reasoningTokens: row.reasoning_tokens,
      });
      update.run(value, row.source, row.range_key, row.provider_key, row.model_id);
    }
  }
  reallocateExternalCosts(rangeKey = '30d') {
    this.db
      .prepare('UPDATE external_usage_snapshots SET allocated_cost=0 WHERE range_key=?')
      .run(rangeKey);
    const contracts = this.db
      .prepare("SELECT * FROM contracts WHERE billing_kind='subscription' AND fixed_cost>0")
      .all();
    for (const contract of contracts) {
      const rows = this.db
        .prepare(
          'SELECT source,provider_key,model_id,requests,input_tokens,output_tokens,cached_tokens,reasoning_tokens FROM external_usage_snapshots WHERE range_key=? AND channel_id=?',
        )
        .all(rangeKey, contract.channel_id);
      if (!rows.length) continue;
      const meta = json(contract.metadata);
      const basis = meta.allocationBasis === 'requests' ? 'requests' : 'tokens';
      const measure = (r) =>
        basis === 'requests'
          ? Number(r.requests ?? 0)
          : Number(r.input_tokens ?? 0) +
            Number(r.output_tokens ?? 0) +
            Number(r.cached_tokens ?? 0) +
            Number(r.reasoning_tokens ?? 0);
      const total = rows.reduce((sum, row) => sum + measure(row), 0);
      if (total <= 0) continue;
      const update = this.db.prepare(
        'UPDATE external_usage_snapshots SET allocated_cost=? WHERE source=? AND range_key=? AND provider_key=? AND model_id=?',
      );
      for (const row of rows) {
        update.run(
          (Number(contract.fixed_cost) * measure(row)) / total,
          row.source,
          rangeKey,
          row.provider_key,
          row.model_id,
        );
      }
    }
  }

  resolve(positionId) {
    const position = this.getPosition(positionId);
    if (!position)
      return { positionId, candidates: [], selected: null, reason: 'position-not-found' };
    const rows = this.db
      .prepare(
        `SELECT a.id assignment_id,a.priority assignment_priority,a.weight assignment_weight,a.status assignment_status,a.reason assignment_reason,
      w.id worker_id,w.channel_id,w.model_id,w.display_name worker_display_name,w.enabled worker_enabled,w.priority worker_priority,w.capabilities worker_capabilities,w.context_window,w.quality_score,w.reliability_score,w.latency_score,w.cost_score,w.metadata worker_metadata,w.created_at worker_created_at,w.updated_at worker_updated_at,
      c.provider_id,c.name channel_name,c.enabled channel_enabled,c.priority channel_priority,c.weight channel_weight,c.health channel_health,c.last_test,c.protocol channel_protocol
      FROM assignments a JOIN workers w ON w.id=a.worker_id JOIN channels c ON c.id=w.channel_id
      WHERE a.position_id=? AND a.status IN ('active','standby') AND (a.effective_to IS NULL OR a.effective_to>?)`,
      )
      .all(positionId, now());
    const candidates = [];
    for (const r of rows) {
      const worker = {
        id: r.worker_id,
        channelId: r.channel_id,
        modelId: r.model_id,
        displayName: r.worker_display_name,
        enabled: r.worker_enabled,
        priority: r.worker_priority,
        capabilities: json(r.worker_capabilities, []),
        contextWindow: r.context_window,
        qualityScore: r.quality_score,
        reliabilityScore: r.reliability_score,
        latencyScore: r.latency_score,
        costScore: r.cost_score,
        metadata: json(r.worker_metadata),
        createdAt: r.worker_created_at,
        updatedAt: r.worker_updated_at,
      };
      const channel = {
        id: r.channel_id,
        providerId: r.provider_id,
        name: r.channel_name,
        protocol: r.channel_protocol,
        enabled: r.channel_enabled,
        priority: r.channel_priority,
        weight: r.channel_weight,
        health: r.channel_health,
        lastTest: r.last_test,
      };
      const qrow = this.db
        .prepare(
          'SELECT * FROM quotas WHERE worker_id=? OR (worker_id IS NULL AND channel_id=?) ORDER BY worker_id IS NOT NULL DESC, updated_at DESC LIMIT 1',
        )
        .get(worker.id, worker.channelId);
      const quota = qrow
        ? {
            limit: qrow.limit_value,
            remaining: qrow.remaining_value,
            unit: qrow.unit,
            resetAt: qrow.reset_at,
          }
        : null;
      const assignment = {
        id: r.assignment_id,
        priority: r.assignment_priority,
        weight: r.assignment_weight,
        status: r.assignment_status,
        reason: r.assignment_reason,
      };
      const ok = eligible(worker, position, channel, quota);
      candidates.push({
        worker,
        channel,
        assignment,
        quota,
        eligible: ok,
        score: ok ? scoreCandidate({ worker, position, channel, quota, assignment }) : null,
      });
    }
    candidates.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
    const selected = candidates.find((c) => c.eligible) ?? null;
    this.emit('route.resolved', 'position', positionId, {
      selectedWorkerId: selected?.worker.id ?? null,
      candidateCount: candidates.length,
    });
    return { positionId, position, selected, candidates };
  }
  recordUsage(u) {
    const worker = this.getWorker(u.workerId);
    if (!worker) throw new Error('unknown worker');
    const channel = this.getChannel(worker.channelId);
    const id = u.runId ?? `run:${crypto.randomUUID()}`;
    if (u.createRun !== false)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO runs(id,position_id,worker_id,external_run_id,task_id,agent_instance_id,status,started_at,metadata) VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          u.positionId ?? null,
          u.workerId,
          u.externalRunId ?? null,
          u.taskId ?? null,
          u.agentInstanceId ?? null,
          u.status ?? 'running',
          u.startedAt ?? now(),
          enc(u.runMetadata),
        );
    const t = u.occurredAt ?? now();
    this.db
      .prepare(
        `INSERT INTO usage_ledger(run_id,position_id,worker_id,channel_id,provider_id,input_tokens,output_tokens,cached_tokens,reasoning_tokens,actual_cost,allocated_cost,market_value,occurred_at,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        u.positionId ?? null,
        u.workerId,
        worker.channelId,
        channel.providerId,
        u.inputTokens ?? 0,
        u.outputTokens ?? 0,
        u.cachedTokens ?? 0,
        u.reasoningTokens ?? 0,
        u.actualCost ?? 0,
        u.allocatedCost ?? 0,
        u.marketValue ?? 0,
        t,
        enc(u.metadata),
      );
    this.emit('usage.recorded', 'run', id, {
      workerId: u.workerId,
      positionId: u.positionId ?? null,
    });
    return { runId: id, occurredAt: t };
  }
  list(table, mapper = (x) => x) {
    return this.db.prepare(`SELECT * FROM ${table}`).all().map(mapper);
  }
  statsBy(field) {
    const allowed = {
      worker: 'worker_id',
      position: 'position_id',
      provider: 'provider_id',
      channel: 'channel_id',
    };
    const col = allowed[field];
    if (!col) throw new Error('bad stats field');
    return this.db
      .prepare(
        `SELECT ${col} id, COUNT(DISTINCT run_id) runs, SUM(input_tokens) inputTokens, SUM(output_tokens) outputTokens, SUM(cached_tokens) cachedTokens, SUM(reasoning_tokens) reasoningTokens, SUM(actual_cost) actualCost, SUM(allocated_cost) allocatedCost, SUM(market_value) marketValue FROM usage_ledger GROUP BY ${col} ORDER BY actualCost DESC`,
      )
      .all();
  }
  eventsAfter(seq = 0, limit = 500) {
    return this.db
      .prepare('SELECT * FROM events WHERE seq>? ORDER BY seq ASC LIMIT ?')
      .all(seq, limit)
      .map((r) => ({
        seq: r.seq,
        type: r.type,
        entityType: r.entity_type,
        entityId: r.entity_id,
        payload: json(r.payload),
        occurredAt: r.occurred_at,
      }));
  }
  snapshot() {
    return {
      providers: this.list('providers', (r) => this.mapProvider(r)),
      channels: this.list('channels', (r) => this.mapChannel(r)),
      models: this.list('model_definitions', (r) => this.getModel(r.id)),
      workers: this.list('workers', (r) => this.mapWorker(r)),
      profiles: this.list('profiles', (r) => ({
        id: r.id,
        name: r.name,
        metadata: json(r.metadata),
      })),
      positions: this.list('positions', (r) => this.getPosition(r.id)),
      contracts: this.list('contracts', (r) => ({
        id: r.id,
        channelId: r.channel_id,
        billingKind: r.billing_kind,
        fixedCost: r.fixed_cost,
        currency: r.currency,
        billingPeriod: r.billing_period,
        startsAt: r.starts_at,
        resetsAt: r.resets_at,
        metadata: json(r.metadata),
      })),
      prices: this.list('prices', (r) => ({
        id: r.id,
        modelId: r.model_id,
        workerId: r.worker_id,
        inputPerMillion: r.input_per_million,
        outputPerMillion: r.output_per_million,
        cachedPerMillion: r.cached_per_million,
        reasoningPerMillion: r.reasoning_per_million,
        currency: r.currency,
        source: r.source,
        metadata: json(r.metadata),
      })),
      assignments: this.list('assignments', (r) => ({
        id: r.id,
        positionId: r.position_id,
        workerId: r.worker_id,
        priority: r.priority,
        weight: r.weight,
        status: r.status,
        reason: r.reason,
        effectiveFrom: r.effective_from,
        effectiveTo: r.effective_to,
        metadata: json(r.metadata),
      })),
      quotas: this.list('quotas', (r) => ({
        id: r.id,
        channelId: r.channel_id,
        workerId: r.worker_id,
        kind: r.kind,
        limit: r.limit_value,
        remaining: r.remaining_value,
        unit: r.unit,
        resetAt: r.reset_at,
        source: r.source,
        metadata: json(r.metadata),
        updatedAt: r.updated_at,
      })),
      activeRuns: this.db
        .prepare("SELECT * FROM runs WHERE status NOT IN ('completed','failed','cancelled')")
        .all()
        .map((r) => ({
          id: r.id,
          positionId: r.position_id,
          workerId: r.worker_id,
          externalRunId: r.external_run_id,
          taskId: r.task_id,
          agentInstanceId: r.agent_instance_id,
          status: r.status,
          startedAt: r.started_at,
          metadata: json(r.metadata),
        })),
      stats: {
        workers: this.combinedStatsBy('worker'),
        positions: this.statsBy('position'),
        providers: this.statsBy('provider'),
        channels: this.combinedStatsBy('channel'),
      },
    };
  }

  syncExternalUsage(snapshot, source = 'cpa-cap-token-usage-tracker') {
    const groups = snapshot?.stats?.groups ?? [];
    const costRows = snapshot?.costs?.models ?? [];
    const costs = new Map(
      costRows.map((r) => [`${r.provider}\u0000${r.model}`, Number(r.total_usd ?? 0)]),
    );
    const aggregated = new Map();
    for (const g of groups) {
      const providerKey = String(g.provider ?? 'unknown');
      const modelId = String(g.model ?? g.alias ?? 'unknown');
      const key = `${providerKey}\u0000${modelId}`;
      const row = aggregated.get(key) ?? {
        providerKey,
        modelId,
        requests: 0,
        failedRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        metadata: { sources: new Set(), executorTypes: new Set() },
      };
      row.requests += Number(g.requests ?? 0);
      row.failedRequests += Number(g.failed_requests ?? 0);
      row.inputTokens += Number(g.input_tokens ?? 0);
      row.outputTokens += Number(g.output_tokens ?? 0);
      row.cachedTokens += Number(g.cached_tokens ?? 0);
      row.reasoningTokens += Number(g.reasoning_tokens ?? 0);
      if (g.source) row.metadata.sources.add(String(g.source));
      if (g.executor_type) row.metadata.executorTypes.add(String(g.executor_type));
      aggregated.set(key, row);
    }
    const rangeKey = String(snapshot.range ?? snapshot?.stats?.range ?? '30d');
    const generatedAt = Date.parse(snapshot?.stats?.generated_at ?? '') || now();
    for (const row of aggregated.values()) {
      let channelId = null,
        workerId = null;
      const pref = 'openai-compatible-';
      if (row.providerKey.startsWith(pref)) {
        const name = row.providerKey.slice(pref.length);
        const channel = this.getChannel(`cpa:${slug(name)}`);
        if (channel) channelId = channel.id;
      }
      if (!channelId) {
        const candidates = this.db
          .prepare(
            `SELECT w.id worker_id,w.channel_id FROM workers w JOIN channels c ON c.id=w.channel_id WHERE w.model_id=?`,
          )
          .all(row.modelId);
        if (candidates.length === 1) {
          workerId = candidates[0].worker_id;
          channelId = candidates[0].channel_id;
        }
      }
      if (channelId && !workerId) {
        const w = this.db
          .prepare('SELECT id FROM workers WHERE channel_id=? AND model_id=?')
          .get(channelId, row.modelId);
        workerId = w?.id ?? null;
      }
      if (!channelId) {
        const nativeId = `cpa:native-${slug(row.providerKey)}`;
        this.upsertChannel({
          id: nativeId,
          providerId: 'cpa',
          name: `CPA native · ${row.providerKey}`,
          protocol: 'native',
          enabled: true,
          health: 'unknown',
          metadata: { source: 'usage-discovery', providerKey: row.providerKey },
        });
        channelId = nativeId;
        this.upsertModel({
          id: row.modelId,
          displayName: row.modelId,
          capabilities: inferCapabilities(row.modelId),
        });
        workerId = stableWorkerId(channelId, row.modelId);
        this.upsertWorker({
          id: workerId,
          channelId,
          modelId: row.modelId,
          displayName: `${row.modelId} · ${row.providerKey}`,
          capabilities: inferCapabilities(row.modelId),
          metadata: { source: 'usage-discovery' },
        });
      }
      const metadata = {
        sources: [...row.metadata.sources],
        executorTypes: [...row.metadata.executorTypes],
      };
      const actualCost = costs.get(`${row.providerKey}\u0000${row.modelId}`) ?? 0;
      const marketValue = this.estimateMarketValue(workerId, row.modelId, row);
      this.db
        .prepare(
          `INSERT INTO external_usage_snapshots(source,range_key,provider_key,model_id,worker_id,channel_id,requests,failed_requests,input_tokens,output_tokens,cached_tokens,reasoning_tokens,actual_cost,allocated_cost,market_value,generated_at,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source,range_key,provider_key,model_id) DO UPDATE SET worker_id=excluded.worker_id,channel_id=excluded.channel_id,requests=excluded.requests,failed_requests=excluded.failed_requests,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cached_tokens=excluded.cached_tokens,reasoning_tokens=excluded.reasoning_tokens,actual_cost=excluded.actual_cost,allocated_cost=excluded.allocated_cost,market_value=excluded.market_value,generated_at=excluded.generated_at,metadata=excluded.metadata`,
        )
        .run(
          source,
          rangeKey,
          row.providerKey,
          row.modelId,
          workerId,
          channelId,
          row.requests,
          row.failedRequests,
          row.inputTokens,
          row.outputTokens,
          row.cachedTokens,
          row.reasoningTokens,
          actualCost,
          0,
          marketValue,
          generatedAt,
          enc(metadata),
        );
    }
    this.revalueExternalUsage();
    this.reallocateExternalCosts(rangeKey);
    this.emit('usage.snapshot.synced', 'usage', source, {
      source,
      range: rangeKey,
      groups: aggregated.size,
      generatedAt,
    });
    return { source, range: rangeKey, groups: aggregated.size, generatedAt };
  }
  externalStatsBy(field, rangeKey = '30d') {
    const allowed = { worker: 'worker_id', channel: 'channel_id' };
    const col = allowed[field];
    if (!col) return [];
    return this.db
      .prepare(
        `SELECT ${col} id, SUM(requests) runs, SUM(input_tokens) inputTokens, SUM(output_tokens) outputTokens, SUM(cached_tokens) cachedTokens, SUM(reasoning_tokens) reasoningTokens, SUM(actual_cost) actualCost, SUM(allocated_cost) allocatedCost, SUM(market_value) marketValue FROM external_usage_snapshots WHERE range_key=? AND ${col} IS NOT NULL GROUP BY ${col}`,
      )
      .all(rangeKey);
  }
  combinedStatsBy(field) {
    const live = this.statsBy(field);
    if (!['worker', 'channel'].includes(field)) return live;
    const map = new Map(live.map((r) => [r.id, { ...r }]));
    for (const r of this.externalStatsBy(field)) {
      const v = map.get(r.id) ?? {
        id: r.id,
        runs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        actualCost: 0,
        allocatedCost: 0,
        marketValue: 0,
      };
      for (const k of [
        'runs',
        'inputTokens',
        'outputTokens',
        'cachedTokens',
        'reasoningTokens',
        'actualCost',
        'allocatedCost',
        'marketValue',
      ])
        v[k] = Number(v[k] ?? 0) + Number(r[k] ?? 0);
      map.set(r.id, v);
    }
    return [...map.values()].sort((a, b) => Number(b.actualCost ?? 0) - Number(a.actualCost ?? 0));
  }

  syncCpa(channels) {
    const provider = this.upsertProvider({
      id: 'cpa',
      name: 'CLIProxyAPI',
      kind: 'gateway',
      metadata: { adapter: 'gatewayctl' },
    });
    for (const c of channels) {
      const channel = this.upsertChannel({
        id: `cpa:${slug(c.name)}`,
        providerId: provider.id,
        name: c.name,
        protocol: c.protocol,
        enabled: c.enabled,
        health: c.health,
        lastTest: c.lastTest,
        metadata: { source: 'gatewayctl' },
      });
      for (const modelId of c.models.filter((id) => !String(id).startsWith('position:'))) {
        const model = this.upsertModel({
          id: modelId,
          displayName: modelId,
          capabilities: inferCapabilities(modelId),
        });
        this.upsertWorker({
          channelId: channel.id,
          modelId: model.id,
          displayName: `${model.displayName} · ${c.name}`,
          enabled: c.enabled,
          capabilities: model.capabilities,
          metadata: { source: 'cpa' },
        });
      }
    }
    this.cleanupLogicalAliasArtifacts();
    this.emit('cpa.synced', 'provider', 'cpa', { channelCount: channels.length });
    return this.snapshot();
  }
  cleanupLogicalAliasArtifacts() {
    const workers = this.db
      .prepare("SELECT id FROM workers WHERE model_id LIKE 'position:%'")
      .all();
    for (const row of workers) {
      const refs =
        Number(
          this.db.prepare('SELECT COUNT(*) n FROM assignments WHERE worker_id=?').get(row.id)?.n ??
            0,
        ) +
        Number(
          this.db.prepare('SELECT COUNT(*) n FROM usage_ledger WHERE worker_id=?').get(row.id)?.n ??
            0,
        );
      if (refs === 0) this.db.prepare('DELETE FROM workers WHERE id=?').run(row.id);
    }
    const models = this.db
      .prepare("SELECT id FROM model_definitions WHERE id LIKE 'position:%'")
      .all();
    for (const row of models) {
      const refs =
        Number(
          this.db.prepare('SELECT COUNT(*) n FROM workers WHERE model_id=?').get(row.id)?.n ?? 0,
        ) +
        Number(
          this.db.prepare('SELECT COUNT(*) n FROM prices WHERE model_id=?').get(row.id)?.n ?? 0,
        );
      if (refs === 0) this.db.prepare('DELETE FROM model_definitions WHERE id=?').run(row.id);
    }
  }

  autoAssignDefaults() {
    const positions = this.list('positions', (r) => this.getPosition(r.id));
    const workers = this.list('workers', (r) => this.mapWorker(r));
    for (const position of positions) {
      const compatible = workers.filter((w) => {
        const caps = new Set(w.capabilities);
        return position.requiredCapabilities.every((c) => caps.has(c));
      });
      const compatibleIds = new Set(compatible.map((w) => w.id));
      for (const worker of compatible) {
        const channel = this.getChannel(worker.channelId);
        let priority = 10 + Number(channel?.priority ?? 0);
        if (channel?.health === 'healthy') priority += 20;
        if (channel?.enabled) priority += 20;
        if (position.id === 'hermes-brain' && worker.modelId.includes('deepseek-v4-flash'))
          priority += 40;
        if (position.id === 'codex-general' && /codex|claude|deepseek|gpt/.test(worker.modelId))
          priority += 20;
        const assignmentId = `asg:${position.id}:${worker.id}`;
        const existingAssignment = this.db
          .prepare('SELECT * FROM assignments WHERE id=?')
          .get(assignmentId);
        if (existingAssignment?.reason === 'manual-override') {
          this.db
            .prepare("UPDATE assignments SET status='standby',effective_to=NULL WHERE id=?")
            .run(assignmentId);
        } else {
          this.assign({
            id: assignmentId,
            positionId: position.id,
            workerId: worker.id,
            priority,
            status: 'standby',
            reason: 'auto-capability-match',
            metadata: { managed: true },
          });
        }
      }
      const managed = this.db
        .prepare(
          "SELECT id,worker_id FROM assignments WHERE position_id=? AND reason='auto-capability-match'",
        )
        .all(position.id);
      for (const row of managed) {
        if (!compatibleIds.has(row.worker_id))
          this.db
            .prepare("UPDATE assignments SET status='inactive',effective_to=? WHERE id=?")
            .run(now(), row.id);
      }
      const resolution = this.resolve(position.id);
      if (resolution.selected) {
        this.db
          .prepare(
            "UPDATE assignments SET status='standby' WHERE position_id=? AND reason='auto-capability-match' AND status='active'",
          )
          .run(position.id);
        this.db
          .prepare("UPDATE assignments SET status='active',effective_to=NULL WHERE id=?")
          .run(resolution.selected.assignment.id);
        this.emit('assignment.activated', 'assignment', resolution.selected.assignment.id, {
          positionId: position.id,
          workerId: resolution.selected.worker.id,
          reason: 'scheduler-selected',
        });
      }
    }
    this.emit('assignments.reconciled', 'system', 'default', {
      positions: positions.length,
      workers: workers.length,
    });
    return this.snapshot();
  }
}

function inferCapabilities(modelId) {
  const s = modelId.toLowerCase();
  const out = ['text'];
  if (/claude|gpt|deepseek|codex|sonnet|opus/.test(s)) out.push('reasoning', 'coding', 'tools');
  if (/flash|mini|haiku/.test(s)) out.push('fast');
  if (/codex|claude|deepseek|gpt/.test(s)) out.push('review');
  return normalizeCapabilities(out);
}
