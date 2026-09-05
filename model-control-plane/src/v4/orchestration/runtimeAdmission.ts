import type {
  ResourceCandidateReadinessPort,
  ResourceSelectionCandidate,
} from './resourceSelector.js';

export interface RuntimeAdmissionStatus {
  key: string;
  agentBackend: string;
  transport: string;
  resourceId: string;
  bindingId: string;
  modelFamily: string;
  routeModel?: string;
  ready: boolean;
  checkedAt: string;
  errorCode?: string;
}

export function runtimeAdmissionKey(candidate: ResourceSelectionCandidate): string {
  const profile = candidate.profile;
  return [
    profile.agentBackend,
    profile.transport,
    profile.resourceId,
    profile.bindingId ?? candidate.binding.bindingId,
    profile.routeModel ?? profile.modelFamily,
  ].join('|');
}

export function requiresAcpRuntimeAdmission(candidate: ResourceSelectionCandidate): boolean {
  return candidate.profile.agentBackend.endsWith('-acp');
}

export function isTransientRuntimeAdmissionFailure(errorCode: string | undefined): boolean {
  if (!errorCode) return false;
  return (
    errorCode === 'OPENHANDS_UNAVAILABLE' ||
    errorCode === 'OPENHANDS_TIMEOUT' ||
    errorCode === 'RUNTIME_PROBE_TRANSPORT_ERROR' ||
    /^OPENHANDS_HTTP_5\d\d$/.test(errorCode)
  );
}

export class RuntimeAdmissionRegistry implements ResourceCandidateReadinessPort {
  private readonly statuses = new Map<string, RuntimeAdmissionStatus>();

  isReady(candidate: ResourceSelectionCandidate): boolean {
    if (!requiresAcpRuntimeAdmission(candidate)) return true;
    return this.statuses.get(runtimeAdmissionKey(candidate))?.ready === true;
  }

  get(candidate: ResourceSelectionCandidate): RuntimeAdmissionStatus | undefined {
    return this.statuses.get(runtimeAdmissionKey(candidate));
  }

  record(
    candidate: ResourceSelectionCandidate,
    input: { ready: boolean; checkedAt?: string; errorCode?: string },
  ): RuntimeAdmissionStatus {
    const status: RuntimeAdmissionStatus = {
      key: runtimeAdmissionKey(candidate),
      agentBackend: candidate.profile.agentBackend,
      transport: candidate.profile.transport,
      resourceId: candidate.profile.resourceId,
      bindingId: candidate.profile.bindingId ?? candidate.binding.bindingId,
      modelFamily: candidate.profile.modelFamily,
      ...(candidate.profile.routeModel ? { routeModel: candidate.profile.routeModel } : {}),
      ready: input.ready,
      checkedAt: input.checkedAt ?? new Date().toISOString(),
      ...(input.errorCode ? { errorCode: input.errorCode.slice(0, 500) } : {}),
    };
    this.statuses.set(status.key, status);
    return status;
  }

  isStale(
    candidate: ResourceSelectionCandidate,
    nowMs: number,
    ttlMs: number,
    transientFailureTtlMs = ttlMs,
  ): boolean {
    const status = this.get(candidate);
    if (!status) return true;
    const checkedAt = Date.parse(status.checkedAt);
    if (!Number.isFinite(checkedAt)) return true;
    const effectiveTtl =
      !status.ready && isTransientRuntimeAdmissionFailure(status.errorCode)
        ? Math.min(ttlMs, transientFailureTtlMs)
        : ttlMs;
    return nowMs - checkedAt >= effectiveTtl;
  }

  list(): RuntimeAdmissionStatus[] {
    return [...this.statuses.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  summary(): {
    checked: number;
    ready: number;
    unready: number;
    implementationReady: number;
    reviewReady: number;
  } {
    const values = this.list();
    return {
      checked: values.length,
      ready: values.filter((item) => item.ready).length,
      unready: values.filter((item) => !item.ready).length,
      implementationReady: values.filter(
        (item) => item.ready && /(?:dsh|zcode|codex)-acp/.test(item.agentBackend),
      ).length,
      reviewReady: values.filter(
        (item) => item.ready && /(?:codex|claude)-acp/.test(item.agentBackend),
      ).length,
    };
  }
}
