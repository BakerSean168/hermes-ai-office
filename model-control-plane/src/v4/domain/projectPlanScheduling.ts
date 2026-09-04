import { failClosed } from './errors.js';

export interface ProjectPlanLease {
  projectKey: string;
  repositoryPath: string;
  activeRootPlanId?: string;
  committedRevision?: string;
  version: number;
  acquiredAt?: string;
  updatedAt: string;
}

export interface ProjectPlanQueueEntry {
  planId: string;
  projectKey: string;
  repositoryPath: string;
  sequence: number;
  priority: number;
  enqueuedAt: string;
  activatedAt?: string;
  cancelledAt?: string;
}

export interface RootPlanScheduleResult {
  status: 'ACTIVE' | 'QUEUED';
  lease: ProjectPlanLease;
  queueEntry?: ProjectPlanQueueEntry;
}

export interface RootPlanHandoffResult {
  releasedPlanId: string;
  activatedPlanId?: string;
  lease: ProjectPlanLease;
}

export function validateProjectPlanLease(lease: ProjectPlanLease): void {
  failClosed(lease.projectKey.trim().length > 0, 'PROJECT_PLAN_PROJECT_REQUIRED');
  failClosed(lease.repositoryPath.trim().length > 0, 'PROJECT_PLAN_REPOSITORY_REQUIRED');
  if (lease.committedRevision !== undefined)
    failClosed(
      lease.committedRevision.trim().length > 0,
      'PROJECT_PLAN_COMMITTED_REVISION_INVALID',
    );
  failClosed(
    Number.isInteger(lease.version) && lease.version >= 0,
    'PROJECT_PLAN_LEASE_VERSION_INVALID',
  );
  failClosed(lease.updatedAt.trim().length > 0, 'PROJECT_PLAN_LEASE_TIME_REQUIRED');
}

export function validateProjectPlanPriority(priority: number): void {
  failClosed(
    Number.isInteger(priority) && priority >= -1_000_000 && priority <= 1_000_000,
    'PROJECT_PLAN_PRIORITY_INVALID',
  );
}
