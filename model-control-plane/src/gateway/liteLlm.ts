import fs from 'node:fs';

import type {
  GatewayBindingSource,
  GatewayDiscoveryPort,
  GatewayDiscoverySnapshot,
  GatewayExecutionPort,
  GatewayHealth,
  GatewayInvocationPort,
  GatewayInvocationRequest,
  GatewayInvocationResult,
  GatewayProtocol,
  GatewayProvisioningPort,
  GatewayProvisionRouteInput,
  GatewayProvisionRouteResult,
  GatewayRouteEvidence,
  GatewayRouteRef,
  GatewayRouteResolution,
} from './ports.js';

interface JsonRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function responsesText(payload: JsonRecord): string {
  if (typeof payload.output_text === 'string') return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  const chunks: string[] = [];
  for (const rawItem of output) {
    const item = asRecord(rawItem);
    const content = Array.isArray(item.content) ? item.content : [];
    for (const rawContent of content) {
      const part = asRecord(rawContent);
      if (typeof part.text === 'string') chunks.push(part.text);
      else if (typeof part.output_text === 'string') chunks.push(part.output_text);
    }
  }
  return chunks.join('');
}

function chatText(payload: JsonRecord): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const choice = asRecord(choices[0]);
  const message = asRecord(choice.message);
  return typeof message.content === 'string' ? message.content : '';
}

export interface GatewaySecretProvider {
  readBearerToken(): Promise<string>;
}

export class EnvFileBearerTokenProvider implements GatewaySecretProvider {
  readonly #path: string;
  readonly #key: string;

  constructor(path: string, key = 'LITELLM_MASTER_KEY') {
    this.#path = path;
    this.#key = key;
  }

  async readBearerToken(): Promise<string> {
    const text = fs.readFileSync(this.#path, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.trimStart().startsWith('#')) continue;
      const index = line.indexOf('=');
      if (index <= 0) continue;
      const key = line.slice(0, index).trim();
      if (key !== this.#key) continue;
      const value = line.slice(index + 1).trim();
      if (!value) throw new Error(`empty ${this.#key} in gateway env file`);
      return value;
    }
    throw new Error(`missing ${this.#key} in gateway env file`);
  }
}

export class StaticBearerTokenProvider implements GatewaySecretProvider {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  async readBearerToken(): Promise<string> {
    return this.#token;
  }
}

export class LiteLlmGateway
  implements
    GatewayExecutionPort,
    GatewayDiscoveryPort,
    GatewayInvocationPort,
    GatewayProvisioningPort
{
  readonly gatewayId: string;
  readonly #baseUrl: string;
  readonly #secrets: GatewaySecretProvider;
  readonly #bindings: GatewayBindingSource;
  readonly #routeProtocols: Readonly<Record<string, GatewayProtocol>>;

  constructor(options: {
    gatewayId?: string;
    baseUrl: string;
    secrets: GatewaySecretProvider;
    bindings: GatewayBindingSource;
    routeProtocols?: Record<string, GatewayProtocol>;
  }) {
    this.gatewayId = options.gatewayId ?? 'litellm-reference';
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#secrets = options.secrets;
    this.#bindings = options.bindings;
    this.#routeProtocols = options.routeProtocols ?? {};
  }

  async #request(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
    const token = await this.#secrets.readBearerToken();
    if (!token) throw new Error('empty LiteLLM bearer token');
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`LITELLM_HTTP_${response.status}`);
    return response;
  }

  async #requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
    return (await this.#request(path, init)).json();
  }

  async #credentialExists(name: string): Promise<boolean> {
    try {
      await this.#requestJson(`/credentials/by_name/${encodeURIComponent(name)}`);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === 'LITELLM_HTTP_404') return false;
      throw error;
    }
  }

  async #upsertCredential(input: GatewayProvisionRouteInput): Promise<void> {
    const name = input.credential.name.trim();
    if (!name) throw new Error('GATEWAY_CREDENTIAL_NAME_REQUIRED');
    const credentialInfo: JsonRecord = {
      custom_llm_provider: input.credential.provider,
      ...(input.upstreamBaseUrl ? { api_base: input.upstreamBaseUrl } : {}),
    };
    const body = {
      credential_name: name,
      credential_info: credentialInfo,
      credential_values: input.credential.secretMaterial,
    };
    if (await this.#credentialExists(name)) {
      await this.#requestJson(`/credentials/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      return;
    }
    await this.#requestJson('/credentials', { method: 'POST', body: JSON.stringify(body) });
  }

  async #managedModelByRoute(externalRouteRef: string): Promise<JsonRecord | null> {
    const payload = asRecord(await this.#requestJson('/model/info'));
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const matches = rows.map(asRecord).filter((item) => item.model_name === externalRouteRef);
    if (matches.length > 1) throw new Error('LITELLM_ROUTE_AMBIGUOUS');
    return matches[0] ?? null;
  }

  async provisionRoute(input: GatewayProvisionRouteInput): Promise<GatewayProvisionRouteResult> {
    if (!input.employmentId || input.externalRouteRef !== `employment:${input.employmentId}`) {
      throw new Error('EMPLOYMENT_ROUTE_IDENTITY_MISMATCH');
    }
    if (!input.upstreamModel.trim()) throw new Error('UPSTREAM_MODEL_REQUIRED');
    if (input.protocol === 'anthropic-messages') {
      throw new Error('LITELLM_PROVISIONING_PROTOCOL_UNSUPPORTED');
    }

    await this.#upsertCredential(input);
    const current = await this.#managedModelByRoute(input.externalRouteRef);
    const modelInfo = asRecord(current?.model_info);
    const currentId = typeof modelInfo.id === 'string' ? modelInfo.id : '';
    if (current && modelInfo.db_model !== true) throw new Error('LITELLM_CONFIG_ROUTE_IMMUTABLE');

    const litellmParams = {
      model: input.upstreamModel,
      litellm_credential_name: input.credential.name,
      ...(input.upstreamBaseUrl ? { api_base: input.upstreamBaseUrl } : {}),
      timeout: 120,
      stream_timeout: 120,
      max_retries: 1,
    };
    let created = false;
    let externalDeploymentRef = currentId;
    if (currentId) {
      await this.#requestJson('/model/update', {
        method: 'POST',
        body: JSON.stringify({
          model_name: input.externalRouteRef,
          litellm_params: litellmParams,
          model_info: { id: currentId },
        }),
      });
    } else {
      const result = asRecord(
        await this.#requestJson('/model/new', {
          method: 'POST',
          body: JSON.stringify({
            model_name: input.externalRouteRef,
            litellm_params: litellmParams,
            model_info: {
              id: null,
              base_model: input.upstreamModel,
              metadata: {
                owner: 'hermes-ai-office',
                employmentId: input.employmentId,
                ...input.metadata,
              },
            },
          }),
        }),
      );
      const createdInfo = asRecord(result.model_info);
      externalDeploymentRef = typeof createdInfo.id === 'string' ? createdInfo.id : '';
      created = true;
    }

    const ids = await this.#modelIds();
    if (!ids.has(input.externalRouteRef)) throw new Error('LITELLM_ROUTE_NOT_VISIBLE');
    const observedAt = Date.now();
    return {
      route: {
        gatewayId: this.gatewayId,
        employmentId: input.employmentId,
        externalRouteRef: input.externalRouteRef,
        protocol: input.protocol,
      },
      ...(externalDeploymentRef ? { externalDeploymentRef } : {}),
      credentialName: input.credential.name,
      created,
      observedAt,
    };
  }

  async #modelIds(): Promise<Set<string>> {
    const payload = asRecord(await this.#requestJson('/v1/models'));
    const rows = Array.isArray(payload.data) ? payload.data : [];
    return new Set(rows.map((row) => String(asRecord(row).id ?? '')).filter(Boolean));
  }

  async resolveRoute(employmentId: string): Promise<GatewayRouteResolution> {
    const binding = await this.#bindings.findByEmploymentId(employmentId);
    const observedAt = Date.now();
    if (!binding || binding.gatewayId !== this.gatewayId) {
      return { route: null, routable: false, reasons: ['NO_GATEWAY_BINDING'], observedAt };
    }
    const route: GatewayRouteRef = { ...binding };
    const health = await this.getRouteHealth(route);
    const routable = health === 'healthy';
    return {
      route: routable ? route : null,
      routable,
      reasons: routable ? ['LITELLM_ROUTE_AVAILABLE'] : ['LITELLM_ROUTE_UNAVAILABLE'],
      observedAt,
    };
  }

  async getRouteHealth(route: GatewayRouteRef): Promise<GatewayHealth> {
    try {
      await this.#requestJson('/health/liveliness');
      const ids = await this.#modelIds();
      return ids.has(route.externalRouteRef) ? 'healthy' : 'unhealthy';
    } catch {
      return 'unhealthy';
    }
  }

  async discover(): Promise<GatewayDiscoverySnapshot> {
    const observedAt = Date.now();
    const ids = await this.#modelIds();
    const routes: GatewayRouteEvidence[] = [...ids].sort().map((externalRouteRef) => ({
      externalRouteRef,
      protocol: this.#routeProtocols[externalRouteRef] ?? 'unknown',
      health: 'healthy',
      capabilities: [],
      deployments: [],
      metadata: { source: 'litellm-model-list' },
    }));
    return { gatewayId: this.gatewayId, observedAt, routes };
  }

  async invoke(
    request: GatewayInvocationRequest,
    signal?: AbortSignal,
  ): Promise<GatewayInvocationResult> {
    if (request.route.gatewayId !== this.gatewayId) throw new Error('GATEWAY_ROUTE_MISMATCH');
    const startedAt = Date.now();
    let response: Response;
    let payload: JsonRecord;
    let outputText: string;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let reasoningTokens = 0;

    if (request.route.protocol === 'anthropic-messages') {
      throw new Error('LITELLM_INVOCATION_PROTOCOL_UNSUPPORTED');
    }

    if (request.route.protocol === 'openai-responses') {
      response = await this.#request(
        '/v1/responses',
        {
          method: 'POST',
          body: JSON.stringify({
            model: request.route.externalRouteRef,
            input: request.input,
            max_output_tokens: request.maxOutputTokens ?? 512,
          }),
          signal,
        },
        180_000,
      );
      payload = asRecord(await response.json());
      outputText = responsesText(payload);
      const usage = asRecord(payload.usage);
      const inputDetails = asRecord(usage.input_tokens_details);
      const outputDetails = asRecord(usage.output_tokens_details);
      inputTokens = asNumber(usage.input_tokens);
      outputTokens = asNumber(usage.output_tokens);
      cacheReadTokens = asNumber(inputDetails.cached_tokens);
      reasoningTokens = asNumber(outputDetails.reasoning_tokens);
    } else {
      response = await this.#request(
        '/v1/chat/completions',
        {
          method: 'POST',
          body: JSON.stringify({
            model: request.route.externalRouteRef,
            messages: [{ role: 'user', content: request.input }],
            max_tokens: request.maxOutputTokens ?? 512,
            stream: false,
          }),
          signal,
        },
        180_000,
      );
      payload = asRecord(await response.json());
      outputText = chatText(payload);
      const usage = asRecord(payload.usage);
      const promptDetails = asRecord(usage.prompt_tokens_details);
      const completionDetails = asRecord(usage.completion_tokens_details);
      inputTokens = asNumber(usage.prompt_tokens);
      outputTokens = asNumber(usage.completion_tokens);
      cacheReadTokens = asNumber(promptDetails.cached_tokens);
      reasoningTokens = asNumber(completionDetails.reasoning_tokens);
    }

    const gatewayRequestId =
      response.headers.get('x-litellm-call-id') || String(payload.id ?? `litellm-${startedAt}`);
    const latencyMs =
      headerNumber(response.headers, 'x-litellm-response-duration-ms') ?? Date.now() - startedAt;
    const cost =
      headerNumber(response.headers, 'x-litellm-response-cost-original') ??
      headerNumber(response.headers, 'x-litellm-response-cost');

    return {
      gatewayRequestId,
      externalDeploymentRef: response.headers.get('x-litellm-model-id') ?? undefined,
      outputText,
      responseModel: typeof payload.model === 'string' ? payload.model : undefined,
      status:
        payload.status === 'cancelled'
          ? 'cancelled'
          : payload.status === 'failed' || payload.error
            ? 'failed'
            : 'succeeded',
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
      reasoningTokens,
      actualCost: cost,
      currency: 'USD',
      latencyMs,
      metadata: {
        liteLlmVersion: response.headers.get('x-litellm-version'),
        modelGroup: response.headers.get('x-litellm-model-group'),
        attemptedRetries: asNumber(response.headers.get('x-litellm-attempted-retries')),
        attemptedFallbacks: asNumber(response.headers.get('x-litellm-attempted-fallbacks')),
      },
    };
  }

  invocationEndpoint(): string {
    return this.#baseUrl;
  }
}
