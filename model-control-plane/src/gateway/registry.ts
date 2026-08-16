import {
  supportsGatewayInvocation,
  type GatewayExecutionPort,
  type GatewayInvocationPort,
} from './ports.js';

export class GatewayRegistry {
  readonly #gateways = new Map<string, GatewayExecutionPort>();

  constructor(gateways: GatewayExecutionPort[] = []) {
    for (const gateway of gateways) this.register(gateway);
  }

  register(gateway: GatewayExecutionPort): void {
    this.#gateways.set(gateway.gatewayId, gateway);
  }

  get(gatewayId: string): GatewayExecutionPort | null {
    return this.#gateways.get(gatewayId) ?? null;
  }

  getInvocation(gatewayId: string): (GatewayExecutionPort & GatewayInvocationPort) | null {
    const gateway = this.get(gatewayId);
    return gateway && supportsGatewayInvocation(gateway) ? gateway : null;
  }

  list(): GatewayExecutionPort[] {
    return [...this.#gateways.values()];
  }
}
