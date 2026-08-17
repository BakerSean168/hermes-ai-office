# Gateway Strategy V2

## 1. Decision

Hermes AI Office is **runtime-native first and gateway-optional**.

The business domain selects Position -> Employee -> Employment. External coding Agents then use a `RuntimeAccessProfile` and runtime-specific adapter. A gateway participates only when that Employment explicitly needs one.

```text
Position / Duty
    -> Employee
    -> Employment
    -> RuntimeAccessProfile
          | NATIVE_CONFIG              | GATEWAY
          v                            v
       Agent config              Gateway adapter
          |                            |
          +-------------+--------------+
                        v
                     provider
```

Current adapters:

- **Native Agent configuration:** default for OpenCode and Codex onboarding.
- **CPA:** supplier/account-pool, route/health/quota/usage evidence, and compatibility endpoint where applicable.
- **LiteLLM:** optional protocol/gateway adapter and historical compatibility route; not a mandatory model traffic layer.

See [`RUNTIME-ACCESS.md`](RUNTIME-ACCESS.md) for the primary launch contract.

## 2. Ownership

### AI Workforce Domain owns

- Employee and Employment identity;
- staffing, qualification and appointment policy;
- RuntimeAccessProfile selection;
- business-level Employment failover;
- duty/staffing/invocation history and business attribution.

### RuntimeAdapter owns

- materializing the selected access into the target Agent's supported config/CLI/environment contract;
- keeping runtime-specific syntax outside business objects;
- retrieving credential values from the credential owner at launch/materialization time;
- observing the resulting technical runtime/session.

### Gateway adapter owns, when used

- protocol/request transformation;
- physical forwarding;
- same-Employment retry/load balancing across equivalent deployments;
- gateway-specific health/usage evidence;
- gateway-side credential storage when the adapter actually requires it.

A gateway never owns Employee selection or cross-Employment failover.

## 3. Why gateways are optional

OpenCode, Codex, Claude Code and future Agents do not share one configuration contract. Forcing all of them through a single proxy creates a second configuration truth and hides capabilities already supported by the native tools.

The product therefore normalizes **business access intent**, not every HTTP request:

```text
RuntimeAccessProfile
  providerRef / modelRef / profileRef
  baseUrl (optional)
  credentialRef (safe reference)
  protocol/config hints
```

Each RuntimeAdapter translates that safe intent into the native tool configuration it supports.

## 4. CPA role

CPA is a valid Supplier/infrastructure adapter, especially for account pools and subscription access.

Useful CPA facts include:

- account-pool availability;
- quota/reset state;
- route health;
- aggregate usage;
- provider/model evidence.

If an Employee's real access endpoint is CPA, the Agent may be configured directly to that CPA endpoint. AI Office does not need another LiteLLM hop in front of it.

CPA-specific channel names remain infrastructure evidence and never manufacture Supplier/Employee identity.

## 5. LiteLLM role

LiteLLM remains available for cases where a gateway is genuinely useful, for example:

- protocol adaptation an Agent cannot perform natively;
- a controlled gateway-only Employment;
- historical/reference routes that must remain available during migration;
- transport-level evidence or testing.

The existing `GatewayProvisioningPort` and DB-backed LiteLLM deployment are therefore retained as an **optional adapter contract**. New supplier onboarding does not call it by default.

When used, one logical gateway route still represents one selected Employment:

```text
employment:<employment-id>
```

Do not put different Employees or commercially distinct Employments into one gateway fallback group.

## 6. Failover ownership

Canonical levels remain:

```text
G0 same Employment/access, transport retry
G1 same Employment/access, equivalent physical route
B2 another Employment for the same Employee
B3 another appointed Employee
B4 another qualified Employee permitted by staffing policy
B5 operator/escalation decision
```

Only G0/G1 may happen below the business domain. B2-B5 require an explicit Hermes business decision.

## 7. Gateway ports

Gateway ports remain useful infrastructure abstractions:

### GatewayExecutionPort

```text
resolveRoute(employmentId) -> GatewayRouteRef | UNROUTABLE
invoke(...)                 -> normalized physical evidence
```

### GatewayDiscoveryPort

```text
discover() -> GatewayDiscoverySnapshot
```

Discovery is evidence, not workforce identity.

### GatewayUsagePort

```text
pullUsage(...) -> normalized gateway usage evidence
```

Gateway evidence may be reconciled with business invocation identity when correlation is strong enough. Aggregate evidence stays separate from verified Employee ledger data.

### GatewayProvisioningPort

Optional administrative capability for a gateway-backed RuntimeAccessProfile. It must not become the default supplier onboarding path merely because an adapter implements it.

## 8. Secrets

The strongest invariant is:

> AI Office business persistence stores no plaintext provider/gateway secret.

For native access, Hermes credential storage owns the user-side key and RuntimeAccessProfile stores only a credential-slot reference.

For a gateway-backed access profile, a gateway may keep its own encrypted copy if required by that adapter. This is infrastructure state, not business truth.

No secret may enter V2 events, RuntimeAccessProfile config JSON, projections, or persisted idempotency request payloads.

## 9. Usage and accounting

Evidence ownership follows the actual path:

- native Agent/provider evidence is preferred when it identifies the physical request reliably;
- CPA/LiteLLM evidence is authoritative only for requests they actually observed;
- Hermes remains authoritative for Employee, Employment, Position, Duty and Run attribution.

Do not invent request-level Employee usage from aggregate gateway statistics.

## 10. Acceptance contract

Every RuntimeAccess/Gateway adapter must prove:

1. it cannot change durable Employee identity;
2. it cannot silently cross Employment boundaries;
3. credentials never enter business payloads/events/logs;
4. selected provider/model/profile is auditable;
5. runtime configuration is idempotent and namespaced where AI Office manages it;
6. an unavailable access path becomes explicit unroutable/degraded evidence rather than an unrelated raw-model fallback;
7. historical RuntimeAccess and staffing evidence survive configuration changes.

## 11. Decision summary

1. RuntimeAccessProfile is the primary Employment -> Agent access contract.
2. Native Agent configuration is the default path for new supplier onboarding.
3. CPA is primarily a supplier/account-pool and evidence adapter, and may also be the direct endpoint for a concrete Employment.
4. LiteLLM is optional compatibility/protocol infrastructure, not the north-star model data plane.
5. Gateway ports remain because some Employments genuinely need them; they no longer define the default architecture.
