import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from './db.mjs';
import { registerV3Routes } from './v3/api.js';
import { ExecutionLinkRepository } from './v3/correlation.js';
import { GitHubPlanDelivery, type PlanDeliveryPort } from './v3/delivery.js';
import {
  GitHubGovernanceStatus,
  type GitHubGovernanceStatusPort,
} from './v3/githubGovernanceStatus.js';
import {
  GitHubPullRequestRepairPublisher,
  type GitHubPullRequestRepairPublisherPort,
} from './v3/githubPrRepairPublisher.js';
import { JulesApiClient, type JulesApiPort } from './v3/jules.js';
import { GitHubPullRequestIntake, type GitHubPullRequestIntakePort } from './v3/githubPrIntake.js';
import {
  LiteLlmModelGateway,
  LiteLlmModelRegistry,
  LiteLlmSpendObservability,
} from './v3/adapters/liteLlm.js';
import { AntigravityExecutionHost } from './v3/adapters/antigravity.js';
import { EnvFileValueProvider, OpenHandsExecutionHost } from './v3/adapters/openHands.js';
import { RoutedExecutionHost } from './v3/adapters/routedExecutionHost.js';
import type {
  ExecutionHostPort,
  ModelGatewayPort,
  ModelRegistryPort,
  ObservabilityPort,
} from './v3/ports.js';
import { DevelopmentPolicy } from './v3/policy.js';
import { PlanRepository } from './v3/plans.js';
import { PLAN_RECONCILE_INTERVAL_MS } from './v3/planConstants.js';
import { loadV3ReadinessEvidence } from './v3/readiness.js';
import { DevelopmentExecutionService, UnconfiguredObservability } from './v3/service.js';
import { WorkspaceProvisioner, type WorkspaceProvisioningPort } from './v3/workspace.js';
import { ExecutionWorkspaceRetention } from './v3/workspaceRetention.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface BuildControlPlaneOptions {
  env?: NodeJS.ProcessEnv;
  dbFile?: string;
  logger?: boolean;
  v3Policy?: DevelopmentPolicy;
  v3ExecutionHost?: ExecutionHostPort;
  v3ModelGateway?: ModelGatewayPort;
  v3ModelRegistry?: ModelRegistryPort;
  v3Observability?: ObservabilityPort;
  v3Workspace?: WorkspaceProvisioningPort;
  v3Delivery?: PlanDeliveryPort;
  v3PullRequestIntake?: GitHubPullRequestIntakePort;
  v3PullRequestRepairPublisher?: GitHubPullRequestRepairPublisherPort;
  v3GovernanceStatus?: GitHubGovernanceStatusPort;
  v3GitHubEventToken?: string;
  v3Jules?: JulesApiPort;
  v3BackendAvailability?: Readonly<Record<string, boolean>>;
}

export interface ControlPlaneRuntime {
  app: FastifyInstance;
  v3: DevelopmentExecutionService;
  dbFile: string;
  host: string;
  port: number;
}

export async function buildControlPlane(
  options: BuildControlPlaneOptions = {},
): Promise<ControlPlaneRuntime> {
  const env = options.env ?? process.env;
  const dbFile =
    options.dbFile ?? env.MODEL_CP_DB ?? path.resolve(here, '../data/control-plane.sqlite');
  const host = env.MODEL_CP_HOST ?? '127.0.0.1';
  const port = Number(env.MODEL_CP_PORT ?? 8320);
  const app = Fastify({ logger: options.logger ?? true });
  const db = openDb(dbFile);

  const policy =
    options.v3Policy ??
    DevelopmentPolicy.fromFile(
      env.MODEL_CP_V3_POLICY_FILE ?? path.resolve(here, '../config/development-policy.yaml'),
    );
  const openHandsEnv =
    env.MODEL_CP_V3_OPENHANDS_ENV_FILE ?? '/srv/hermes-personal/secrets/openhands-v3.env';
  const executionSecrets = new EnvFileValueProvider(openHandsEnv);
  const configuredBackends = new Set(
    (env.MODEL_CP_V3_ENABLED_BACKENDS ?? 'opencode-acp,openhands-builtin')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const executionHost =
    options.v3ExecutionHost ??
    (() => {
      const openHandsHost = new OpenHandsExecutionHost({
        baseUrl: env.MODEL_CP_V3_OPENHANDS_URL ?? 'http://127.0.0.1:18000',
        secrets: executionSecrets,
        policy,
      });
      const antigravityEnabled =
        configuredBackends.has('antigravity-review') ||
        configuredBackends.has('antigravity-worker');
      if (!antigravityEnabled) return openHandsHost;
      const antigravityHome = env.MODEL_CP_V3_ANTIGRAVITY_HOME ?? '/home/dev';
      const antigravityOwner = fs.statSync(antigravityHome);
      const antigravityHost = new AntigravityExecutionHost({
        binary: env.MODEL_CP_V3_ANTIGRAVITY_BIN ?? '/home/dev/.local/bin/agy',
        stateRoot:
          env.MODEL_CP_V3_ANTIGRAVITY_STATE_ROOT ??
          '/srv/hermes-personal/data/model-control-plane/antigravity',
        workspaceHostRoot:
          env.MODEL_CP_V3_WORKSPACE_ROOT ?? '/opt/data/hermes-ai-office-v3/workspaces',
        workspaceExecutionRoot: env.MODEL_CP_V3_OPENHANDS_WORKSPACE_ROOT ?? '/workspace',
        home: antigravityHome,
        uid: Number(env.MODEL_CP_V3_ANTIGRAVITY_UID ?? antigravityOwner.uid),
        gid: Number(env.MODEL_CP_V3_ANTIGRAVITY_GID ?? antigravityOwner.gid),
        workspaceGid: Number(
          env.MODEL_CP_V3_ANTIGRAVITY_WORKSPACE_GID ?? env.MODEL_CP_V3_OPENHANDS_GID ?? 10001,
        ),
        user: env.MODEL_CP_V3_ANTIGRAVITY_USER ?? 'dev',
        printTimeout: env.MODEL_CP_V3_ANTIGRAVITY_PRINT_TIMEOUT ?? '20m',
        sandboxWrapper:
          env.MODEL_CP_V3_ANTIGRAVITY_SANDBOX_WRAPPER ??
          path.resolve(here, '../scripts/run-antigravity-sandbox.sh'),
      });
      return new RoutedExecutionHost({
        defaultHost: openHandsHost,
        byBackend: {
          'antigravity-review': antigravityHost,
          'antigravity-worker': antigravityHost,
        },
        byConversationPrefix: { 'antigravity:': antigravityHost },
      });
    })();
  const modelGateway =
    options.v3ModelGateway ??
    new LiteLlmModelGateway({
      baseUrl: env.MODEL_CP_V3_LITELLM_URL ?? 'http://127.0.0.1:4000',
      secrets: executionSecrets,
    });
  const adminSecrets = new EnvFileValueProvider(
    env.MODEL_CP_V3_LITELLM_ADMIN_ENV_FILE ??
      env.LITELLM_ENV_FILE ??
      '/srv/hermes-personal/secrets/litellm.env',
  );
  const modelRegistry =
    options.v3ModelRegistry ??
    new LiteLlmModelRegistry({
      baseUrl: env.MODEL_CP_V3_LITELLM_URL ?? 'http://127.0.0.1:4000',
      secrets: adminSecrets,
      keyName: env.MODEL_CP_V3_LITELLM_ADMIN_KEY_NAME ?? 'LITELLM_MASTER_KEY',
      adminUrl: env.MODEL_CP_V3_LITELLM_ADMIN_URL,
    });
  const observability =
    options.v3Observability ??
    (options.v3ExecutionHost
      ? new UnconfiguredObservability()
      : new LiteLlmSpendObservability({
          baseUrl: env.MODEL_CP_V3_LITELLM_URL ?? 'http://127.0.0.1:4000',
          secrets: adminSecrets,
          keyName: env.MODEL_CP_V3_LITELLM_ADMIN_KEY_NAME ?? 'LITELLM_MASTER_KEY',
          lookbackDays: Number(env.MODEL_CP_V3_LITELLM_OBSERVABILITY_LOOKBACK_DAYS ?? 365),
          modelRegistry,
        }));
  const repositoryRoots = (env.MODEL_CP_V3_REPOSITORY_ROOTS ?? '/home/ubuntu/projects,/opt/data')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const workspace =
    options.v3Workspace ??
    new WorkspaceProvisioner({
      hostRoot: env.MODEL_CP_V3_WORKSPACE_ROOT ?? '/opt/data/hermes-ai-office-v3/workspaces',
      executionRoot: env.MODEL_CP_V3_OPENHANDS_WORKSPACE_ROOT ?? '/workspace',
      allowedRepositoryRoots: repositoryRoots,
      executionOwner: {
        uid: Number(env.MODEL_CP_V3_OPENHANDS_UID ?? 10001),
        gid: Number(env.MODEL_CP_V3_OPENHANDS_GID ?? 10001),
      },
    });
  const backendAvailability = Object.fromEntries(
    Object.entries(policy.config.backends).map(([name, backend]) => [
      name,
      backend.kind === 'internal' ||
        (options.v3BackendAvailability
          ? options.v3BackendAvailability[name] === true
          : configuredBackends.has(name)),
    ]),
  );

  const links = new ExecutionLinkRepository(db);
  const plans = new PlanRepository(db);
  const v3 = new DevelopmentExecutionService({
    policy,
    links,
    plans,
    delivery: options.v3Delivery ?? new GitHubPlanDelivery({ home: env.MODEL_CP_V3_DELIVERY_HOME }),
    pullRequestRepairPublisher:
      options.v3PullRequestRepairPublisher ??
      new GitHubPullRequestRepairPublisher({
        home: env.MODEL_CP_V3_GITHUB_HOME ?? env.MODEL_CP_V3_DELIVERY_HOME,
      }),
    governanceStatus:
      options.v3GovernanceStatus ??
      new GitHubGovernanceStatus({
        home: env.MODEL_CP_V3_GITHUB_HOME ?? env.MODEL_CP_V3_DELIVERY_HOME,
      }),
    host: executionHost,
    workspace,
    gateway: modelGateway,
    observability,
    backendAvailability,
    reviewStrategy:
      env.MODEL_CP_V3_PLAN_REVIEW_STRATEGY === 'BATCH_ONLY' ? 'BATCH_ONLY' : 'PER_ITEM_AND_BATCH',
  });
  const readinessEvidence = loadV3ReadinessEvidence(
    env.MODEL_CP_V3_READINESS_EVIDENCE_FILE ??
      path.resolve(here, '../config/v3-readiness-evidence.yaml'),
  );
  const pullRequestIntake =
    options.v3PullRequestIntake ??
    new GitHubPullRequestIntake({
      home: env.MODEL_CP_V3_GITHUB_HOME ?? env.MODEL_CP_V3_DELIVERY_HOME,
    });
  const julesEnvFile = env.MODEL_CP_V3_JULES_ENV_FILE?.trim();
  const jules =
    options.v3Jules ??
    (julesEnvFile && fs.existsSync(julesEnvFile)
      ? new JulesApiClient({
          secrets: new EnvFileValueProvider(julesEnvFile),
          baseUrl: env.MODEL_CP_V3_JULES_BASE_URL,
          apiKeyName: env.MODEL_CP_V3_JULES_API_KEY_NAME ?? 'JULES_API_KEY',
        })
      : undefined);
  registerV3Routes(
    app,
    v3,
    policy,
    readinessEvidence,
    modelRegistry,
    pullRequestIntake,
    options.v3GitHubEventToken ?? env.MODEL_CP_V3_GITHUB_EVENT_TOKEN,
    jules,
  );
  const reconcileInterval = setInterval(
    () => {
      void v3
        .reconcilePlans()
        .catch((error) => app.log.error(error, 'V3 plan reconciliation failed'));
    },
    Number(env.MODEL_CP_V3_RECONCILE_INTERVAL_MS ?? PLAN_RECONCILE_INTERVAL_MS),
  );
  reconcileInterval.unref();

  const workspaceRetention = new ExecutionWorkspaceRetention({
    links,
    plans,
    workspace,
    standaloneSuccessTtlMs: Number(
      env.MODEL_CP_V3_WORKSPACE_SUCCESS_TTL_MS ?? 6 * 60 * 60_000,
    ),
    standaloneFailureTtlMs: Number(
      env.MODEL_CP_V3_WORKSPACE_FAILURE_TTL_MS ?? 60 * 60_000,
    ),
    terminalPlanTtlMs: Number(
      env.MODEL_CP_V3_WORKSPACE_TERMINAL_PLAN_TTL_MS ?? 60 * 60_000,
    ),
    recoverablePlanArtifactTtlMs: Number(
      env.MODEL_CP_V3_WORKSPACE_RECOVERABLE_ARTIFACT_TTL_MS ?? 60 * 60_000,
    ),
  });
  const collectWorkspaces = () =>
    void workspaceRetention
      .collect()
      .then((summary) => {
        if (summary.deleted || summary.pruned) {
          app.log.info(summary, 'V3 execution workspace retention completed');
        }
      })
      .catch((error) => app.log.error(error, 'V3 execution workspace retention failed'));
  const workspaceRetentionStartup = setTimeout(collectWorkspaces, 5_000);
  workspaceRetentionStartup.unref();
  const workspaceRetentionInterval = setInterval(
    collectWorkspaces,
    Math.max(60_000, Number(env.MODEL_CP_V3_WORKSPACE_GC_INTERVAL_MS ?? 15 * 60_000)),
  );
  workspaceRetentionInterval.unref();

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'hermes-model-control-plane',
    apiVersion: 3,
    mode: 'production',
    providerAuthority: 'LITELLM',
    db: dbFile,
  }));

  app.addHook('onClose', async () => {
    clearInterval(reconcileInterval);
    clearTimeout(workspaceRetentionStartup);
    clearInterval(workspaceRetentionInterval);
    db.close();
  });

  return { app, v3, dbFile, host, port };
}
