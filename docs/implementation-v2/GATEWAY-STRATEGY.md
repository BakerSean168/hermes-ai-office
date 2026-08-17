# Gateway Strategy V2

## 1. Decision

Hermes AI Office is **gateway-neutral**.

The business architecture must not depend on CPA, LiteLLM, or any other model gateway. Gateways implement infrastructure ports below the business domain.

For the V2 implementation:

- **Reference gateway:** LiteLLM Proxy.
- **Compatibility gateway:** current CPA / CLIProxyAPI through a CPA adapter.
- **Special-provider option:** CPA or another compatibility service may sit behind LiteLLM as one upstream deployment when LiteLLM does not natively support the required subscription/auth protocol.
- **Direct provider adapters:** allowed only when a gateway adds no value or cannot represent the provider safely.

Current production deployment affects migration order only. It does not define the north-star architecture.

## 2. Why LiteLLM is the reference implementation

As of the architecture review on 2026-08-16, LiteLLM documents a centralized Proxy/AI Gateway that provides OpenAI-compatible access across many providers, including `/chat/completions` and `/responses`, while its Router supports retry/fallback/load-balancing across deployments. The Proxy also provides authentication, rate limiting, budget/spend tracking, logging hooks, and cost tracking.

Primary references:

- [LiteLLM Getting Started](https://docs.litellm.ai/)
- [LiteLLM repository](https://github.com/BerriAI/litellm)
- [LiteLLM architecture](https://github.com/BerriAI/litellm/blob/litellm_internal_staging/ARCHITECTURE.md)

This makes LiteLLM a good place to outsource generic transport concerns instead of rebuilding them in Hermes AI Office.

LiteLLM is still an external dependency with evolving behavior. Gateway contract tests remain mandatory, and business-semantic failover must stay above the gateway.

## 3. What we deliberately do not build

The Hermes business/control service should not reimplement generic gateway infrastructure unless a verified product requirement cannot be expressed by the selected gateway.

Do not build a second generic implementation of:

- provider request/response transformation;
- OpenAI/Anthropic/provider protocol normalization;
- generic streaming adaptation;
- generic provider exception normalization;
- same-route request retry;
- deployment load balancing within one business Employment;
- generic gateway authentication/virtual keys;
- generic gateway rate limiting;
- generic provider spend logging;
- generic deployment health probing when the gateway already supplies sufficient evidence;
- generic provider credential storage.

Hermes AI Office may project these facts into its own business views, but projections are not a second implementation of the underlying gateway feature.

## 4. What remains our product

The business service owns capabilities that generic gateways do not understand:

- WorkScope and Position structure;
- Employee identity (`Supplier x SupplierModel`);
- Employment history and procurement semantics;
- Appointment and StaffingRule policy;
- role/capability qualification;
- DispatchDecision: which Employee should staff a Position;
- business-level Employment selection;
- DutySession and StaffingSegment history;
- Run/runtime correlation;
- Employee/Position career statistics;
- allocated subscription cost and market-value accounting;
- business audit/explanation;
- Office/Organization/Operations projections and animation semantics.

## 5. Three routing layers

Routing is intentionally split into three levels.

```text
Position / DutySession
        |
        | staffing policy
        v
Employee
        |
        | procurement/business route policy
        v
Employment
        |
        | GatewayExecutionPort
        v
Gateway logical route
        |
        | generic gateway routing
        v
physical deployment / Channel
        |
        v
provider
```

### Layer A — staffing

Owned by Hermes domain.

Question:

> Which Employee should do this job?

Changing this layer opens/closes StaffingSegments and is a business event.

### Layer B — Employment selection

Owned by Hermes domain or a deterministic business route policy.

Question:

> Through which current Employment may this Employee be used for this invocation?

This layer is where subscription preference, fixed-cost utilization, contract constraints, and cross-account policy belong.

Changing Employment does **not** change Employee or StaffingSegment, but it must be recorded on InvocationAttempt.

### Layer C — physical gateway routing

Owned by the gateway.

Question:

> Within the selected Employment route, which concrete deployment/channel should carry this physical request?

Retry/load balancing inside this boundary does not change business staffing identity.

## 6. Failover ownership

Canonical levels:

```text
G0 same logical Employment route, gateway retries the request
G1 same Employment, gateway chooses another equivalent deployment/channel
B2 Hermes chooses another Employment for the same Employee
B3 Hermes dispatches another appointed Employee
B4 Hermes considers another qualified Employee permitted by policy
B5 explicit escalation / operator decision
```

The gateway must never silently perform B2-B5.

A LiteLLM model group should therefore normally represent **one Employment route**, not all Employments or all Employees that happen to expose the same canonical model.

## 7. Logical gateway naming

Recommended generated gateway model/group name:

```text
employment:<employment-id>
```

Example:

```text
employment:empl_01K...
  -> deployment A
  -> deployment B
```

Both deployments must represent routes that are business-equivalent under that Employment.

Do not create one LiteLLM model group containing deployments for different Employees. Avoid mixing different Employments unless the domain has explicitly declared them commercially interchangeable and the adapter can still report the selected Employment accurately.

`position:*` remains a product/domain logical identity. It should not be implemented as a static gateway fallback group that is allowed to select arbitrary Employees.

The migration-era CPA `position:*` aliases were retired on 2026-08-16. Current physical routing uses Employment-scoped bindings/aliases; Position staffing decisions remain in the V2 domain and are never delegated to a static gateway fallback group.

## 8. Gateway ports

### GatewayExecutionPort

Minimum conceptual contract:

```text
resolveRoute(employmentId) -> GatewayRouteRef | UNROUTABLE
getRouteHealth(routeRef) -> GatewayHealth
getRouteCapabilities(routeRef) -> capabilities
```

The runtime may invoke the gateway directly using the returned logical route, or an adapter/facade may proxy the request. The business layer does not need to transform provider payloads.

### GatewayDiscoveryPort

```text
discover() -> GatewayDiscoverySnapshot
```

Snapshot may contain:

- gateway route/deployment references;
- supplier/model hints;
- protocols;
- health evidence;
- model capabilities advertised by the gateway/provider;
- non-secret account/agreement hints;
- quota/spend evidence when available.

Discovery evidence is normalized into Supplier/SupplierModel/Employment/Channel projections. It never becomes canonical identity merely because the gateway used a particular row ID.

### GatewayUsagePort

```text
streamUsage(callback) | pullUsage(cursor)
```

Normalized evidence should include, where available:

- gateway request/trace ID;
- logical gateway route;
- selected physical deployment;
- model/provider identity;
- token counts;
- latency;
- status/error class;
- gateway/provider cost;
- timestamps.

The Usage Adapter attaches these physical facts to ModelInvocation/InvocationAttempt and business context.

### GatewayProvisioningPort — optional capability

Provisioning is intentionally separate from execution/discovery and is now implemented for the LiteLLM reference adapter. It exists only for explicit supplier onboarding; discovery never creates workforce identity.

```text
provisionRoute(
  Employment,
  upstream model/base URL,
  ephemeral credential material
) -> GatewayRouteRef
```

The domain derives the public route as `employment:<employmentId>`. The LiteLLM adapter stores one reusable encrypted Credential Store record per SupplyAgreement and makes each DB-backed model deployment reference that credential. Secret material is never written to V2 business persistence or the idempotency cache.

The core V2 domain still works when this capability is absent; operators may manage a gateway natively and bind already-existing routes. Generic gateway administration remains outside the product domain.

## 9. Secrets

The preferred rule is stronger than the previous design:

> V2 business persistence contains no gateway/provider secret reference unless a concrete adapter cannot work without an opaque reference.

Credentials belong to the selected gateway or an external secret manager.

The control service stores only safe route/deployment references and business metadata.

AI Office credential onboarding is implemented as an isolated provisioning flow with explicit redaction. Hermes remains the user-facing credential lifecycle; LiteLLM owns its encrypted gateway credential copy; the workforce database stores neither plaintext keys nor generic secret references.

## 10. Usage and accounting boundary

Gateway is authoritative for **physical request evidence it actually observed**.

Hermes domain is authoritative for **business attribution**.

```text
Gateway telemetry
  request/deployment/tokens/provider cost
        |
        v
Usage Adapter
        |
        + business correlation
        v
InvocationAttempt + UsageEntry
  Employee
  Employment
  Position
  DutySession
  Run
```

Do not recalculate provider token usage if trustworthy gateway/provider evidence already exists.

Hermes-specific calculations remain ours:

- allocated subscription/fixed cost;
- market value;
- lifetime Employee rollups;
- Position/WorkScope/Run attribution;
- role-aware performance.

## 11. LiteLLM mapping

Reference mapping:

```text
LiteLLM Proxy                  Hermes V2
------------------------------------------------------------
Proxy instance                 Gateway
model_name / model group       GatewayRouteRef for Employment
model deployment               Channel / physical route evidence
provider model                 SupplierModel evidence
request/spend log              InvocationAttempt/Usage evidence
provider credential            gateway-owned secret
router health/retry            G0/G1 physical routing evidence
```

This mapping is adapter-level. LiteLLM IDs are external references, never Hermes business IDs.

## 12. CPA mapping

CPA is a compatibility implementation of the same ports.

```text
CPA upstream/channel           Channel / GatewayRouteRef evidence
gatewayctl                     optional GatewayAdminPort implementation
CAP usage tracker              GatewayUsagePort evidence
logical aliases                compatibility routing mechanism
```

CPA-specific code should live under a CPA gateway adapter and should not leak into staffing, persistence schemas, API names, or event vocabulary.

## 13. CPA behind LiteLLM

For a special subscription/auth protocol that CPA supports and LiteLLM does not natively support well:

```text
Hermes
  -> LiteLLM reference gateway
      -> CPA compatibility upstream
          -> special provider/subscription
```

Use this only when it reduces complexity and preserves observability. It is not a mandatory topology.

## 14. Gateway acceptance contract

Every gateway adapter must prove:

1. request compatibility for protocols used by Hermes/Codex/OpenCode;
2. streaming correctness for supported request types;
3. cancellation/disconnect behavior is understood;
4. no cross-Employee or cross-Employment fallback occurs below the allowed boundary;
5. selected physical route can be identified sufficiently for accounting/audit;
6. token/usage evidence is reconcilable;
7. health failure produces explicit degraded/unroutable evidence;
8. credentials never enter Hermes business payloads/events/logs;
9. repeated discovery is idempotent at the normalized identity layer;
10. gateway outage does not corrupt Employee/Appointment history.

## 15. Architecture decision summary

1. Gateway choice is infrastructure, not domain identity.
2. LiteLLM Proxy is the reference implementation because it lets us delete generic gateway work from our backlog.
3. CPA remains supported only through an adapter/compatibility path unless later evidence justifies a broader role.
4. Business dispatch never delegates cross-Employee selection to a gateway.
5. Business route policy never delegates silent cross-Employment selection to a gateway.
6. Gateway model groups represent a selected Employment route and may load-balance only across business-equivalent physical deployments.
7. Usage is sourced from gateway/provider evidence and enriched with Hermes business attribution.
8. Gateway provisioning is an optional infrastructure capability separated from the core business service.
9. Runtime callers use a dedicated LiteLLM virtual key; the gateway master key is never written into OpenCode/Codex configuration.
