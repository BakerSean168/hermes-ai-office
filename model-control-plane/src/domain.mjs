export const HEALTH = new Set(['healthy', 'degraded', 'unavailable', 'disabled', 'unknown']);
export const POSITION_KINDS = new Set([
  'brain',
  'developer',
  'reviewer',
  'researcher',
  'tester',
  'generic',
]);

export function stableWorkerId(channelId, modelId) {
  return `worker:${channelId}:${modelId}`;
}

export function normalizeCapabilities(value) {
  if (Array.isArray(value)) return [...new Set(value.map(String).filter(Boolean))].sort();
  if (typeof value === 'string')
    return [
      ...new Set(
        value
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    ].sort();
  return [];
}

export function eligible(worker, position, channel, quota) {
  if (!worker || !position || !channel) return false;
  if (worker.enabled === 0 || channel.enabled === 0) return false;
  if (!['healthy', 'unknown'].includes(channel.health)) return false;
  const routeProtocol = position.metadata?.routeProtocol;
  if (routeProtocol && channel.protocol !== routeProtocol) return false;
  const needs = normalizeCapabilities(position.requiredCapabilities);
  const has = new Set(normalizeCapabilities(worker.capabilities));
  if (needs.some((cap) => !has.has(cap))) return false;
  if (position.minContext && worker.contextWindow && worker.contextWindow < position.minContext)
    return false;
  if (quota && quota.remaining !== null && quota.remaining <= 0) return false;
  return true;
}

export function scoreCandidate({ worker, position, channel, quota, assignment, now = Date.now() }) {
  const weights = position.weights ?? {};
  const priority = Number(assignment?.priority ?? worker.priority ?? channel.priority ?? 0);
  const quality = Number(worker.qualityScore ?? 0.7);
  const reliability = Number(worker.reliabilityScore ?? 0.8);
  const latency = Number(worker.latencyScore ?? 0.7);
  const cost = Number(worker.costScore ?? 0.7);
  let quotaEfficiency = 0.5;
  if (quota?.remaining != null && quota?.limit != null && quota.limit > 0) {
    quotaEfficiency = Math.max(0, Math.min(1, quota.remaining / quota.limit));
    if (quota.resetAt && quota.resetAt > now) {
      const days = (quota.resetAt - now) / 86400000;
      if (days < 3 && quotaEfficiency > 0.2) quotaEfficiency = Math.min(1, quotaEfficiency + 0.25);
    }
  }
  return (
    priority * 1000 +
    quality * Number(weights.quality ?? 35) +
    reliability * Number(weights.reliability ?? 20) +
    latency * Number(weights.latency ?? 10) +
    cost * Number(weights.cost ?? 20) +
    quotaEfficiency * Number(weights.quota ?? 15)
  );
}
