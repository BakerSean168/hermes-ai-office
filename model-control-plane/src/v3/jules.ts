export interface JulesSecretReader {
  read(key: string): string;
}

export interface JulesSource {
  name: string;
  id?: string;
  repository: string;
  defaultBranch?: string;
  branches: string[];
}

export interface JulesPullRequestOutput {
  url: string;
  title?: string;
  description?: string;
}

export interface JulesSession {
  name: string;
  id?: string;
  title?: string;
  state?: string;
  url?: string;
  pullRequests: JulesPullRequestOutput[];
}

export interface CreateJulesSessionInput {
  repository: string;
  startingBranch: string;
  prompt: string;
  title?: string;
  requirePlanApproval?: boolean;
  autoCreatePullRequest?: boolean;
}

export interface JulesApiPort {
  findSource(repository: string): Promise<JulesSource | null>;
  createSession(input: CreateJulesSessionInput): Promise<JulesSession>;
  getSession(name: string): Promise<JulesSession>;
}

export type JulesRequest = (url: string, init?: RequestInit) => Promise<Response>;

interface RawSource {
  name?: string;
  id?: string;
  githubRepo?: {
    owner?: string;
    repo?: string;
    defaultBranch?: { displayName?: string } | null;
    branches?: Array<{ displayName?: string }>;
  } | null;
}

interface RawSession {
  name?: string;
  id?: string;
  title?: string;
  state?: string;
  url?: string;
  outputs?: Array<{
    pullRequest?: { url?: string; title?: string; description?: string } | null;
  }>;
}

function validateRepository(repository: string): string {
  const value = repository.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('JULES_REPOSITORY_INVALID');
  }
  return value;
}

function validateBranch(branch: string): string {
  const value = branch.trim();
  if (
    !value ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes('..') ||
    value.includes('@{') ||
    value.endsWith('/') ||
    value.endsWith('.')
  ) {
    throw new Error('JULES_BRANCH_INVALID');
  }
  return value;
}

function normalizeSource(raw: RawSource): JulesSource | null {
  const owner = raw.githubRepo?.owner?.trim();
  const repo = raw.githubRepo?.repo?.trim();
  const name = raw.name?.trim();
  if (!owner || !repo || !name) return null;
  return {
    name,
    id: raw.id?.trim() || undefined,
    repository: `${owner}/${repo}`,
    defaultBranch: raw.githubRepo?.defaultBranch?.displayName?.trim() || undefined,
    branches: (raw.githubRepo?.branches ?? [])
      .map((branch) => branch.displayName?.trim() ?? '')
      .filter(Boolean),
  };
}

function normalizeSession(raw: RawSession): JulesSession {
  const name = raw.name?.trim();
  if (!name || !/^sessions\/[^/]+$/.test(name)) throw new Error('JULES_SESSION_RESPONSE_INVALID');
  return {
    name,
    id: raw.id?.trim() || undefined,
    title: raw.title?.trim() || undefined,
    state: raw.state?.trim() || undefined,
    url: raw.url?.trim() || undefined,
    pullRequests: (raw.outputs ?? [])
      .map((output) => output.pullRequest)
      .filter((pullRequest): pullRequest is NonNullable<typeof pullRequest> => Boolean(pullRequest?.url))
      .map((pullRequest) => ({
        url: pullRequest.url!.trim(),
        title: pullRequest.title?.trim() || undefined,
        description: pullRequest.description?.trim() || undefined,
      })),
  };
}

export class JulesApiClient implements JulesApiPort {
  readonly #baseUrl: string;
  readonly #secrets: JulesSecretReader;
  readonly #apiKeyName: string;
  readonly #request: JulesRequest;
  readonly #timeoutMs: number;

  constructor(options: {
    secrets: JulesSecretReader;
    baseUrl?: string;
    apiKeyName?: string;
    request?: JulesRequest;
    timeoutMs?: number;
  }) {
    this.#baseUrl = (options.baseUrl ?? 'https://jules.googleapis.com/v1alpha').replace(/\/$/, '');
    this.#secrets = options.secrets;
    this.#apiKeyName = options.apiKeyName ?? 'JULES_API_KEY';
    this.#request = options.request ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async #json(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref();
    try {
      const response = await this.#request(`${this.#baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.#secrets.read(this.#apiKeyName),
          ...(init.headers ?? {}),
        },
      });
      const text = await response.text();
      let payload: Record<string, unknown> = {};
      if (text) {
        try {
          payload = JSON.parse(text) as Record<string, unknown>;
        } catch {
          throw new Error('JULES_API_RESPONSE_INVALID');
        }
      }
      if (!response.ok) {
        const error = payload.error;
        const detail =
          error && typeof error === 'object' && !Array.isArray(error)
            ? String((error as Record<string, unknown>).status ?? response.status)
            : String(response.status);
        throw new Error(`JULES_API_REQUEST_FAILED:${detail.slice(0, 120)}`);
      }
      return payload;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('JULES_API_TIMEOUT');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async findSource(repository: string): Promise<JulesSource | null> {
    const expected = validateRepository(repository).toLowerCase();
    let pageToken = '';
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ pageSize: '100' });
      if (pageToken) query.set('pageToken', pageToken);
      const payload = await this.#json(`/sources?${query.toString()}`);
      const sources = Array.isArray(payload.sources) ? payload.sources : [];
      for (const raw of sources) {
        const source = normalizeSource(raw as RawSource);
        if (source?.repository.toLowerCase() === expected) return source;
      }
      pageToken = typeof payload.nextPageToken === 'string' ? payload.nextPageToken.trim() : '';
      if (!pageToken) return null;
    }
    throw new Error('JULES_SOURCE_PAGINATION_LIMIT');
  }

  async createSession(input: CreateJulesSessionInput): Promise<JulesSession> {
    const repository = validateRepository(input.repository);
    const startingBranch = validateBranch(input.startingBranch);
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error('JULES_PROMPT_REQUIRED');
    const source = await this.findSource(repository);
    if (!source) throw new Error('JULES_SOURCE_NOT_FOUND');
    if (source.branches.length > 0 && !source.branches.includes(startingBranch)) {
      throw new Error('JULES_BRANCH_NOT_FOUND');
    }
    const payload = await this.#json('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        sourceContext: {
          source: source.name,
          githubRepoContext: { startingBranch },
        },
        requirePlanApproval: input.requirePlanApproval === true,
        ...(input.autoCreatePullRequest === true ? { automationMode: 'AUTO_CREATE_PR' } : {}),
      }),
    });
    return normalizeSession(payload as RawSession);
  }

  async getSession(name: string): Promise<JulesSession> {
    const resource = name.trim();
    if (!/^sessions\/[^/]+$/.test(resource)) throw new Error('JULES_SESSION_NAME_INVALID');
    const payload = await this.#json(`/${resource}`);
    return normalizeSession(payload as RawSession);
  }
}
