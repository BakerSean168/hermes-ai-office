# Provider Hub

Hermes AI Office treats provider connections as shared infrastructure rather than profile-local islands.

A `ProviderConnection` stores only safe connection metadata: provider identity, base URL, protocol, authentication kind, credential reference, credential scope, discovered model IDs, source profile, sharing scope, readiness and optional Supplier classification. Secret values never enter the V2 database.

A `ProfileProviderLink` records where a shared connection was discovered or explicitly used. The same public connection can therefore be known by every Hermes profile while retaining evidence about which profiles currently reference it.

## Discovery

Profile-native discovery scans supported Agent configuration under each Hermes profile home:

- Codex `config.toml` and `*.config.toml` provider/model selections;
- Codex ChatGPT OAuth metadata without persisting OAuth material;
- OpenCode `opencode.json` provider definitions and model catalogue;
- Claude Code endpoint/credential references from profile client environment configuration.

API-key connections discovered in a profile can be promoted into the Hermes global credential store. This makes the credential reference reusable by other profiles while keeping the secret out of AI Office persistence. OAuth profile credentials remain source-profile scoped and are globally visible as connection metadata only.

## Business classification

Discovery and employment are separate facts. A Provider Hub connection can exist without creating an Employee. Only an explicitly selected model (for example a Codex `*.config.toml` model or a Hermes profile default) is eligible for automatic Supplier/Employee/Employment materialization. Merely listing a model in a provider catalogue does not hire it.

Known business identities are classified conservatively. Existing Suppliers are reused; unknown or infrastructure-only connections stay unclassified until an operator confirms their commercial identity.

## Runtime use

`RuntimeAccessProfile` remains the executable boundary. The Provider Hub does not proxy model traffic. Codex, OpenCode and Claude Code continue to use their native configuration contracts. API-key connections promoted to the Hermes global credential store can be materialized for any profile without duplicating the secret into the business database.
