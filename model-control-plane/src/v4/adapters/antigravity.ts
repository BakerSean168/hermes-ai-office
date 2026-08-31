import { V4Error } from '../domain/errors.js';
import type { ResourceObservation } from '../domain/resource.js';

export interface AntiGravityProbe {
  probe(): ResourceObservation;
}

export class AntiGravityReadinessAdapter {
  constructor(readonly probeClient?: AntiGravityProbe) {}

  observe(resourceId = 'antigravity'): ResourceObservation {
    const observation = this.probeClient?.probe() ?? { resourceId, kind: 'NATIVE_MACHINE' as const, status: 'UNCONFIGURED' as const, capabilities: [], observedAt: new Date().toISOString() };
    return { ...observation, resourceId };
  }

  requireReady(resourceId = 'antigravity'): ResourceObservation {
    const observation = this.observe(resourceId);
    if (observation.status !== 'AVAILABLE') throw new V4Error('RESOURCE_NOT_READY', 'Anti-Gravity is not available: ' + observation.status);
    return observation;
  }
}
