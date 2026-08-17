# Provider Hub

Hermes AI Office keeps one shared technical registry of provider connections, but **Provider Hub is not a separate business concept in the product UI**.

The user-facing model is intentionally simpler:

```text
External provider/API connection -> External Supplier -> Employee
Internal account pool            -> Internal Employee source -> Employee
```

`ProviderConnection` remains a safe infrastructure record containing provider identity, endpoint, protocol, auth kind, credential reference, credential scope, discovered model IDs, source profile, share scope and readiness. Secret values never enter the V2 database.

## Shared connection registry

A `ProfileProviderLink` records which Hermes profiles currently use a connection. Any profile can add or discover a provider once and other profiles learn the current state by querying the central registry. Sharing is **query-based, not event-replication-based**; events are audit/refresh evidence rather than the source of truth.

The Hermes plugin exposes:

- `ai_office_add_provider`: URL + `api_key`/`key`, optional display name and website. The secret is written only to Hermes global credential storage. An external workforce source/Supplier is created immediately, while Employees are created only for explicitly selected models.
- `ai_office_list_providers`: reads the shared registry so any profile can discover current connections, readiness, models, Supplier mapping and active Profile usage.

`newapi_channel_conn`-style payloads are accepted by the add tool.

## External suppliers

External URL/API-key/OAuth providers are represented to operators as Suppliers. The ProviderConnection is folded into **Supplier details** instead of being shown as a separate top-level Channels page.

A connection may exist before any model is hired. This means Worldclaw/Chybenzun-style endpoints can appear as Suppliers with zero Employees until the operator selects models. Provider discovery never hires an entire model catalogue implicitly.

Supplier details load connection metadata lazily through:

- `GET /api/v2/suppliers/:supplierId/provider-connections`

The detail contains only safe metadata such as Base URL, credential reference, model IDs and Profile links. Credential values stay outside AI Office persistence.

## Internal workforce sources

Account pools operated by the user are not presented as external Suppliers. Current internal sources include My CPA/xAI-Grok and Grok2API.

The control plane periodically projects their safe account-pool/model inventory into durable Employee identities. The compatibility table remains `v2_suppliers`, but `source_kind='INTERNAL'` distinguishes an internal workforce source from a commercial Supplier. The Supplier page filters INTERNAL sources; the Workforce page shows their Employees with an **Internal** source marker.

Identity and execution readiness remain separate. Creating an internal Employee does not invent a RuntimeAccessProfile or credential. Runtime access is added only when a safe executable connection is known.

## Native Agent discovery

Profile-native discovery still scans supported Agent configuration:

- Codex `config.toml` and `*.config.toml` provider/model selections;
- Codex ChatGPT OAuth metadata without persisting OAuth material;
- OpenCode `opencode.json` providers/models;
- Claude Code endpoint/credential references from profile client environment configuration.

API-key credentials can be promoted to Hermes global credential storage. OAuth profile credentials remain source-profile scoped unless explicitly shared.

`RuntimeAccessProfile` remains the executable boundary. Provider Hub never becomes a global model proxy; Codex, OpenCode and Claude Code continue using their native configuration contracts.
