import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildControlPlane } from '../src/app.ts';
import { createExecutionResourceSelection } from '../src/v4/domain/resourceRouting.ts';

const SOURCE_REPOSITORY =
  process.env.PIXEL_V4_ROUTING_SMOKE_REPOSITORY ?? '/home/dev/projects/ai-office-smoke';
const PRODUCTION_CONTROL_PLANE =
  process.env.PIXEL_V4_ROUTING_SMOKE_CONTROL_PLANE ?? 'http://127.0.0.1:8320';
const MANAGED_WORKSPACE_ROOT = '/opt/data/hermes-ai-office-v3/workspaces';
const OPENHANDS_URL = 'http://127.0.0.1:18000';
const trackedPlanIds = new Set<string>();

interface TargetProfile {
  key: string;
  phase: 'IMPLEMENT' | 'REVIEW';
  resourceId: string;
  modelFamily: string;
  agentBackend: string;
  transport: 'LITELLM_MANAGED' | 'PROVIDER_NATIVE';
  routeModel?: string;
  marker?: string;
}

const TARGETS: Record<string, TargetProfile> = {
  dsh: {
    key: 'dsh',
    phase: 'IMPLEMENT',
    resourceId: 'wechat-miniapp-free',
    modelFamily: 'deepseek-v4-flash',
    agentBackend: 'dsh-acp',
    transport: 'LITELLM_MANAGED',
    routeModel: 'route-wechat-miniapp-free-deepseek-v4-flash',
    marker: 'DSH_OK',
  },
  zcode: {
    key: 'zcode',
    phase: 'IMPLEMENT',
    resourceId: 'wechat-miniapp-free',
    modelFamily: 'glm-current',
    agentBackend: 'zcode-acp',
    transport: 'LITELLM_MANAGED',
    routeModel: 'route-wechat-miniapp-free-glm-5.2',
    marker: 'ZCODE_OK',
  },
  'luna-orcai': {
    key: 'luna-orcai',
    phase: 'IMPLEMENT',
    resourceId: 'orcai',
    modelFamily: 'gpt-5.6-luna',
    agentBackend: 'codex-acp',
    transport: 'LITELLM_MANAGED',
    routeModel: 'route-orcai-gpt-5.6-luna',
    marker: 'LUNA_ORCAI_OK',
  },
  'sol-orcai': {
    key: 'sol-orcai',
    phase: 'REVIEW',
    resourceId: 'orcai',
    modelFamily: 'gpt-5.6-sol',
    agentBackend: 'codex-acp',
    transport: 'LITELLM_MANAGED',
    routeModel: 'route-orcai-gpt-5.6-sol',
  },
};

function fail(message: string): never {
  throw new Error(message);
}

function git(cwd: string, args: string[]): string {
  return execFileSync('/usr/bin/git', ['-c', `safe.directory=${cwd}`, '-C', cwd, ...args], {
    encoding: 'utf8',
  }).trim();
}

function npmTest(cwd: string): void {
  execFileSync('/usr/bin/npm', ['test'], { cwd, stdio: 'ignore' });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matches(candidate: any, target: TargetProfile): boolean {
  const profile = candidate.profile ?? candidate;
  return (
    profile.resourceId === target.resourceId &&
    profile.modelFamily === target.modelFamily &&
    profile.agentBackend === target.agentBackend &&
    profile.transport === target.transport &&
    (target.routeModel === undefined || profile.routeModel === target.routeModel)
  );
}

function routeFor(profile: any): string {
  return ['resource', profile.resourceId, profile.bindingId ?? profile.modelFamily]
    .join(':')
    .slice(0, 500);
}

async function requireProductionAdmission(target: TargetProfile): Promise<void> {
  const response = await fetch(`${PRODUCTION_CONTROL_PLANE}/api/v4/runtime-admission`);
  if (!response.ok) fail(`production runtime admission unavailable: HTTP ${response.status}`);
  const payload = (await response.json()) as any;
  const status = payload.items?.find(
    (item: any) =>
      item.resourceId === target.resourceId &&
      item.modelFamily === target.modelFamily &&
      item.agentBackend === target.agentBackend &&
      (target.routeModel === undefined || item.routeModel === target.routeModel),
  );
  if (!status?.ready)
    fail(
      `production target is not READY: ${target.key} ${status?.errorCode ?? 'missing admission record'}`,
    );
}

function isolatedEnv(): NodeJS.ProcessEnv {
  for (const required of ['SESSION_API_KEY', 'LITELLM_V3_KEY'])
    if (!process.env[required])
      fail(`${required} is required in the acceptance runner environment`);
  return {
    ...process.env,
    NODE_ENV: 'test',
    MODEL_CP_EXECUTION_RUNTIME_ENABLED: 'true',
    MODEL_CP_AUTOMATION_RUNTIME_ENABLED: 'false',
    MODEL_CP_SUPERVISOR_RUNTIME_ENABLED: 'false',
    MODEL_CP_V4_RESOURCE_SELECTOR_ENABLED: 'true',
    MODEL_CP_V4_RUNTIME_ADMISSION_ENABLED: 'false',
    MODEL_CP_V4_SINGLE_ACTIVE_PLAN_ENABLED: 'false',
    MODEL_CP_V4_LITERAL_WORKTREES_ENABLED: 'false',
    MODEL_CP_V4_BUSINESS_RESOURCE_ENABLED: 'false',
    MODEL_CP_V4_ANTIGRAVITY_RESOURCE_ENABLED: 'false',
    MODEL_CP_V4_ALLOWED_REPOSITORY_ROOTS: '/home/dev/projects',
    MODEL_CP_V4_WORKSPACE_HOST_ROOT: MANAGED_WORKSPACE_ROOT,
    MODEL_CP_V4_WORKSPACE_EXECUTION_ROOT: '/workspace',
    MODEL_CP_V4_WORKSPACE_UID: '10001',
    MODEL_CP_V4_WORKSPACE_GID: '10001',
    MODEL_CP_V4_AUTOMATION_PROJECTS: 'ai-office-smoke',
    MODEL_CP_V4_REQUIRE_DELIVERY: 'false',
    MODEL_CP_OPENHANDS_URL: OPENHANDS_URL,
    MODEL_CP_V4_RESOURCE_REFRESH_MS: '3600000',
  };
}

function selectTarget(runtime: any, target: TargetProfile): any {
  const priorAttempts: Array<{ resourceId: string; bindingId?: string; modelFamily?: string }> = [];
  for (let index = 0; index < 100; index += 1) {
    const selected = runtime.automation.resourceSelector.select({
      phase: target.phase,
      includeProviderNativeProfiles: false,
      priorAttempts,
    });
    if (selected.status !== 'SELECTED') break;
    if (matches(selected.candidate, target)) return selected;
    priorAttempts.push({
      resourceId: selected.profile.resourceId,
      ...(selected.profile.bindingId ? { bindingId: selected.profile.bindingId } : {}),
      modelFamily: selected.profile.modelFamily,
    });
  }
  fail(`target profile is not selectable in isolated directory: ${target.key}`);
}

async function createPlan(runtime: any, baseRevision: string, suffix: string, objective: string) {
  const created = await runtime.app.inject({
    method: 'POST',
    url: '/api/v4/plans',
    headers: { 'idempotency-key': `routing-profile-smoke-${suffix}-${Date.now()}-${process.pid}` },
    payload: {
      projectKey: 'ai-office-smoke',
      objective,
      repositoryPath: SOURCE_REPOSITORY,
      baseRevision,
      workItems: [
        {
          itemKey: `routing-profile-${suffix}`,
          title: `Routing profile ${suffix}`,
          objective,
          dependencies: [],
          acceptanceCriteria: [],
        },
      ],
    },
  });
  if (created.statusCode !== 201) fail(`plan create failed ${created.statusCode}: ${created.body}`);
  const planId = created.json().plan.planId as string;
  trackedPlanIds.add(planId);
  const graph = runtime.repositories.plans.getActiveGraphVersion(planId);
  if (!graph) fail('acceptance graph missing');
  const item = runtime.repositories.plans.listWorkItems(planId, graph.graphVersionId)[0];
  if (!item) fail('acceptance work item missing');
  const started = runtime.repositories.plans.compareAndSetStatus(planId, 'READY', 'RUNNING');
  if (!started.value) fail(`acceptance plan could not start: ${started.reason ?? 'unknown'}`);
  runtime.repositories.plans.updateWorkItemStatus(item.workItemId, 'RUNNING');
  return { planId, item };
}

function createSelectedExecution(
  runtime: any,
  input: {
    planId: string;
    workItemId: string;
    phase: 'IMPLEMENT' | 'REVIEW';
    parentExecutionId?: string;
    sourceRevision: string;
    objective: string;
    selected: any;
  },
): any {
  const executionId = `execution_accept_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const execution = runtime.repositories.executions.create({
    idempotencyKey: executionId,
    identity: {
      executionId,
      planId: input.planId,
      workItemId: input.workItemId,
      phase: input.phase,
      ...(input.parentExecutionId ? { parentExecutionId: input.parentExecutionId } : {}),
      attempt: 1,
      route: routeFor(input.selected.profile),
      sourceRevision: input.sourceRevision,
    },
    objective: input.objective,
  }).value;
  if (!execution) fail('acceptance execution create failed');
  const selection = createExecutionResourceSelection(
    executionId,
    input.selected.profile,
    execution.createdAt,
  );
  runtime.repositories.resourceSelections.create(selection);
  return execution;
}

async function driveExecution(runtime: any, executionId: string): Promise<any> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const result = await runtime.automation.worker.runExecution(executionId);
    const execution = runtime.repositories.executions.get(executionId);
    const session = runtime.repositories.sessions.getOptional(executionId);
    if (
      attempt === 0 ||
      attempt % 5 === 0 ||
      ['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(execution.status)
    ) {
      console.log(
        JSON.stringify({
          attempt,
          executionId,
          workerCode: result.code,
          executionStatus: execution.status,
          providerStatus: session?.providerStatus ?? null,
        }),
      );
    }
    if (execution.status === 'SUCCEEDED')
      return {
        execution,
        session,
        evidence: runtime.repositories.evidence.listByExecution(executionId),
      };
    if (['FAILED', 'BLOCKED', 'CANCELLED'].includes(execution.status))
      fail(
        `acceptance execution terminal ${execution.status}: ${execution.errorCode ?? result.code}`,
      );
    await sleep(1500);
  }
  fail(`acceptance execution timed out: ${executionId}`);
}

function verifyImplementation(baseRevision: string, terminal: any, target: TargetProfile): void {
  const repo = terminal.session?.workspace?.hostPath;
  const resultRevision = terminal.execution.resultRevision;
  if (!repo || !resultRevision) fail('implementation missing workspace or result revision');
  if (git(repo, ['rev-parse', 'HEAD']) !== resultRevision)
    fail('implementation HEAD/result revision mismatch');
  if (resultRevision === baseRevision) fail('implementation produced no commit');
  if (git(repo, ['status', '--porcelain=v1']) !== '') fail('implementation workspace is dirty');
  const resultPath = path.join(repo, `result-${target.key}.txt`);
  const expected = `${target.marker}\n`;
  if (fs.readFileSync(resultPath, 'utf8') !== expected)
    fail(`unexpected implementation marker for ${target.key}`);
  npmTest(repo);
  const kinds = terminal.evidence.map((item: any) => item.kind);
  for (const required of ['WORKSPACE', 'REVISION', 'DIFF', 'TEST', 'PROVIDER_OUTPUT'])
    if (!kinds.includes(required)) fail(`missing ${required} evidence for ${target.key}`);
}

async function runImplementation(runtime: any, baseRevision: string, target: TargetProfile) {
  if (!target.marker) fail(`implementation target missing marker: ${target.key}`);
  const objective = [
    `Create result-${target.key}.txt containing exactly ${target.marker} followed by a newline.`,
    'Run npm test and require success.',
    'Commit the intended change.',
    'Leave the repository clean and write the required Pixel implementation completion evidence.',
  ].join(' ');
  const { planId, item } = await createPlan(runtime, baseRevision, target.key, objective);
  const selected = selectTarget(runtime, target);
  const execution = createSelectedExecution(runtime, {
    planId,
    workItemId: item.workItemId,
    phase: 'IMPLEMENT',
    sourceRevision: baseRevision,
    objective,
    selected,
  });
  const terminal = await driveExecution(runtime, execution.identity.executionId);
  verifyImplementation(baseRevision, terminal, target);
  return { planId, item, selected, terminal };
}

async function runReview(runtime: any, baseRevision: string, target: TargetProfile) {
  const implementationTarget = TARGETS.dsh!;
  await requireProductionAdmission(implementationTarget);
  const implementation = await runImplementation(runtime, baseRevision, implementationTarget);
  const implementationExecution = implementation.terminal.execution;
  const reviewedSha = implementationExecution.resultRevision;
  if (!reviewedSha) fail('review fixture implementation has no exact result revision');

  const review = runtime.repositories.reviews.create({
    idempotencyKey: `routing-review-${target.key}-${Date.now()}-${process.pid}`,
    planId: implementation.planId,
    workItemId: implementation.item.workItemId,
    implementationExecutionId: implementationExecution.identity.executionId,
    sourceRevision: reviewedSha,
  }).value;
  if (!review) fail('review record create failed');

  const selected = selectTarget(runtime, target);
  const execution = createSelectedExecution(runtime, {
    planId: implementation.planId,
    workItemId: implementation.item.workItemId,
    phase: 'REVIEW',
    parentExecutionId: implementationExecution.identity.executionId,
    sourceRevision: reviewedSha,
    objective: `Independently review the exact implementation SHA ${reviewedSha}. Run repository checks as needed. Write a PASS/FAIL review verdict with findings and do not modify product files.`,
    selected,
  });
  const terminal = await driveExecution(runtime, execution.identity.executionId);
  const durableReview = runtime.repositories.reviews.findByReviewerExecution(
    execution.identity.executionId,
  );
  if (!durableReview) fail('durable review not bound to reviewer execution');
  if (terminal.execution.resultRevision !== reviewedSha)
    fail('review result revision drifted from exact reviewed SHA');
  if (durableReview.reviewedSha !== reviewedSha) fail('durable review reviewedSha drifted');
  if (durableReview.status !== 'PASSED' || durableReview.verdict !== 'PASS')
    fail(
      `exact review did not PASS: ${durableReview.status}/${durableReview.verdict ?? 'no-verdict'}`,
    );
  const kinds = terminal.evidence.map((item: any) => item.kind);
  for (const required of ['WORKSPACE', 'REVISION', 'REVIEW', 'PROVIDER_OUTPUT'])
    if (!kinds.includes(required)) fail(`missing ${required} review evidence for ${target.key}`);
  return { implementation, selected, terminal, durableReview };
}

const targetKey = process.argv[2];
const target = targetKey ? TARGETS[targetKey] : undefined;
if (!target)
  fail(
    `usage: npx tsx model-control-plane/scripts/smoke-v4-routing-profile.mts <${Object.keys(TARGETS).join('|')}>`,
  );

async function disposeConversation(providerSessionId: string): Promise<void> {
  const sessionApiKey = process.env.SESSION_API_KEY;
  if (!sessionApiKey) return;
  const headers = { 'X-Session-API-Key': sessionApiKey };
  try {
    await fetch(
      `${OPENHANDS_URL}/api/conversations/${encodeURIComponent(providerSessionId)}/interrupt`,
      {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {}
  try {
    await fetch(`${OPENHANDS_URL}/api/conversations/${encodeURIComponent(providerSessionId)}`, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {}
}

let runtime: Awaited<ReturnType<typeof buildControlPlane>> | undefined;
const cleanupRoots = new Set<string>();
const cleanupConversations = new Set<string>();
try {
  await requireProductionAdmission(target);
  const baseRevision = git(SOURCE_REPOSITORY, ['rev-parse', 'HEAD']);
  if (git(SOURCE_REPOSITORY, ['status', '--porcelain=v1']) !== '')
    fail('canonical smoke repository is dirty before acceptance');

  runtime = await buildControlPlane({
    dbFile: ':memory:',
    environment: 'test',
    logger: false,
    env: isolatedEnv(),
  });
  if (!runtime.automation) fail('execution automation missing');
  if (runtime.automation.runtimeAdmissionEnabled)
    fail('isolated runtime admission must be disabled; production precheck is authoritative');

  const result =
    target.phase === 'IMPLEMENT'
      ? await runImplementation(runtime, baseRevision, target)
      : await runReview(runtime, baseRevision, target);

  for (const session of runtime.repositories.sessions.listByPlan(
    target.phase === 'IMPLEMENT' ? result.planId : result.implementation.planId,
  )) {
    const hostPath = session.workspace?.hostPath;
    if (hostPath?.startsWith(`${MANAGED_WORKSPACE_ROOT}/v4/executions/`))
      cleanupRoots.add(path.dirname(hostPath));
  }

  if (git(SOURCE_REPOSITORY, ['rev-parse', 'HEAD']) !== baseRevision)
    fail('canonical smoke repository HEAD changed');
  if (git(SOURCE_REPOSITORY, ['status', '--porcelain=v1']) !== '')
    fail('canonical smoke repository became dirty');

  if (target.phase === 'IMPLEMENT') {
    const terminal = result.terminal;
    console.log(
      JSON.stringify({
        status: 'PASS',
        matrix: target.key,
        phase: target.phase,
        resourceId: target.resourceId,
        modelFamily: target.modelFamily,
        agentBackend: target.agentBackend,
        transport: target.transport,
        routeModel: target.routeModel ?? null,
        baseRevision,
        resultRevision: terminal.execution.resultRevision,
        exactCommit: true,
        workspaceClean: true,
        testPass: true,
        canonicalUnchanged: true,
        evidenceKinds: terminal.evidence.map((item: any) => item.kind),
      }),
    );
  } else {
    console.log(
      JSON.stringify({
        status: 'PASS',
        matrix: target.key,
        phase: target.phase,
        resourceId: target.resourceId,
        modelFamily: target.modelFamily,
        agentBackend: target.agentBackend,
        transport: target.transport,
        routeModel: target.routeModel ?? null,
        reviewedSha: result.durableReview.reviewedSha,
        verdict: result.durableReview.verdict,
        exactReview: true,
        canonicalUnchanged: true,
        evidenceKinds: result.terminal.evidence.map((item: any) => item.kind),
      }),
    );
  }
} finally {
  if (runtime) {
    for (const planId of trackedPlanIds) {
      for (const session of runtime.repositories.sessions.listByPlan(planId)) {
        if (session.providerSessionId) cleanupConversations.add(session.providerSessionId);
        const hostPath = session.workspace?.hostPath;
        if (hostPath?.startsWith(`${MANAGED_WORKSPACE_ROOT}/v4/executions/`))
          cleanupRoots.add(path.dirname(hostPath));
      }
    }
  }
  for (const providerSessionId of cleanupConversations)
    await disposeConversation(providerSessionId);
  try {
    if (runtime) await runtime.app.close();
  } catch {}
  for (const root of cleanupRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
}
