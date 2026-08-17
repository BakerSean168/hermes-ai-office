import type { GatewayProtocol } from '../gateway/ports.js';
import type { GatewayRegistry } from '../gateway/registry.js';
import type { V2Repository, V2Row } from './repository.js';
import type { SupplyRepository } from './supply.js';

type JsonRecord = Record<string, unknown>;

function row(value: unknown): V2Row | null {
  return value && typeof value === 'object' ? (value as V2Row) : null;
}

function sanitizedSecretMaterial(value: JsonRecord): Record<string, string> {
  const result: Record<string, string> = {};
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 12)
    throw new Error('GATEWAY_SECRET_MATERIAL_INVALID');
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(key)) throw new Error('GATEWAY_SECRET_FIELD_INVALID');
    const secret = typeof raw === 'string' ? raw.trim() : '';
    if (!secret || secret.length > 16_384) throw new Error('GATEWAY_SECRET_VALUE_INVALID');
    result[key] = secret;
  }
  return result;
}

function upstreamModel(provider: string, model: string): string {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim();
  if (!normalizedProvider || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalizedProvider)) {
    throw new Error('GATEWAY_UPSTREAM_PROVIDER_INVALID');
  }
  if (!normalizedModel || normalizedModel.length > 240)
    throw new Error('GATEWAY_UPSTREAM_MODEL_INVALID');
  if (normalizedModel.startsWith(`${normalizedProvider}/`)) return normalizedModel;
  return `${normalizedProvider}/${normalizedModel}`;
}

export interface ProvisionEmploymentRouteInput {
  employmentId: string;
  gatewaySlug?: string;
  protocol: GatewayProtocol;
  upstreamProvider: string;
  upstreamModel: string;
  upstreamBaseUrl?: string;
  secretMaterial: JsonRecord;
}

export class GatewayProvisioningService {
  readonly #domain: V2Repository;
  readonly #supply: SupplyRepository;
  readonly #gateways: GatewayRegistry;

  constructor(domain: V2Repository, supply: SupplyRepository, gateways: GatewayRegistry) {
    this.#domain = domain;
    this.#supply = supply;
    this.#gateways = gateways;
  }

  async provisionEmploymentRoute(input: ProvisionEmploymentRouteInput): Promise<V2Row> {
    const employment = row(
      this.#domain.db
        .prepare(
          `SELECT em.id,em.employee_id,em.supply_agreement_id,em.model_offering_id,em.status,
                  a.lifecycle agreement_lifecycle,e.supplier_id,e.supplier_model_id,
                  s.slug supplier_slug,sm.supplier_model_key
           FROM v2_employments em
           JOIN v2_supply_agreements a ON a.id=em.supply_agreement_id
           JOIN v2_employees e ON e.id=em.employee_id
           JOIN v2_suppliers s ON s.id=e.supplier_id
           JOIN v2_supplier_models sm ON sm.id=e.supplier_model_id
           WHERE em.id=?`,
        )
        .get(input.employmentId),
    );
    if (!employment) throw new Error('EMPLOYMENT_NOT_FOUND');
    if (employment.status !== 'CURRENT' || employment.agreement_lifecycle !== 'ACTIVE') {
      throw new Error('EMPLOYMENT_NOT_CURRENT');
    }
    if (!employment.model_offering_id) throw new Error('EMPLOYMENT_OFFERING_REQUIRED');

    const gatewaySlug = input.gatewaySlug?.trim() || 'litellm-reference';
    const gatewayRecord = this.#domain.findGatewayBySlug(gatewaySlug);
    if (!gatewayRecord || gatewayRecord.lifecycle !== 'ACTIVE')
      throw new Error('GATEWAY_NOT_FOUND');
    const provisioning = this.#gateways.getProvisioning(gatewaySlug);
    if (!provisioning) throw new Error('GATEWAY_PROVISIONING_UNAVAILABLE');

    const externalRouteRef = `employment:${input.employmentId}`;
    const agreementId = String(employment.supply_agreement_id);
    const credentialName = `hermes-agreement-${agreementId}`;
    const model = upstreamModel(input.upstreamProvider, input.upstreamModel);
    const baseUrl = input.upstreamBaseUrl?.trim();
    if (baseUrl && !/^https?:\/\//i.test(baseUrl))
      throw new Error('GATEWAY_UPSTREAM_BASE_URL_INVALID');

    const result = await provisioning.provisionRoute({
      employmentId: input.employmentId,
      externalRouteRef,
      protocol: input.protocol,
      upstreamModel: model,
      ...(baseUrl ? { upstreamBaseUrl: baseUrl.replace(/\/$/, '') } : {}),
      credential: {
        name: credentialName,
        provider: input.upstreamProvider.trim().toLowerCase(),
        secretMaterial: sanitizedSecretMaterial(input.secretMaterial),
      },
      metadata: {
        supplierId: employment.supplier_id,
        supplierModelId: employment.supplier_model_id,
        supplyAgreementId: agreementId,
      },
    });

    const observed = this.#domain.upsertChannelObservation({
      gatewayId: String(gatewayRecord.id),
      supplyAgreementId: agreementId,
      externalRouteRef,
      name: externalRouteRef,
      protocol: input.protocol,
      health: 'HEALTHY',
      lifecycle: 'ENABLED',
      supplierHint: String(employment.supplier_slug),
      supplierModelHint: String(employment.supplier_model_key),
      capabilities: [],
      metadata: {
        source: 'GATEWAY_PROVISIONING',
        externalDeploymentRef: result.externalDeploymentRef ?? null,
        credentialName: result.credentialName,
      },
      observedAt: result.observedAt,
    });
    const binding = this.#domain.getOrCreateGatewayBinding({
      employmentId: input.employmentId,
      gatewayId: String(gatewayRecord.id),
      externalRouteRef,
      protocol: input.protocol,
      priority: 100,
    });

    const runtimeSelectors: JsonRecord = {
      OPENCODE: {
        model: `hermes-office/${externalRouteRef}`,
        provider: 'hermes-office',
      },
    };
    if (input.protocol === 'openai-responses') {
      runtimeSelectors.CODEX = {
        model: externalRouteRef,
        provider: 'hermes-office',
        profile: 'hermes-office',
      };
    }
    this.#supply.setRuntimeSelectors(String(employment.model_offering_id), runtimeSelectors);

    this.#domain.emit({
      type: result.created ? 'gateway_route.provisioned' : 'gateway_route.updated',
      entityType: 'Employment',
      entityId: input.employmentId,
      payload: {
        gatewaySlug,
        externalRouteRef,
        protocol: input.protocol,
        credentialName: result.credentialName,
        externalDeploymentRef: result.externalDeploymentRef ?? null,
      },
    });

    return {
      employmentId: input.employmentId,
      employeeId: employment.employee_id,
      supplyAgreementId: agreementId,
      gateway: { id: gatewayRecord.id, slug: gatewaySlug },
      route: result.route,
      channelId: (observed.channel as V2Row).id,
      bindingId: binding.id,
      externalDeploymentRef: result.externalDeploymentRef ?? null,
      credentialName: result.credentialName,
      runtimeSelectors,
      created: result.created,
      observedAt: result.observedAt,
    };
  }
}
