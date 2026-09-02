import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import type { DeliveryObservation, PlanDelivery } from '../domain/delivery.js';
import { V4Error, failClosed } from '../domain/errors.js';
import type { Plan } from '../domain/plan.js';
import type { DeliveryAutomationPort } from '../orchestration/contracts.js';

interface CommandResult {
  stdout: string;
  stderr: string;
  status: number;
}

export interface GitHubCliDeliveryOptions {
  allowedRepositoryRoots: string[];
  commandTimeoutMs?: number;
  maxBufferBytes?: number;
  spawn?: typeof spawnSync;
}

interface PullRequestView {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  url: string;
  headRefOid: string;
  mergeStateStatus?: string;
  mergeCommit?: { oid?: string } | null;
  statusCheckRollup?: Array<{
    name?: string;
    context?: string;
    status?: string;
    conclusion?: string;
  }>;
}

const SUCCESS_CONCLUSIONS = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
const FAILURE_CONCLUSIONS = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

export class GitHubCliDeliveryAdapter implements DeliveryAutomationPort {
  readonly allowedRoots: string[];
  readonly commandTimeoutMs: number;
  readonly maxBufferBytes: number;
  readonly spawn: typeof spawnSync;

  constructor(options: GitHubCliDeliveryOptions) {
    failClosed(options.allowedRepositoryRoots.length > 0, 'DELIVERY_ALLOWED_ROOT_REQUIRED');
    this.allowedRoots = options.allowedRepositoryRoots.map((root) => fs.realpathSync(root));
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
    this.maxBufferBytes = options.maxBufferBytes ?? 8 * 1024 * 1024;
    this.spawn = options.spawn ?? spawnSync;
    failClosed(this.commandTimeoutMs >= 1_000 && this.commandTimeoutMs <= 15 * 60_000, 'DELIVERY_TIMEOUT_INVALID');
    failClosed(this.maxBufferBytes >= 64 * 1024 && this.maxBufferBytes <= 64 * 1024 * 1024, 'DELIVERY_BUFFER_INVALID');
  }

  async advance(plan: Plan, delivery: PlanDelivery): Promise<DeliveryObservation> {
    const repository = this.repositoryRoot(plan.repositoryPath);
    const identity = this.repositoryIdentity(repository);
    const head = this.git(repository, identity, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    if (head !== plan.currentRevision) throw new V4Error('DELIVERY_LOCAL_HEAD_STALE');
    if (this.git(repository, identity, ['status', '--porcelain=v1', '-z']).length !== 0)
      throw new V4Error('DELIVERY_LOCAL_REPOSITORY_DIRTY');
    this.assertBranch(delivery.branch, repository, identity);
    this.assertBranch(delivery.targetBranch, repository, identity);

    const repositoryName = this.githubRepository(repository, identity, delivery.remote);
    const remoteHead = this.remoteHead(repository, identity, delivery.remote, delivery.branch);
    if (remoteHead && remoteHead !== plan.currentRevision) throw new V4Error('DELIVERY_REMOTE_BRANCH_DIVERGED');
    if (!remoteHead) {
      this.git(repository, identity, ['push', delivery.remote, plan.currentRevision + ':refs/heads/' + delivery.branch], false);
    }

    let pullRequest = this.findPullRequest(repository, identity, repositoryName, delivery);
    if (!pullRequest) {
      const title = plan.objective.trim().slice(0, 240) || 'Pixel Agent delivery';
      const body = [
        'Pixel Agent V4 durable delivery.',
        '',
        'Plan: `' + plan.planId + '`',
        'Exact reviewed head: `' + plan.currentRevision + '`',
      ].join('\n');
      this.gh(repository, identity, [
        'pr', 'create', '--repo', repositoryName, '--base', delivery.targetBranch,
        '--head', delivery.branch, '--title', title, '--body', body,
      ]);
      pullRequest = this.findPullRequest(repository, identity, repositoryName, delivery);
      if (!pullRequest) throw new V4Error('DELIVERY_PR_CREATE_NOT_OBSERVED');
    }
    if (pullRequest.headRefOid !== plan.currentRevision) throw new V4Error('DELIVERY_PR_HEAD_STALE');
    if (pullRequest.state === 'CLOSED') throw new V4Error('DELIVERY_PR_CLOSED_UNMERGED');

    const base = {
      headSha: plan.currentRevision,
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.url,
    };
    if (pullRequest.state === 'MERGED') return this.verifyMerged(repository, identity, delivery, pullRequest, base);

    const checks = pullRequest.statusCheckRollup ?? [];
    const checkState = this.checkState(checks, delivery.requiredChecks);
    if (checkState === 'FAILED') throw new V4Error('DELIVERY_REQUIRED_CHECK_FAILED');
    if (checkState === 'PENDING') return { status: 'CHECKS_PENDING', ...base };
    if (!delivery.autoMerge) return { status: 'PR_OPEN', ...base };

    const mergeFlag = delivery.mergeMethod === 'squash' ? '--squash' : delivery.mergeMethod === 'rebase' ? '--rebase' : '--merge';
    this.gh(repository, identity, [
      'pr', 'merge', String(pullRequest.number), '--repo', repositoryName,
      mergeFlag, '--match-head-commit', plan.currentRevision,
    ]);
    const merged = this.viewPullRequest(repository, identity, repositoryName, pullRequest.number);
    if (merged.state !== 'MERGED') throw new V4Error('DELIVERY_MERGE_NOT_OBSERVED');
    return this.verifyMerged(repository, identity, delivery, merged, base);
  }

  private verifyMerged(
    repository: string,
    identity: { uid: number; gid: number; home: string },
    delivery: PlanDelivery,
    pullRequest: PullRequestView,
    base: { headSha: string; pullRequestNumber: number; pullRequestUrl: string },
  ): DeliveryObservation {
    const mergeSha = pullRequest.mergeCommit?.oid?.trim();
    if (!mergeSha) throw new V4Error('DELIVERY_MERGE_SHA_MISSING');
    const targetHead = this.remoteHead(repository, identity, delivery.remote, delivery.targetBranch);
    if (!targetHead || targetHead !== mergeSha) throw new V4Error('DELIVERY_POST_MERGE_HEAD_MISMATCH');
    return { status: 'VERIFIED', ...base, mergeSha };
  }

  private checkState(checks: NonNullable<PullRequestView['statusCheckRollup']>, required: string[]): 'READY' | 'PENDING' | 'FAILED' {
    const byName = new Map(checks.map((check) => [String(check.name ?? check.context ?? '').trim(), check]));
    const selected = required.length > 0 ? required.map((name) => byName.get(name)) : checks;
    if (required.length > 0 && selected.some((check) => !check)) return 'PENDING';
    for (const check of selected) {
      if (!check) continue;
      const conclusion = String(check.conclusion ?? '').toUpperCase();
      const status = String(check.status ?? '').toUpperCase();
      if (FAILURE_CONCLUSIONS.has(conclusion)) return 'FAILED';
      if (!SUCCESS_CONCLUSIONS.has(conclusion) || (status && status !== 'COMPLETED')) return 'PENDING';
    }
    return 'READY';
  }

  private findPullRequest(
    repository: string,
    identity: { uid: number; gid: number; home: string },
    repositoryName: string,
    delivery: PlanDelivery,
  ): PullRequestView | undefined {
    const output = this.gh(repository, identity, [
      'pr', 'list', '--repo', repositoryName, '--head', delivery.branch, '--base', delivery.targetBranch,
      '--state', 'all', '--limit', '5', '--json', 'number,state,url,headRefOid,mergeCommit,statusCheckRollup,mergeStateStatus',
    ]).stdout;
    const parsed = this.parseJson<unknown>(output, 'DELIVERY_PR_LIST_INVALID');
    if (!Array.isArray(parsed)) throw new V4Error('DELIVERY_PR_LIST_INVALID');
    if (parsed.length > 1) throw new V4Error('DELIVERY_PR_AMBIGUOUS');
    return parsed[0] as PullRequestView | undefined;
  }

  private viewPullRequest(repository: string, identity: { uid: number; gid: number; home: string }, repositoryName: string, number: number): PullRequestView {
    const output = this.gh(repository, identity, [
      'pr', 'view', String(number), '--repo', repositoryName,
      '--json', 'number,state,url,headRefOid,mergeCommit,statusCheckRollup,mergeStateStatus',
    ]).stdout;
    return this.parseJson<PullRequestView>(output, 'DELIVERY_PR_VIEW_INVALID');
  }

  private remoteHead(repository: string, identity: { uid: number; gid: number; home: string }, remote: string, branch: string): string | undefined {
    const output = this.git(repository, identity, ['ls-remote', '--heads', remote, 'refs/heads/' + branch], false).trim();
    if (!output) return undefined;
    const rows = output.split('\n').filter(Boolean);
    if (rows.length !== 1) throw new V4Error('DELIVERY_REMOTE_REF_AMBIGUOUS');
    return rows[0]!.split(/\s+/)[0];
  }

  private githubRepository(repository: string, identity: { uid: number; gid: number; home: string }, remote: string): string {
    const url = this.git(repository, identity, ['remote', 'get-url', remote]).trim();
    const match = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i);
    if (!match?.[1]) throw new V4Error('DELIVERY_GITHUB_REMOTE_REQUIRED');
    return match[1].replace(/\.git$/i, '');
  }

  private assertBranch(branch: string, repository: string, identity: { uid: number; gid: number; home: string }): void {
    this.git(repository, identity, ['check-ref-format', '--branch', branch]);
  }

  private git(repository: string, identity: { uid: number; gid: number; home: string }, args: string[], readOnly = true): string {
    return this.command('/usr/bin/git', ['-C', repository, ...args], identity, readOnly ? { GIT_OPTIONAL_LOCKS: '0' } : {}).stdout;
  }

  private gh(repository: string, identity: { uid: number; gid: number; home: string }, args: string[]): CommandResult {
    return this.command('/usr/bin/gh', args, identity, { GH_PROMPT_DISABLED: '1' }, repository);
  }

  private command(
    command: string,
    args: string[],
    identity: { uid: number; gid: number; home: string },
    extraEnv: Record<string, string> = {},
    cwd?: string,
  ): CommandResult {
    const result = this.spawn(command, args, {
      cwd,
      encoding: 'utf8',
      timeout: this.commandTimeoutMs,
      maxBuffer: this.maxBufferBytes,
      uid: identity.uid,
      gid: identity.gid,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: identity.home,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        GIT_TERMINAL_PROMPT: '0',
        ...extraEnv,
      },
    });
    const status = result.status ?? -1;
    const stdout = String(result.stdout ?? '');
    const stderr = String(result.stderr ?? '');
    if (result.error || status !== 0) {
      const detail = (stderr || result.error?.message || 'command failed').replace(/\s+/g, ' ').slice(0, 1_000);
      throw new V4Error('DELIVERY_COMMAND_FAILED', path.basename(command) + ': ' + detail);
    }
    return { stdout, stderr, status };
  }

  private repositoryRoot(repositoryPath: string): string {
    const lexical = path.resolve(repositoryPath);
    const real = fs.realpathSync(lexical);
    const allowed = this.allowedRoots.some((root) => real === root || real.startsWith(root + path.sep));
    if (!allowed) throw new V4Error('DELIVERY_REPOSITORY_NOT_ALLOWED');
    return real;
  }

  private repositoryIdentity(repository: string): { uid: number; gid: number; home: string } {
    const stat = fs.statSync(repository);
    const passwd = this.spawn('/usr/bin/getent', ['passwd', String(stat.uid)], { encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 });
    if (passwd.status !== 0) throw new V4Error('DELIVERY_REPOSITORY_OWNER_INVALID');
    const fields = String(passwd.stdout ?? '').trim().split(':');
    const home = fields[5];
    if (!home || !path.isAbsolute(home)) throw new V4Error('DELIVERY_REPOSITORY_OWNER_INVALID');
    return { uid: stat.uid, gid: stat.gid, home };
  }

  private parseJson<T>(value: string, code: string): T {
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      throw new V4Error(code, 'GitHub CLI returned invalid JSON.', error);
    }
  }
}
