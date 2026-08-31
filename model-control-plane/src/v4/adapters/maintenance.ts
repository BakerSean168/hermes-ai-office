import { createHash } from 'node:crypto';
import { V4Error, failClosed } from '../domain/errors.js';

export interface MaintenanceProgram {
  programId: string;
  projectKey: string;
  implementationRoutes: string[];
  reviewRoutes: string[];
  autonomousScope: 'CONSERVATIVE' | 'STANDARD';
  autoMerge: boolean;
  enabled: boolean;
}

export interface ImprovementCandidate {
  candidateId: string;
  programId: string;
  fingerprint: string;
  title: string;
  evidence: string[];
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  status: 'DISCOVERED' | 'QUEUED' | 'ADOPTED' | 'REJECTED' | 'STALE' | 'COMPLETED';
  planId?: string;
  pullRequestId?: string;
}

export class MaintenanceCandidateRegistry {
  readonly candidates = new Map<string, ImprovementCandidate>();

  create(program: MaintenanceProgram, input: { candidateId?: string; title: string; evidence: string[]; risk: ImprovementCandidate['risk'] }): { status: 'created' | 'existing'; candidate: ImprovementCandidate } {
    failClosed(program.enabled, 'MAINTENANCE_PROGRAM_DISABLED');
    failClosed(input.title.trim().length > 0, 'CANDIDATE_TITLE_REQUIRED');
    failClosed(input.evidence.length > 0, 'CANDIDATE_EVIDENCE_REQUIRED');
    const fingerprint = createHash('sha256').update([program.projectKey, input.title.trim(), ...input.evidence.map((item) => item.trim()).sort()].join('|')).digest('hex');
    const existing = this.candidates.get(fingerprint);
    if (existing) return { status: 'existing', candidate: existing };
    const candidate: ImprovementCandidate = { candidateId: input.candidateId ?? 'candidate-' + fingerprint.slice(0, 20), programId: program.programId, fingerprint, title: input.title.trim(), evidence: input.evidence.map((item) => item.trim()), risk: input.risk, status: 'DISCOVERED' };
    this.candidates.set(fingerprint, candidate);
    return { status: 'created', candidate };
  }

  attachPlan(candidateId: string, planId: string): ImprovementCandidate {
    const candidate = Array.from(this.candidates.values()).find((item) => item.candidateId === candidateId);
    if (!candidate) throw new V4Error('CANDIDATE_NOT_FOUND');
    if (candidate.planId && candidate.planId !== planId) throw new V4Error('CANDIDATE_PLAN_IMMUTABLE');
    candidate.planId = planId;
    candidate.status = 'ADOPTED';
    return candidate;
  }
}
