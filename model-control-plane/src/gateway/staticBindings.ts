import type { GatewayBinding, GatewayBindingSource } from './ports.js';

export class StaticGatewayBindingSource implements GatewayBindingSource {
  readonly #bindings = new Map<string, GatewayBinding>();

  constructor(bindings: GatewayBinding[] = []) {
    for (const binding of bindings) this.set(binding);
  }

  set(binding: GatewayBinding): void {
    this.#bindings.set(binding.employmentId, { ...binding });
  }

  delete(employmentId: string): void {
    this.#bindings.delete(employmentId);
  }

  async findByEmploymentId(employmentId: string): Promise<GatewayBinding | null> {
    return this.#bindings.get(employmentId) ?? null;
  }
}
