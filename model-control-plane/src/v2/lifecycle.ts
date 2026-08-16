import type { DispatchService } from './dispatch.js';
import type { V2Repository, V2Row } from './repository.js';

export interface RedispatchOutcome {
  dutySessionId: string;
  status: 'SUCCEEDED' | 'FAILED';
  result?: Record<string, unknown>;
  errorCode?: string;
}

export interface LifecycleCommandResult {
  entity: V2Row;
  redispatches: RedispatchOutcome[];
}

export class WorkforceLifecycleService {
  readonly #repository: V2Repository;
  readonly #dispatch: DispatchService;

  constructor(repository: V2Repository, dispatch: DispatchService) {
    this.#repository = repository;
    this.#dispatch = dispatch;
  }

  async #redispatch(
    dutySessionIds: string[],
    trigger: string,
    correlationId?: string,
  ): Promise<RedispatchOutcome[]> {
    const outcomes: RedispatchOutcome[] = [];
    for (const dutySessionId of [...new Set(dutySessionIds)]) {
      try {
        outcomes.push({
          dutySessionId,
          status: 'SUCCEEDED',
          result: await this.#dispatch.dispatchDuty(dutySessionId, {
            trigger,
            correlationId,
          }),
        });
      } catch (error) {
        outcomes.push({
          dutySessionId,
          status: 'FAILED',
          errorCode: error instanceof Error ? error.message : 'REDISPATCH_FAILED',
        });
      }
    }
    return outcomes;
  }

  async suspendEmployment(
    employmentId: string,
    options: { reason?: string; correlationId?: string } = {},
  ): Promise<LifecycleCommandResult> {
    const current = this.#repository.getEmployment(employmentId);
    if (!current) throw new Error('EMPLOYMENT_NOT_FOUND');
    const dutyIds = this.#repository.activeDutyIdsForEmployee(String(current.employee_id));
    const entity = this.#repository.suspendEmployment(
      employmentId,
      options.reason ?? 'OPERATOR_SUSPENDED',
      options.correlationId,
    );
    return {
      entity,
      redispatches: await this.#redispatch(dutyIds, 'EMPLOYMENT_SUSPENDED', options.correlationId),
    };
  }

  async resumeEmployment(
    employmentId: string,
    options: { correlationId?: string } = {},
  ): Promise<LifecycleCommandResult> {
    const entity = this.#repository.resumeEmployment(employmentId, options.correlationId);
    return { entity, redispatches: [] };
  }

  async endEmployment(
    employmentId: string,
    options: { reason?: string; correlationId?: string } = {},
  ): Promise<LifecycleCommandResult> {
    const current = this.#repository.getEmployment(employmentId);
    if (!current) throw new Error('EMPLOYMENT_NOT_FOUND');
    const dutyIds = this.#repository.activeDutyIdsForEmployee(String(current.employee_id));
    const entity = this.#repository.endEmployment(employmentId, options.reason ?? 'OPERATOR_ENDED');
    return {
      entity,
      redispatches: await this.#redispatch(dutyIds, 'EMPLOYMENT_ENDED', options.correlationId),
    };
  }

  async suspendAppointment(
    appointmentId: string,
    options: { reason?: string; correlationId?: string } = {},
  ): Promise<LifecycleCommandResult> {
    const dutyIds = this.#repository.activeDutyIdsForAppointment(appointmentId);
    const entity = this.#repository.suspendAppointment(
      appointmentId,
      options.reason ?? 'OPERATOR_SUSPENDED',
      options.correlationId,
    );
    return {
      entity,
      redispatches: await this.#redispatch(dutyIds, 'APPOINTMENT_SUSPENDED', options.correlationId),
    };
  }

  async resumeAppointment(
    appointmentId: string,
    options: { correlationId?: string } = {},
  ): Promise<LifecycleCommandResult> {
    const entity = this.#repository.resumeAppointment(appointmentId, options.correlationId);
    return { entity, redispatches: [] };
  }

  async endAppointment(
    appointmentId: string,
    options: { reason?: string; correlationId?: string } = {},
  ): Promise<LifecycleCommandResult> {
    const dutyIds = this.#repository.activeDutyIdsForAppointment(appointmentId);
    const entity = this.#repository.endAppointment(
      appointmentId,
      options.reason ?? 'OPERATOR_ENDED',
      options.correlationId,
    );
    return {
      entity,
      redispatches: await this.#redispatch(dutyIds, 'APPOINTMENT_ENDED', options.correlationId),
    };
  }
}
