import { V4Error, failClosed } from '../domain/errors.js';
import { workItemsConflict, type WorkItem } from '../domain/workGraph.js';

export interface WorkItemWaveSelection {
  wave: number;
  baseRevision: string;
  items: WorkItem[];
}

export function selectWorkItemWave(
  items: readonly WorkItem[],
  currentRevision: string,
  maxParallelism: number,
): WorkItemWaveSelection | undefined {
  failClosed(currentRevision.trim().length > 0, 'WORK_ITEM_WAVE_BASE_REQUIRED');
  failClosed(
    Number.isInteger(maxParallelism) && maxParallelism >= 1 && maxParallelism <= 32,
    'WORK_ITEM_PARALLELISM_INVALID',
  );
  if (items.some((item) => item.status === 'RUNNING')) return undefined;
  const byKey = new Map(items.map((item) => [item.itemKey, item]));
  const runnable = items
    .filter(
      (item) =>
        (item.status === 'PENDING' || item.status === 'READY') &&
        item.dependencies.every((dependency) => byKey.get(dependency)?.status === 'SUCCEEDED'),
    )
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.itemKey.localeCompare(right.itemKey),
    );
  if (runnable.length === 0) return undefined;
  const assignedWaves = items.map((item) => item.wave ?? 0);
  const wave = Math.max(0, ...assignedWaves) + 1;
  const first = runnable[0]!;
  if (!first.parallelSafe) return { wave, baseRevision: currentRevision, items: [first] };
  const selected: WorkItem[] = [first];
  for (const candidate of runnable.slice(1)) {
    if (selected.length >= maxParallelism) break;
    if (!candidate.parallelSafe) continue;
    if (selected.some((current) => workItemsConflict(current, candidate))) continue;
    selected.push(candidate);
  }
  return { wave, baseRevision: currentRevision, items: selected };
}

export function validateExistingWave(item: WorkItem, wave: number, baseRevision: string): void {
  if (item.wave === undefined && item.integrationBaseRevision === undefined) return;
  if (item.wave !== wave || item.integrationBaseRevision !== baseRevision)
    throw new V4Error('WORK_ITEM_WAVE_PROVENANCE_MISMATCH');
}
