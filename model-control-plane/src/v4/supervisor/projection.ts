import type { DatabaseSync } from 'node:sqlite';
import { buildSupervisorProjection as buildProjection, type BoundedSupervisorProjection } from '../persistence/projections.js';

export type SupervisorProjection = BoundedSupervisorProjection;

export function buildBoundedProjection(db: DatabaseSync, supervisorId: string, options?: { afterCursor?: number; maxEvents?: number; maxItems?: number }): SupervisorProjection {
  return buildProjection(db, supervisorId, options);
}
