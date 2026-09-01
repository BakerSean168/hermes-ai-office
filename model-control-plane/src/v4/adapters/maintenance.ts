import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { DuplicateKeyError, V4Error, failClosed } from '../domain/errors.js';
import { assertCurrentV4Schema, openV4Database, withTransaction } from '../persistence/database.js';

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

interface ProgramRow {
  program_id: string;
  project_key: string;
  policy: string;
  status: string;
}

interface CandidateRow {
  candidate_id: string;
  program_id: string;
  fingerprint: string;
  title: string;
  evidence: string;
  risk: ImprovementCandidate['risk'];
  status: ImprovementCandidate['status'];
  plan_id: string | null;
  pull_request_id: string | null;
}

const CANDIDATE_RISKS = new Set<ImprovementCandidate['risk']>(['LOW', 'MEDIUM', 'HIGH']);
const CANDIDATE_STATUSES = new Set<ImprovementCandidate['status']>(['DISCOVERED', 'QUEUED', 'ADOPTED', 'REJECTED', 'STALE', 'COMPLETED']);

function decodeEvidence(value: string): string[] {
  try {
    const decoded = JSON.parse(value) as unknown;
    if (!Array.isArray(decoded) || decoded.length === 0 || !decoded.every((item) => typeof item === 'string' && item.trim().length > 0)) {
      throw new Error('invalid evidence');
    }
    return decoded;
  } catch (error) {
    throw new V4Error('CORRUPTED_CANDIDATE_EVIDENCE', 'Candidate evidence is not a non-empty string array.', error);
  }
}

function fromRow(row: CandidateRow): ImprovementCandidate {
  if (!row.candidate_id.trim() || !row.program_id.trim() || !row.fingerprint.trim() || !row.title.trim()) {
    throw new V4Error('CORRUPTED_CANDIDATE_IDENTITY');
  }
  if (!CANDIDATE_RISKS.has(row.risk) || !CANDIDATE_STATUSES.has(row.status)) {
    throw new V4Error('CORRUPTED_CANDIDATE_STATE');
  }
  if (row.plan_id !== null && !row.plan_id.trim()) throw new V4Error('CORRUPTED_CANDIDATE_IDENTITY');
  if (row.pull_request_id !== null && !row.pull_request_id.trim()) throw new V4Error('CORRUPTED_CANDIDATE_IDENTITY');
  return {
    candidateId: row.candidate_id,
    programId: row.program_id,
    fingerprint: row.fingerprint,
    title: row.title,
    evidence: decodeEvidence(row.evidence),
    risk: row.risk,
    status: row.status,
    planId: row.plan_id ?? undefined,
    pullRequestId: row.pull_request_id ?? undefined,
  };
}

function programPolicy(program: MaintenanceProgram): string {
  return JSON.stringify({
    implementationRoutes: program.implementationRoutes,
    reviewRoutes: program.reviewRoutes,
    autonomousScope: program.autonomousScope,
    autoMerge: program.autoMerge,
  });
}

function normalizedEvidence(evidence: string[]): string[] {
  const values = evidence.map((item) => item.trim());
  failClosed(values.every((item) => item.length > 0), 'CANDIDATE_EVIDENCE_INVALID');
  return values;
}

export class MaintenanceCandidateRegistry {
  constructor(
    readonly db: DatabaseSync = openV4Database(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } }),
  ) {
    assertCurrentV4Schema(this.db);
  }

  create(
    program: MaintenanceProgram,
    input: { candidateId?: string; title: string; evidence: string[]; risk: ImprovementCandidate['risk'] },
  ): { status: 'created' | 'existing'; candidate: ImprovementCandidate } {
    failClosed(program.enabled, 'MAINTENANCE_PROGRAM_DISABLED');
    failClosed(program.programId.trim().length > 0 && program.projectKey.trim().length > 0, 'MAINTENANCE_PROGRAM_INVALID');
    failClosed(program.implementationRoutes.length > 0, 'MAINTENANCE_IMPLEMENTATION_ROUTE_REQUIRED');
    failClosed(program.reviewRoutes.length > 0, 'MAINTENANCE_REVIEW_ROUTE_REQUIRED');
    const title = input.title.trim();
    failClosed(title.length > 0, 'CANDIDATE_TITLE_REQUIRED');
    failClosed(input.evidence.length > 0, 'CANDIDATE_EVIDENCE_REQUIRED');
    const evidence = normalizedEvidence(input.evidence);
    const policy = programPolicy(program);
    const fingerprint = createHash('sha256')
      .update([program.projectKey, title, ...[...evidence].sort()].join('|'))
      .digest('hex');

    return withTransaction(this.db, () => {
      const now = new Date().toISOString();
      const durableProgram = this.db.prepare('SELECT * FROM maintenance_programs WHERE program_id=?').get(program.programId) as ProgramRow | undefined;
      if (durableProgram) {
        if (durableProgram.project_key !== program.projectKey || durableProgram.policy !== policy) {
          throw new V4Error('MAINTENANCE_PROGRAM_CONFLICT');
        }
        if (durableProgram.status !== 'ACTIVE') throw new V4Error('MAINTENANCE_PROGRAM_DISABLED');
      } else {
        this.db.prepare('INSERT INTO maintenance_programs(program_id,project_key,policy,status,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(
          program.programId, program.projectKey, policy, 'ACTIVE', now, now,
        );
      }

      const durable = this.db.prepare('SELECT * FROM improvement_candidates WHERE fingerprint=?').get(fingerprint) as CandidateRow | undefined;
      if (durable) {
        const candidate = fromRow(durable);
        const same = candidate.programId === program.programId
          && candidate.title === title
          && candidate.risk === input.risk
          && JSON.stringify(candidate.evidence) === JSON.stringify(evidence);
        if (!same) throw new DuplicateKeyError(fingerprint);
        return { status: 'existing', candidate };
      }

      const candidate: ImprovementCandidate = {
        candidateId: input.candidateId ?? 'candidate-' + fingerprint.slice(0, 20),
        programId: program.programId,
        fingerprint,
        title,
        evidence,
        risk: input.risk,
        status: 'DISCOVERED',
      };
      const idConflict = this.db.prepare('SELECT candidate_id FROM improvement_candidates WHERE candidate_id=?').get(candidate.candidateId);
      if (idConflict) throw new DuplicateKeyError(candidate.candidateId);
      this.db.prepare('INSERT INTO improvement_candidates(candidate_id,program_id,fingerprint,title,evidence,status,plan_id,pull_request_id,risk,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
        candidate.candidateId, candidate.programId, candidate.fingerprint, candidate.title,
        JSON.stringify(candidate.evidence), candidate.status, null, null, candidate.risk, now, now,
      );
      return { status: 'created', candidate };
    });
  }

  attachPlan(candidateId: string, planId: string): ImprovementCandidate {
    failClosed(candidateId.trim().length > 0 && planId.trim().length > 0, 'CANDIDATE_PLAN_INPUT_INVALID');
    return withTransaction(this.db, () => {
      const durable = this.db.prepare('SELECT * FROM improvement_candidates WHERE candidate_id=?').get(candidateId) as CandidateRow | undefined;
      const candidate = durable ? fromRow(durable) : undefined;
      if (!candidate) throw new V4Error('CANDIDATE_NOT_FOUND');
      if (candidate.planId === planId) return candidate;
      if (candidate.planId) throw new V4Error('CANDIDATE_PLAN_IMMUTABLE');
      if (!this.db.prepare('SELECT plan_id FROM plans WHERE plan_id=?').get(planId)) throw new V4Error('PLAN_NOT_FOUND');
      const result = this.db.prepare('UPDATE improvement_candidates SET plan_id=?,status=?,updated_at=? WHERE candidate_id=? AND plan_id IS NULL').run(
        planId, 'ADOPTED', new Date().toISOString(), candidateId,
      );
      if (Number(result.changes) !== 1) throw new V4Error('CANDIDATE_PLAN_STALE');
      return fromRow(this.db.prepare('SELECT * FROM improvement_candidates WHERE candidate_id=?').get(candidateId) as unknown as CandidateRow);
    });
  }
}
