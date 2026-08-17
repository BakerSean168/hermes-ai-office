import {
  supportsGatewayDiscovery,
  supportsGatewayInvocation,
  supportsGatewayProvisioning,
  supportsGatewayUsage,
  type GatewayDiscoveryPort,
  type GatewayExecutionPort,
  type GatewayInvocationPort,
  type GatewayProvisioningPort,
  type GatewayUsagePort,
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

  getDiscovery(gatewayId: string): (GatewayExecutionPort & GatewayDiscoveryPort) | null {
    const gateway = this.get(gatewayId);
    return gateway && supportsGatewayDiscovery(gateway) ? gateway : null;
  }

  getUsage(gatewayId: string): (GatewayExecutionPort & GatewayUsagePort) | null {
    const gateway = this.get(gatewayId);
    return gateway && supportsGatewayUsage(gateway) ? gateway : null;
  }

  getInvocation(gatewayId: string): (GatewayExecutionPort & GatewayInvocationPort) | null {
    const gateway = this.get(gatewayId);
    return gateway && supportsGatewayInvocation(gateway) ? gateway : null;
  }

  getProvisioning(gatewayId: string): (GatewayExecutionPort & GatewayProvisioningPort) | null {
    const gateway = this.get(gatewayId);
    return gateway && supportsGatewayProvisioning(gateway) ? gateway : null;
  }

  list(): GatewayExecutionPort[] {
    return [...this.#gateways.values()];
  }
}
