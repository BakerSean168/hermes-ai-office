import type { GatewayRouteResolution } from '../gateway/ports.js';
import { GatewayRegistry } from '../gateway/registry.js';
import type { DispatchCandidate, V2Repository } from './repository.js';

interface RouteResult {
  employmentId: string;
  gatewayId: string;
  externalRouteRef: string;
  routable: boolean;
  reasons: string[];
}

interface CandidateResult {
  employeeId: string;
  employeeName: string;
  appointmentId: string;
  appointmentClass: string;
  appointmentPriority: number;
  qualified: boolean;
  eligible: boolean;
  routable: boolean;
  reasons: string[];
  routes: RouteResult[];
}

function appointmentRank(value: DispatchCandidate['appointmentClass']): number {
  if (value === 'PRIMARY') return 0;
  if (value === 'BACKUP') return 1;
  return 2;
}

export class DispatchService {
  readonly #repository: V2Repository;
  readonly #gateways: GatewayRegistry;

  constructor(repository: V2Repository, gateways: GatewayRegistry) {
    this.#repository = repository;
    this.#gateways = gateways;
  }

  async dispatchDuty(
    dutySessionId: string,
    options: { trigger?: string; correlationId?: string } = {},
  ): Promise<Record<string, unknown>> {
    const duty = this.#repository.getDuty(dutySessionId);
    if (!duty) throw new Error('DUTY_NOT_FOUND');
    const candidates = this.#repository
      .dispatchCandidates(String(duty.position_id))
      .sort(
        (left, right) =>
          appointmentRank(left.appointmentClass) - appointmentRank(right.appointmentClass) ||
          right.appointmentPriority - left.appointmentPriority ||
          left.employeeId.localeCompare(right.employeeId),
      );
    const candidateResults: CandidateResult[] = [];
    let selection:
      | {
          employeeId: string;
          appointmentId: string;
          employmentId: string;
          route: GatewayRouteResolution['route'];
        }
      | undefined;

    for (const candidate of candidates) {
      const routeResults: RouteResult[] = [];
      if (candidate.eligible) {
        for (const route of candidate.routes) {
          const gateway = this.#gateways.get(route.gatewayId);
          if (!gateway) {
            routeResults.push({
              employmentId: route.employmentId,
              gatewayId: route.gatewayId,
              externalRouteRef: route.externalRouteRef,
              routable: false,
              reasons: ['GATEWAY_ADAPTER_UNAVAILABLE'],
            });
            continue;
          }
          let resolution: GatewayRouteResolution;
          try {
            resolution = await gateway.resolveRoute(route.employmentId);
          } catch {
            resolution = {
              route: null,
              routable: false,
              reasons: ['GATEWAY_RESOLUTION_FAILED'],
              observedAt: Date.now(),
            };
          }
          routeResults.push({
            employmentId: route.employmentId,
            gatewayId: route.gatewayId,
            externalRouteRef: route.externalRouteRef,
            routable: resolution.routable,
            reasons: resolution.reasons,
          });
          if (!selection && resolution.routable && resolution.route) {
            selection = {
              employeeId: candidate.employeeId,
              appointmentId: candidate.appointmentId,
              employmentId: route.employmentId,
              route: resolution.route,
            };
          }
        }
      }
      const routable = routeResults.some((route) => route.routable);
      candidateResults.push({
        employeeId: candidate.employeeId,
        employeeName: candidate.employeeName,
        appointmentId: candidate.appointmentId,
        appointmentClass: candidate.appointmentClass,
        appointmentPriority: candidate.appointmentPriority,
        qualified: candidate.qualified,
        eligible: candidate.eligible,
        routable,
        reasons: [
          ...candidate.reasons,
          ...(candidate.routes.length === 0 ? ['NO_CURRENT_EMPLOYMENT_ROUTE'] : []),
          ...(candidate.routes.length > 0 && !routable ? ['NO_HEALTHY_GATEWAY_ROUTE'] : []),
        ],
        routes: routeResults,
      });
    }

    const decision = this.#repository.recordDispatch({
      dutySessionId,
      trigger: options.trigger ?? 'DUTY_STARTED',
      policyVersion: 'reference-v1',
      correlationId: options.correlationId,
      candidateResults,
      selected: selection
        ? {
            employeeId: selection.employeeId,
            appointmentId: selection.appointmentId,
            employmentId: selection.employmentId,
          }
        : undefined,
      reasons: selection ? ['APPOINTMENT_AND_ROUTE_SELECTED'] : ['NO_ROUTABLE_EMPLOYEE'],
    });
    return {
      ...decision,
      selectedRoute: selection?.route ?? null,
      candidateResults,
    };
  }
}
