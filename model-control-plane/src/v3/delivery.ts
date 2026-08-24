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

export type DeliveryStage =
  'PENDING' | 'PULL_REQUEST' | 'CHECKS' | 'MERGE' | 'POST_MERGE_CHECKS' | 'SUCCEEDED' | 'BLOCKED';

export interface PlanDeliveryConfig {
  remote: string;
  branch: string;
  targetBranch: string;
  autoMerge: boolean;
  mergeMethod: 'merge' | 'squash' | 'rebase';
}

export interface PlanDeliveryRequest {
  planId: string;
  repositoryPath: string;
  objective: string;
  revision: string;
  config: PlanDeliveryConfig;
}

export type PlanDeliveryResult =
  | {
      outcome: 'NEEDS_FIX';
      stage: 'CHECKS';
      reason: 'DELIVERY_CHECKS_FAILED';
      pullRequestUrl: string;
      evidence: Record<string, unknown>;
    }
  | {
      outcome: 'WAITING';
      stage: Exclude<DeliveryStage, 'PENDING' | 'SUCCEEDED' | 'BLOCKED'>;
      pullRequestUrl?: string;
      evidence: Record<string, unknown>;
    }
  | {
      outcome: 'BLOCKED';
      stage: 'BLOCKED';
      reason: string;
      pullRequestUrl?: string;
      evidence: Record<string, unknown>;
    }
  | {
      outcome: 'SUCCEEDED';
      stage: 'SUCCEEDED';
      pullRequestUrl: string;
      mergeRevision: string;
      evidence: Record<string, unknown>;
    };

export interface PlanDeliveryPort {
  reconcile(input: PlanDeliveryRequest): Promise<PlanDeliveryResult>;
}

interface PullRequestView {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergeStateStatus?: string;
  headRefOid?: string;
  baseRefName?: string;
  mergeCommit?: { oid?: string } | null;
  statusCheckRollup?: Array<{
    name?: string;
    context?: string;
    status?: string;
    conclusion?: string;
    state?: string;
    detailsUrl?: string;
  }>;
}

interface CheckSummary {
  pending: string[];
  failed: string[];
  passed: string[];
}

export type DeliveryCommandRunner = (
  cwd: string,
  command: string,
  args: string[],
) => Promise<string>;

function validateRef(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes('..')) {
    throw new Error('DELIVERY_REF_INVALID');
  }
}

function summarizeChecks(checks: PullRequestView['statusCheckRollup'] = []): CheckSummary {
  const summary: CheckSummary = { pending: [], failed: [], passed: [] };
  for (const check of checks) {
    const name = check.name || check.context || 'unnamed-check';
    const conclusion = check.conclusion?.toUpperCase();
    const status = check.status?.toUpperCase();
    const state = check.state?.toUpperCase();
    if (
      ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(
        conclusion ?? state ?? '',
      )
    ) {
      summary.failed.push(name);
    } else if (state === 'SUCCESS' || (status === 'COMPLETED' && Boolean(conclusion))) {
      summary.passed.push(name);
    } else {
      summary.pending.push(name);
    }
  }
  return summary;
}

export class GitHubPlanDelivery implements PlanDeliveryPort {
  readonly #home?: string;
  readonly #commandRunner?: DeliveryCommandRunner;

  constructor(options: { home?: string; commandRunner?: DeliveryCommandRunner } = {}) {
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
    if (!home) throw new Error('DELIVERY_OWNER_HOME_NOT_FOUND');
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
      throw new Error(`DELIVERY_COMMAND_FAILED:${failure.stderr?.trim() || failure.message}`);
    }
  }

  async #repository(input: PlanDeliveryRequest): Promise<string> {
    const remoteUrl = await this.#run(input.repositoryPath, 'git', [
      'remote',
      'get-url',
      input.config.remote,
    ]);
    const match = remoteUrl.match(/github\.com(?::|\/)([^/]+\/[^/]+?)(?:\.git)?$/i);
    if (!match?.[1]) throw new Error('DELIVERY_GITHUB_REMOTE_REQUIRED');
    return match[1];
  }

  async #findPullRequest(
    input: PlanDeliveryRequest,
    repository: string,
  ): Promise<PullRequestView | undefined> {
    const fields =
      'number,url,state,mergeStateStatus,mergeCommit,statusCheckRollup,headRefOid,baseRefName';
    const output = await this.#run(input.repositoryPath, 'gh', [
      'pr',
      'list',
      '--state',
      'all',
      '--head',
      input.config.branch,
      '--repo',
      repository,
      '--limit',
      String(PLAN_LIMITS.pullRequestResults),
      '--json',
      fields,
    ]);
    const pullRequests = JSON.parse(output) as PullRequestView[];
    return (
      pullRequests.find(
        (pullRequest) =>
          pullRequest.state === 'OPEN' && pullRequest.baseRefName === input.config.targetBranch,
      ) ??
      pullRequests.find(
        (pullRequest) =>
          pullRequest.state === 'MERGED' &&
          pullRequest.baseRefName === input.config.targetBranch &&
          pullRequest.headRefOid === input.revision,
      )
    );
  }

  async #pullRequest(input: PlanDeliveryRequest, repository: string): Promise<PullRequestView> {
    const pullRequest = await this.#findPullRequest(input, repository);
    if (pullRequest) return pullRequest;
    await this.#run(input.repositoryPath, 'gh', [
      'pr',
      'create',
      '--head',
      input.config.branch,
      '--base',
      input.config.targetBranch,
      '--repo',
      repository,
      '--title',
      input.objective.slice(0, PLAN_LIMITS.pullRequestTitleCharacters),
      '--body',
      `Durable AI Office plan: ${input.planId}`,
    ]);
    return this.#pullRequest(input, repository);
  }

  async #postMergeChecks(input: PlanDeliveryRequest, revision: string): Promise<CheckSummary> {
    const repository = await this.#repository(input);
    const checkRunsOutput = await this.#run(input.repositoryPath, 'gh', [
      'api',
      `repos/${repository}/commits/${revision}/check-runs`,
      '--jq',
      '[.check_runs[] | {name, status, conclusion, detailsUrl: .details_url}]',
    ]);
    const statusesOutput = await this.#run(input.repositoryPath, 'gh', [
      'api',
      `repos/${repository}/commits/${revision}/status`,
      '--jq',
      '[.statuses[] | {context, state, detailsUrl: .target_url}]',
    ]);
    return summarizeChecks([
      ...(JSON.parse(checkRunsOutput) as NonNullable<PullRequestView['statusCheckRollup']>),
      ...(JSON.parse(statusesOutput) as NonNullable<PullRequestView['statusCheckRollup']>),
    ]);
  }

  async reconcile(input: PlanDeliveryRequest): Promise<PlanDeliveryResult> {
    validateRef(input.config.remote);
    validateRef(input.config.branch);
    validateRef(input.config.targetBranch);
    validateRef(input.revision);
    if (!input.config.autoMerge) {
      return {
        outcome: 'BLOCKED',
        stage: 'BLOCKED',
        reason: 'DELIVERY_AUTO_MERGE_NOT_AUTHORIZED',
        evidence: {},
      };
    }

    const repository = await this.#repository(input);
    let pullRequest: PullRequestView | undefined;
    pullRequest = await this.#findPullRequest(input, repository);
    if (pullRequest?.state !== 'MERGED') {
      await this.#run(input.repositoryPath, 'git', [
        'push',
        input.config.remote,
        `${input.revision}:refs/heads/${input.config.branch}`,
      ]);
      pullRequest = await this.#pullRequest(input, repository);
    }
    if (!pullRequest) throw new Error('DELIVERY_PULL_REQUEST_NOT_FOUND');
    if (pullRequest.state === 'CLOSED') {
      return {
        outcome: 'BLOCKED',
        stage: 'BLOCKED',
        reason: 'DELIVERY_PULL_REQUEST_CLOSED',
        pullRequestUrl: pullRequest.url,
        evidence: { number: pullRequest.number },
      };
    }

    if (pullRequest.state !== 'MERGED') {
      if (pullRequest.headRefOid !== input.revision) {
        return {
          outcome: 'WAITING',
          stage: 'CHECKS',
          pullRequestUrl: pullRequest.url,
          evidence: {
            expectedRevision: input.revision,
            observedRevision: pullRequest.headRefOid,
          },
        };
      }
      const checks = summarizeChecks(pullRequest.statusCheckRollup);
      if (checks.failed.length > 0) {
        return {
          outcome: 'NEEDS_FIX',
          stage: 'CHECKS',
          reason: 'DELIVERY_CHECKS_FAILED',
          pullRequestUrl: pullRequest.url,
          evidence: { ...checks },
        };
      }
      if (checks.pending.length > 0 || (checks.failed.length === 0 && checks.passed.length === 0)) {
        return {
          outcome: 'WAITING',
          stage: 'CHECKS',
          pullRequestUrl: pullRequest.url,
          evidence: { ...checks },
        };
      }
      try {
        await this.#run(input.repositoryPath, 'gh', [
          'pr',
          'merge',
          String(pullRequest.number),
          '--repo',
          repository,
          `--${input.config.mergeMethod}`,
          '--delete-branch',
        ]);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/required|review|merge queue|not mergeable/i.test(error.message)
        ) {
          throw error;
        }
        return {
          outcome: 'WAITING',
          stage: 'MERGE',
          pullRequestUrl: pullRequest.url,
          evidence: {
            mergeStateStatus: pullRequest.mergeStateStatus,
            message: error.message.slice(0, PLAN_LIMITS.errorDetailCharacters),
          },
        };
      }
      pullRequest = await this.#pullRequest(input, repository);
    }

    const mergeRevision = pullRequest.mergeCommit?.oid;
    if (!mergeRevision) {
      return {
        outcome: 'WAITING',
        stage: 'MERGE',
        pullRequestUrl: pullRequest.url,
        evidence: { mergeStateStatus: pullRequest.mergeStateStatus },
      };
    }
    const postMergeChecks = await this.#postMergeChecks(input, mergeRevision);
    if (postMergeChecks.failed.length > 0) {
      return {
        outcome: 'BLOCKED',
        stage: 'BLOCKED',
        reason: 'DELIVERY_POST_MERGE_CHECKS_FAILED',
        pullRequestUrl: pullRequest.url,
        evidence: { ...postMergeChecks },
      };
    }
    if (postMergeChecks.pending.length > 0 || postMergeChecks.passed.length === 0) {
      return {
        outcome: 'WAITING',
        stage: 'POST_MERGE_CHECKS',
        pullRequestUrl: pullRequest.url,
        evidence: { ...postMergeChecks },
      };
    }
    return {
      outcome: 'SUCCEEDED',
      stage: 'SUCCEEDED',
      pullRequestUrl: pullRequest.url,
      mergeRevision,
      evidence: { ...postMergeChecks },
    };
  }
}
