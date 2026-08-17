# Runtime Access V2

## Decision

Hermes AI Office selects **who works** and **through which Employment**, but external coding Agents should use their own native configuration whenever that Agent can represent the selected provider directly.

The default launch path is therefore:

```text
Position / DutySession
  -> DispatchDecision
  -> Employee
  -> Employment
  -> RuntimeAccessProfile
  -> RuntimeAdapter
  -> native Agent configuration
  -> provider / supplier endpoint
```

A model gateway is not part of this path unless the selected RuntimeAccessProfile explicitly uses `adapterKind=GATEWAY`.

## RuntimeAccessProfile

`RuntimeAccessProfile` is an infrastructure-facing child of Employment. It records how one current Employment may be used by one external runtime without changing Employee identity.

Current fields:

- `employmentId`
- `runtimeKind`: `OPENCODE`, `CODEX`, or `CLAUDE_CODE`
- `adapterKind`: `NATIVE_CONFIG` or `GATEWAY`
- `providerRef`
- `modelRef`
- optional `profileRef`
- optional `baseUrl`
- optional `credentialRef`
- optional protocol/config hints
- priority/lifecycle

`credentialRef` is a **credential slot name**, never credential material. `config` rejects secret-like fields such as API keys, passwords, tokens, and credentials.

## Runtime adapters

### OpenCode

The runtime policy selects a `provider/model` reference. When the provider is managed by AI Office, the plugin merges a namespaced provider entry into the runtime's `opencode.json`; otherwise it references an already-existing native provider. Credentials are read from Hermes credential storage and, when a file reference is required by the runtime config, materialized into a local `0600` file outside business persistence.

### Codex

The runtime policy selects a named profile. AI Office may materialize a namespaced provider and profile block into `config.toml`. The launch command uses the profile, so provider/model selection remains owned by Codex configuration rather than by a proxy URL injected into every request.

### Claude Code

The domain schema supports `CLAUDE_CODE` access profiles so Anthropic-compatible Employment access can be modeled without redesign. Automatic Claude Code launch materialization is a separate RuntimeAdapter and must follow Claude Code's own settings/environment mechanisms rather than reusing the Codex profile contract.

## Credentials

Credential ownership is intentionally split:

```text
User onboarding
  -> Hermes credential lifecycle             authoritative user-side secret
  -> RuntimeAccessProfile.credentialRef      safe reference only
  -> RuntimeAdapter                          obtains value at launch/materialization time
```

Raw secrets never enter:

- Employee / Employment / Appointment records;
- RuntimeAccessProfile config JSON;
- V2 events;
- runtime-launch decisions;
- idempotency request storage;
- Office projections.

## Gateway compatibility

`GATEWAY` remains a supported adapter kind for an Employment that genuinely needs an intermediate gateway. LiteLLM and CPA are therefore optional infrastructure adapters, not mandatory traffic hops.

Examples:

- CPA account pool: CPA may remain the supplier's actual endpoint and usage/quota evidence source.
- LiteLLM protocol bridge: use only when the target Agent cannot directly represent the upstream protocol/provider safely.
- Historical `hermes-office` LiteLLM routes: imported as explicit `GATEWAY` RuntimeAccessProfiles and kept for rollback/compatibility.

A gateway must never silently cross Employee or Employment boundaries.

## Migration from runtimeSelectors

The old `ModelOffering.commercial_metadata.runtimeSelectors` contract is retained temporarily as a read fallback. Migration `012_runtime_access_profiles` introduces the first-class table, and the idempotent `runtime-access.import-legacy` command imports only explicit selector facts:

- it does not infer base URLs;
- it does not infer credentials;
- it does not infer supplier identity;
- `hermes-office` selectors remain `GATEWAY`;
- ordinary OpenCode/Codex selectors become `NATIVE_CONFIG` references.

New supplier onboarding writes RuntimeAccessProfiles directly. Once production history and rollback windows no longer require the legacy metadata fallback, it can be retired in a later additive migration/release.
