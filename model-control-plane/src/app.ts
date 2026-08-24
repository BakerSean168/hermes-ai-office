import Fastify, { type FastifyInstance } from 'fastify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from './db.mjs';
import { registerV3Routes } from './v3/api.js';
import { ExecutionLinkRepository } from './v3/correlation.js';
import { GitHubPlanDelivery, type PlanDeliveryPort } from './v3/delivery.js';
import {
  LiteLlmModelGateway,
  LiteLlmModelRegistry,
  LiteLlmSpendObservability,
} from './v3/adapters/liteLlm.js';
import { EnvFileValueProvider, OpenHandsExecutionHost } from './v3/adapters/openHands.js';
import type {
  ExecutionHostPort,
  ModelGatewayPort,
  ModelRegistryPort,
  ObservabilityPort,
} from './v3/ports.js';
import { DevelopmentPolicy } from './v3/policy.js';
import { PlanRepository } from './v3/plans.js';
import { loadV3ReadinessEvidence } from './v3/readiness.js';
import { DevelopmentExecutionService, UnconfiguredObservability } from './v3/service.js';
import { WorkspaceProvisioner, type WorkspaceProvisioningPort } from './v3/workspace.js';

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
  const executionHost =
    options.v3ExecutionHost ??
    new OpenHandsExecutionHost({
      baseUrl: env.MODEL_CP_V3_OPENHANDS_URL ?? 'http://127.0.0.1:18000',
      secrets: executionSecrets,
      policy,
    });
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
  const configuredBackends = new Set(
    (env.MODEL_CP_V3_ENABLED_BACKENDS ?? 'opencode-acp,openhands-builtin')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const backendAvailability =
    options.v3BackendAvailability ??
    Object.fromEntries(
      Object.entries(policy.config.backends).map(([name, backend]) => [
        name,
        backend.kind === 'internal' || configuredBackends.has(name),
      ]),
    );

  const v3 = new DevelopmentExecutionService({
    policy,
    links: new ExecutionLinkRepository(db),
    plans: new PlanRepository(db),
    delivery: options.v3Delivery ?? new GitHubPlanDelivery({ home: env.MODEL_CP_V3_DELIVERY_HOME }),
    host: executionHost,
    workspace,
    gateway: modelGateway,
    observability,
    backendAvailability,
  });
  const readinessEvidence = loadV3ReadinessEvidence(
    env.MODEL_CP_V3_READINESS_EVIDENCE_FILE ??
      path.resolve(here, '../config/v3-readiness-evidence.yaml'),
  );
  registerV3Routes(app, v3, policy, readinessEvidence, modelRegistry);
  const reconcileInterval = setInterval(
    () => {
      void v3
        .reconcilePlans()
        .catch((error) => app.log.error(error, 'V3 plan reconciliation failed'));
    },
    Number(env.MODEL_CP_V3_RECONCILE_INTERVAL_MS ?? 5_000),
  );
  reconcileInterval.unref();

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
    db.close();
  });

  return { app, v3, dbFile, host, port };
}
