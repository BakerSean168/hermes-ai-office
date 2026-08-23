import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

import {
  DEVELOPMENT_PHASES,
  TRANSPORT_MODES,
  type DevelopmentPhase,
  type ExecutionHints,
  type ExecutionOverride,
  type ExecutionSelection,
  type SessionPolicy,
  type TransportMode,
  type WorkspaceMode,
} from './types.js';

interface BackendSupportsConfig {
  litellm_managed?: boolean | 'conditional';
  write?: boolean;
}

export type ManagedEnvironmentSource =
  | 'litellm_api_key'
  | 'litellm_base_url'
  | 'litellm_base_url_v1'
  | 'logical_model'
  | 'execution_id'
  | 'codex_config';

export interface BackendPolicyConfig {
  kind: 'openhands' | 'acp' | 'external_adapter' | 'internal';
  enabled: boolean;
  command?: string[];
  acp_server?: string;
  managed_model_prefix?: string;
  managed_env?: Record<string, ManagedEnvironmentSource>;
  static_env?: Record<string, string>;
  supports?: BackendSupportsConfig;
}

interface PhasePolicyConfig {
  backend_candidates: string[];
  model_class: string;
  transport_preference: TransportMode[];
  workspace_mode: WorkspaceMode;
  session_policy: SessionPolicy;
}

export interface DevelopmentPolicyConfig {
  version: number;
  concurrency: {
    max_active_writers: number;
    max_active_writers_per_project: number;
  };
  phases: Record<DevelopmentPhase, PhasePolicyConfig>;
  backends: Record<string, BackendPolicyConfig>;
}

function isDevelopmentPhase(value: string): value is DevelopmentPhase {
  return DEVELOPMENT_PHASES.includes(value as DevelopmentPhase);
}

function supportsTransport(backend: BackendPolicyConfig, mode: TransportMode): boolean {
  if (mode === 'INTERNAL') return backend.kind === 'internal';
  if (backend.kind === 'internal') return false;
  return backend.supports?.litellm_managed !== false;
}

function validateConfig(raw: unknown): DevelopmentPolicyConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('V3_POLICY_INVALID');
  }
  const config = raw as Record<string, unknown>;
  if (Number(config.version) !== 2) throw new Error('V3_POLICY_VERSION_UNSUPPORTED');
  if (!config.phases || typeof config.phases !== 'object' || Array.isArray(config.phases)) {
    throw new Error('V3_POLICY_PHASES_REQUIRED');
  }
  if (!config.backends || typeof config.backends !== 'object' || Array.isArray(config.backends)) {
    throw new Error('V3_POLICY_BACKENDS_REQUIRED');
  }
  if (
    !config.concurrency ||
    typeof config.concurrency !== 'object' ||
    Array.isArray(config.concurrency)
  ) {
    throw new Error('V3_POLICY_CONCURRENCY_REQUIRED');
  }
  const concurrency = config.concurrency as Record<string, unknown>;
  const maxActiveWriters = Number(concurrency.max_active_writers);
  const maxProjectWriters = Number(concurrency.max_active_writers_per_project);
  if (!Number.isInteger(maxActiveWriters) || maxActiveWriters < 1 || maxActiveWriters > 32) {
    throw new Error('V3_POLICY_MAX_ACTIVE_WRITERS_INVALID');
  }
  if (
    !Number.isInteger(maxProjectWriters) ||
    maxProjectWriters < 1 ||
    maxProjectWriters > maxActiveWriters
  ) {
    throw new Error('V3_POLICY_MAX_PROJECT_WRITERS_INVALID');
  }
  const phases = config.phases as Record<string, Record<string, unknown>>;
  for (const phase of DEVELOPMENT_PHASES) {
    const item = phases[phase];
    if (!item) throw new Error(`V3_POLICY_PHASE_MISSING:${phase}`);
    if (!Array.isArray(item.backend_candidates) || item.backend_candidates.length === 0) {
      throw new Error(`V3_POLICY_BACKENDS_MISSING:${phase}`);
    }
    if (typeof item.model_class !== 'string' || !item.model_class.trim()) {
      throw new Error(`V3_POLICY_MODEL_CLASS_MISSING:${phase}`);
    }
    if (!Array.isArray(item.transport_preference) || item.transport_preference.length === 0) {
      throw new Error(`V3_POLICY_TRANSPORT_MISSING:${phase}`);
    }
    for (const mode of item.transport_preference) {
      if (!TRANSPORT_MODES.includes(String(mode) as TransportMode)) {
        throw new Error(`V3_POLICY_TRANSPORT_INVALID:${phase}`);
      }
    }
  }
  for (const name of Object.values(phases).flatMap((item) =>
    Array.isArray(item.backend_candidates) ? item.backend_candidates.map(String) : [],
  )) {
    if (!(name in (config.backends as Record<string, unknown>))) {
      throw new Error(`V3_POLICY_BACKEND_UNKNOWN:${name}`);
    }
  }
  const managedSources = new Set<ManagedEnvironmentSource>([
    'litellm_api_key',
    'litellm_base_url',
    'litellm_base_url_v1',
    'logical_model',
    'execution_id',
    'codex_config',
  ]);
  for (const [name, rawBackend] of Object.entries(
    config.backends as Record<string, Record<string, unknown>>,
  )) {
    const managedEnv = rawBackend.managed_env;
    if (managedEnv != null) {
      if (typeof managedEnv !== 'object' || Array.isArray(managedEnv)) {
        throw new Error(`V3_POLICY_MANAGED_ENV_INVALID:${name}`);
      }
      for (const source of Object.values(managedEnv as Record<string, unknown>)) {
        if (!managedSources.has(String(source) as ManagedEnvironmentSource)) {
          throw new Error(`V3_POLICY_MANAGED_ENV_SOURCE_INVALID:${name}`);
        }
      }
    }
    const staticEnv = rawBackend.static_env;
    if (staticEnv != null) {
      if (typeof staticEnv !== 'object' || Array.isArray(staticEnv)) {
        throw new Error(`V3_POLICY_STATIC_ENV_INVALID:${name}`);
      }
      if (
        Object.values(staticEnv as Record<string, unknown>).some(
          (value) => typeof value !== 'string',
        )
      ) {
        throw new Error(`V3_POLICY_STATIC_ENV_VALUE_INVALID:${name}`);
      }
    }
  }
  return config as unknown as DevelopmentPolicyConfig;
}

export class DevelopmentPolicy {
  readonly config: DevelopmentPolicyConfig;

  constructor(config: DevelopmentPolicyConfig) {
    this.config = validateConfig(config);
  }

  static fromFile(file: string): DevelopmentPolicy {
    const absolute = path.resolve(file);
    return new DevelopmentPolicy(
      parse(fs.readFileSync(absolute, 'utf8')) as DevelopmentPolicyConfig,
    );
  }

  backend(name: string): BackendPolicyConfig | undefined {
    return this.config.backends[name];
  }

  select(
    phase: DevelopmentPhase,
    override: ExecutionOverride = {},
    availability: Readonly<Record<string, boolean>> = {},
    hints: ExecutionHints = {},
  ): ExecutionSelection {
    if (!isDevelopmentPhase(phase)) throw new Error('V3_PHASE_INVALID');
    const phasePolicy = this.config.phases[phase];
    const requestedBackend = override.backend?.trim() || null;
    const candidates = requestedBackend ? [requestedBackend] : phasePolicy.backend_candidates;
    const backendName = candidates.find((name) => {
      const backend = this.config.backends[name];
      if (!backend?.enabled) return false;
      if (availability[name] === false) return false;
      return true;
    });
    if (!backendName) throw new Error('POLICY_NO_ELIGIBLE_BACKEND');
    const backend = this.config.backends[backendName]!;

    const requestedTransport = override.transportMode ?? null;
    const transports = requestedTransport ? [requestedTransport] : phasePolicy.transport_preference;
    const transportMode = transports.find((mode) => supportsTransport(backend, mode));
    if (!transportMode) throw new Error('POLICY_NO_ELIGIBLE_TRANSPORT');

    return {
      backend: backendName,
      modelClass: override.modelClass?.trim() || phasePolicy.model_class,
      transportMode,
      workspaceMode: phasePolicy.workspace_mode,
      sessionPolicy: phasePolicy.session_policy,
      reasons: [
        `phase:${phase}`,
        requestedBackend ? 'backend:operator-override' : 'backend:phase-policy',
        requestedTransport ? 'transport:operator-override' : 'transport:phase-policy',
        ...(hints.complexity ? [`hint:complexity:${hints.complexity}`] : []),
        ...(hints.risk ? [`hint:risk:${hints.risk}`] : []),
        ...(hints.quality ? [`hint:quality:${hints.quality}`] : []),
        ...(hints.budget ? [`hint:budget:${hints.budget}`] : []),
        ...(hints.parallelism != null ? [`hint:parallelism:${hints.parallelism}`] : []),
      ],
    };
  }
}
