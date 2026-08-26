import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  DELIVERY_COMMAND_MAX_BUFFER_BYTES,
  DELIVERY_COMMAND_TIMEOUT_MS,
  PLAN_LIMITS,
} from './planConstants.js';

const execFileAsync = promisify(execFile);

export interface GitHubPullRequestIntakeInput {
  repositoryPath: string;
  pullRequestNumber: number;
  remote?: string;
}

export interface GitHubPullRequestSnapshot {
  repository: string;
  number: number;
  url: string;
  title: string;
  author?: string;
  headRevision: string;
  baseRevision: string;
  headRef: string;
  baseRef: string;
  headRepository: string;
  fetchedHeadRef: string;
  fetchedBaseRef: string;
}

export interface GitHubPullRequestIntakePort {
  resolve(input: GitHubPullRequestIntakeInput): Promise<GitHubPullRequestSnapshot>;
}

export type GitHubIntakeCommandRunner = (
  cwd: string,
  command: string,
  args: string[],
) => Promise<string>;

interface PullRequestApiView {
  number?: number;
  html_url?: string;
  state?: string;
  title?: string;
  user?: { login?: string } | null;
  head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null } | null;
  base?: { sha?: string; ref?: string } | null;
}

function validateRemote(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes('..')) {
    throw new Error('GITHUB_PR_REMOTE_INVALID');
  }
}

function validateBranch(value: string, role: 'HEAD' | 'BASE'): void {
  if (
    !value ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes('..') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.includes('@{')
  ) {
    throw new Error(`GITHUB_PR_${role}_REF_INVALID`);
  }
}

function validateSha(value: string, role: 'HEAD' | 'BASE'): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`GITHUB_PR_${role}_REVISION_INVALID`);
}

function repositoryFromRemote(remoteUrl: string): string {
  const match = remoteUrl
    .trim()
    .match(/github\.com(?::|\/)([^/\s]+\/[^/\s]+?)(?:\.git)?$/i);
  if (!match?.[1]) throw new Error('GITHUB_PR_GITHUB_REMOTE_REQUIRED');
  return match[1];
}

export class GitHubPullRequestIntake implements GitHubPullRequestIntakePort {
  readonly #home?: string;
  readonly #commandRunner?: GitHubIntakeCommandRunner;

  constructor(options: { home?: string; commandRunner?: GitHubIntakeCommandRunner } = {}) {
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
    if (!home) throw new Error('GITHUB_PR_OWNER_HOME_NOT_FOUND');
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
        `GITHUB_PR_COMMAND_FAILED:${detail.slice(0, PLAN_LIMITS.errorDetailCharacters)}`,
      );
    }
  }

  async resolve(input: GitHubPullRequestIntakeInput): Promise<GitHubPullRequestSnapshot> {
    const repositoryPath = path.resolve(input.repositoryPath);
    const stat = fs.statSync(repositoryPath, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) throw new Error('GITHUB_PR_REPOSITORY_NOT_FOUND');
    if (!Number.isInteger(input.pullRequestNumber) || input.pullRequestNumber < 1) {
      throw new Error('GITHUB_PR_NUMBER_INVALID');
    }
    const remote = input.remote?.trim() || 'origin';
    validateRemote(remote);

    const remoteUrl = await this.#run(repositoryPath, 'git', ['remote', 'get-url', remote]);
    const repository = repositoryFromRemote(remoteUrl);
    const raw = await this.#run(repositoryPath, 'gh', [
      'api',
      `repos/${repository}/pulls/${input.pullRequestNumber}`,
    ]);
    let pullRequest: PullRequestApiView;
    try {
      pullRequest = JSON.parse(raw) as PullRequestApiView;
    } catch {
      throw new Error('GITHUB_PR_RESPONSE_INVALID');
    }
    if (pullRequest.state !== 'open') throw new Error('GITHUB_PR_NOT_OPEN');
    if (pullRequest.number !== input.pullRequestNumber) throw new Error('GITHUB_PR_NUMBER_MISMATCH');

    const headRevision = pullRequest.head?.sha?.trim() ?? '';
    const headRef = pullRequest.head?.ref?.trim() ?? '';
    const headRepository = pullRequest.head?.repo?.full_name?.trim() ?? '';
    const baseRef = pullRequest.base?.ref?.trim() ?? '';
    validateSha(headRevision, 'HEAD');
    validateBranch(headRef, 'HEAD');
    validateBranch(baseRef, 'BASE');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(headRepository)) {
      throw new Error('GITHUB_PR_HEAD_REPOSITORY_INVALID');
    }

    const refPrefix = `refs/ai-office/external/github/pr-${input.pullRequestNumber}`;
    const fetchedHeadRef = `${refPrefix}/head`;
    const fetchedBaseRef = `${refPrefix}/base`;
    await this.#run(repositoryPath, 'git', [
      'fetch',
      '--no-tags',
      remote,
      `+refs/pull/${input.pullRequestNumber}/head:${fetchedHeadRef}`,
      `+refs/heads/${baseRef}:${fetchedBaseRef}`,
    ]);
    const [observedHead, observedBase, currentBaseRemote, finalRaw] = await Promise.all([
      this.#run(repositoryPath, 'git', ['rev-parse', '--verify', fetchedHeadRef]),
      this.#run(repositoryPath, 'git', ['rev-parse', '--verify', fetchedBaseRef]),
      this.#run(repositoryPath, 'git', ['ls-remote', remote, `refs/heads/${baseRef}`]),
      this.#run(repositoryPath, 'gh', [
        'api',
        `repos/${repository}/pulls/${input.pullRequestNumber}`,
      ]),
    ]);
    let finalPullRequest: PullRequestApiView;
    try {
      finalPullRequest = JSON.parse(finalRaw) as PullRequestApiView;
    } catch {
      throw new Error('GITHUB_PR_RESPONSE_INVALID');
    }
    const remoteBaseRevision = currentBaseRemote.trim().split(/\s+/, 1)[0] ?? '';
    validateSha(observedHead.trim(), 'HEAD');
    validateSha(observedBase.trim(), 'BASE');
    validateSha(remoteBaseRevision, 'BASE');
    if (
      finalPullRequest.state !== 'open' ||
      finalPullRequest.number !== input.pullRequestNumber ||
      finalPullRequest.head?.sha?.trim() !== headRevision ||
      finalPullRequest.head?.ref?.trim() !== headRef ||
      finalPullRequest.head?.repo?.full_name?.trim() !== headRepository ||
      finalPullRequest.base?.ref?.trim() !== baseRef ||
      observedHead.trim() !== headRevision ||
      observedBase.trim() !== remoteBaseRevision
    ) {
      throw new Error('GITHUB_PR_CHANGED_DURING_INTAKE');
    }
    const baseRevision = observedBase.trim();
    if (headRevision === baseRevision) throw new Error('GITHUB_PR_EMPTY_CHANGE');

    return {
      repository,
      number: pullRequest.number,
      url: finalPullRequest.html_url?.trim() || `https://github.com/${repository}/pull/${pullRequest.number}`,
      title:
        finalPullRequest.title?.trim().slice(0, PLAN_LIMITS.pullRequestTitleCharacters) ||
        `PR #${pullRequest.number}`,
      author: finalPullRequest.user?.login?.trim() || undefined,
      headRevision,
      baseRevision,
      headRef,
      baseRef,
      headRepository,
      fetchedHeadRef,
      fetchedBaseRef,
    };
  }
}
