import type {
  GatewayDiscoverySnapshot,
  GatewayHealth,
  GatewayProtocol,
  GatewayRouteEvidence,
} from '../gateway/ports.js';
import { GatewayRegistry } from '../gateway/registry.js';
import type { DiscoveryRunSummary, V2Repository, V2Row } from './repository.js';

export interface GatewayDescriptor {
  kind: 'LITELLM' | 'CPA' | 'DIRECT' | 'OTHER';
  displayName: string;
  baseUrlHint?: string;
}

export interface DiscoveryIssue {
  code:
    | 'GATEWAY_ADAPTER_UNAVAILABLE'
    | 'SUPPLIER_IDENTITY_MISSING'
    | 'SUPPLIER_MODEL_IDENTITY_MISSING'
    | 'AGREEMENT_IDENTITY_AMBIGUOUS'
    | 'ROUTE_RECONCILIATION_FAILED';
  externalRouteRef?: string;
  message: string;
}

export interface DiscoveryResult extends DiscoveryRunSummary {
  discoveryRunId: string;
  gatewayId: string;
  observedAt: number;
}

interface IdentityHints {
  supplierSlug?: string;
  supplierName?: string;
  supplierModelKey?: string;
  supplierModelName?: string;
  agreementRef?: string;
  agreementName?: string;
  channelName: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function slugify(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || 'unknown-supplier';
}

function title(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}

function health(value: GatewayHealth): 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN' {
  return value.toUpperCase() as 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
}

function lifecycle(evidence: GatewayRouteEvidence): 'ENABLED' | 'DISABLED' {
  const metadata = record(evidence.metadata);
  return metadata.enabled === false ? 'DISABLED' : 'ENABLED';
}

function hints(gatewayId: string, evidence: GatewayRouteEvidence): IdentityHints {
  const metadata = record(evidence.metadata);
  const channelName =
    stringValue(
      metadata.channelName,
      metadata.routeName,
      evidence.deployments[0]?.externalDeploymentRef,
    ) ?? evidence.externalRouteRef;
  const rawSupplier = stringValue(
    evidence.supplierHint,
    metadata.supplierSlug,
    metadata.supplierName,
  );
  const supplierSlug = rawSupplier ? slugify(rawSupplier) : undefined;
  const supplierName =
    stringValue(metadata.supplierName, evidence.supplierHint) ??
    (supplierSlug ? title(supplierSlug) : undefined);
  const supplierModelKey = stringValue(
    evidence.supplierModelHint,
    metadata.supplierModelKey,
    metadata.modelId,
  );
  const supplierModelName =
    stringValue(metadata.supplierModelName) ??
    (supplierModelKey ? title(supplierModelKey) : undefined);
  const rawAgreement = stringValue(
    evidence.agreementHint,
    metadata.agreementRef,
    metadata.accountName,
  );
  const agreementRef = rawAgreement ? `gateway:${gatewayId}:${slugify(rawAgreement)}` : undefined;
  const agreementName =
    stringValue(metadata.agreementName) ??
    (rawAgreement ? `${title(rawAgreement)} Supply` : undefined);
  return {
    supplierSlug,
    supplierName,
    supplierModelKey,
    supplierModelName,
    agreementRef,
    agreementName,
    channelName,
  };
}

export class GatewayDiscoveryService {
  readonly #repository: V2Repository;
  readonly #gateways: GatewayRegistry;
  readonly #descriptors: Readonly<Record<string, GatewayDescriptor>>;

  constructor(
    repository: V2Repository,
    gateways: GatewayRegistry,
    descriptors: Record<string, GatewayDescriptor>,
  ) {
    this.#repository = repository;
    this.#gateways = gateways;
    this.#descriptors = descriptors;
  }

  gatewayIds(): string[] {
    return Object.keys(this.#descriptors).filter((id) => this.#gateways.getDiscovery(id));
  }

  async reconcileAll(): Promise<DiscoveryResult[]> {
    const results: DiscoveryResult[] = [];
    for (const gatewayId of this.gatewayIds()) {
      results.push(await this.reconcile(gatewayId));
    }
    return results;
  }

  async reconcile(gatewayId: string): Promise<DiscoveryResult> {
    const adapter = this.#gateways.getDiscovery(gatewayId);
    if (!adapter) throw new Error('GATEWAY_DISCOVERY_UNAVAILABLE');
    const descriptor = this.#descriptors[gatewayId] ?? {
      kind: 'OTHER' as const,
      displayName: gatewayId,
    };
    const gatewayExisted = Boolean(this.#repository.findGatewayBySlug(gatewayId));
    const gateway = this.#repository.getOrCreateGateway({
      slug: gatewayId,
      kind: descriptor.kind,
      displayName: descriptor.displayName,
      baseUrlHint: descriptor.baseUrlHint,
    });
    let snapshot: GatewayDiscoverySnapshot;
    try {
      snapshot = await adapter.discover();
    } catch (error) {
      const run = this.#repository.startDiscoveryRun(String(gateway.id), Date.now());
      this.#repository.failDiscoveryRun(
        String(run.id),
        error instanceof Error ? error.message : 'GATEWAY_DISCOVERY_FAILED',
      );
      throw error;
    }
    const discoveryRun = this.#repository.startDiscoveryRun(
      String(gateway.id),
      snapshot.observedAt,
    );
    const summary: DiscoveryRunSummary = {
      routeCount: snapshot.routes.length,
      createdSuppliers: 0,
      createdSupplierModels: 0,
      createdEmployees: 0,
      createdAgreements: 0,
      createdEmployments: 0,
      createdBindings: 0,
      issues: gatewayExisted ? [] : [{ code: 'GATEWAY_REGISTERED', gatewayId }],
    };

    try {
      this.#repository.transaction(() => {
        this.#repository.markGatewaySeen(String(gateway.id), snapshot.observedAt);
        for (const evidence of snapshot.routes) {
          this.#reconcileRoute(gatewayId, String(gateway.id), evidence, summary);
        }
        this.#repository.archiveMissingChannels(
          String(gateway.id),
          snapshot.routes.map((route) => route.externalRouteRef),
          snapshot.observedAt,
        );
      });
      this.#repository.completeDiscoveryRun(String(discoveryRun.id), summary);
      return {
        discoveryRunId: String(discoveryRun.id),
        gatewayId,
        observedAt: snapshot.observedAt,
        ...summary,
      };
    } catch (error) {
      const errorCode = error instanceof Error ? error.message : 'ROUTE_RECONCILIATION_FAILED';
      this.#repository.failDiscoveryRun(String(discoveryRun.id), errorCode);
      throw error;
    }
  }

  #reconcileRoute(
    gatewaySlug: string,
    gatewayDbId: string,
    evidence: GatewayRouteEvidence,
    summary: DiscoveryRunSummary,
  ): void {
    const routeHints = hints(gatewaySlug, evidence);
    const existingBinding = this.#repository.findGatewayBindingByRoute(
      gatewaySlug,
      evidence.externalRouteRef,
    );
    if (existingBinding) {
      this.#repository.upsertChannelObservation({
        gatewayId: gatewayDbId,
        supplyAgreementId: String(existingBinding.supply_agreement_id),
        externalRouteRef: evidence.externalRouteRef,
        name: routeHints.channelName,
        protocol: evidence.protocol,
        health: health(evidence.health),
        lifecycle: lifecycle(evidence),
        supplierHint: evidence.supplierHint,
        supplierModelHint: evidence.supplierModelHint,
        capabilities: evidence.capabilities,
        metadata: { ...record(evidence.metadata), identitySource: 'existing-gateway-binding' },
        observedAt: Date.now(),
      });
      return;
    }

    if (!routeHints.supplierSlug || !routeHints.supplierName) {
      const issue: DiscoveryIssue = {
        code: 'SUPPLIER_IDENTITY_MISSING',
        externalRouteRef: evidence.externalRouteRef,
        message: 'Route was retained as gateway evidence but no Supplier identity was inferred.',
      };
      summary.issues.push(issue);
      this.#repository.upsertChannelObservation({
        gatewayId: gatewayDbId,
        externalRouteRef: evidence.externalRouteRef,
        name: routeHints.channelName,
        protocol: evidence.protocol,
        health: health(evidence.health),
        lifecycle: lifecycle(evidence),
        supplierModelHint: evidence.supplierModelHint,
        capabilities: evidence.capabilities,
        metadata: { ...record(evidence.metadata), issue: issue.code },
        observedAt: Date.now(),
      });
      return;
    }
    if (!routeHints.supplierModelKey || !routeHints.supplierModelName) {
      const issue: DiscoveryIssue = {
        code: 'SUPPLIER_MODEL_IDENTITY_MISSING',
        externalRouteRef: evidence.externalRouteRef,
        message:
          'Route was retained as gateway evidence but no SupplierModel identity was inferred.',
      };
      summary.issues.push(issue);
      this.#repository.upsertChannelObservation({
        gatewayId: gatewayDbId,
        externalRouteRef: evidence.externalRouteRef,
        name: routeHints.channelName,
        protocol: evidence.protocol,
        health: health(evidence.health),
        lifecycle: lifecycle(evidence),
        supplierHint: routeHints.supplierSlug,
        capabilities: evidence.capabilities,
        metadata: { ...record(evidence.metadata), issue: issue.code },
        observedAt: Date.now(),
      });
      return;
    }

    const supplierBefore = this.#repository.findSupplierBySlug(routeHints.supplierSlug);
    const supplier = this.#repository.getOrCreateSupplier(
      routeHints.supplierSlug,
      routeHints.supplierName,
    );
    if (!supplierBefore) summary.createdSuppliers += 1;

    const supplierModelBefore = this.#repository.findSupplierModel(
      String(supplier.id),
      routeHints.supplierModelKey,
    );
    const supplierModel = this.#repository.getOrCreateSupplierModel({
      supplierId: String(supplier.id),
      supplierModelKey: routeHints.supplierModelKey,
      displayName: routeHints.supplierModelName,
    });
    if (!supplierModelBefore) summary.createdSupplierModels += 1;

    const employeeBefore = this.#repository.findEmployee(
      String(supplier.id),
      String(supplierModel.id),
    );
    const employee = this.#repository.getOrCreateEmployee({
      supplierId: String(supplier.id),
      supplierModelId: String(supplierModel.id),
      displayName: `${routeHints.supplierModelName} @ ${routeHints.supplierName}`,
    });
    if (!employeeBefore) summary.createdEmployees += 1;

    let agreement: V2Row | null = null;
    if (routeHints.agreementRef) {
      agreement = this.#repository.findAgreementByExternalRef(
        String(supplier.id),
        routeHints.agreementRef,
      );
    }
    if (!agreement)
      agreement = this.#repository.findUniqueActiveAgreementForSupplier(String(supplier.id));
    if (!agreement) {
      if (!routeHints.agreementRef || !routeHints.agreementName) {
        const issue: DiscoveryIssue = {
          code: 'AGREEMENT_IDENTITY_AMBIGUOUS',
          externalRouteRef: evidence.externalRouteRef,
          message:
            'Supplier and Employee were identified but no safe SupplyAgreement identity was available.',
        };
        summary.issues.push(issue);
        this.#repository.upsertChannelObservation({
          gatewayId: gatewayDbId,
          externalRouteRef: evidence.externalRouteRef,
          name: routeHints.channelName,
          protocol: evidence.protocol,
          health: health(evidence.health),
          lifecycle: lifecycle(evidence),
          supplierHint: routeHints.supplierSlug,
          supplierModelHint: routeHints.supplierModelKey,
          capabilities: evidence.capabilities,
          metadata: { ...record(evidence.metadata), issue: issue.code },
          observedAt: Date.now(),
        });
        return;
      }
      agreement = this.#repository.getOrCreateAgreement({
        supplierId: String(supplier.id),
        externalAccountRef: routeHints.agreementRef,
        name: routeHints.agreementName,
      });
      summary.createdAgreements += 1;
    }

    const employmentBefore = this.#repository.findCurrentEmployment(
      String(employee.id),
      String(agreement.id),
    );
    const employment = this.#repository.getOrCreateCurrentEmployment({
      employeeId: String(employee.id),
      supplyAgreementId: String(agreement.id),
    });
    if (!employmentBefore) summary.createdEmployments += 1;

    const bindingBefore = this.#repository.findGatewayBinding(
      String(employment.id),
      gatewayDbId,
      evidence.externalRouteRef,
    );
    this.#repository.getOrCreateGatewayBinding({
      employmentId: String(employment.id),
      gatewayId: gatewayDbId,
      externalRouteRef: evidence.externalRouteRef,
      protocol: evidence.protocol,
      priority: 50,
    });
    if (!bindingBefore) summary.createdBindings += 1;

    this.#repository.upsertChannelObservation({
      gatewayId: gatewayDbId,
      supplyAgreementId: String(agreement.id),
      externalRouteRef: evidence.externalRouteRef,
      name: routeHints.channelName,
      protocol: evidence.protocol,
      health: health(evidence.health),
      lifecycle: lifecycle(evidence),
      supplierHint: routeHints.supplierSlug,
      supplierModelHint: routeHints.supplierModelKey,
      capabilities: evidence.capabilities,
      metadata: {
        ...record(evidence.metadata),
        identitySource: 'gateway-discovery',
        employeeId: employee.id,
        employmentId: employment.id,
      },
      observedAt: Date.now(),
    });
  }
}
