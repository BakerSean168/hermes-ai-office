# Implementation Roadmap V2

## 1. Goal

Implement Domain Model V2 with the **smallest custom system that preserves Hermes-specific business value**.

The roadmap is intentionally gateway-neutral. Current CPA production traffic is protected during migration, while LiteLLM Proxy is the reference implementation for the new Gateway Ports.

The key simplification is:

> We build organizational identity, staffing, history, attribution, and projections. We do not build a generic AI gateway.

## 2. Protected contracts throughout

- current `/api/v1/*` semantics;
- Pixel `/api/model/*` compatibility;
- Hermes Bridge endpoints/SSE;
- current CPA production path until explicit cutover;
- current service ports until deployment migration is approved;
- current logical aliases until explicitly migrated;
- existing historical usage totals;
- no raw provider/gateway secret persistence in V2 business state/events/UI.

## 3. Work deliberately removed from our backlog

Unless contract tests prove a gateway cannot supply it, do not implement custom generic versions of:

- provider protocol transformation;
- generic streaming adaptation;
- generic provider retries;
- same-Employment deployment load balancing;
- generic gateway auth/rate limits;
- generic gateway spend logging;
- provider credential vaulting;
- generic provider error normalization;
- a second gateway admin dashboard.

LiteLLM/other gateway adapters normalize these capabilities through Gateway Ports.

## Phase 0 — Baseline and gateway contract

### Objective

Freeze current behavior and define the replaceable gateway boundary before new domain code.

### Tickets

#### V2-000 — Capture current compatibility fixtures

Capture non-secret V1 schema, workforce projections, current position aliases, current CPA route inventory, and aggregate usage baselines.

#### V2-001 — Gateway adapter contract test kit

Create fixture-driven tests for:

- discovery normalization;
- route health;
- request/stream compatibility assumptions;
- selected deployment evidence;
- usage normalization;
- no cross-Employment fallback;
- secret redaction.

#### V2-002 — Gateway Ports types

Define `GatewayExecutionPort`, `GatewayDiscoveryPort`, `GatewayUsagePort`, and optional `GatewayAdminPort` without LiteLLM/CPA types leaking into domain code.

### Acceptance

- current system unchanged;
- adapter contract can be tested against recorded fixtures;
- core domain imports no CPA/LiteLLM implementation type.

## Phase 1 — Reference gateway + minimal V2 foundation

### Objective

Prove the infrastructure boundary and V2 schema with minimal code.

### Tickets

#### V2-100 — LiteLLM reference adapter

Implement discovery/route/usage normalization against a controlled LiteLLM Proxy instance or deterministic fixture harness.

Do not build UI or migrate production traffic yet.

#### V2-101 — CPA compatibility adapter

Wrap existing CPA/gatewayctl/discovery/usage behavior behind the same Gateway Ports. Preserve current secret boundary.

#### V2-102 — V2 schema migration framework

Introduce versioned additive `v2_*` schema with migration checksums and transaction helpers.

#### V2-103 — Core workforce schema

Supplier, SupplierModel, Employee, Plan, SupplyAgreement, ModelOffering, Employment, Gateway, Channel/route projection, CapacityPool.

#### V2-104 — Organization/staffing/execution schema

WorkScope, Position, Appointment, DispatchDecision, DutySession, StaffingSegment, InvocationAttempt, UsageEntry, V2 events, and supporting types.

### Acceptance

- V1 unaffected;
- LiteLLM and CPA adapters satisfy the same contract at the normalized boundary;
- no provider credential is stored in V2 tables.

## Phase 2 — Stable workforce identity from gateway evidence

### Objective

Make `Supplier x SupplierModel -> Employee` real without changing runtime staffing.

### Tickets

#### V2-200 — Supplier/SupplierModel identity reconciler

Normalize discovery from any GatewayDiscoveryPort with provenance.

#### V2-201 — Stable Employee reconciliation

Enforce one durable Employee per Supplier + SupplierModel.

#### V2-202 — SupplyAgreement/Employment reconciliation

Represent current/historical commercial access without tying identity to gateway rows.

#### V2-203 — Gateway/Channel projection

Store only safe external route refs, health/capability evidence, and Employment relationship. Do not mirror gateway configuration or secrets.

#### V2-204 — Employee dossier query

Prove current/historical Employment and stable career identity.

#### V2-205 — V1 workforce compatibility projection

Compare V2-derived legacy shape against current V1 output.

### Acceptance

```text
same SupplierModel + new gateway/channel -> same Employee
same SupplierModel + new Agreement       -> same Employee + new Employment
same canonical model + different Supplier -> different Employee
```

## Phase 3 — Organization and staffing

### Objective

Represent jobs and long-lived appointments independently from gateways.

### Tickets

#### V2-300 — Profile -> WorkScope + Profile Lead mapping

#### V2-301 — Role/Position/PositionTemplate model

#### V2-302 — legacy Assignment -> Appointment migration

#### V2-303 — StaffingRule reconciliation

#### V2-304 — Qualification engine v1

Use explainable capability/protocol/context/supplier constraints. Generic gateway health is consumed as evidence, not reimplemented.

### Acceptance

Employee dossier shows Employments and Appointments as independent timelines.

## Phase 4 — One LiteLLM-first business vertical slice

### Objective

Make one controlled Position V2-authoritative without rebuilding gateway routing.

### Tickets

#### V2-400 — DutySession lifecycle

#### V2-401 — Employee DispatchDecision

Choose Employee using qualification, constraints, Appointment, and business policy.

#### V2-402 — Employment route policy

Choose one routable Employment for the selected Employee. Return a logical `employment:<id>` GatewayRouteRef.

#### V2-403 — StaffingSegment lifecycle

#### V2-404 — LiteLLM route binding

Bind the selected Employment route to one or more business-equivalent LiteLLM deployments. LiteLLM handles only G0/G1 retry/load balancing.

#### V2-405 — Business failover B2-B4

Test Employment switch and Employee redispatch above the gateway.

### Acceptance

One real or controlled duty explains:

- who was appointed;
- which Employee was selected and why;
- which Employment was selected and why;
- which physical deployment the gateway used;
- whether any failover was physical, commercial, or staffing-level.

## Phase 5 — Invocation and accounting

### Tickets

#### V2-500 — Invocation correlation context

Attach `runId`, `dutySessionId`, `employeeId`, and `employmentId` correlation to gateway calls without exposing business policy to the gateway.

#### V2-501 — Gateway usage adapter

Normalize gateway request/deployment/token/latency/cost evidence into InvocationAttempt facts.

#### V2-502 — UsageEntry business attribution

Add Employee/Employment/Position/Run dimensions plus allocatedCost/marketValue.

#### V2-503 — Usage reconciliation

Reconcile request-level V2 totals with selected gateway/provider aggregates. CPA totals are one migration baseline, not the permanent source.

#### V2-504 — Employee/Employment/Position statistics

### Acceptance

No duplicate token/cost calculation occurs when trustworthy gateway evidence exists; business attribution remains queryable independently of gateway product.

## Phase 6 — Runtime and Office projections

### Tickets

#### V2-600 — RuntimeSession correlation adapter

#### V2-601 — ActivityEvent normalization

#### V2-602 — Office projection

#### V2-603 — Organization/Operations projections

#### V2-604 — Gateway health/routability projection

Project normalized gateway evidence without making Office depend on LiteLLM/CPA payloads.

## Phase 7 — V2 API and frontend migration

### Tickets

#### V2-700 — `/api/v2` business queries

#### V2-701 — `/api/v2` business commands

Do not expose generic gateway configuration as core domain CRUD.

#### V2-702 — V2 events/SSE replay

#### V2-703 — Employee dossier UI

#### V2-704 — Position dossier UI

#### V2-705 — Workforce/Office integration

#### V2-706 — Optional Gateway Admin facade decision

Only implement if native LiteLLM/CPA administration is insufficient for an actual operator workflow. Keep it adapter-specific and isolated from domain persistence.

## Phase 8 — Cutover and hardening

### Tickets

#### V2-800 — gateway adapter parity report

#### V2-801 — restart/reconciliation hardening

#### V2-802 — concurrency and transaction tests

#### V2-803 — stale telemetry behavior

#### V2-804 — archive/retention jobs

#### V2-805 — event replay/load tests

#### V2-806 — migration discrepancy report

#### V2-807 — choose production gateway topology

Decision options:

- LiteLLM direct to supported providers;
- LiteLLM with CPA only for special upstreams;
- mixed Gateway Ports during transition;
- retain CPA adapter for a justified niche.

#### V2-808 — V1/legacy write retirement

### Acceptance

Production gateway choice can change without migrating Employee, Appointment, DutySession, or historical Usage identity.

## 4. Dependency order

```text
Phase 0 gateway contract
  -> Phase 1 adapters + schema
  -> Phase 2 stable workforce identity
  -> Phase 3 organization/staffing
  -> Phase 4 business vertical slice
  -> Phase 5 accounting
  -> Phase 6 projections
  -> Phase 7 API/UI
  -> Phase 8 cutover/hardening
```

## 5. Stop conditions

Create a decision record before work that would:

- make CPA or LiteLLM identifiers part of canonical Employee identity;
- let a gateway silently select another Employee;
- let a gateway silently cross Employment boundaries;
- persist provider credentials in V2 business tables/events;
- reimplement a generic gateway capability without a failed adapter requirement;
- break `/api/v1` or production CPA before parity evidence exists;
- invent historical request precision that was never observed;
- make UI the owner of a domain lifecycle.
