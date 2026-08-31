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

export interface SupervisorDecisionClient {
  decide(input: { conversationId: string; supervisorId: string; planId: string; projection: SupervisorProjection }): Promise<string>;
}

export class HttpSupervisorDecisionClient implements SupervisorDecisionClient {
  constructor(readonly endpoint: string, readonly bearerToken?: string, readonly fetchImpl: typeof fetch = fetch) {}
  async decide(input: { conversationId: string; supervisorId: string; planId: string; projection: SupervisorProjection }): Promise<string> {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: Object.fromEntries([['content-type', 'application/json'], ...(this.bearerToken ? [['authorization', 'Bearer ' + this.bearerToken]] : [])]),
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
      const conversation = this.host.startOrResume({ supervisorId: supervisor.supervisorId, planId: supervisor.planId, conversationId: supervisor.conversationId, projection });
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
      return { supervisorId: request.supervisorId, status: 'FAILED', code: error instanceof V4Error ? error.code : 'SUPERVISOR_RUNTIME_FAILED' };
    } finally {
      this.supervisors.releaseLease(request.supervisorId, this.ownerId, claim.value.leaseToken);
    }
  }
}
