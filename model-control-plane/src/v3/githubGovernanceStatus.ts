import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  DELIVERY_COMMAND_MAX_BUFFER_BYTES,
  DELIVERY_COMMAND_TIMEOUT_MS,
  PLAN_LIMITS,
} from './planConstants.js';
import type { PlanStatus } from './plans.js';

const execFileAsync = promisify(execFile);

export const GITHUB_GOVERNANCE_STATUS_CONTEXT = 'Hermes / PR Governance';

export interface GitHubGovernanceStatusInput {
  repositoryPath: string;
  repository: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  expectedHeadRevision: string;
  planId: string;
  planStatus: PlanStatus;
  blockedReason?: string;
}

export interface GitHubGovernanceStatusResult {
  revision: string;
  state: 'pending' | 'success' | 'failure' | 'error';
  stale: boolean;
  observedHeadRevision?: string;
}

export interface GitHubGovernanceStatusPort {
  publish(input: GitHubGovernanceStatusInput): Promise<GitHubGovernanceStatusResult>;
}

export type GitHubGovernanceCommandRunner = (
  cwd: string,
  command: string,
  args: string[],
) => Promise<string>;

interface PullRequestApiView {
  number?: number;
  state?: string;
  head?: { sha?: string } | null;
}

function validateRepository(value: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('GITHUB_GOVERNANCE_REPOSITORY_INVALID');
  }
}

function validateSha(value: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error('GITHUB_GOVERNANCE_REVISION_INVALID');
  }
}

function desiredStatus(
  planStatus: PlanStatus,
  blockedReason?: string,
): { state: GitHubGovernanceStatusResult['state']; description: string } {
  if (planStatus === 'SUCCEEDED') {
    return { state: 'success', description: 'Hermes independently verified this pull request.' };
  }
  if (planStatus === 'BLOCKED') {
    const reason = blockedReason?.trim() || 'blocking governance finding';
    return {
      state: 'failure',
      description: `Hermes blocked this pull request: ${reason}`.slice(0, 140),
    };
  }
  if (planStatus === 'CANCELLED') {
    return { state: 'error', description: 'Hermes governance was cancelled.' };
  }
  return { state: 'pending', description: 'Hermes is independently reviewing this pull request.' };
}

export class GitHubGovernanceStatus implements GitHubGovernanceStatusPort {
  readonly #home?: string;
  readonly #commandRunner?: GitHubGovernanceCommandRunner;

  constructor(options: { home?: string; commandRunner?: GitHubGovernanceCommandRunner } = {}) {
    this.#home = options.home;
    this.#commandRunner = options.commandRunner;
  }

  #owner(cwd: string): { uid: number; gid: number; home: string } {
    const stat = fs.statSync(cwd);
    const passwd = fs
      .readFileSync('/etc/passwd', 'utf8')
      .split('\n')
      .map((line) => line.split(':'))
      .find((fields) => Number(fields[2]) === stat.uid);
    const home = this.#home ?? passwd?.[5];
    if (!home) throw new Error('GITHUB_GOVERNANCE_OWNER_HOME_NOT_FOUND');
    return { uid: stat.uid, gid: stat.gid, home };
  }

  async #run(cwd: string, command: string, args: string[]): Promise<string> {
    if (this.#commandRunner) return this.#commandRunner(cwd, command, args);
    try {
      const owner = this.#owner(cwd);
      const result = await execFileAsync(command, args, {
        cwd,
        uid: owner.uid,
        gid: owner.gid,
        env: {
          ...process.env,
          HOME: owner.home,
          GH_CONFIG_DIR: path.join(owner.home, '.config', 'gh'),
        },
        encoding: 'utf8',
        timeout: DELIVERY_COMMAND_TIMEOUT_MS,
        maxBuffer: DELIVERY_COMMAND_MAX_BUFFER_BYTES,
      });
      return result.stdout.trim();
    } catch (error) {
      const failure = error as Error & { stderr?: string };
      const detail = failure.stderr?.trim() || failure.message;
      throw new Error(
        `GITHUB_GOVERNANCE_COMMAND_FAILED:${detail.slice(0, PLAN_LIMITS.errorDetailCharacters)}`,
      );
    }
  }

  async publish(input: GitHubGovernanceStatusInput): Promise<GitHubGovernanceStatusResult> {
    validateRepository(input.repository);
    validateSha(input.expectedHeadRevision);
    if (!Number.isInteger(input.pullRequestNumber) || input.pullRequestNumber < 1) {
      throw new Error('GITHUB_GOVERNANCE_PR_NUMBER_INVALID');
    }
    if (!input.planId.trim()) throw new Error('GITHUB_GOVERNANCE_PLAN_ID_REQUIRED');
    const repositoryPath = path.resolve(input.repositoryPath);
    if (!fs.statSync(repositoryPath, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('GITHUB_GOVERNANCE_REPOSITORY_NOT_FOUND');
    }

    const raw = await this.#run(repositoryPath, 'gh', [
      'api',
      `repos/${input.repository}/pulls/${input.pullRequestNumber}`,
    ]);
    let pullRequest: PullRequestApiView;
    try {
      pullRequest = JSON.parse(raw) as PullRequestApiView;
    } catch {
      throw new Error('GITHUB_GOVERNANCE_RESPONSE_INVALID');
    }

    const currentHead = pullRequest.head?.sha?.trim() ?? '';
    const stale =
      pullRequest.number !== input.pullRequestNumber ||
      pullRequest.state !== 'open' ||
      currentHead !== input.expectedHeadRevision;
    const desired = stale
      ? {
          state: 'error' as const,
          description: 'Hermes review is stale because the pull request head changed.',
        }
      : desiredStatus(input.planStatus, input.blockedReason);

    await this.#run(repositoryPath, 'gh', [
      'api',
      '-X',
      'POST',
      `repos/${input.repository}/statuses/${input.expectedHeadRevision}`,
      '-f',
      `state=${desired.state}`,
      '-f',
      `context=${GITHUB_GOVERNANCE_STATUS_CONTEXT}`,
      '-f',
      `description=${desired.description.slice(0, 140)}`,
      '-f',
      `target_url=${input.pullRequestUrl}`,
    ]);

    return {
      revision: input.expectedHeadRevision,
      state: desired.state,
      stale,
      observedHeadRevision: currentHead || undefined,
    };
  }
}
