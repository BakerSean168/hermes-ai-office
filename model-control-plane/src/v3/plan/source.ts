export type PlanSource =
  | { kind: 'TASK' }
  | {
      kind: 'EXTERNAL_CHANGE';
      revision: string;
      reviewBackend?: string;
      repairBackend?: string;
      origin?: {
        kind: 'GITHUB_PULL_REQUEST';
        repository: string;
        pullRequestNumber: number;
        pullRequestUrl: string;
        title: string;
        author?: string;
        headRef: string;
        baseRef: string;
        headRepository: string;
        producer?: 'JULES' | 'UNKNOWN';
      };
    };

function validGitHubRepository(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.trim());
}

function validGitRef(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const ref = value.trim();
  return Boolean(
    ref &&
      /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) &&
      !ref.includes('..') &&
      !ref.includes('@{') &&
      !ref.endsWith('/') &&
      !ref.endsWith('.'),
  );
}

function validGitHubPullRequestUrl(value: unknown, repository: string, number: number): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    const path = url.pathname.replace(/\/$/, '');
    return (
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === 'github.com' &&
      path === `/${repository}/pull/${number}` &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function validatePlanSource(source: PlanSource | undefined, baseRevision: string | undefined): void {
  if (!source || source.kind === 'TASK') return;
  if (source.kind !== 'EXTERNAL_CHANGE') throw new Error('PLAN_SOURCE_KIND_INVALID');
  if (!source.revision?.trim()) throw new Error('EXTERNAL_CHANGE_REVISION_REQUIRED');
  if (!source.origin) return;

  const origin = source.origin as unknown as Record<string, unknown>;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin) || origin.kind !== 'GITHUB_PULL_REQUEST') {
    throw new Error('PLAN_SOURCE_ORIGIN_INVALID');
  }
  if (!/^[0-9a-f]{40}$/i.test(source.revision.trim())) throw new Error('GITHUB_PR_SOURCE_REVISION_INVALID');
  if (!/^[0-9a-f]{40}$/i.test(baseRevision?.trim() ?? '')) throw new Error('GITHUB_PR_BASE_REVISION_INVALID');
  if (!validGitHubRepository(origin.repository)) throw new Error('GITHUB_PR_SOURCE_REPOSITORY_INVALID');
  if (!Number.isInteger(origin.pullRequestNumber) || Number(origin.pullRequestNumber) < 1) {
    throw new Error('GITHUB_PR_SOURCE_NUMBER_INVALID');
  }
  const repository = String(origin.repository).trim();
  const number = Number(origin.pullRequestNumber);
  if (!validGitHubPullRequestUrl(origin.pullRequestUrl, repository, number)) {
    throw new Error('GITHUB_PR_SOURCE_URL_INVALID');
  }
  if (typeof origin.title !== 'string' || !origin.title.trim()) throw new Error('GITHUB_PR_SOURCE_TITLE_REQUIRED');
  if (origin.author != null && (typeof origin.author !== 'string' || !origin.author.trim())) {
    throw new Error('GITHUB_PR_SOURCE_AUTHOR_INVALID');
  }
  if (!validGitRef(origin.headRef)) throw new Error('GITHUB_PR_SOURCE_HEAD_REF_INVALID');
  if (!validGitRef(origin.baseRef)) throw new Error('GITHUB_PR_SOURCE_BASE_REF_INVALID');
  if (!validGitHubRepository(origin.headRepository)) throw new Error('GITHUB_PR_SOURCE_HEAD_REPOSITORY_INVALID');
  if (origin.producer != null && !['JULES', 'UNKNOWN'].includes(String(origin.producer))) {
    throw new Error('GITHUB_PR_SOURCE_PRODUCER_INVALID');
  }
}

export function normalizePlanSource(source: PlanSource | undefined): PlanSource {
  if (!source || source.kind === 'TASK') return { kind: 'TASK' };
  const reviewBackend = source.reviewBackend?.trim();
  const repairBackend = source.repairBackend?.trim();
  const origin = source.origin
    ? {
        kind: 'GITHUB_PULL_REQUEST' as const,
        repository: source.origin.repository.trim(),
        pullRequestNumber: source.origin.pullRequestNumber,
        pullRequestUrl: source.origin.pullRequestUrl.trim(),
        title: source.origin.title.trim(),
        ...(source.origin.author?.trim() ? { author: source.origin.author.trim() } : {}),
        headRef: source.origin.headRef.trim(),
        baseRef: source.origin.baseRef.trim(),
        headRepository: source.origin.headRepository.trim(),
        ...(source.origin.producer ? { producer: source.origin.producer } : {}),
      }
    : undefined;
  return {
    kind: 'EXTERNAL_CHANGE',
    revision: source.revision.trim(),
    ...(reviewBackend ? { reviewBackend } : {}),
    ...(repairBackend ? { repairBackend } : {}),
    ...(origin ? { origin } : {}),
  };
}
