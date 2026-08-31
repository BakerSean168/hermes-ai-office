import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { V4Error, failClosed } from '../domain/errors.js';

export interface GitHubPullRequest {
  repository: string;
  number: number;
  baseBranch: string;
  baseSha: string;
  headSha: string;
  headRef: string;
  headRepository: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
}

export interface ExternalChangeRecord extends GitHubPullRequest {
  externalChangeId: string;
  fingerprint: string;
  status: 'PENDING' | 'STALE' | 'REVIEWED' | 'REJECTED' | 'READY';
}

export class GitHubPrIntake {
  readonly changes = new Map<string, ExternalChangeRecord>();
  constructor(readonly db?: DatabaseSync) {
    this.db?.exec('CREATE TABLE IF NOT EXISTS external_changes (external_change_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, repository TEXT NOT NULL, base_sha TEXT NOT NULL, head_sha TEXT NOT NULL, source_ref TEXT NOT NULL, status TEXT NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
  }

  adopt(pr: GitHubPullRequest): ExternalChangeRecord {
    failClosed(pr.repository.length > 0, 'GITHUB_REPOSITORY_REQUIRED');
    failClosed(pr.baseSha.length > 0 && pr.headSha.length > 0, 'GITHUB_SHA_REQUIRED');
    const fingerprint = createHash('sha256').update([pr.repository, String(pr.number), pr.baseBranch, pr.baseSha, pr.headSha, pr.headRef, pr.headRepository].join('|')).digest('hex');
    const durable = this.db?.prepare('SELECT * FROM external_changes WHERE fingerprint=?').get(fingerprint) as { external_change_id: string; repository: string; base_sha: string; head_sha: string; source_ref: string; status: ExternalChangeRecord['status']; evidence: string } | undefined;
    if (durable) return { ...pr, externalChangeId: durable.external_change_id, fingerprint, status: durable.status };
    const existing = this.changes.get(fingerprint);
    if (existing) return existing;
    const record: ExternalChangeRecord = { ...pr, externalChangeId: 'external-' + fingerprint.slice(0, 20), fingerprint, status: 'PENDING' };
    this.changes.set(fingerprint, record);
    this.db?.prepare('INSERT INTO external_changes(external_change_id,fingerprint,repository,base_sha,head_sha,source_ref,status,evidence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(record.externalChangeId, fingerprint, pr.repository, pr.baseSha, pr.headSha, pr.headRef, record.status, JSON.stringify(pr), new Date().toISOString(), new Date().toISOString());
    return record;
  }

  invalidateIfHeadChanged(externalChangeId: string, currentHeadSha: string): ExternalChangeRecord {
    const record = Array.from(this.changes.values()).find((item) => item.externalChangeId === externalChangeId);
    if (!record) throw new V4Error('EXTERNAL_CHANGE_NOT_FOUND');
    if (record.headSha !== currentHeadSha && record.status !== 'STALE') { record.status = 'STALE'; this.db?.prepare('UPDATE external_changes SET status=?,updated_at=? WHERE external_change_id=?').run('STALE', new Date().toISOString(), externalChangeId); }
    return record;
  }

  assertExactHead(record: ExternalChangeRecord, currentHeadSha: string): void {
    if (record.status === 'STALE' || record.headSha !== currentHeadSha) throw new V4Error('EXTERNAL_HEAD_STALE');
  }

  prepareMerge(record: ExternalChangeRecord, input: { currentHeadSha: string; reviewId: string; checksPassed: boolean; autoMergeAuthorized: boolean }): { pullRequestId: string; expectedHeadSha: string } {
    this.assertExactHead(record, input.currentHeadSha);
    failClosed(input.reviewId.length > 0, 'GITHUB_REVIEW_REQUIRED');
    failClosed(input.checksPassed, 'GITHUB_CHECKS_REQUIRED');
    failClosed(input.autoMergeAuthorized, 'GITHUB_AUTO_MERGE_NOT_AUTHORIZED');
    return { pullRequestId: record.repository + '#' + record.number, expectedHeadSha: record.headSha };
  }
}

export interface GitHubDeliveryPort {
  mergeExact(input: { pullRequestId: string; expectedHeadSha: string }): { mergeSha: string };
  verify(input: { repository: string; revision: string }): { verified: boolean; evidenceRef: string };
}

export class GovernanceOnlyGitHubDelivery implements GitHubDeliveryPort {
  mergeExact(_input: { pullRequestId: string; expectedHeadSha: string }): { mergeSha: string } {
    throw new V4Error('REAL_MERGE_DISABLED', 'Production GitHub merge is disabled in this implementation.');
  }

  verify(_input: { repository: string; revision: string }): { verified: boolean; evidenceRef: string } {
    return { verified: false, evidenceRef: 'verification-not-configured' };
  }
}
