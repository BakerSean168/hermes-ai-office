import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

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

  constructor(options: { home?: string } = {}) {
    this.#home = options.home;
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
        timeout: 180_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return result.stdout.trim();
    } catch (error) {
      const failure = error as Error & { stderr?: string };
      throw new Error(`DELIVERY_COMMAND_FAILED:${failure.stderr?.trim() || failure.message}`);
    }
  }

  async #findPullRequest(input: PlanDeliveryRequest): Promise<PullRequestView | undefined> {
    const fields = 'number,url,state,mergeStateStatus,mergeCommit,statusCheckRollup';
    const output = await this.#run(input.repositoryPath, 'gh', [
      'pr',
      'list',
      '--state',
      'all',
      '--head',
      input.config.branch,
      '--limit',
      '1',
      '--json',
      fields,
    ]);
    return (JSON.parse(output) as PullRequestView[])[0];
  }

  async #pullRequest(input: PlanDeliveryRequest): Promise<PullRequestView> {
    const pullRequest = await this.#findPullRequest(input);
    if (pullRequest) return pullRequest;
    await this.#run(input.repositoryPath, 'gh', [
      'pr',
      'create',
      '--head',
      input.config.branch,
      '--base',
      input.config.targetBranch,
      '--title',
      input.objective.slice(0, 240),
      '--body',
      `Durable AI Office plan: ${input.planId}`,
    ]);
    return this.#pullRequest(input);
  }

  async #postMergeChecks(input: PlanDeliveryRequest, revision: string): Promise<CheckSummary> {
    const repository = await this.#run(input.repositoryPath, 'gh', [
      'repo',
      'view',
      '--json',
      'nameWithOwner',
      '--jq',
      '.nameWithOwner',
    ]);
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

    let pullRequest: PullRequestView | undefined;
    pullRequest = await this.#findPullRequest(input);
    if (pullRequest?.state !== 'MERGED') {
      await this.#run(input.repositoryPath, 'git', [
        'push',
        input.config.remote,
        `${input.revision}:refs/heads/${input.config.branch}`,
      ]);
      pullRequest = await this.#pullRequest(input);
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
      if (checks.pending.length > 0) {
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
            message: error.message.slice(0, 2_000),
          },
        };
      }
      pullRequest = await this.#pullRequest(input);
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
