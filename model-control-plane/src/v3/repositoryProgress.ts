import fs from 'node:fs';
import path from 'node:path';

import { git, inside } from './gitSupport.js';
export interface ExternalProgressCandidate {
  revision: string;
  ref: string;
  aheadBy: number;
  matchedWorkItemKeys: string[];
  commitSubjects: string[];
}

export class RepositoryProgressDiscovery {
  readonly #allowedRepositoryRoots: string[];

  constructor(allowedRepositoryRoots: string[]) {
    this.#allowedRepositoryRoots = allowedRepositoryRoots.map((item) => path.resolve(item));
  }

  async discover(input: {
    repositoryPath: string;
    currentRevision: string;
    workItemKeys: string[];
  }): Promise<ExternalProgressCandidate | null> {
    const requested = path.resolve(input.repositoryPath);
    if (!this.#allowedRepositoryRoots.some((root) => inside(requested, root))) {
      throw new Error('V3_REPOSITORY_PATH_NOT_ALLOWED');
    }
    const requestedStat = fs.statSync(requested, { throwIfNoEntry: false });
    if (!requestedStat?.isDirectory()) throw new Error('V3_REPOSITORY_NOT_FOUND');
    const requestedOwner = { uid: requestedStat.uid, gid: requestedStat.gid };
    const repoRoot = path.resolve(
      await git(requested, ['rev-parse', '--show-toplevel'], requestedOwner),
    );
    if (!this.#allowedRepositoryRoots.some((root) => inside(repoRoot, root))) {
      throw new Error('V3_REPOSITORY_ROOT_NOT_ALLOWED');
    }
    const repoStat = fs.statSync(repoRoot);
    const sourceOwner = { uid: repoStat.uid, gid: repoStat.gid };
    const base = await git(repoRoot, ['rev-parse', '--verify', input.currentRevision], sourceOwner);
    const keys = [...new Set(input.workItemKeys.map((key) => key.trim()).filter(Boolean))];
    if (keys.length === 0) return null;

    const refsRaw = await git(
      repoRoot,
      [
        'for-each-ref',
        '--format=%(refname)|%(objectname)|%(committerdate:unix)',
        'refs/heads',
        'refs/remotes',
      ],
      sourceOwner,
    );
    const candidates: Array<ExternalProgressCandidate & { committedAt: number }> = [];
    const seen = new Set<string>();
    for (const line of refsRaw.split('\n').filter(Boolean)) {
      const [fullRef, revision, committedAtRaw] = line.split('|');
      if (!fullRef || !revision || revision === base || seen.has(revision)) continue;
      if (fullRef.endsWith('/HEAD')) continue;
      try {
        await git(repoRoot, ['merge-base', '--is-ancestor', base, revision], sourceOwner);
      } catch {
        continue;
      }
      const aheadBy = Number(
        await git(repoRoot, ['rev-list', '--count', `${base}..${revision}`], sourceOwner),
      );
      if (!Number.isFinite(aheadBy) || aheadBy <= 0) continue;
      const commitSubjects = (
        await git(repoRoot, ['log', '--format=%s', '--max-count=200', `${base}..${revision}`], sourceOwner)
      )
        .split('\n')
        .filter(Boolean);
      const matchedWorkItemKeys = keys.filter((key) =>
        commitSubjects.some((subject) => subject.includes(key)),
      );
      if (matchedWorkItemKeys.length === 0) continue;
      const ref = fullRef.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');
      const committedAt = Number(committedAtRaw || 0);
      candidates.push({
        revision,
        ref,
        aheadBy,
        matchedWorkItemKeys,
        commitSubjects: commitSubjects.slice(0, 80),
        committedAt,
      });
      seen.add(revision);
    }
    const selected = candidates.sort(
      (left, right) =>
        right.matchedWorkItemKeys.length - left.matchedWorkItemKeys.length ||
        right.aheadBy - left.aheadBy ||
        right.committedAt - left.committedAt,
    )[0];
    if (!selected) return null;
    return {
      revision: selected.revision,
      ref: selected.ref,
      aheadBy: selected.aheadBy,
      matchedWorkItemKeys: selected.matchedWorkItemKeys,
      commitSubjects: selected.commitSubjects,
    };
  }
}
