import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
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

interface CandidateRow { candidate_id: string; program_id: string; fingerprint: string; title: string; evidence: string; risk: ImprovementCandidate['risk']; status: ImprovementCandidate['status']; plan_id: string | null; pull_request_id: string | null; }

function fromRow(row: CandidateRow): ImprovementCandidate {
  return { candidateId: row.candidate_id, programId: row.program_id, fingerprint: row.fingerprint, title: row.title, evidence: JSON.parse(row.evidence) as string[], risk: row.risk, status: row.status, planId: row.plan_id ?? undefined, pullRequestId: row.pull_request_id ?? undefined };
}

export class MaintenanceCandidateRegistry {
  readonly candidates = new Map<string, ImprovementCandidate>();

  constructor(readonly db?: DatabaseSync) {
    this.db?.exec("CREATE TABLE IF NOT EXISTS improvement_candidates (candidate_id TEXT PRIMARY KEY, program_id TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE, title TEXT NOT NULL, evidence TEXT NOT NULL, status TEXT NOT NULL, plan_id TEXT, pull_request_id TEXT, risk TEXT NOT NULL DEFAULT 'LOW', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  }

  create(program: MaintenanceProgram, input: { candidateId?: string; title: string; evidence: string[]; risk: ImprovementCandidate['risk'] }): { status: 'created' | 'existing'; candidate: ImprovementCandidate } {
    failClosed(program.enabled, 'MAINTENANCE_PROGRAM_DISABLED');
    failClosed(input.title.trim().length > 0, 'CANDIDATE_TITLE_REQUIRED');
    failClosed(input.evidence.length > 0, 'CANDIDATE_EVIDENCE_REQUIRED');
    const fingerprint = createHash('sha256').update([program.projectKey, input.title.trim(), ...input.evidence.map((item) => item.trim()).sort()].join('|')).digest('hex');
    const durable = this.db?.prepare('SELECT * FROM improvement_candidates WHERE fingerprint=?').get(fingerprint) as CandidateRow | undefined;
    if (durable) return { status: 'existing', candidate: fromRow(durable) };
    const existing = this.candidates.get(fingerprint);
    if (existing) return { status: 'existing', candidate: existing };
    const candidate: ImprovementCandidate = { candidateId: input.candidateId ?? 'candidate-' + fingerprint.slice(0, 20), programId: program.programId, fingerprint, title: input.title.trim(), evidence: input.evidence.map((item) => item.trim()), risk: input.risk, status: 'DISCOVERED' };
    this.db?.prepare('INSERT INTO improvement_candidates(candidate_id,program_id,fingerprint,title,evidence,status,plan_id,pull_request_id,risk,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(candidate.candidateId, candidate.programId, candidate.fingerprint, candidate.title, JSON.stringify(candidate.evidence), candidate.status, null, null, candidate.risk, new Date().toISOString(), new Date().toISOString());
    this.candidates.set(fingerprint, candidate);
    return { status: 'created', candidate };
  }

  attachPlan(candidateId: string, planId: string): ImprovementCandidate {
    const durable = this.db?.prepare('SELECT * FROM improvement_candidates WHERE candidate_id=?').get(candidateId) as CandidateRow | undefined;
    const candidate = durable ? fromRow(durable) : Array.from(this.candidates.values()).find((item) => item.candidateId === candidateId);
    if (!candidate) throw new V4Error('CANDIDATE_NOT_FOUND');
    if (candidate.planId && candidate.planId !== planId) throw new V4Error('CANDIDATE_PLAN_IMMUTABLE');
    candidate.planId = planId;
    candidate.status = 'ADOPTED';
    this.candidates.set(candidate.fingerprint, candidate);
    this.db?.prepare('UPDATE improvement_candidates SET plan_id=?,status=?,updated_at=? WHERE candidate_id=? AND (plan_id IS NULL OR plan_id=?)').run(planId, 'ADOPTED', new Date().toISOString(), candidateId, planId);
    return candidate;
  }
}
