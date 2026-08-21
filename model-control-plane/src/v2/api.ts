import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { DispatchService } from './dispatch.js';
import type { GatewayDiscoveryService } from './discovery.js';
import type { GatewayProvisioningService } from './gatewayProvisioning.js';
import type { HermesExecutionSyncService, HermesOrgSnapshotInput } from './execution.js';
import type { FinanceRepository } from './finance.js';
import type {
  ExecutionHarness,
  ExecutionIntent,
  ExecutionPolicyService,
} from './executionPolicy.js';
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  type IdempotencyService,
} from './idempotency.js';
import type { IncidentProjectionService } from './incidents.js';
import type { InvocationService } from './invocation.js';
import type { MaintenanceService } from './maintenance.js';
import type { OrganizationRepository } from './organization.js';
import type { OfficeProjectionService } from './projections.js';
import type {
  InternalPoolWorkforceSyncService,
  PersonalChannelProjectionService,
} from './personalChannels.js';
import type { ProviderHubRepository, ProfileProviderRuntime } from './providerHub.js';
import type { WorkforceLifecycleService } from './lifecycle.js';
import type { V2Event, V2Repository } from './repository.js';
import type {
  RuntimeAccessRepository,
  RuntimeAccessKind,
  RuntimeAccessAdapterKind,
} from './runtimeAccess.js';
import type { RuntimePolicyService, RuntimeKind, RuntimePolicyMode } from './runtimePolicy.js';
import type { StaffingRepository, Requirement } from './staffing.js';
import type { SupplyRepository } from './supply.js';
import type { UsageReconciliationService } from './usageReconciliation.js';

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function registerV2Routes(
  app: FastifyInstance,
  repository: V2Repository,
  services: {
    dispatchService?: DispatchService;
    invocationService?: InvocationService;
    lifecycleService?: WorkforceLifecycleService;
    discoveryService?: GatewayDiscoveryService;
    gatewayProvisioning?: GatewayProvisioningService;
    usageReconciliationService?: UsageReconciliationService;
    supply?: SupplyRepository;
    finance?: FinanceRepository;
    staffing?: StaffingRepository;
    organization?: OrganizationRepository;
    executionSync?: HermesExecutionSyncService;
    officeProjection?: OfficeProjectionService;
    incidentProjection?: IncidentProjectionService;
    maintenance?: MaintenanceService;
    idempotencyService?: IdempotencyService;
    runtimePolicy?: RuntimePolicyService;
    executionPolicy?: ExecutionPolicyService;
    runtimeAccess?: RuntimeAccessRepository;
    providerHub?: ProviderHubRepository;
    personalChannels?: PersonalChannelProjectionService;
    internalWorkforce?: InternalPoolWorkforceSyncService;
  } = {},
): void {
  const runCommand = async <T>(input: {
    request: FastifyRequest;
    reply: FastifyReply;
    commandType: string;
    operation: () => Promise<T> | T;
  }): Promise<T | { error: { code: string } }> => {
    const header = input.request.headers['idempotency-key'];
    const key = Array.isArray(header) ? header[0] : header;
    if (!services.idempotencyService) return input.operation();
    try {
      const outcome = await services.idempotencyService.execute({
        key,
        commandType: input.commandType,
        request: {
          params: input.request.params ?? {},
          body: input.request.body ?? null,
        },
        operation: async () => {
          const body = await input.operation();
          return { statusCode: input.reply.statusCode, body };
        },
      });
      input.reply.code(outcome.statusCode);
      if (outcome.replayed) input.reply.header('Idempotency-Replayed', 'true');
      return outcome.body as T;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        input.reply.code(409);
        return { error: { code: 'IDEMPOTENCY_CONFLICT' } };
      }
      if (error instanceof IdempotencyInProgressError) {
        input.reply.code(409);
        return { error: { code: 'IDEMPOTENCY_IN_PROGRESS' } };
      }
      const code = error instanceof Error ? error.message : 'IDEMPOTENCY_FAILED';
      input.reply.code(code === 'IDEMPOTENCY_KEY_TOO_LONG' ? 400 : 500);
      return { error: { code } };
    }
  };

  app.get('/api/v2/projections/provider-hub', async (_request, reply) => {
    if (!services.providerHub) {
      reply.code(503);
      return { error: { code: 'PROVIDER_HUB_UNAVAILABLE' } };
    }
    return services.providerHub.projection();
  });

  app.get('/api/v2/projections/provider-hub-summary', async (_request, reply) => {
    if (!services.providerHub) {
      reply.code(503);
      return { error: { code: 'PROVIDER_HUB_UNAVAILABLE' } };
    }
    return services.providerHub.summaryProjection();
  });

  app.get<{ Params: { connectionId: string } }>(
    '/api/v2/provider-connections/:connectionId',
    async (request, reply) => {
      if (!services.providerHub) {
        reply.code(503);
        return { error: { code: 'PROVIDER_HUB_UNAVAILABLE' } };
      }
      const detail = services.providerHub.connectionDetail(request.params.connectionId);
      if (!detail) {
        reply.code(404);
        return { error: { code: 'PROVIDER_CONNECTION_NOT_FOUND' } };
      }
      return detail;
    },
  );

  app.get<{ Params: { supplierId: string } }>(
    '/api/v2/suppliers/:supplierId/provider-connections',
    async (request, reply) => {
      if (!services.providerHub) {
        reply.code(503);
        return { error: { code: 'PROVIDER_HUB_UNAVAILABLE' } };
      }
      return { items: services.providerHub.connectionsForSupplier(request.params.supplierId) };
    },
  );

  app.get('/api/v2/provider-connections', async () => ({
    items: services.providerHub?.listConnections() ?? [],
  }));

  app.get('/api/v2/profile-provider-links', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.providerHub?.listProfileLinks(
          typeof query.profileId === 'string' ? query.profileId : undefined,
        ) ?? [],
    };
  });

  app.post('/api/v2/commands/provider-connections/upsert', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'provider-connection.upsert',
      operation: () => {
        if (!services.providerHub) {
          reply.code(503);
          return { error: { code: 'PROVIDER_HUB_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.providerKey || !body.displayName || !body.sourceKind) {
          reply.code(400);
          return { error: { code: 'PROVIDER_CONNECTION_FIELDS_REQUIRED' } };
        }
        try {
          return services.providerHub.upsertConnection({
            providerKey: String(body.providerKey),
            displayName: String(body.displayName),
            supplierId: body.supplierId ? String(body.supplierId) : undefined,
            baseUrl: body.baseUrl ? String(body.baseUrl) : undefined,
            websiteUrl: body.websiteUrl ? String(body.websiteUrl) : undefined,
            protocol: body.protocol ? String(body.protocol) : undefined,
            authKind: body.authKind ? (String(body.authKind) as any) : undefined,
            credentialRef: body.credentialRef ? String(body.credentialRef) : undefined,
            credentialScope: body.credentialScope
              ? (String(body.credentialScope) as any)
              : undefined,
            sourceProfileId: body.sourceProfileId ? String(body.sourceProfileId) : undefined,
            sourceKind: String(body.sourceKind),
            shareScope: body.shareScope ? (String(body.shareScope) as any) : undefined,
            health: body.health ? (String(body.health) as any) : undefined,
            models: Array.isArray(body.models) ? body.models.map(String) : undefined,
            metadata:
              body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
                ? (body.metadata as Record<string, unknown>)
                : undefined,
            lastSeenAt: body.lastSeenAt == null ? undefined : Number(body.lastSeenAt),
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : 'PROVIDER_CONNECTION_UPSERT_FAILED';
          reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
          return { error: { code } };
        }
      },
    }),
  );

  app.post<{ Params: { connectionId: string } }>(
    '/api/v2/commands/provider-connections/:connectionId/profile',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'provider-connection.profile.update',
        operation: () => {
          if (!services.providerHub) {
            reply.code(503);
            return { error: { code: 'PROVIDER_HUB_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          try {
            return services.providerHub.updateConnection(request.params.connectionId, {
              displayName: body.displayName == null ? undefined : String(body.displayName),
              baseUrl: body.baseUrl == null ? undefined : String(body.baseUrl),
              websiteUrl: body.websiteUrl == null ? undefined : String(body.websiteUrl),
              protocol: body.protocol == null ? undefined : String(body.protocol),
              models: Array.isArray(body.models) ? body.models.map(String) : undefined,
            });
          } catch (error) {
            const code =
              error instanceof Error ? error.message : 'PROVIDER_CONNECTION_UPDATE_FAILED';
            reply.code(
              code.endsWith('_NOT_FOUND')
                ? 404
                : code.endsWith('_REQUIRED') || code.endsWith('_INVALID')
                  ? 400
                  : code.endsWith('_CONFLICT')
                    ? 409
                    : 422,
            );
            return { error: { code } };
          }
        },
      }),
  );

  app.post<{ Params: { connectionId: string } }>(
    '/api/v2/commands/provider-connections/:connectionId/retire',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'provider-connection.retire',
        operation: () => {
          if (!services.providerHub) {
            reply.code(503);
            return { error: { code: 'PROVIDER_HUB_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          try {
            return services.providerHub.retireConnection(
              request.params.connectionId,
              body.reason ? String(body.reason) : 'OPERATOR_RETIRED',
            );
          } catch (error) {
            const code =
              error instanceof Error ? error.message : 'PROVIDER_CONNECTION_RETIRE_FAILED';
            reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
            return { error: { code } };
          }
        },
      }),
  );

  app.post<{ Params: { connectionId: string } }>(
    '/api/v2/commands/provider-connections/:connectionId/profile-links',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'profile-provider-link.upsert',
        operation: () => {
          if (!services.providerHub) {
            reply.code(503);
            return { error: { code: 'PROVIDER_HUB_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          const runtimeKind = String(body.runtimeKind ?? '').toUpperCase();
          if (
            !body.profileId ||
            !['HERMES', 'OPENCODE', 'CODEX', 'CLAUDE_CODE'].includes(runtimeKind)
          ) {
            reply.code(400);
            return { error: { code: 'PROFILE_PROVIDER_LINK_FIELDS_REQUIRED' } };
          }
          try {
            return services.providerHub.linkProfile({
              connectionId: request.params.connectionId,
              profileId: String(body.profileId),
              runtimeKind: runtimeKind as ProfileProviderRuntime,
              providerRef: body.providerRef ? String(body.providerRef) : undefined,
              modelRef: body.modelRef ? String(body.modelRef) : undefined,
              profileRef: body.profileRef ? String(body.profileRef) : undefined,
              sourceKind: body.sourceKind ? String(body.sourceKind) : 'MANUAL',
            });
          } catch (error) {
            const code =
              error instanceof Error ? error.message : 'PROFILE_PROVIDER_LINK_UPSERT_FAILED';
            reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
            return { error: { code } };
          }
        },
      }),
  );

  app.post<{ Params: { connectionId: string } }>(
    '/api/v2/commands/provider-connections/:connectionId/attempts',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'provider-connection.attempt',
        operation: () => {
          if (!services.providerHub) {
            reply.code(503);
            return { error: { code: 'PROVIDER_HUB_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          if (!body.outcome) {
            reply.code(400);
            return { error: { code: 'PROVIDER_ATTEMPT_OUTCOME_REQUIRED' } };
          }
          try {
            return services.providerHub.recordAttempt(request.params.connectionId, {
              outcome: String(body.outcome) as any,
              errorKind: body.errorKind ? String(body.errorKind) : undefined,
              httpStatus: body.httpStatus == null ? undefined : Number(body.httpStatus),
              message: body.message == null ? undefined : String(body.message),
              observedAt: body.observedAt == null ? undefined : Number(body.observedAt),
              source: body.source == null ? undefined : String(body.source),
              retryAfterAt: body.retryAfterAt == null ? undefined : Number(body.retryAfterAt),
              retryAfterSeconds:
                body.retryAfterSeconds == null ? undefined : Number(body.retryAfterSeconds),
              metadata:
                body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
                  ? (body.metadata as Record<string, unknown>)
                  : undefined,
            });
          } catch (error) {
            const code =
              error instanceof Error ? error.message : 'PROVIDER_CONNECTION_ATTEMPT_FAILED';
            reply.code(
              code.endsWith('_NOT_FOUND')
                ? 404
                : code.endsWith('_REQUIRED') || code.endsWith('_INVALID')
                  ? 400
                  : 422,
            );
            return { error: { code } };
          }
        },
      }),
  );

  app.post<{ Params: { connectionId: string } }>(
    '/api/v2/commands/provider-connections/:connectionId/control',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'provider-connection.control',
        operation: () => {
          if (!services.providerHub) {
            reply.code(503);
            return { error: { code: 'PROVIDER_HUB_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          if (typeof body.enabled !== 'boolean') {
            reply.code(400);
            return { error: { code: 'PROVIDER_CONTROL_ENABLED_REQUIRED' } };
          }
          try {
            return services.providerHub.setControl(request.params.connectionId, {
              enabled: body.enabled,
              reason: body.reason ? String(body.reason) : undefined,
            });
          } catch (error) {
            const code =
              error instanceof Error ? error.message : 'PROVIDER_CONNECTION_CONTROL_FAILED';
            reply.code(
              code.endsWith('_NOT_FOUND')
                ? 404
                : code.endsWith('_REQUIRED') || code.endsWith('_INVALID')
                  ? 400
                  : 422,
            );
            return { error: { code } };
          }
        },
      }),
  );

  app.post('/api/v2/commands/internal-workforce/sync', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'internal-workforce.sync',
      operation: async () => {
        if (!services.internalWorkforce) {
          reply.code(503);
          return { error: { code: 'INTERNAL_WORKFORCE_UNAVAILABLE' } };
        }
        return services.internalWorkforce.sync();
      },
    }),
  );

  app.get('/api/v2/projections/personal-channels', async (_request, reply) => {
    if (!services.personalChannels) {
      reply.code(503);
      return { error: { code: 'PERSONAL_CHANNEL_PROJECTION_UNAVAILABLE' } };
    }
    return services.personalChannels.projection();
  });

  app.get('/api/v2/health', async () => ({
    status: 'ok',
    service: 'hermes-ai-workforce-domain',
    apiVersion: 2,
    schemaMigrations: repository.db
      .prepare('SELECT id,checksum,applied_at FROM v2_schema_migrations ORDER BY id')
      .all(),
  }));

  app.post<{ Params: { employmentId: string } }>(
    '/api/v2/internal/employments/:employmentId/gateway-route',
    async (request, reply) => {
      if (!services.gatewayProvisioning) {
        reply.code(503);
        return { error: { code: 'GATEWAY_PROVISIONING_SERVICE_UNAVAILABLE' } };
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const protocol = String(body.protocol ?? '');
      if (!['openai-chat-completions', 'openai-responses'].includes(protocol)) {
        reply.code(400);
        return { error: { code: 'GATEWAY_PROVISIONING_PROTOCOL_INVALID' } };
      }
      if (!body.upstreamProvider || !body.upstreamModel || !body.secretMaterial) {
        reply.code(400);
        return { error: { code: 'GATEWAY_PROVISIONING_FIELDS_REQUIRED' } };
      }
      if (
        typeof body.secretMaterial !== 'object' ||
        body.secretMaterial === null ||
        Array.isArray(body.secretMaterial)
      ) {
        reply.code(400);
        return { error: { code: 'GATEWAY_SECRET_MATERIAL_INVALID' } };
      }
      try {
        return await services.gatewayProvisioning.provisionEmploymentRoute({
          employmentId: request.params.employmentId,
          gatewaySlug: body.gatewaySlug ? String(body.gatewaySlug) : undefined,
          protocol: protocol as 'openai-chat-completions' | 'openai-responses',
          upstreamProvider: String(body.upstreamProvider),
          upstreamModel: String(body.upstreamModel),
          upstreamBaseUrl: body.upstreamBaseUrl ? String(body.upstreamBaseUrl) : undefined,
          secretMaterial: body.secretMaterial as Record<string, unknown>,
        });
      } catch (error) {
        const code = error instanceof Error ? error.message : 'GATEWAY_PROVISIONING_FAILED';
        reply.code(code.endsWith('_NOT_FOUND') ? 404 : code.includes('UNAVAILABLE') ? 503 : 422);
        return { error: { code } };
      }
    },
  );

  app.get('/api/v2/employees', async () => ({ items: repository.listEmployees() }));
  app.get<{ Params: { employeeId: string } }>(
    '/api/v2/employees/:employeeId',
    async (request, reply) => {
      const dossier = repository.employeeDossier(request.params.employeeId);
      if (!dossier) {
        reply.code(404);
        return { error: { code: 'EMPLOYEE_NOT_FOUND' } };
      }
      return dossier;
    },
  );
  app.get<{ Params: { employeeId: string } }>(
    '/api/v2/employees/:employeeId/employments',
    async (request) => ({ items: repository.listEmployments(request.params.employeeId) }),
  );
  app.get<{ Params: { employeeId: string } }>(
    '/api/v2/employees/:employeeId/appointments',
    async (request) => ({
      items: repository.listAppointments({ employeeId: request.params.employeeId }),
    }),
  );
  app.get('/api/v2/employments', async () => ({ items: repository.listEmployments() }));
  app.get('/api/v2/runtime-access-profiles', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.runtimeAccess?.list(
          typeof query.employmentId === 'string' ? query.employmentId : undefined,
        ) ?? [],
    };
  });

  app.post('/api/v2/commands/runtime-access/import-legacy', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'runtime-access.import-legacy',
      operation: () => {
        if (!services.runtimeAccess) {
          reply.code(503);
          return { error: { code: 'RUNTIME_ACCESS_SERVICE_UNAVAILABLE' } };
        }
        return services.runtimeAccess.importLegacySelectors();
      },
    }),
  );

  app.post<{ Params: { employmentId: string } }>(
    '/api/v2/commands/employments/:employmentId/runtime-access',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'runtime-access.upsert',
        operation: () => {
          if (!services.runtimeAccess) {
            reply.code(503);
            return { error: { code: 'RUNTIME_ACCESS_SERVICE_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          const runtimeKind = String(body.runtimeKind ?? '').toUpperCase();
          const adapterKind = String(body.adapterKind ?? 'NATIVE_CONFIG').toUpperCase();
          if (!['OPENCODE', 'CODEX', 'CLAUDE_CODE'].includes(runtimeKind) || !body.modelRef) {
            reply.code(400);
            return { error: { code: 'RUNTIME_ACCESS_FIELDS_REQUIRED' } };
          }
          if (!['NATIVE_CONFIG', 'GATEWAY'].includes(adapterKind)) {
            reply.code(400);
            return { error: { code: 'RUNTIME_ACCESS_ADAPTER_INVALID' } };
          }
          try {
            return services.runtimeAccess.upsert({
              employmentId: request.params.employmentId,
              runtimeKind: runtimeKind as RuntimeAccessKind,
              adapterKind: adapterKind as RuntimeAccessAdapterKind,
              providerRef: body.providerRef == null ? undefined : String(body.providerRef),
              modelRef: String(body.modelRef),
              profileRef: body.profileRef == null ? undefined : String(body.profileRef),
              baseUrl: body.baseUrl == null ? undefined : String(body.baseUrl),
              credentialRef: body.credentialRef == null ? undefined : String(body.credentialRef),
              protocol: body.protocol == null ? undefined : String(body.protocol),
              config:
                body.config && typeof body.config === 'object' && !Array.isArray(body.config)
                  ? (body.config as Record<string, unknown>)
                  : undefined,
              priority: body.priority == null ? undefined : Number(body.priority),
            });
          } catch (error) {
            const code = error instanceof Error ? error.message : 'RUNTIME_ACCESS_UPSERT_FAILED';
            reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
            return { error: { code } };
          }
        },
      }),
  );

  app.get('/api/v2/appointments', async () => ({ items: repository.listAppointments() }));
  app.get('/api/v2/positions', async () => ({ items: repository.listPositions() }));
  app.get('/api/v2/gateways', async () => ({ items: repository.listGateways() }));
  app.get('/api/v2/channels', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items: repository.listChannels(
        typeof query.gatewayId === 'string' ? query.gatewayId : undefined,
      ),
    };
  });
  app.get('/api/v2/runtime-launch-decisions', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.runtimePolicy?.list(Math.min(500, Math.max(1, number(query.limit, 100)))) ?? [],
    };
  });

  app.get('/api/v2/discovery-runs', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const limit = Math.min(500, Math.max(1, number(query.limit, 50)));
    return {
      items: repository.listDiscoveryRuns(
        typeof query.gatewayDbId === 'string' ? query.gatewayDbId : undefined,
        limit,
      ),
    };
  });

  app.get(
    '/api/v2/projections/supply',
    async () =>
      services.supply?.projection() ?? {
        projectionVersion: 2,
        generatedAt: Date.now(),
        suppliers: [],
        gateways: [],
        unmappedInfrastructure: { channels: [], count: 0 },
        summary: {},
      },
  );
  app.get('/api/v2/suppliers', async () => ({
    items: (services.supply?.projection().suppliers as unknown[]) ?? [],
  }));

  app.get('/api/v2/supply-agreements', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.supply?.listSupplyAgreements(
          typeof query.supplierId === 'string' ? query.supplierId : undefined,
        ) ?? [],
    };
  });
  app.get('/api/v2/plans', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.supply?.listPlans(
          typeof query.supplierId === 'string' ? query.supplierId : undefined,
        ) ?? [],
    };
  });
  app.get('/api/v2/model-offerings', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.supply?.listModelOfferings({
          supplierId: typeof query.supplierId === 'string' ? query.supplierId : undefined,
          agreementId: typeof query.agreementId === 'string' ? query.agreementId : undefined,
        }) ?? [],
    };
  });
  app.get('/api/v2/capacity-pools', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.supply?.listCapacityPools(
          typeof query.agreementId === 'string' ? query.agreementId : undefined,
        ) ?? [],
    };
  });

  app.get('/api/v2/reference-prices', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.finance?.listReferencePrices(
          typeof query.supplierModelId === 'string' ? query.supplierModelId : undefined,
        ) ?? [],
    };
  });

  app.get('/api/v2/cost-allocation-runs', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.finance?.listAllocationRuns(
          typeof query.agreementId === 'string' ? query.agreementId : undefined,
        ) ?? [],
    };
  });

  app.get('/api/v2/evaluations', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.finance?.listEvaluations({
          employeeId: typeof query.employeeId === 'string' ? query.employeeId : undefined,
          positionId: typeof query.positionId === 'string' ? query.positionId : undefined,
          limit: Math.min(1_000, Math.max(1, number(query.limit, 100))),
        }) ?? [],
    };
  });

  app.get<{ Params: { employeeId: string } }>(
    '/api/v2/employees/:employeeId/performance',
    async (request) => ({
      items: services.finance?.performanceByPosition(request.params.employeeId) ?? [],
    }),
  );

  app.get(
    '/api/v2/projections/office',
    async () =>
      services.officeProjection?.office() ?? {
        projectionVersion: 2,
        generatedAt: Date.now(),
        summary: {},
        positions: [],
        relations: [],
        activeRuns: [],
        activeDuties: [],
        activeRuntimeSessions: [],
        workforce: { employees: [], summary: {} },
      },
  );

  app.get('/api/v2/incidents', async (request) => {
    services.incidentProjection?.projectIncremental();
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.incidentProjection?.listIncidents({
          lifecycle: typeof query.lifecycle === 'string' ? query.lifecycle : undefined,
          runId: typeof query.runId === 'string' ? query.runId : undefined,
          positionId: typeof query.positionId === 'string' ? query.positionId : undefined,
          limit: Math.min(5_000, Math.max(1, number(query.limit, 200))),
        }) ?? [],
    };
  });

  app.get<{ Params: { incidentId: string } }>(
    '/api/v2/incidents/:incidentId',
    async (request, reply) => {
      services.incidentProjection?.projectIncremental();
      const incident = services.incidentProjection?.getIncident(request.params.incidentId);
      if (!incident) {
        reply.code(404);
        return { error: { code: 'INCIDENT_NOT_FOUND' } };
      }
      return incident;
    },
  );

  app.get('/api/v2/projection-checkpoints/incidents', async () => {
    services.incidentProjection?.projectIncremental();
    return { checkpoint: services.incidentProjection?.checkpoint() ?? null };
  });

  app.post('/api/v2/internal/projections/incidents/rebuild', async (_request, reply) => {
    if (!services.incidentProjection) {
      reply.code(503);
      return { error: { code: 'INCIDENT_PROJECTION_UNAVAILABLE' } };
    }
    return services.incidentProjection.rebuild();
  });

  app.post<{ Params: { incidentId: string } }>(
    '/api/v2/commands/incidents/:incidentId/acknowledge',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'incident.acknowledge',
        operation: () => {
          if (!services.incidentProjection) {
            reply.code(503);
            return { error: { code: 'INCIDENT_PROJECTION_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          try {
            return services.incidentProjection.acknowledge(
              request.params.incidentId,
              body.note == null ? undefined : String(body.note),
            );
          } catch (error) {
            const code = error instanceof Error ? error.message : 'INCIDENT_ACKNOWLEDGE_FAILED';
            reply.code(code === 'INCIDENT_NOT_FOUND' ? 404 : 422);
            return { error: { code } };
          }
        },
      }),
  );

  app.post<{ Params: { incidentId: string } }>(
    '/api/v2/commands/incidents/:incidentId/resolve',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'incident.resolve',
        operation: () => {
          if (!services.incidentProjection) {
            reply.code(503);
            return { error: { code: 'INCIDENT_PROJECTION_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          try {
            return services.incidentProjection.resolve(
              request.params.incidentId,
              body.note == null ? undefined : String(body.note),
            );
          } catch (error) {
            const code = error instanceof Error ? error.message : 'INCIDENT_RESOLVE_FAILED';
            reply.code(code === 'INCIDENT_NOT_FOUND' ? 404 : 422);
            return { error: { code } };
          }
        },
      }),
  );

  app.get('/api/v2/maintenance/policy', async () => ({
    policy: services.maintenance?.retentionPolicy() ?? null,
  }));
  app.get('/api/v2/maintenance-runs', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.maintenance?.listRuns(Math.min(1_000, Math.max(1, number(query.limit, 100)))) ??
        [],
    };
  });
  app.get('/api/v2/maintenance/status', async () => ({
    policy: services.maintenance?.retentionPolicy() ?? null,
    recentRuns: services.maintenance?.listRuns(20) ?? [],
  }));
  app.post('/api/v2/internal/maintenance/run', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'maintenance.run',
      operation: () => {
        if (!services.maintenance) {
          reply.code(503);
          return { error: { code: 'MAINTENANCE_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        return services.maintenance.run({
          dryRun: body.dryRun === true,
          at: body.at == null ? undefined : Number(body.at),
          staleSyncAfterMs:
            body.staleSyncAfterMs == null ? undefined : Number(body.staleSyncAfterMs),
        });
      },
    }),
  );

  app.get<{ Params: { positionId: string } }>(
    '/api/v2/projections/positions/:positionId/dossier',
    async (request, reply) => {
      const dossier = services.officeProjection?.positionDossier(request.params.positionId);
      if (!dossier) {
        reply.code(404);
        return { error: { code: 'POSITION_NOT_FOUND' } };
      }
      return dossier;
    },
  );

  app.get<{ Params: { runId: string } }>(
    '/api/v2/projections/runs/:runId/dossier',
    async (request, reply) => {
      const dossier = services.officeProjection?.runDossier(request.params.runId);
      if (!dossier) {
        reply.code(404);
        return { error: { code: 'RUN_NOT_FOUND' } };
      }
      return dossier;
    },
  );

  app.get('/api/v2/runtime-sessions', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.executionSync?.listRuntimeSessions({
          runId: typeof query.runId === 'string' ? query.runId : undefined,
          activeOnly: query.activeOnly === '1' || query.activeOnly === 'true',
          limit: Math.min(2_000, Math.max(1, number(query.limit, 500))),
        }) ?? [],
    };
  });

  app.get('/api/v2/runtime-edges', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.executionSync?.listRuntimeEdges(
          typeof query.runId === 'string' ? query.runId : undefined,
          Math.min(5_000, Math.max(1, number(query.limit, 1_000))),
        ) ?? [],
    };
  });

  app.get('/api/v2/activity-events', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.executionSync?.listActivityEvents(
          typeof query.runId === 'string' ? query.runId : undefined,
          Math.min(5_000, Math.max(1, number(query.limit, 500))),
        ) ?? [],
    };
  });

  app.get('/api/v2/execution-sync-runs', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.executionSync?.listSyncRuns(
          Math.min(1_000, Math.max(1, number(query.limit, 100))),
        ) ?? [],
    };
  });

  app.get('/api/v2/roles', async () => ({
    items: services.organization?.listRoles() ?? [],
  }));

  app.get('/api/v2/position-templates', async () => ({
    items: services.organization?.listPositionTemplates() ?? [],
  }));

  app.get('/api/v2/position-relations', async () => ({
    items: services.organization?.listPositionRelations() ?? [],
  }));

  app.get(
    '/api/v2/projections/organization',
    async () =>
      services.organization?.topology() ?? {
        roles: [],
        templates: [],
        positions: [],
        relations: [],
      },
  );

  app.get('/api/v2/capabilities', async () => ({
    items: services.staffing?.listCapabilityDefinitions() ?? [],
  }));

  app.get('/api/v2/capability-claims', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.staffing?.listCapabilityClaims({
          subjectType: typeof query.subjectType === 'string' ? query.subjectType : undefined,
          subjectId: typeof query.subjectId === 'string' ? query.subjectId : undefined,
        }) ?? [],
    };
  });

  app.get('/api/v2/requirement-sets', async () => ({
    items: services.staffing?.listRequirementSets() ?? [],
  }));

  app.get('/api/v2/qualification-assessments', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items:
        services.staffing?.listQualificationAssessments({
          employeeId: typeof query.employeeId === 'string' ? query.employeeId : undefined,
          positionId: typeof query.positionId === 'string' ? query.positionId : undefined,
          limit: Math.min(1_000, Math.max(1, number(query.limit, 100))),
        }) ?? [],
    };
  });

  app.get('/api/v2/staffing-rules', async () => ({
    items: services.staffing?.listStaffingRules() ?? [],
  }));

  app.get('/api/v2/staffing-constraints', async () => ({
    items: services.staffing?.listStaffingConstraints() ?? [],
  }));

  app.get('/api/v2/usage-evidence', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items: repository.listGatewayUsageEvidence({
        gatewaySlug: typeof query.gatewayId === 'string' ? query.gatewayId : undefined,
        kind: typeof query.kind === 'string' ? query.kind : undefined,
        limit: Math.min(1_000, Math.max(1, number(query.limit, 200))),
      }),
    };
  });

  app.get('/api/v2/usage-reconciliation-runs', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items: repository.listUsageReconciliationRuns(
        typeof query.gatewayId === 'string' ? query.gatewayId : undefined,
        Math.min(500, Math.max(1, number(query.limit, 50))),
      ),
    };
  });

  app.get('/api/v2/runs', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const limit = Math.min(500, Math.max(1, number(query.limit, 100)));
    return { items: repository.listRuns(limit) };
  });
  app.get('/api/v2/duties', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items: repository.listDuties({
        runId: typeof query.runId === 'string' ? query.runId : undefined,
        activeOnly: query.activeOnly === '1' || query.activeOnly === 'true',
      }),
    };
  });
  app.get('/api/v2/invocations', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items: repository.listInvocations({
        dutySessionId: typeof query.dutySessionId === 'string' ? query.dutySessionId : undefined,
        runId: typeof query.runId === 'string' ? query.runId : undefined,
      }),
    };
  });
  app.get('/api/v2/usage', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items: repository.listUsage({
        employeeId: typeof query.employeeId === 'string' ? query.employeeId : undefined,
        dutySessionId: typeof query.dutySessionId === 'string' ? query.dutySessionId : undefined,
        runId: typeof query.runId === 'string' ? query.runId : undefined,
      }),
    };
  });

  app.get('/api/v2/dispatch-decisions', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return {
      items: repository.listDispatchDecisions(
        typeof query.dutySessionId === 'string' ? query.dutySessionId : undefined,
      ),
    };
  });

  app.post('/api/v2/commands/runs/create', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'run.create',
      operation: () => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.workScopeId || !body.title) {
          reply.code(400);
          return { error: { code: 'WORK_SCOPE_AND_TITLE_REQUIRED' } };
        }
        try {
          return repository.createRun({
            workScopeId: String(body.workScopeId),
            title: String(body.title),
            externalRunRef: body.externalRunRef ? String(body.externalRunRef) : undefined,
            metadata:
              body.metadata && typeof body.metadata === 'object'
                ? (body.metadata as Record<string, unknown>)
                : undefined,
          });
        } catch (error) {
          reply.code(422);
          return {
            error: { code: error instanceof Error ? error.message : 'RUN_CREATE_FAILED' },
          };
        }
      },
    }),
  );

  app.post('/api/v2/commands/duties/open', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'duty.open',
      operation: () => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.runId || !body.positionId) {
          reply.code(400);
          return { error: { code: 'RUN_AND_POSITION_REQUIRED' } };
        }
        try {
          return repository.openDuty({
            runId: String(body.runId),
            positionId: String(body.positionId),
            activity: body.activity ? String(body.activity) : undefined,
            metadata:
              body.metadata && typeof body.metadata === 'object'
                ? (body.metadata as Record<string, unknown>)
                : undefined,
          });
        } catch (error) {
          reply.code(422);
          return {
            error: { code: error instanceof Error ? error.message : 'DUTY_OPEN_FAILED' },
          };
        }
      },
    }),
  );

  app.post<{ Params: { dutySessionId: string } }>(
    '/api/v2/commands/duties/:dutySessionId/dispatch',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'duty.dispatch',
        operation: async () => {
          if (!services.dispatchService) {
            reply.code(503);
            return { error: { code: 'DISPATCH_SERVICE_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          try {
            const result = await services.dispatchService.dispatchDuty(
              request.params.dutySessionId,
              {
                trigger: body.trigger ? String(body.trigger) : undefined,
                correlationId: body.correlationId ? String(body.correlationId) : undefined,
              },
            );
            if (!result.selected) reply.code(422);
            return result;
          } catch (error) {
            const code = error instanceof Error ? error.message : 'DISPATCH_FAILED';
            reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
            return { error: { code } };
          }
        },
      }),
  );

  app.post('/api/v2/internal/hermes/sync', async (request, reply) => {
    if (!services.executionSync) {
      reply.code(503);
      return { error: { code: 'EXECUTION_SYNC_SERVICE_UNAVAILABLE' } };
    }
    const body = (request.body ?? {}) as Partial<HermesOrgSnapshotInput>;
    if (
      !Array.isArray(body.profiles) ||
      !Array.isArray(body.runs) ||
      !Array.isArray(body.nodes) ||
      !Array.isArray(body.edges)
    ) {
      reply.code(400);
      return { error: { code: 'HERMES_ORG_SNAPSHOT_REQUIRED' } };
    }
    try {
      return await services.executionSync.sync(body as HermesOrgSnapshotInput);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'HERMES_EXECUTION_SYNC_FAILED';
      reply.code(422);
      return { error: { code } };
    }
  });

  app.post('/api/v2/commands/roles/create', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'role.create',
      operation: () => {
        if (!services.organization) {
          reply.code(503);
          return { error: { code: 'ORGANIZATION_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.slug || !body.name) {
          reply.code(400);
          return { error: { code: 'ROLE_FIELDS_REQUIRED' } };
        }
        try {
          return services.organization.createRole({
            slug: String(body.slug),
            name: String(body.name),
            purpose: body.purpose ? String(body.purpose) : undefined,
            defaultRequirementSetId: body.defaultRequirementSetId
              ? String(body.defaultRequirementSetId)
              : undefined,
            metadata:
              body.metadata && typeof body.metadata === 'object'
                ? (body.metadata as Record<string, unknown>)
                : undefined,
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : 'ROLE_CREATE_FAILED';
          reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
          return { error: { code } };
        }
      },
    }),
  );

  app.post('/api/v2/commands/positions/create', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'position.create',
      operation: () => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.workScopeId || !body.slug || !body.name || !body.kind) {
          reply.code(400);
          return { error: { code: 'POSITION_FIELDS_REQUIRED' } };
        }
        const scope = repository.db
          .prepare('SELECT id FROM v2_work_scopes WHERE id=?')
          .get(String(body.workScopeId));
        if (!scope) {
          reply.code(404);
          return { error: { code: 'WORK_SCOPE_NOT_FOUND' } };
        }
        return repository.getOrCreatePosition({
          workScopeId: String(body.workScopeId),
          slug: String(body.slug),
          name: String(body.name),
          kind: String(body.kind),
          runtimeKind: body.runtimeKind ? String(body.runtimeKind) : undefined,
        });
      },
    }),
  );

  app.post('/api/v2/commands/appointments/create', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'appointment.create',
      operation: () => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.employeeId || !body.positionId) {
          reply.code(400);
          return { error: { code: 'APPOINTMENT_FIELDS_REQUIRED' } };
        }
        const appointmentClass = String(body.appointmentClass ?? 'PRIMARY').toUpperCase();
        if (!['PRIMARY', 'BACKUP', 'RESERVE'].includes(appointmentClass)) {
          reply.code(400);
          return { error: { code: 'APPOINTMENT_CLASS_INVALID' } };
        }
        if (!repository.listEmployees().some((item) => item.id === String(body.employeeId))) {
          reply.code(404);
          return { error: { code: 'EMPLOYEE_NOT_FOUND' } };
        }
        if (!repository.listPositions().some((item) => item.id === String(body.positionId))) {
          reply.code(404);
          return { error: { code: 'POSITION_NOT_FOUND' } };
        }
        return repository.getOrCreateCurrentAppointment({
          employeeId: String(body.employeeId),
          positionId: String(body.positionId),
          appointmentClass: appointmentClass as 'PRIMARY' | 'BACKUP' | 'RESERVE',
          priority: body.priority == null ? undefined : Number(body.priority),
        });
      },
    }),
  );

  app.post('/api/v2/commands/position-templates/create', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'position-template.create',
      operation: () => {
        if (!services.organization) {
          reply.code(503);
          return { error: { code: 'ORGANIZATION_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.slug || !body.name || !body.roleId || !body.lifecyclePolicy) {
          reply.code(400);
          return { error: { code: 'POSITION_TEMPLATE_FIELDS_REQUIRED' } };
        }
        try {
          return services.organization.createPositionTemplate({
            slug: String(body.slug),
            name: String(body.name),
            roleId: String(body.roleId),
            runtimePolicy:
              body.runtimePolicy && typeof body.runtimePolicy === 'object'
                ? (body.runtimePolicy as Record<string, unknown>)
                : undefined,
            defaultRequirementSetId: body.defaultRequirementSetId
              ? String(body.defaultRequirementSetId)
              : undefined,
            lifecyclePolicy: String(body.lifecyclePolicy) as 'STANDING' | 'RUN_SCOPED',
            defaultRelations: Array.isArray(body.defaultRelations)
              ? (body.defaultRelations as Record<string, unknown>[])
              : undefined,
            defaultConstraints: Array.isArray(body.defaultConstraints)
              ? (body.defaultConstraints as Record<string, unknown>[])
              : undefined,
            metadata:
              body.metadata && typeof body.metadata === 'object'
                ? (body.metadata as Record<string, unknown>)
                : undefined,
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : 'POSITION_TEMPLATE_CREATE_FAILED';
          reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
          return { error: { code } };
        }
      },
    }),
  );

  app.post('/api/v2/commands/positions/instantiate', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'position.instantiate',
      operation: () => {
        if (!services.organization) {
          reply.code(503);
          return { error: { code: 'ORGANIZATION_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.templateId || !body.workScopeId) {
          reply.code(400);
          return { error: { code: 'POSITION_INSTANTIATE_FIELDS_REQUIRED' } };
        }
        try {
          return services.organization.instantiatePosition({
            templateId: String(body.templateId),
            workScopeId: String(body.workScopeId),
            name: body.name ? String(body.name) : undefined,
            slug: body.slug ? String(body.slug) : undefined,
            originRunId: body.originRunId ? String(body.originRunId) : undefined,
            metadata:
              body.metadata && typeof body.metadata === 'object'
                ? (body.metadata as Record<string, unknown>)
                : undefined,
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : 'POSITION_INSTANTIATE_FAILED';
          reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
          return { error: { code } };
        }
      },
    }),
  );

  app.post('/api/v2/commands/position-relations/create', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'position-relation.create',
      operation: () => {
        if (!services.organization) {
          reply.code(503);
          return { error: { code: 'ORGANIZATION_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.fromPositionId || !body.toPositionId || !body.relationType) {
          reply.code(400);
          return { error: { code: 'POSITION_RELATION_FIELDS_REQUIRED' } };
        }
        try {
          return services.organization.createPositionRelation({
            fromPositionId: String(body.fromPositionId),
            toPositionId: String(body.toPositionId),
            relationType: String(body.relationType) as
              'SUPERVISES' | 'DELEGATES_TO' | 'REVIEWS' | 'DEPENDS_ON' | 'ESCALATES_TO',
            source: body.source
              ? (String(body.source) as 'MANUAL' | 'TEMPLATE' | 'POLICY' | 'MIGRATION')
              : undefined,
            effectiveFrom: body.effectiveFrom == null ? undefined : Number(body.effectiveFrom),
            effectiveTo: body.effectiveTo == null ? undefined : Number(body.effectiveTo),
            metadata:
              body.metadata && typeof body.metadata === 'object'
                ? (body.metadata as Record<string, unknown>)
                : undefined,
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : 'POSITION_RELATION_CREATE_FAILED';
          reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
          return { error: { code } };
        }
      },
    }),
  );

  app.post('/api/v2/commands/capabilities/create', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'capability.create',
      operation: () => {
        if (!services.staffing) {
          reply.code(503);
          return { error: { code: 'STAFFING_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.slug || !body.name || !body.valueType) {
          reply.code(400);
          return { error: { code: 'CAPABILITY_FIELDS_REQUIRED' } };
        }
        try {
          return services.staffing.createCapabilityDefinition({
            slug: String(body.slug),
            name: String(body.name),
            valueType: String(body.valueType) as 'NUMERIC' | 'BOOLEAN' | 'TEXT',
            unit: body.unit ? String(body.unit) : undefined,
            metadata:
              body.metadata && typeof body.metadata === 'object'
                ? (body.metadata as Record<string, unknown>)
                : undefined,
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : 'CAPABILITY_CREATE_FAILED';
          reply.code(422);
          return { error: { code } };
        }
      },
    }),
  );

  app.post('/api/v2/commands/capability-claims/add', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'capability-claim.add',
      operation: () => {
        if (!services.staffing) {
          reply.code(503);
          return { error: { code: 'STAFFING_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (
          !body.subjectType ||
          !body.subjectId ||
          !body.capabilityId ||
          body.value === undefined ||
          !body.source
        ) {
          reply.code(400);
          return { error: { code: 'CAPABILITY_CLAIM_FIELDS_REQUIRED' } };
        }
        try {
          return services.staffing.addCapabilityClaim({
            subjectType: String(body.subjectType) as
              'SUPPLIER' | 'SUPPLIER_MODEL' | 'EMPLOYEE' | 'MODEL_OFFERING' | 'EMPLOYMENT',
            subjectId: String(body.subjectId),
            capabilityId: String(body.capabilityId),
            value: body.value as number | boolean | string,
            source: String(body.source) as
              'DECLARED' | 'MEASURED' | 'MANUAL' | 'INFERRED' | 'IMPORTED',
            confidence: body.confidence == null ? undefined : Number(body.confidence),
            observedAt: body.observedAt == null ? undefined : Number(body.observedAt),
            expiresAt: body.expiresAt == null ? undefined : Number(body.expiresAt),
            evidence:
              body.evidence && typeof body.evidence === 'object'
                ? (body.evidence as Record<string, unknown>)
                : undefined,
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : 'CAPABILITY_CLAIM_FAILED';
          reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
          return { error: { code } };
        }
      },
    }),
  );

  app.post('/api/v2/commands/requirement-sets/create', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'requirement-set.create',
      operation: () => {
        if (!services.staffing) {
          reply.code(503);
          return { error: { code: 'STAFFING_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.name || !Array.isArray(body.requirements)) {
          reply.code(400);
          return { error: { code: 'REQUIREMENT_SET_FIELDS_REQUIRED' } };
        }
        try {
          return services.staffing.createRequirementSet({
            name: String(body.name),
            requirements: body.requirements as Requirement[],
            version: body.version == null ? undefined : Number(body.version),
            metadata:
              body.metadata && typeof body.metadata === 'object'
                ? (body.metadata as Record<string, unknown>)
                : undefined,
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : 'REQUIREMENT_SET_CREATE_FAILED';
          reply.code(422);
          return { error: { code } };
        }
      },
    }),
  );

  app.post<{ Params: { positionId: string } }>(
    '/api/v2/commands/positions/:positionId/set-requirements',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'position.set-requirements',
        operation: () => {
          if (!services.staffing) {
            reply.code(503);
            return { error: { code: 'STAFFING_SERVICE_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          try {
            return services.staffing.assignRequirementSet(
              request.params.positionId,
              body.requirementSetId === null
                ? null
                : body.requirementSetId
                  ? String(body.requirementSetId)
                  : null,
            );
          } catch (error) {
            const code = error instanceof Error ? error.message : 'POSITION_REQUIREMENTS_FAILED';
            reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
            return { error: { code } };
          }
        },
      }),
  );

  app.post('/api/v2/commands/qualifications/assess', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'qualification.assess',
      operation: () => {
        if (!services.staffing) {
          reply.code(503);
          return { error: { code: 'STAFFING_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.employeeId || !body.positionId) {
          reply.code(400);
          return { error: { code: 'EMPLOYEE_AND_POSITION_REQUIRED' } };
        }
        try {
          return services.staffing.assessQualification(
            String(body.employeeId),
            String(body.positionId),
          );
        } catch (error) {
          const code = error instanceof Error ? error.message : 'QUALIFICATION_ASSESSMENT_FAILED';
          reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
          return { error: { code } };
        }
      },
    }),
  );

  app.post('/api/v2/commands/staffing-rules/create', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'staffing-rule.create',
      operation: () => {
        if (!services.staffing) {
          reply.code(503);
          return { error: { code: 'STAFFING_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.name) {
          reply.code(400);
          return { error: { code: 'STAFFING_RULE_NAME_REQUIRED' } };
        }
        return services.staffing.createStaffingRule({
          name: String(body.name),
          employeeSelector:
            body.employeeSelector && typeof body.employeeSelector === 'object'
              ? (body.employeeSelector as Record<string, unknown>)
              : undefined,
          positionSelector:
            body.positionSelector && typeof body.positionSelector === 'object'
              ? (body.positionSelector as Record<string, unknown>)
              : undefined,
          appointmentClass: body.appointmentClass
            ? (String(body.appointmentClass) as 'PRIMARY' | 'BACKUP' | 'RESERVE')
            : undefined,
          priority: body.priority == null ? undefined : Number(body.priority),
          effectiveFrom: body.effectiveFrom == null ? undefined : Number(body.effectiveFrom),
          effectiveTo: body.effectiveTo == null ? undefined : Number(body.effectiveTo),
          provenance:
            body.provenance && typeof body.provenance === 'object'
              ? (body.provenance as Record<string, unknown>)
              : undefined,
        });
      },
    }),
  );

  app.post<{ Params: { ruleId: string } }>(
    '/api/v2/commands/staffing-rules/:ruleId/materialize',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'staffing-rule.materialize',
        operation: () => {
          if (!services.staffing) {
            reply.code(503);
            return { error: { code: 'STAFFING_SERVICE_UNAVAILABLE' } };
          }
          try {
            return services.staffing.materializeStaffingRule(request.params.ruleId);
          } catch (error) {
            const code =
              error instanceof Error ? error.message : 'STAFFING_RULE_MATERIALIZE_FAILED';
            reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
            return { error: { code } };
          }
        },
      }),
  );

  app.post('/api/v2/commands/staffing-constraints/create', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'staffing-constraint.create',
      operation: () => {
        if (!services.staffing) {
          reply.code(503);
          return { error: { code: 'STAFFING_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.name || !body.scopeType || !body.constraintType || !body.expression) {
          reply.code(400);
          return { error: { code: 'STAFFING_CONSTRAINT_FIELDS_REQUIRED' } };
        }
        try {
          return services.staffing.createStaffingConstraint({
            name: String(body.name),
            scopeType: String(body.scopeType) as 'GLOBAL' | 'WORK_SCOPE' | 'POSITION',
            scopeId: body.scopeId ? String(body.scopeId) : undefined,
            constraintType: String(body.constraintType) as
              'MAX_CONCURRENT_DUTIES' | 'SEPARATION_OF_DUTIES',
            strength: body.strength ? (String(body.strength) as 'HARD' | 'SOFT') : undefined,
            expression: body.expression as Record<string, unknown>,
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : 'STAFFING_CONSTRAINT_CREATE_FAILED';
          reply.code(422);
          return { error: { code } };
        }
      },
    }),
  );

  app.post('/api/v2/commands/runtime-launch/resolve', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'runtime-launch.resolve',
      operation: () => {
        if (!services.runtimePolicy) {
          reply.code(503);
          return { error: { code: 'RUNTIME_POLICY_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        const runtimeKind = String(body.runtimeKind ?? '').toUpperCase();
        const policyMode = String(body.policyMode ?? 'PREFER').toUpperCase();
        if (!['OPENCODE', 'CODEX'].includes(runtimeKind)) {
          reply.code(400);
          return { error: { code: 'RUNTIME_KIND_INVALID' } };
        }
        if (!['OBSERVE', 'PREFER', 'ENFORCE'].includes(policyMode)) {
          reply.code(400);
          return { error: { code: 'RUNTIME_POLICY_MODE_INVALID' } };
        }
        return services.runtimePolicy.resolve({
          runtimeKind: runtimeKind as RuntimeKind,
          policyMode: policyMode as RuntimePolicyMode,
          positionSlug: body.positionSlug ? String(body.positionSlug) : undefined,
          workScopeSlug: body.workScopeSlug ? String(body.workScopeSlug) : undefined,
          sessionId: body.sessionId ? String(body.sessionId) : undefined,
          taskId: body.taskId ? String(body.taskId) : undefined,
          toolCallId: body.toolCallId ? String(body.toolCallId) : undefined,
          workdir: body.workdir ? String(body.workdir) : undefined,
          commandName: body.commandName ? String(body.commandName) : undefined,
          requestedModel: body.requestedModel ? String(body.requestedModel) : undefined,
          metadata:
            body.metadata && typeof body.metadata === 'object'
              ? (body.metadata as Record<string, unknown>)
              : undefined,
        });
      },
    }),
  );

  app.post('/api/v2/commands/execution/resolve', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'execution.resolve',
      operation: () => {
        if (!services.executionPolicy) {
          reply.code(503);
          return { error: { code: 'EXECUTION_POLICY_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        const intent = String(body.intent ?? '').toUpperCase();
        if (
          !['PLAN', 'REVIEW', 'IMPLEMENT', 'DEBUG', 'TEST', 'RESEARCH', 'QUICK_FIX'].includes(
            intent,
          )
        ) {
          reply.code(400);
          return { error: { code: 'EXECUTION_INTENT_INVALID' } };
        }
        const runtimeKinds = new Set(['CLAUDE_CODE', 'CODEX', 'DSH', 'ZCODE', 'OPENCODE']);
        const availableRuntimes = Array.isArray(body.availableRuntimes)
          ? body.availableRuntimes
              .filter(
                (item): item is Record<string, unknown> =>
                  Boolean(item) && typeof item === 'object' && !Array.isArray(item),
              )
              .map((item) => ({
                kind: String(item.kind ?? '').toUpperCase() as ExecutionHarness,
                path: item.path == null ? undefined : String(item.path),
                mode: item.mode == null ? undefined : String(item.mode),
              }))
              .filter((item) => runtimeKinds.has(item.kind))
          : undefined;
        try {
          return services.executionPolicy.resolve({
            intent: intent as ExecutionIntent,
            requestedModel: body.requestedModel ? String(body.requestedModel) : undefined,
            availableRuntimes,
            availableProviderConnectionIds: Array.isArray(body.availableProviderConnectionIds)
              ? body.availableProviderConnectionIds.map(String)
              : undefined,
            at: body.at == null ? undefined : Number(body.at),
            timezone: body.timezone ? String(body.timezone) : undefined,
            metadata:
              body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
                ? (body.metadata as Record<string, unknown>)
                : undefined,
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : 'EXECUTION_RESOLVE_FAILED';
          reply.code(code.endsWith('_INVALID') ? 400 : 422);
          return { error: { code } };
        }
      },
    }),
  );

  app.post('/api/v2/commands/workforce-sources/upsert', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'workforce-source.upsert',
      operation: () => {
        if (!services.supply) {
          reply.code(503);
          return { error: { code: 'SUPPLY_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        const sourceKind = String(body.sourceKind ?? 'EXTERNAL').toUpperCase();
        if (!body.slug || !body.name || !['EXTERNAL', 'INTERNAL'].includes(sourceKind)) {
          reply.code(400);
          return { error: { code: 'WORKFORCE_SOURCE_IDENTITY_REQUIRED' } };
        }
        return services.supply.upsertSource({
          slug: String(body.slug),
          name: String(body.name),
          websiteUrl: body.websiteUrl == null ? undefined : String(body.websiteUrl),
          sourceKind: sourceKind as 'EXTERNAL' | 'INTERNAL',
        });
      },
    }),
  );

  app.post<{ Params: { supplierId: string } }>(
    '/api/v2/commands/suppliers/:supplierId/profile',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'supplier.profile.update',
        operation: () => {
          if (!services.supply) {
            reply.code(503);
            return { error: { code: 'SUPPLY_SERVICE_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          if (!body.name || !String(body.name).trim()) {
            reply.code(400);
            return { error: { code: 'SUPPLIER_NAME_REQUIRED' } };
          }
          try {
            return services.supply.updateSupplierProfile(request.params.supplierId, {
              name: String(body.name),
              websiteUrl: body.websiteUrl == null ? undefined : String(body.websiteUrl),
            });
          } catch (error) {
            const code = error instanceof Error ? error.message : 'SUPPLIER_PROFILE_UPDATE_FAILED';
            reply.code(code === 'SUPPLIER_NOT_FOUND' ? 404 : 422);
            return { error: { code } };
          }
        },
      }),
  );

  app.post<{ Params: { supplierId: string } }>(
    '/api/v2/commands/suppliers/:supplierId/retire',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'supplier.retire',
        operation: async () => {
          if (!services.supply) {
            reply.code(503);
            return { error: { code: 'SUPPLY_SERVICE_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          try {
            const force = body.force === true;
            if (force) {
              if (!services.lifecycleService) {
                reply.code(503);
                return { error: { code: 'LIFECYCLE_SERVICE_UNAVAILABLE' } };
              }
              const relationships = services.supply.openRelationshipsForSupplier(
                request.params.supplierId,
              );
              for (const appointmentId of relationships.appointmentIds) {
                await services.lifecycleService.endAppointment(appointmentId, {
                  reason: body.reason ? String(body.reason) : 'SUPPLIER_RETIRED',
                });
              }
              for (const employmentId of relationships.employmentIds) {
                await services.lifecycleService.endEmployment(employmentId, {
                  reason: body.reason ? String(body.reason) : 'SUPPLIER_RETIRED',
                });
              }
            }
            return services.supply.retireSupplier(
              request.params.supplierId,
              body.reason ? String(body.reason) : 'OPERATOR_RETIRED',
            );
          } catch (error) {
            const code = error instanceof Error ? error.message : 'SUPPLIER_RETIRE_FAILED';
            reply.code(
              code === 'SUPPLIER_NOT_FOUND'
                ? 404
                : code === 'SUPPLIER_HAS_OPEN_RELATIONSHIPS'
                  ? 409
                  : 422,
            );
            return { error: { code } };
          }
        },
      }),
  );

  app.post<{ Params: { supplierId: string } }>(
    '/api/v2/commands/suppliers/:supplierId/staffing-preferences',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'supplier.staffing-preferences.set',
        operation: () => {
          if (!services.supply) {
            reply.code(503);
            return { error: { code: 'SUPPLY_SERVICE_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          if (!Array.isArray(body.enabledEmployeeIds)) {
            reply.code(400);
            return { error: { code: 'ENABLED_EMPLOYEE_IDS_REQUIRED' } };
          }
          try {
            return services.supply.setStaffingPreferences(request.params.supplierId, {
              enabledEmployeeIds: body.enabledEmployeeIds.map(String),
              defaultEmployeeId:
                body.defaultEmployeeId == null ? null : String(body.defaultEmployeeId),
            });
          } catch (error) {
            const code =
              error instanceof Error ? error.message : 'SUPPLIER_STAFFING_PREFERENCES_FAILED';
            reply.code(code === 'SUPPLIER_NOT_FOUND' ? 404 : 422);
            return { error: { code } };
          }
        },
      }),
  );

  app.post('/api/v2/commands/supply-catalog/register', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'supply-catalog.register',
      operation: () => {
        if (!services.supply) {
          reply.code(503);
          return { error: { code: 'SUPPLY_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        const supplier = body.supplier as Record<string, unknown> | undefined;
        const supplierModel = body.supplierModel as Record<string, unknown> | undefined;
        const agreement = body.agreement as Record<string, unknown> | undefined;
        const plan = body.plan as Record<string, unknown> | undefined;
        const gatewayRoute = body.gatewayRoute as Record<string, unknown> | undefined;
        const runtimeSelectors = body.runtimeSelectors as Record<string, unknown> | undefined;
        if (
          !supplier?.slug ||
          !supplier.name ||
          !supplierModel?.key ||
          !supplierModel.name ||
          !agreement?.externalAccountRef ||
          !agreement.name
        ) {
          reply.code(400);
          return { error: { code: 'SUPPLY_CATALOG_IDENTITY_REQUIRED' } };
        }
        if (
          plan &&
          (!plan.slug ||
            !plan.name ||
            (plan.commercialType != null &&
              !['FREE', 'SUBSCRIPTION', 'PREPAID', 'METERED', 'SPONSORED', 'OTHER'].includes(
                String(plan.commercialType),
              )))
        ) {
          reply.code(400);
          return { error: { code: 'SUPPLY_CATALOG_PLAN_INVALID' } };
        }
        if (gatewayRoute && (!gatewayRoute.gatewaySlug || !gatewayRoute.externalRouteRef)) {
          reply.code(400);
          return { error: { code: 'SUPPLY_CATALOG_GATEWAY_ROUTE_INVALID' } };
        }
        try {
          return services.supply.registerCatalogEntry({
            supplier: {
              slug: String(supplier.slug),
              name: String(supplier.name),
              websiteUrl: supplier.websiteUrl == null ? undefined : String(supplier.websiteUrl),
              sourceKind:
                supplier.sourceKind == null
                  ? undefined
                  : (String(supplier.sourceKind).toUpperCase() as 'EXTERNAL' | 'INTERNAL'),
            },
            supplierModel: { key: String(supplierModel.key), name: String(supplierModel.name) },
            agreement: {
              externalAccountRef: String(agreement.externalAccountRef),
              name: String(agreement.name),
            },
            plan: plan
              ? {
                  slug: String(plan.slug),
                  name: String(plan.name),
                  commercialType: plan.commercialType
                    ? (String(plan.commercialType) as
                        'FREE' | 'SUBSCRIPTION' | 'PREPAID' | 'METERED' | 'SPONSORED' | 'OTHER')
                    : undefined,
                }
              : undefined,
            runtimeSelectors:
              runtimeSelectors && typeof runtimeSelectors === 'object'
                ? runtimeSelectors
                : undefined,
            gatewayRoute: gatewayRoute
              ? {
                  gatewaySlug: String(gatewayRoute.gatewaySlug),
                  externalRouteRef: String(gatewayRoute.externalRouteRef),
                  activateBinding: gatewayRoute.activateBinding === true,
                }
              : undefined,
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : 'SUPPLY_CATALOG_REGISTER_FAILED';
          reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
          return { error: { code } };
        }
      },
    }),
  );

  app.post('/api/v2/commands/plans/create', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'plan.create',
      operation: () => {
        if (!services.supply) {
          reply.code(503);
          return { error: { code: 'SUPPLY_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.supplierId || !body.slug || !body.name) {
          reply.code(400);
          return { error: { code: 'SUPPLIER_SLUG_AND_NAME_REQUIRED' } };
        }
        return services.supply.getOrCreatePlan({
          supplierId: String(body.supplierId),
          slug: String(body.slug),
          name: String(body.name),
          commercialType: body.commercialType
            ? (String(body.commercialType) as
                'FREE' | 'SUBSCRIPTION' | 'PREPAID' | 'METERED' | 'SPONSORED' | 'OTHER')
            : undefined,
          terms:
            body.terms && typeof body.terms === 'object'
              ? (body.terms as Record<string, unknown>)
              : undefined,
        });
      },
    }),
  );

  app.post<{ Params: { offeringId: string } }>(
    '/api/v2/commands/model-offerings/:offeringId/runtime-selectors',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'model-offering.runtime-selectors',
        operation: () => {
          if (!services.supply) {
            reply.code(503);
            return { error: { code: 'SUPPLY_SERVICE_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          if (!body.runtimeSelectors || typeof body.runtimeSelectors !== 'object') {
            reply.code(400);
            return { error: { code: 'RUNTIME_SELECTOR_REQUIRED' } };
          }
          try {
            return services.supply.setRuntimeSelectors(
              request.params.offeringId,
              body.runtimeSelectors as Record<string, unknown>,
            );
          } catch (error) {
            const code = error instanceof Error ? error.message : 'RUNTIME_SELECTOR_UPDATE_FAILED';
            reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
            return { error: { code } };
          }
        },
      }),
  );

  app.post('/api/v2/commands/model-offerings/create', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'model-offering.create',
      operation: () => {
        if (!services.supply) {
          reply.code(503);
          return { error: { code: 'SUPPLY_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.supplierId || !body.supplierModelId) {
          reply.code(400);
          return { error: { code: 'SUPPLIER_AND_MODEL_REQUIRED' } };
        }
        return services.supply.getOrCreateModelOffering({
          supplierId: String(body.supplierId),
          supplierModelId: String(body.supplierModelId),
          planId: body.planId ? String(body.planId) : undefined,
          supplyAgreementId: body.supplyAgreementId ? String(body.supplyAgreementId) : undefined,
          advertisedCapabilities: Array.isArray(body.advertisedCapabilities)
            ? body.advertisedCapabilities.map(String)
            : undefined,
          protocolOptions: Array.isArray(body.protocolOptions)
            ? body.protocolOptions.map(String)
            : undefined,
          commercialMetadata:
            body.commercialMetadata && typeof body.commercialMetadata === 'object'
              ? (body.commercialMetadata as Record<string, unknown>)
              : undefined,
        });
      },
    }),
  );

  app.post('/api/v2/commands/capacity-pools/upsert', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'capacity-pool.upsert',
      operation: () => {
        if (!services.supply) {
          reply.code(503);
          return { error: { code: 'SUPPLY_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.supplyAgreementId || !body.name || !body.dimension || !body.source) {
          reply.code(400);
          return { error: { code: 'CAPACITY_POOL_FIELDS_REQUIRED' } };
        }
        return services.supply.upsertCapacityPool({
          supplyAgreementId: String(body.supplyAgreementId),
          name: String(body.name),
          dimension: String(body.dimension) as
            'TOKENS' | 'REQUESTS' | 'COST' | 'CONCURRENCY' | 'CUSTOM',
          limit: body.limit == null ? undefined : Number(body.limit),
          remaining: body.remaining == null ? undefined : Number(body.remaining),
          unit: body.unit ? String(body.unit) : undefined,
          resetAt: body.resetAt == null ? undefined : Number(body.resetAt),
          lifecycle: body.lifecycle
            ? (String(body.lifecycle) as 'ACTIVE' | 'SUSPENDED' | 'RETIRED')
            : undefined,
          source: String(body.source),
          metadata:
            body.metadata && typeof body.metadata === 'object'
              ? (body.metadata as Record<string, unknown>)
              : undefined,
          observedAt: body.observedAt == null ? undefined : Number(body.observedAt),
        });
      },
    }),
  );

  app.post<{ Params: { agreementId: string } }>(
    '/api/v2/commands/supply-agreements/:agreementId/set-plan',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'supply-agreement.set-plan',
        operation: () => {
          if (!services.supply) {
            reply.code(503);
            return { error: { code: 'SUPPLY_SERVICE_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          if (!body.planId) {
            reply.code(400);
            return { error: { code: 'PLAN_REQUIRED' } };
          }
          try {
            return services.supply.assignPlanToAgreement(
              request.params.agreementId,
              String(body.planId),
            );
          } catch (error) {
            const code = error instanceof Error ? error.message : 'PLAN_ASSIGNMENT_FAILED';
            reply.code(code.endsWith('_NOT_FOUND') ? 404 : 409);
            return { error: { code } };
          }
        },
      }),
  );

  app.post<{ Params: { employmentId: string } }>(
    '/api/v2/commands/employments/:employmentId/set-offering',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'employment.set-offering',
        operation: () => {
          if (!services.supply) {
            reply.code(503);
            return { error: { code: 'SUPPLY_SERVICE_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          if (!body.offeringId) {
            reply.code(400);
            return { error: { code: 'OFFERING_REQUIRED' } };
          }
          try {
            return services.supply.assignOfferingToEmployment(
              request.params.employmentId,
              String(body.offeringId),
            );
          } catch (error) {
            const code = error instanceof Error ? error.message : 'OFFERING_ASSIGNMENT_FAILED';
            reply.code(code.endsWith('_NOT_FOUND') ? 404 : 409);
            return { error: { code } };
          }
        },
      }),
  );

  app.post('/api/v2/commands/reference-prices/create', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'reference-price.create',
      operation: () => {
        if (!services.finance) {
          reply.code(503);
          return { error: { code: 'FINANCE_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!body.supplierModelId || !body.name || !body.source) {
          reply.code(400);
          return { error: { code: 'REFERENCE_PRICE_FIELDS_REQUIRED' } };
        }
        try {
          return services.finance.createReferencePrice({
            supplierModelId: String(body.supplierModelId),
            name: String(body.name),
            inputPerMillion:
              body.inputPerMillion == null ? undefined : Number(body.inputPerMillion),
            outputPerMillion:
              body.outputPerMillion == null ? undefined : Number(body.outputPerMillion),
            cacheReadPerMillion:
              body.cacheReadPerMillion == null ? undefined : Number(body.cacheReadPerMillion),
            cacheWritePerMillion:
              body.cacheWritePerMillion == null ? undefined : Number(body.cacheWritePerMillion),
            reasoningPerMillion:
              body.reasoningPerMillion == null ? undefined : Number(body.reasoningPerMillion),
            currency: body.currency ? String(body.currency) : undefined,
            source: String(body.source),
            effectiveFrom: body.effectiveFrom == null ? undefined : Number(body.effectiveFrom),
            effectiveTo: body.effectiveTo == null ? undefined : Number(body.effectiveTo),
            metadata:
              body.metadata && typeof body.metadata === 'object'
                ? (body.metadata as Record<string, unknown>)
                : undefined,
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : 'REFERENCE_PRICE_CREATE_FAILED';
          reply.code(code.includes('FOREIGN KEY') ? 404 : 422);
          return { error: { code } };
        }
      },
    }),
  );

  app.post<{ Params: { priceId: string } }>(
    '/api/v2/commands/reference-prices/:priceId/apply',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'reference-price.apply',
        operation: () => {
          if (!services.finance) {
            reply.code(503);
            return { error: { code: 'FINANCE_SERVICE_UNAVAILABLE' } };
          }
          try {
            return services.finance.applyReferencePrice(request.params.priceId);
          } catch (error) {
            const code = error instanceof Error ? error.message : 'REFERENCE_PRICE_APPLY_FAILED';
            reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
            return { error: { code } };
          }
        },
      }),
  );

  app.post<{ Params: { agreementId: string } }>(
    '/api/v2/commands/supply-agreements/:agreementId/commercial-terms',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'supply-agreement.commercial-terms',
        operation: () => {
          if (!services.supply) {
            reply.code(503);
            return { error: { code: 'SUPPLY_SERVICE_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          try {
            return services.supply.updateAgreementCommercialTerms(request.params.agreementId, {
              fixedCost:
                body.fixedCost === undefined
                  ? undefined
                  : body.fixedCost === null
                    ? null
                    : Number(body.fixedCost),
              currency:
                body.currency === undefined
                  ? undefined
                  : body.currency === null
                    ? null
                    : String(body.currency),
              billingPeriod:
                body.billingPeriod === undefined
                  ? undefined
                  : body.billingPeriod === null
                    ? null
                    : String(body.billingPeriod),
            });
          } catch (error) {
            const code = error instanceof Error ? error.message : 'COMMERCIAL_TERMS_UPDATE_FAILED';
            reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
            return { error: { code } };
          }
        },
      }),
  );

  app.post<{ Params: { agreementId: string } }>(
    '/api/v2/commands/supply-agreements/:agreementId/allocate-cost',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'supply-agreement.allocate-cost',
        operation: () => {
          if (!services.finance) {
            reply.code(503);
            return { error: { code: 'FINANCE_SERVICE_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          if (body.periodStart == null || body.periodEnd == null) {
            reply.code(400);
            return { error: { code: 'ALLOCATION_PERIOD_REQUIRED' } };
          }
          try {
            return services.finance.allocateAgreementCost({
              supplyAgreementId: request.params.agreementId,
              periodStart: Number(body.periodStart),
              periodEnd: Number(body.periodEnd),
              basis: body.basis ? (String(body.basis) as 'TOKENS' | 'REQUESTS') : undefined,
              fixedCost: body.fixedCost == null ? undefined : Number(body.fixedCost),
              currency: body.currency ? String(body.currency) : undefined,
              policy:
                body.policy && typeof body.policy === 'object'
                  ? (body.policy as Record<string, unknown>)
                  : undefined,
            });
          } catch (error) {
            const code = error instanceof Error ? error.message : 'COST_ALLOCATION_FAILED';
            reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
            return { error: { code } };
          }
        },
      }),
  );

  app.post('/api/v2/commands/evaluations/record', async (request, reply) =>
    runCommand({
      request,
      reply,
      commandType: 'evaluation.record',
      operation: () => {
        if (!services.finance) {
          reply.code(503);
          return { error: { code: 'FINANCE_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (
          !body.subjectType ||
          !body.subjectId ||
          !body.source ||
          !body.dimensions ||
          typeof body.dimensions !== 'object' ||
          Array.isArray(body.dimensions)
        ) {
          reply.code(400);
          return { error: { code: 'EVALUATION_FIELDS_REQUIRED' } };
        }
        try {
          return services.finance.recordEvaluation({
            subjectType: String(body.subjectType),
            subjectId: String(body.subjectId),
            roleId: body.roleId ? String(body.roleId) : undefined,
            positionId: body.positionId ? String(body.positionId) : undefined,
            employeeId: body.employeeId ? String(body.employeeId) : undefined,
            dimensions: body.dimensions as Record<string, number | boolean | string>,
            source: String(body.source),
            recordedAt: body.recordedAt == null ? undefined : Number(body.recordedAt),
            metadata:
              body.metadata && typeof body.metadata === 'object'
                ? (body.metadata as Record<string, unknown>)
                : undefined,
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : 'EVALUATION_RECORD_FAILED';
          reply.code(code.includes('FOREIGN KEY') ? 404 : 422);
          return { error: { code } };
        }
      },
    }),
  );

  app.post<{ Params: { gatewayId: string } }>(
    '/api/v2/internal/gateways/:gatewayId/discover',
    async (request, reply) => {
      if (!services.discoveryService) {
        reply.code(503);
        return { error: { code: 'GATEWAY_DISCOVERY_SERVICE_UNAVAILABLE' } };
      }
      try {
        return await services.discoveryService.reconcile(request.params.gatewayId);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'GATEWAY_DISCOVERY_FAILED';
        reply.code(code === 'GATEWAY_DISCOVERY_UNAVAILABLE' ? 404 : 502);
        return { error: { code } };
      }
    },
  );

  app.post('/api/v2/internal/gateways/discover', async (_request, reply) => {
    if (!services.discoveryService) {
      reply.code(503);
      return { error: { code: 'GATEWAY_DISCOVERY_SERVICE_UNAVAILABLE' } };
    }
    try {
      return { items: await services.discoveryService.reconcileAll() };
    } catch (error) {
      reply.code(502);
      return {
        error: {
          code: error instanceof Error ? error.message : 'GATEWAY_DISCOVERY_FAILED',
        },
      };
    }
  });

  app.post<{ Params: { gatewayId: string } }>(
    '/api/v2/internal/gateways/:gatewayId/reconcile-usage',
    async (request, reply) => {
      if (!services.usageReconciliationService) {
        reply.code(503);
        return { error: { code: 'USAGE_RECONCILIATION_SERVICE_UNAVAILABLE' } };
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      try {
        return await services.usageReconciliationService.reconcile(
          request.params.gatewayId,
          typeof body.cursor === 'string' ? body.cursor : undefined,
        );
      } catch (error) {
        const code = error instanceof Error ? error.message : 'USAGE_RECONCILIATION_FAILED';
        reply.code(
          code === 'GATEWAY_USAGE_UNAVAILABLE' || code === 'GATEWAY_NOT_REGISTERED' ? 404 : 502,
        );
        return { error: { code } };
      }
    },
  );

  app.post('/api/v2/internal/gateways/reconcile-usage', async (_request, reply) => {
    if (!services.usageReconciliationService) {
      reply.code(503);
      return { error: { code: 'USAGE_RECONCILIATION_SERVICE_UNAVAILABLE' } };
    }
    try {
      return { items: await services.usageReconciliationService.reconcileAll() };
    } catch (error) {
      reply.code(502);
      return {
        error: { code: error instanceof Error ? error.message : 'USAGE_RECONCILIATION_FAILED' },
      };
    }
  });

  const lifecycleError = (error: unknown): { status: number; code: string } => {
    const code = error instanceof Error ? error.message : 'LIFECYCLE_COMMAND_FAILED';
    if (code.endsWith('_NOT_FOUND')) return { status: 404, code };
    if (
      code.endsWith('_NOT_SUSPENDABLE') ||
      code.endsWith('_NOT_RESUMABLE') ||
      code.endsWith('_NOT_ENDABLE')
    ) {
      return { status: 409, code };
    }
    return { status: 422, code };
  };

  for (const action of ['suspend', 'resume', 'end'] as const) {
    app.post<{ Params: { employmentId: string } }>(
      `/api/v2/commands/employments/:employmentId/${action}`,
      async (request, reply) => {
        if (!services.lifecycleService) {
          reply.code(503);
          return { error: { code: 'LIFECYCLE_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        try {
          if (action === 'suspend') {
            return await services.lifecycleService.suspendEmployment(request.params.employmentId, {
              reason: body.reason ? String(body.reason) : undefined,
              correlationId: body.correlationId ? String(body.correlationId) : undefined,
            });
          }
          if (action === 'resume') {
            return await services.lifecycleService.resumeEmployment(request.params.employmentId, {
              correlationId: body.correlationId ? String(body.correlationId) : undefined,
            });
          }
          return await services.lifecycleService.endEmployment(request.params.employmentId, {
            reason: body.reason ? String(body.reason) : undefined,
            correlationId: body.correlationId ? String(body.correlationId) : undefined,
          });
        } catch (error) {
          const failure = lifecycleError(error);
          reply.code(failure.status);
          return { error: { code: failure.code } };
        }
      },
    );
  }

  for (const action of ['suspend', 'resume', 'end'] as const) {
    app.post<{ Params: { appointmentId: string } }>(
      `/api/v2/commands/appointments/:appointmentId/${action}`,
      async (request, reply) => {
        if (!services.lifecycleService) {
          reply.code(503);
          return { error: { code: 'LIFECYCLE_SERVICE_UNAVAILABLE' } };
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        try {
          if (action === 'suspend') {
            return await services.lifecycleService.suspendAppointment(
              request.params.appointmentId,
              {
                reason: body.reason ? String(body.reason) : undefined,
                correlationId: body.correlationId ? String(body.correlationId) : undefined,
              },
            );
          }
          if (action === 'resume') {
            return await services.lifecycleService.resumeAppointment(request.params.appointmentId, {
              correlationId: body.correlationId ? String(body.correlationId) : undefined,
            });
          }
          return await services.lifecycleService.endAppointment(request.params.appointmentId, {
            reason: body.reason ? String(body.reason) : undefined,
            correlationId: body.correlationId ? String(body.correlationId) : undefined,
          });
        } catch (error) {
          const failure = lifecycleError(error);
          reply.code(failure.status);
          return { error: { code: failure.code } };
        }
      },
    );
  }

  app.post<{ Params: { dutySessionId: string } }>(
    '/api/v2/commands/duties/:dutySessionId/redispatch',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'duty.redispatch',
        operation: async () => {
          if (!services.dispatchService) {
            reply.code(503);
            return { error: { code: 'DISPATCH_SERVICE_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          try {
            const result = await services.dispatchService.dispatchDuty(
              request.params.dutySessionId,
              {
                trigger: body.trigger ? String(body.trigger) : 'OPERATOR_REDISPATCH',
                correlationId: body.correlationId ? String(body.correlationId) : undefined,
              },
            );
            if (!result.selected) reply.code(422);
            return result;
          } catch (error) {
            const code = error instanceof Error ? error.message : 'REDISPATCH_FAILED';
            reply.code(code.endsWith('_NOT_FOUND') ? 404 : 422);
            return { error: { code } };
          }
        },
      }),
  );

  app.post<{ Params: { dutySessionId: string } }>(
    '/api/v2/internal/duties/:dutySessionId/invoke',
    async (request, reply) =>
      runCommand({
        request,
        reply,
        commandType: 'duty.invoke',
        operation: async () => {
          if (!services.invocationService) {
            reply.code(503);
            return { error: { code: 'INVOCATION_SERVICE_UNAVAILABLE' } };
          }
          const body = (request.body ?? {}) as Record<string, unknown>;
          if (typeof body.input !== 'string' || !body.input.trim()) {
            reply.code(400);
            return { error: { code: 'INVOCATION_INPUT_REQUIRED' } };
          }
          try {
            return await services.invocationService.invokeDuty(
              request.params.dutySessionId,
              body.input,
              {
                maxOutputTokens: body.maxOutputTokens
                  ? Math.max(1, Math.min(8_192, Number(body.maxOutputTokens)))
                  : undefined,
                correlationId: body.correlationId ? String(body.correlationId) : undefined,
                runtimeSessionRef: body.runtimeSessionRef
                  ? String(body.runtimeSessionRef)
                  : undefined,
                completeDuty: body.completeDuty !== false,
              },
            );
          } catch (error) {
            const code = error instanceof Error ? error.message : 'INVOCATION_FAILED';
            if (code.endsWith('_NOT_FOUND')) reply.code(404);
            else if (code === 'INVOCATION_INPUT_REQUIRED') reply.code(400);
            else if (
              code.startsWith('GATEWAY_') ||
              code.startsWith('LITELLM_') ||
              code === 'EMPLOYMENT_ROUTE_UNAVAILABLE'
            ) {
              reply.code(502);
            } else reply.code(422);
            return { error: { code } };
          }
        },
      }),
  );

  app.get('/api/v2/projections/workforce', async () => repository.workforceProjection());
  app.get<{ Params: { employeeId: string } }>(
    '/api/v2/projections/employees/:employeeId/dossier',
    async (request, reply) => {
      const dossier = repository.employeeDossier(request.params.employeeId);
      if (!dossier) {
        reply.code(404);
        return { error: { code: 'EMPLOYEE_NOT_FOUND' } };
      }
      return dossier;
    },
  );

  app.get('/api/v2/events/history', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const after = Math.max(0, number(query.after, 0));
    const limit = Math.min(1_000, Math.max(1, number(query.limit, 500)));
    return { items: repository.eventsAfter(after, limit) };
  });

  app.get('/api/v2/events', async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const header = request.headers['last-event-id'];
    const after = Math.max(
      0,
      number(query.after ?? (Array.isArray(header) ? header[0] : header), 0),
    );
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const write = (event: V2Event): void => {
      reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    for (const event of repository.eventsAfter(after, 500)) write(event as V2Event);
    const unsubscribe = repository.subscribe(write);
    const timer = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    request.raw.on('close', () => {
      clearInterval(timer);
      unsubscribe();
    });
  });
}
