import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SupervisorProjection } from './projection.js';
import { buildBoundedProjection } from './projection.js';
import { parseSupervisorDecision } from './protocol.js';
import type { SupervisorActionExecutor } from './executor.js';
import { SupervisorWakeScheduler, type WakeRequest } from './scheduler.js';
import type { SupervisorRepository } from '../persistence/repositories.js';
import type { OpenHandsSupervisorAdapter } from '../adapters/openhands.js';
import { V4Error } from '../domain/errors.js';

export class OpenAICompatibleSupervisorDecisionClient implements SupervisorDecisionClient {
  constructor(readonly baseUrl: string, readonly model: string, readonly bearerToken: string, readonly fetchImpl: typeof fetch = fetch, readonly timeoutMs = 60_000) {}
  async decide(input: { conversationId: string; supervisorId: string; planId: string; projection: SupervisorProjection }): Promise<string> {
    const endpoint = this.baseUrl.replace(/\/$/, '') + (this.baseUrl.endsWith('/v1') ? '/chat/completions' : '/v1/chat/completions');
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: Object.fromEntries([['content-type', 'application/json'], ['authorization', 'Bearer ' + this.bearerToken]]),
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Return exactly one PIXEL_SUPERVISOR_DECISION_V1 JSON object. Never claim shell, workspace, credential, merge, deployment, or autonomous authority.' },
          { role: 'user', content: JSON.stringify({ conversationId: input.conversationId, supervisorId: input.supervisorId, planId: input.planId, projection: input.projection }) },
        ],
      }),
    });
    if (!response.ok) throw new V4Error('SUPERVISOR_MODEL_UNAVAILABLE', 'Supervisor provider HTTP ' + response.status);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0 || content.length > 64_000) throw new V4Error('SUPERVISOR_DECISION_INVALID');
    const trimmed = content.trim();
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) throw new V4Error('SUPERVISOR_DECISION_INVALID');
    return trimmed.slice(start, end + 1);
  }
}

export interface SupervisorDecisionClient {
  decide(input: { conversationId: string; supervisorId: string; planId: string; projection: SupervisorProjection }): Promise<string>;
}

export class HttpSupervisorDecisionClient implements SupervisorDecisionClient {
  constructor(readonly endpoint: string, readonly bearerToken?: string, readonly fetchImpl: typeof fetch = fetch, readonly timeoutMs = 30_000) {}
  async decide(input: { conversationId: string; supervisorId: string; planId: string; projection: SupervisorProjection }): Promise<string> {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: Object.fromEntries([['content-type', 'application/json'], ...(this.bearerToken ? [['authorization', 'Bearer ' + this.bearerToken]] : [])]),
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({ protocol: 'PIXEL_SUPERVISOR_DECISION_V1', conversationId: input.conversationId, supervisorId: input.supervisorId, planId: input.planId, projection: input.projection }),
    });
    if (!response.ok) throw new V4Error('SUPERVISOR_MODEL_UNAVAILABLE', 'Supervisor model HTTP ' + response.status);
    const payload = await response.text();
    if (payload.length === 0 || payload.length > 64_000) throw new V4Error('SUPERVISOR_DECISION_INVALID');
    return payload;
  }
}

export interface SupervisorRunResult {
  supervisorId: string;
  status: 'SUCCEEDED' | 'SKIPPED' | 'FAILED';
  code: string;
}

export class SupervisorRuntime {
  constructor(
    readonly db: DatabaseSync,
    readonly supervisors: SupervisorRepository,
    readonly scheduler: SupervisorWakeScheduler,
    readonly host: OpenHandsSupervisorAdapter,
    readonly actions: SupervisorActionExecutor,
    readonly client?: SupervisorDecisionClient,
    readonly ownerId = 'supervisor-worker-' + randomUUID(),
    readonly leaseTtlMs = 30_000,
  ) {}

  async runOnce(now = new Date().toISOString()): Promise<SupervisorRunResult[]> {
    const requests = this.scheduler.drain().concat(this.scheduler.recoverDue(now));
    const unique = new Map<string, WakeRequest>();
    for (const request of requests) unique.set(request.supervisorId + ':' + request.observationCursor + ':' + request.reason, request);
    const results: SupervisorRunResult[] = [];
    for (const request of unique.values()) results.push(await this.runOne(request));
    return results;
  }

  private async runOne(request: WakeRequest): Promise<SupervisorRunResult> {
    const claim = this.supervisors.claimLease(request.supervisorId, this.ownerId, this.leaseTtlMs);
    if (!claim.value || claim.status === 'rejected') return { supervisorId: request.supervisorId, status: 'SKIPPED', code: claim.reason ?? 'LEASE_HELD' };
    try {
      const supervisor = this.supervisors.getById(request.supervisorId);
      if (supervisor.status === 'CREATED') this.supervisors.updateStatus(supervisor.supervisorId, 'ACTIVE');
      if (['ACTIVE', 'SLEEPING', 'WAITING_FOR_RESOURCE', 'WAITING_FOR_SYSTEM_REPAIR', 'WAITING_FOR_EXTERNAL_EVIDENCE'].includes(supervisor.status)) this.supervisors.updateStatus(supervisor.supervisorId, 'OBSERVING');
      const projection = buildBoundedProjection(this.db, supervisor.supervisorId);
      const conversation = await this.host.startOrResume({ supervisorId: supervisor.supervisorId, planId: supervisor.planId, conversationId: supervisor.conversationId, projection });
      this.supervisors.attachConversation(supervisor.supervisorId, conversation.conversationId);
      if (!this.client) throw new V4Error('SUPERVISOR_MODEL_UNAVAILABLE');
      const raw = await this.client.decide({ conversationId: conversation.conversationId, supervisorId: supervisor.supervisorId, planId: supervisor.planId, projection });
      const decision = parseSupervisorDecision(raw);
      const result = this.actions.execute(decision, projection);
      if (result.status === 'SUCCEEDED' || result.status === 'DUPLICATE' || result.status === 'REJECTED') {
        const current = this.supervisors.getById(supervisor.supervisorId);
        if (current.status === 'OBSERVING') this.supervisors.updateStatus(current.supervisorId, 'SLEEPING');
      }
      return { supervisorId: supervisor.supervisorId, status: result.status === 'SUCCEEDED' || result.status === 'DUPLICATE' ? 'SUCCEEDED' : 'FAILED', code: result.code };
    } catch (error) {
      const current = this.supervisors.getById(request.supervisorId);
      if (current.status === 'OBSERVING') this.supervisors.updateStatus(current.supervisorId, 'SLEEPING');
      const code = error instanceof V4Error ? (error.code + (error.message !== error.code ? ':' + error.message.replace(/[^A-Za-z0-9_.=:-]/g, '_').slice(0, 100) : '')) : error instanceof Error ? error.message.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120) : 'SUPERVISOR_RUNTIME_FAILED';
      return { supervisorId: request.supervisorId, status: 'FAILED', code };
    } finally {
      this.supervisors.releaseLease(request.supervisorId, this.ownerId, claim.value.leaseToken);
    }
  }
}
