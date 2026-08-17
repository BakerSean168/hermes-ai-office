import Fastify, { type FastifyInstance } from 'fastify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CpaAdapter } from './adapters/cpa.mjs';
import { CpaUsageAdapter } from './adapters/cpaUsage.mjs';
import { openDb } from './db.mjs';
import {
  CpaGateway,
  type CpaAggregateUsageSource,
  type CpaStatusSource,
} from './gateway/cpaGateway.js';
import { EnvFileBearerTokenProvider, LiteLlmGateway } from './gateway/liteLlm.js';
import { GatewayRegistry } from './gateway/registry.js';
import { registerV2Routes } from './v2/api.js';
import { DispatchService } from './v2/dispatch.js';
import { GatewayDiscoveryService } from './v2/discovery.js';
import { GatewayProvisioningService } from './v2/gatewayProvisioning.js';
import { HermesExecutionSyncService } from './v2/execution.js';
import { FinanceRepository } from './v2/finance.js';
import { IdempotencyService } from './v2/idempotency.js';
import { IncidentProjectionService } from './v2/incidents.js';
import { InvocationService } from './v2/invocation.js';
import { WorkforceLifecycleService } from './v2/lifecycle.js';
import { MaintenanceService } from './v2/maintenance.js';
import {
  CpaXaiPersonalChannelSource,
  Grok2ApiPersonalChannelSource,
  InternalPoolWorkforceSyncService,
  PersonalChannelProjectionService,
} from './v2/personalChannels.js';
import { runV2Migrations } from './v2/migrations.js';
import { OrganizationRepository } from './v2/organization.js';
import { ProviderHubRepository } from './v2/providerHub.js';
import { OfficeProjectionService } from './v2/projections.js';
import { RepositoryGatewayBindingSource, V2Repository } from './v2/repository.js';
import { RuntimeAccessRepository } from './v2/runtimeAccess.js';
import { RuntimePolicyService } from './v2/runtimePolicy.js';
import { StaffingRepository } from './v2/staffing.js';
import { SupplyRepository } from './v2/supply.js';
import { UsageReconciliationService } from './v2/usageReconciliation.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface CpaProbePort extends CpaStatusSource {
  test(name: string): Promise<unknown>;
  models?(): Promise<string[]>;
}

export type CpaUsagePort = CpaAggregateUsageSource;

export interface BuildControlPlaneOptions {
  env?: NodeJS.ProcessEnv;
  dbFile?: string;
  logger?: boolean;
  cpa?: CpaProbePort;
  cpaUsage?: CpaUsagePort;
  initialSync?: boolean;
  gateways?: GatewayRegistry;
}

export interface ControlPlaneRuntime {
  app: FastifyInstance;
  v2: V2Repository;
  gateways: GatewayRegistry;
  dbFile: string;
  host: string;
  port: number;
  reconcileGateways(): Promise<void>;
  startBackgroundJobs(): void;
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
  if (env.MODEL_CP_V2_SCHEMA !== '0') runV2Migrations(db);

  const v2 = new V2Repository(db);
  const gateways = options.gateways ?? new GatewayRegistry();
  const supply = new SupplyRepository(v2);
  const finance = new FinanceRepository(v2);
  const staffing = new StaffingRepository(v2);
  const organization = new OrganizationRepository(v2);
  const executionSync = new HermesExecutionSyncService(v2, organization);
  const incidentProjection = new IncidentProjectionService(v2);
  const maintenance = new MaintenanceService(v2);
  const officeProjection = new OfficeProjectionService({
    domain: v2,
    organization,
    execution: executionSync,
    staffing,
    finance,
  });
  const dispatchService = new DispatchService(v2, gateways, supply, staffing);
  const runtimeAccess = new RuntimeAccessRepository(v2);
  const providerHub = new ProviderHubRepository(v2);
  const runtimePolicy = new RuntimePolicyService(v2, supply, staffing, runtimeAccess);
  const invocationService = new InvocationService(v2, gateways);
  const lifecycleService = new WorkforceLifecycleService(v2, dispatchService);
  const idempotencyService = new IdempotencyService(db, {
    ttlMs: Number(env.MODEL_CP_V2_IDEMPOTENCY_TTL_MS ?? 24 * 60 * 60 * 1_000),
  });

  if (
    !options.gateways &&
    env.MODEL_CP_V2_LITELLM !== '0' &&
    env.LITELLM_BASE_URL &&
    env.LITELLM_ENV_FILE
  ) {
    gateways.register(
      new LiteLlmGateway({
        gatewayId: env.LITELLM_GATEWAY_ID ?? 'litellm-reference',
        baseUrl: env.LITELLM_BASE_URL,
        secrets: new EnvFileBearerTokenProvider(env.LITELLM_ENV_FILE),
        bindings: new RepositoryGatewayBindingSource(
          v2,
          env.LITELLM_GATEWAY_ID ?? 'litellm-reference',
        ),
      }),
    );
  }

  const cpa: CpaProbePort =
    options.cpa ??
    (new CpaAdapter({
      gatewayctl: env.GATEWAYCTL ?? '/usr/local/sbin/gatewayctl',
      sudo: env.MODEL_CP_CPA_SUDO !== '0',
      baseUrl: env.CPA_BASE_URL ?? 'http://127.0.0.1:8317',
      configFile: env.CPA_CONFIG_FILE ?? '/opt/cpa/cpa/config.yaml',
    }) as CpaProbePort);
  const cpaUsage: CpaUsagePort =
    options.cpaUsage ??
    new CpaUsageAdapter({
      baseUrl: env.CPA_BASE_URL ?? 'http://127.0.0.1:8317',
      keyFile: env.CPA_MANAGEMENT_KEY_FILE ?? '/opt/cpa/.mgmt_password',
    });

  if (!options.gateways && env.MODEL_CP_V2_CPA_DISCOVERY !== '0') {
    gateways.register(
      new CpaGateway({
        gatewayId: env.CPA_GATEWAY_ID ?? 'cpa-compat',
        statusSource: cpa,
        usageSource: cpaUsage,
        bindings: new RepositoryGatewayBindingSource(v2, env.CPA_GATEWAY_ID ?? 'cpa-compat'),
        usageRange: env.MODEL_CP_USAGE_RANGE ?? '30d',
      }),
    );
  }

  const discoveryService = new GatewayDiscoveryService(v2, gateways, {
    [env.LITELLM_GATEWAY_ID ?? 'litellm-reference']: {
      kind: 'LITELLM',
      displayName: 'LiteLLM Reference Gateway',
      baseUrlHint: env.LITELLM_BASE_URL,
    },
    [env.CPA_GATEWAY_ID ?? 'cpa-compat']: {
      kind: 'CPA',
      displayName: 'My CPA',
      baseUrlHint: env.CPA_BASE_URL,
    },
  });
  const personalChannels = new PersonalChannelProjectionService([
    new CpaXaiPersonalChannelSource({
      authDir: env.CPA_AUTH_DIR ?? '/opt/cpa/cpa/auth',
      baseUrl: env.CPA_BASE_URL ?? 'http://127.0.0.1:8317',
      models: { models: () => (cpa.models ? cpa.models() : Promise.resolve([])) },
    }),
    new Grok2ApiPersonalChannelSource({
      dbFile:
        env.GROK2API_DB_FILE ?? '/var/lib/docker/volumes/grok2api_grok2api-data/_data/backend.db',
      baseUrl: env.GROK2API_BASE_URL ?? 'http://127.0.0.1:8000',
    }),
  ]);
  const internalWorkforce = new InternalPoolWorkforceSyncService(personalChannels, supply);
  const usageReconciliationService = new UsageReconciliationService(v2, gateways);
  const gatewayProvisioning = new GatewayProvisioningService(v2, supply, gateways);
  const timers = new Set<NodeJS.Timeout>();

  registerV2Routes(app, v2, {
    dispatchService,
    invocationService,
    lifecycleService,
    discoveryService,
    gatewayProvisioning,
    usageReconciliationService,
    supply,
    finance,
    staffing,
    organization,
    executionSync,
    officeProjection,
    incidentProjection,
    maintenance,
    idempotencyService,
    runtimePolicy,
    runtimeAccess,
    providerHub,
    personalChannels,
    internalWorkforce,
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'hermes-model-control-plane',
    apiVersion: 2,
    db: dbFile,
  }));

  const projectIncidents = (): void => {
    try {
      incidentProjection.projectIncremental();
    } catch (error) {
      app.log.warn({ err: error }, 'incident projection failed');
    }
  };
  projectIncidents();

  const reconcileGateways = async (): Promise<void> => {
    if (env.MODEL_CP_V2_DISCOVERY !== '0') await discoveryService.reconcileAll();
  };

  if (options.initialSync !== false) {
    try {
      await reconcileGateways();
      await internalWorkforce.sync();
    } catch (error) {
      app.log.warn({ err: error }, 'initial V2 gateway discovery failed');
    }
  }

  const addInterval = (callback: () => void, intervalMs: number): void => {
    const timer = setInterval(callback, intervalMs);
    timer.unref();
    timers.add(timer);
  };

  const addTimeout = (callback: () => void, delayMs: number): void => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    timers.add(timer);
  };

  function startBackgroundJobs(): void {
    if (timers.size > 0) return;

    const discoveryInterval = Math.max(
      10_000,
      Number(env.MODEL_CP_V2_DISCOVERY_INTERVAL_MS ?? 60_000),
    );
    if (env.MODEL_CP_V2_DISCOVERY !== '0' && discoveryInterval > 0) {
      addInterval(() => {
        void reconcileGateways().catch((error) =>
          app.log.warn({ err: error }, 'V2 gateway discovery reconciliation failed'),
        );
      }, discoveryInterval);
    }

    const usageInterval = Math.max(
      60_000,
      Number(env.MODEL_CP_V2_USAGE_RECONCILIATION_INTERVAL_MS ?? 300_000),
    );
    if (env.MODEL_CP_V2_USAGE_RECONCILIATION !== '0' && usageInterval > 0) {
      const reconcileUsage = (): void => {
        void usageReconciliationService
          .reconcileAll()
          .catch((error) => app.log.warn({ err: error }, 'V2 gateway usage reconciliation failed'));
      };
      addTimeout(() => {
        reconcileUsage();
        addInterval(reconcileUsage, usageInterval);
      }, 5_000);
    }

    const internalWorkforceInterval = Math.max(
      60_000,
      Number(env.MODEL_CP_INTERNAL_WORKFORCE_SYNC_INTERVAL_MS ?? 300_000),
    );
    if (internalWorkforceInterval > 0) {
      addInterval(() => {
        void internalWorkforce
          .sync()
          .catch((error) => app.log.warn({ err: error }, 'internal workforce sync failed'));
      }, internalWorkforceInterval);
    }

    const incidentInterval = Number(env.MODEL_CP_INCIDENT_PROJECTION_INTERVAL_MS ?? 5_000);
    if (incidentInterval > 0) addInterval(projectIncidents, incidentInterval);

    const maintenanceInterval = Number(env.MODEL_CP_MAINTENANCE_INTERVAL_MS ?? 86_400_000);
    if (maintenanceInterval > 0) {
      addInterval(() => {
        try {
          maintenance.run();
        } catch (error) {
          app.log.warn({ err: error }, 'periodic V2 maintenance failed');
        }
      }, maintenanceInterval);
    }

    const healthInterval = Number(env.MODEL_CP_HEALTH_CHECK_INTERVAL_MS ?? 1_800_000);
    if (healthInterval > 0 && !options.gateways && env.MODEL_CP_V2_CPA_DISCOVERY !== '0') {
      addInterval(() => {
        void (async () => {
          try {
            const channels = await cpa.status();
            for (const channel of channels.filter((item) => item.enabled)) {
              try {
                await cpa.test(channel.name);
              } catch (error) {
                app.log.warn(
                  { channel: channel.name, err: error },
                  'CPA gateway health probe failed',
                );
              }
            }
            await discoveryService.reconcile(env.CPA_GATEWAY_ID ?? 'cpa-compat');
          } catch (error) {
            app.log.warn({ err: error }, 'periodic CPA gateway health check failed');
          }
        })();
      }, healthInterval);
    }
  }

  app.addHook('onClose', async () => {
    for (const timer of timers) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    timers.clear();
  });

  return {
    app,
    v2,
    gateways,
    dbFile,
    host,
    port,
    reconcileGateways,
    startBackgroundJobs,
  };
}
