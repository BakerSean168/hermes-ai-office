import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  DELIVERY_COMMAND_MAX_BUFFER_BYTES,
  DELIVERY_COMMAND_TIMEOUT_MS,
  PLAN_LIMITS,
} from './planConstants.js';

const execFileAsync = promisify(execFile);

export interface GitHubPullRequestRepairInput {
  planId: string;
  repositoryPath: string;
  workspacePath: string;
  repository: string;
  pullRequestNumber: number;
  headRepository: string;
  headRef: string;
  expectedHeadRevision: string;
  remote?: string;
}

export interface GitHubPullRequestRepairResult {
  previousRevision: string;
  publishedRevision: string;
  auditRef: string;
}

export interface GitHubPullRequestRepairPublisherPort {
  publish(input: GitHubPullRequestRepairInput): Promise<GitHubPullRequestRepairResult>;
}

export type GitHubRepairCommandRunner = (
  cwd: string,
  command: string,
  args: string[],
) => Promise<string>;

interface PullRequestApiView {
  number?: number;
  state?: string;
  head?: {
    sha?: string;
    ref?: string;
    repo?: { full_name?: string } | null;
  } | null;
}

interface UnixIdentity {
  uid: number;
  gid: number;
  home: string;
}

function validateSha(value: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error('GITHUB_PR_REPAIR_REVISION_INVALID');
}

function validateRef(value: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes('..') ||
    value.includes('@{') ||
    value.endsWith('/') ||
    value.endsWith('.')
  ) {
    throw new Error('GITHUB_PR_REPAIR_REF_INVALID');
  }
}

function validateRepository(value: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('GITHUB_PR_REPAIR_REPOSITORY_INVALID');
  }
}

function repositoryFromRemote(remoteUrl: string): string {
  const match = remoteUrl
    .trim()
    .match(/github\.com(?::|\/)([^/\s]+\/[^/\s]+?)(?:\.git)?$/i);
  if (!match?.[1]) throw new Error('GITHUB_PR_REPAIR_GITHUB_REMOTE_REQUIRED');
  return match[1];
}

export class GitHubPullRequestRepairPublisher implements GitHubPullRequestRepairPublisherPort {
  readonly #home?: string;
  readonly #commandRunner?: GitHubRepairCommandRunner;

  constructor(options: { home?: string; commandRunner?: GitHubRepairCommandRunner } = {}) {
    this.#home = options.home;
    this.#commandRunner = options.commandRunner;
  }

  #owner(cwd: string): UnixIdentity {
    const stat = fs.statSync(cwd);
    const passwd = fs
      .readFileSync('/etc/passwd', 'utf8')
      .split('\n')
      .map((line) => line.split(':'))
      .find((fields) => Number(fields[2]) === stat.uid);
    const home = this.#home ?? passwd?.[5];
    if (!home) throw new Error('GITHUB_PR_REPAIR_OWNER_HOME_NOT_FOUND');
    return { uid: stat.uid, gid: stat.gid, home };
  }

  async #run(
    cwd: string,
    command: string,
    args: string[],
    owner?: UnixIdentity,
  ): Promise<string> {
    if (this.#commandRunner) return this.#commandRunner(cwd, command, args);
    try {
      const result = await execFileAsync(command, args, {
        cwd,
        ...(owner ? { uid: owner.uid, gid: owner.gid } : {}),
        env: owner
          ? {
              ...process.env,
              HOME: owner.home,
              GH_CONFIG_DIR: path.join(owner.home, '.config', 'gh'),
            }
          : process.env,
        encoding: 'utf8',
        timeout: DELIVERY_COMMAND_TIMEOUT_MS,
        maxBuffer: DELIVERY_COMMAND_MAX_BUFFER_BYTES,
      });
      return result.stdout.trim();
    } catch (error) {
      const failure = error as Error & { stderr?: string };
      const detail = failure.stderr?.trim() || failure.message;
      throw new Error(
        `GITHUB_PR_REPAIR_COMMAND_FAILED:${detail.slice(0, PLAN_LIMITS.errorDetailCharacters)}`,
      );
    }
  }

  async publish(input: GitHubPullRequestRepairInput): Promise<GitHubPullRequestRepairResult> {
    validateRepository(input.repository);
    validateRepository(input.headRepository);
    validateRef(input.headRef);
    validateSha(input.expectedHeadRevision);
    if (!Number.isInteger(input.pullRequestNumber) || input.pullRequestNumber < 1) {
      throw new Error('GITHUB_PR_REPAIR_NUMBER_INVALID');
    }
    if (input.headRepository !== input.repository) {
      throw new Error('GITHUB_PR_REPAIR_CROSS_REPOSITORY_UNSUPPORTED');
    }

    const repositoryPath = path.resolve(input.repositoryPath);
    const workspacePath = path.resolve(input.workspacePath);
    if (!fs.statSync(repositoryPath, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('GITHUB_PR_REPAIR_REPOSITORY_NOT_FOUND');
    }
    if (!fs.statSync(workspacePath, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('GITHUB_PR_REPAIR_WORKSPACE_NOT_FOUND');
    }
    const remote = input.remote?.trim() || 'origin';
    validateRef(remote);
    const owner = this.#owner(repositoryPath);
    const remoteUrl = await this.#run(repositoryPath, 'git', ['remote', 'get-url', remote], owner);
    if (repositoryFromRemote(remoteUrl) !== input.repository) {
      throw new Error('GITHUB_PR_REPAIR_REPOSITORY_MISMATCH');
    }

    const pullRaw = await this.#run(
      repositoryPath,
      'gh',
      ['api', `repos/${input.repository}/pulls/${input.pullRequestNumber}`],
      owner,
    );
    let pullRequest: PullRequestApiView;
    try {
      pullRequest = JSON.parse(pullRaw) as PullRequestApiView;
    } catch {
      throw new Error('GITHUB_PR_REPAIR_RESPONSE_INVALID');
    }
    if (pullRequest.state !== 'open') throw new Error('GITHUB_PR_REPAIR_NOT_OPEN');
    if (
      pullRequest.number !== input.pullRequestNumber ||
      pullRequest.head?.sha?.trim() !== input.expectedHeadRevision ||
      pullRequest.head?.ref?.trim() !== input.headRef ||
      pullRequest.head?.repo?.full_name?.trim() !== input.headRepository
    ) {
      throw new Error('GITHUB_PR_CHANGED_DURING_REPAIR_PUBLICATION');
    }

    const trustedWorkspace = ['-c', `safe.directory=${workspacePath}`];
    const dirty = await this.#run(workspacePath, 'git', [
      ...trustedWorkspace,
      'status',
      '--porcelain',
    ]);
    if (dirty) throw new Error('GITHUB_PR_REPAIR_WORKSPACE_DIRTY');
    const publishedRevision = await this.#run(workspacePath, 'git', [
      ...trustedWorkspace,
      'rev-parse',
      'HEAD',
    ]);
    validateSha(publishedRevision);
    if (publishedRevision === input.expectedHeadRevision) {
      throw new Error('GITHUB_PR_REPAIR_NO_CHANGE');
    }
    const mergeBase = await this.#run(workspacePath, 'git', [
      ...trustedWorkspace,
      'merge-base',
      input.expectedHeadRevision,
      publishedRevision,
    ]);
    if (mergeBase.trim() !== input.expectedHeadRevision) {
      throw new Error('GITHUB_PR_REPAIR_NOT_DESCENDANT');
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-pr-repair-'));
    const bundle = path.join(tempRoot, 'repair.bundle');
    const safePlan = input.planId.replace(/[^A-Za-z0-9._-]/g, '_');
    const auditRef = `refs/ai-office/external/github/pr-${input.pullRequestNumber}/repairs/${safePlan}/${publishedRevision}`;
    try {
      await this.#run(workspacePath, 'git', [
        ...trustedWorkspace,
        'bundle',
        'create',
        bundle,
        'HEAD',
      ]);
      if (fs.existsSync(bundle)) {
        fs.chownSync(bundle, owner.uid, owner.gid);
        fs.chmodSync(bundle, 0o600);
      }
      await this.#run(
        repositoryPath,
        'git',
        ['fetch', bundle, `+HEAD:${auditRef}`],
        owner,
      );
      await this.#run(
        repositoryPath,
        'git',
        [
          'push',
          `--force-with-lease=refs/heads/${input.headRef}:${input.expectedHeadRevision}`,
          remote,
          `${auditRef}:refs/heads/${input.headRef}`,
        ],
        owner,
      );
      const remoteHead = await this.#run(
        repositoryPath,
        'git',
        ['ls-remote', remote, `refs/heads/${input.headRef}`],
        owner,
      );
      if ((remoteHead.trim().split(/\s+/, 1)[0] ?? '') !== publishedRevision) {
        throw new Error('GITHUB_PR_REPAIR_REMOTE_VERIFICATION_FAILED');
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }

    return {
      previousRevision: input.expectedHeadRevision,
      publishedRevision,
      auditRef,
    };
  }
}
