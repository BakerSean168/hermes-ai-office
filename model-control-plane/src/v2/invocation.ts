import type { GatewayInvocationResult } from '../gateway/ports.js';
import { GatewayRegistry } from '../gateway/registry.js';
import type { InvocationContext, V2Repository } from './repository.js';

function safeErrorClass(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return /^[A-Z0-9_:-]{1,96}$/.test(raw) ? raw.replaceAll(':', '_') : 'GATEWAY_INVOCATION_FAILED';
}

export class InvocationService {
  readonly #repository: V2Repository;
  readonly #gateways: GatewayRegistry;

  constructor(repository: V2Repository, gateways: GatewayRegistry) {
    this.#repository = repository;
    this.#gateways = gateways;
  }

  async invokeDuty(
    dutySessionId: string,
    input: string,
    options: {
      maxOutputTokens?: number;
      correlationId?: string;
      runtimeSessionRef?: string;
      completeDuty?: boolean;
    } = {},
  ): Promise<Record<string, unknown>> {
    if (!input.trim()) throw new Error('INVOCATION_INPUT_REQUIRED');
    const context = this.#repository.invocationContext(dutySessionId);
    if (!context) throw new Error('DUTY_NOT_STAFFED_OR_ROUTABLE');
    const gateway = this.#gateways.getInvocation(context.gatewayId);
    if (!gateway) throw new Error('GATEWAY_INVOCATION_UNAVAILABLE');
    const resolution = await gateway.resolveRoute(context.employmentId);
    if (!resolution.routable || !resolution.route) throw new Error('EMPLOYMENT_ROUTE_UNAVAILABLE');
    if (resolution.route.externalRouteRef !== context.externalRouteRef) {
      throw new Error('GATEWAY_BINDING_CHANGED');
    }

    const invocation = this.#repository.startInvocation({
      context,
      runtimeSessionRef: options.runtimeSessionRef,
      correlationId: options.correlationId,
      metadata: { inputCharacters: input.length },
    });
    const invocationId = String(invocation.id);
    const attempt = this.#repository.startInvocationAttempt({
      invocationId,
      context,
      correlationId: options.correlationId,
    });
    const attemptId = String(attempt.id);

    let result: GatewayInvocationResult;
    try {
      result = await gateway.invoke({
        route: resolution.route,
        input,
        maxOutputTokens: options.maxOutputTokens,
        metadata: {
          correlationId: options.correlationId,
          runId: context.runId,
          dutySessionId: context.dutySessionId,
          invocationId,
        },
      });
      if (result.status !== 'succeeded') throw new Error('GATEWAY_RETURNED_NON_SUCCESS');
    } catch (error) {
      const errorClass = safeErrorClass(error);
      this.#repository.transaction(() => {
        this.#repository.failInvocationAttempt({
          attemptId,
          errorClass,
          correlationId: options.correlationId,
        });
        this.#repository.completeInvocation({
          invocationId,
          status: 'FAILED',
          correlationId: options.correlationId,
        });
        this.#repository.setDutyActivity(dutySessionId, 'BLOCKED', options.correlationId);
      });
      throw new Error(errorClass);
    }

    const usage = this.#repository.transaction(() => {
      this.#repository.completeInvocationAttempt({
        attemptId,
        gatewayRequestId: result.gatewayRequestId,
        externalDeploymentRef: result.externalDeploymentRef,
        latencyMs: result.latencyMs,
        correlationId: options.correlationId,
        metadata: {
          responseModel: result.responseModel ?? null,
          gateway: result.metadata ?? {},
        },
      });
      const usageEntry = this.#repository.recordUsage({
        attemptId,
        context,
        source: `gateway:${context.gatewayId}`,
        correlationId: options.correlationId,
        usage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: result.cacheReadTokens,
          cacheWriteTokens: result.cacheWriteTokens,
          reasoningTokens: result.reasoningTokens,
          actualCost: result.actualCost,
          currency: result.currency,
        },
        metadata: {
          gatewayRequestId: result.gatewayRequestId,
          externalDeploymentRef: result.externalDeploymentRef ?? null,
        },
      });
      this.#repository.completeInvocation({
        invocationId,
        status: 'SUCCEEDED',
        correlationId: options.correlationId,
      });
      if (options.completeDuty ?? true) {
        this.#repository.completeDuty({
          dutySessionId,
          outcome: 'COMPLETED',
          reason: 'INVOCATION_SUCCEEDED',
          correlationId: options.correlationId,
        });
      } else {
        this.#repository.setDutyActivity(dutySessionId, 'REVIEWING', options.correlationId);
      }
      return usageEntry;
    });

    return {
      invocationId,
      attemptId,
      usageEntryId: usage.id,
      employeeId: context.employeeId,
      employmentId: context.employmentId,
      gatewayId: context.gatewayId,
      externalRouteRef: context.externalRouteRef,
      gatewayRequestId: result.gatewayRequestId,
      externalDeploymentRef: result.externalDeploymentRef ?? null,
      status: result.status,
      outputText: result.outputText,
      usage: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
        reasoningTokens: result.reasoningTokens,
        actualCost: result.actualCost ?? 0,
        currency: result.currency ?? 'USD',
      },
      latencyMs: result.latencyMs,
    };
  }
}
