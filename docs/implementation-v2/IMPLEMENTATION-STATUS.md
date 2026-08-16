# Hermes AI Office V2 — Implementation Status

> Status date: 2026-08-16
> Scope: product/domain/architecture implementation for the AI-company model described by `DOMAIN-MODEL-V2.md` and `implementation-v2/*`.
> Rule: this document records what is deployed, what remains compatibility-only, and what must not be inferred from missing commercial evidence.

## 1. Current state

The V2 north-star architecture is implemented as an additive business domain beside the protected V1 compatibility surface.

The current production shape is:

```text
Hermes runtime / Bridge
        │
        ▼
HermesProvider + OrgStore
(normalized execution facts)
        │ latest-wins sync
        ▼
AI Workforce Domain Service (Fastify + TypeScript + SQLite)
        │
        ├── Organization
        │   WorkScope → RoleDefinition → PositionTemplate → Position → PositionRelation
        │
        ├── Workforce Supply
        │   Supplier → Plan/Offering → SupplyAgreement → Employment → Employee
        │                                             └→ CapacityPool
        │
        ├── Staffing
        │   CapabilityClaim → RequirementSet → QualificationAssessment
        │   StaffingRule → Appointment → DutySession → StaffingSegment
        │   StaffingConstraint
        │
        ├── Execution
        │   Run → DutySession → RuntimeSession → RuntimeEdge / ActivityEvent
        │                    └→ ModelInvocation → InvocationAttempt → UsageEntry
        │
        ├── Finance / Performance
        │   ReferencePrice → UsageMarketValuation
        │   CostAllocationRun → CostAllocationEntry
        │   Evaluation
        │
        └── Operations
            V2Event → ProjectionCheckpoint → Incident
            MaintenanceRun / retention policy

Gateway Ports
  ├── LiteLLM reference gateway
  └── CPA compatibility gateway
```

The decisive semantic boundary is now enforced in code:

- **Position is the job/seat.**
- **Employee is durable Supplier × SupplierModel workforce identity.**
- **Employment is the commercial relationship/capacity source.**
- **Appointment means the Employee is authorized to hold a Position.**
- **DutySession means the Position is active for a Run.**
- **StaffingSegment records which Employee is actually on duty.**
- **RuntimeSession is Hermes/Subagent/Codex/OpenCode technical execution evidence.**
- `ExecutionNode.model` / `RuntimeSession.modelHint` is telemetry only and cannot create Employee identity.
- Gateway/Channel identity affects routability, never durable Employee identity.

## 2. Persistence migrations deployed

V2 uses immutable, checksum-verified additive migrations. Applied history must never be edited in place.

| Migration                    | Capability                                                               |
| ---------------------------- | ------------------------------------------------------------------------ |
| `001_spine`                  | V2 identity, supply, staffing, run/duty/invocation/usage/event spine     |
| `002_gateway_discovery`      | gateway discovery evidence                                               |
| `003_usage_reconciliation`   | gateway usage evidence and reconciliation                                |
| `004_supply_capacity`        | Plan, Offering and CapacityPool                                          |
| `005_finance_evaluation`     | reference prices, valuation, allocation and evaluation                   |
| `006_qualification_staffing` | capabilities, requirements, qualification, staffing rules/constraints    |
| `007_organization_topology`  | RoleDefinition, PositionTemplate, PositionRelation, run-scoped positions |
| `008_runtime_projection`     | RuntimeSession, RuntimeEdge, ActivityEvent and Hermes execution sync     |
| `009_incidents_checkpoints`  | replayable Incident projection and projection checkpoints                |
| `010_maintenance`            | safe maintenance run history and retention operations                    |

Production deployment uses a SQLite `.backup` before every new migration and validates `PRAGMA integrity_check` and `PRAGMA foreign_key_check` after restart.

## 3. Implemented execution invariants

### 3.1 Stable organization, replaceable staffing

Position relations belong to Position → Position. Replacing an Employee does not rewrite the organization graph.

Standing positions survive runs. Run-scoped positions, such as temporary Subagent/Codex/OpenCode execution seats, retain history but retire automatically when the owning Run reaches a terminal state.

### 3.2 Qualification is not a model-name allowlist

Eligibility composes independent evidence from Supplier, SupplierModel and Employee capability claims. Hard Position requirements are evaluated from the conservative effective capability. Staffing constraints are evaluated separately.

Dispatch order is therefore:

```text
Appointment/lifecycle
  → Qualification
  → Staffing constraints
  → Capacity
  → Employment route
  → Gateway availability/health
  → deterministic candidate ordering
```

`FIRST_SLICE_STATIC_QUALIFICATION` is no longer part of the dispatch path.

### 3.3 Failover semantics

- B2 failover: switch Employment/route while keeping the same Employee and StaffingSegment.
- B3 failover: replace Employee, close the previous StaffingSegment and open a new segment on the same DutySession/Run.
- Ending/suspending an Employment or Appointment redispatches affected active duties.
- If no valid candidate remains, stale staffing is closed and the Duty is blocked rather than pretending work continues.

### 3.4 Command idempotency

Run/Duty/Dispatch/Redispatch/Invoke and V2 control commands use persistent idempotency keys plus in-process single-flight.

- same key + same payload → original response replayed;
- same key + different payload → conflict;
- repeated Invoke does not make a second gateway call or create duplicate UsageEntry evidence.

## 4. Hermes execution projection

HermesProvider remains the normalizer for Bridge/native runtime data. Model Control Plane does **not** re-parse raw Bridge JSON.

Mapping:

```text
ProfileController → WorkScope + standing Profile Lead Position
Run               → V2 Run (`external_run_ref = hermes:<run-id>`)
ExecutionNode     → run-scoped Position + DutySession + RuntimeSession
ExecutionEdge     → RuntimeEdge and, where semantically valid, PositionRelation
```

Synchronization is failure-isolated, single-flight and latest-wins. A burst keeps the in-flight snapshot and only the newest pending snapshot. MCP unavailability cannot block Hermes execution; the next snapshot converges the projection.

A runtime disappearing from one current snapshot is retained historically and marked cancelled. If the same technical session reappears, a new DutySession is opened without fabricating a new Employee.

## 5. Purpose-built read models

Pixel Office reads V2 projections rather than joining domain tables itself.

### Workforce projection

Answers: who are our Employees, through which Employments, which Appointments do they hold, what work and usage can actually be attributed to them?

### Office projection

Answers: what Positions exist, which are standing/run-scoped, which are staffed, which are working, and which only have runtime evidence?

Important status distinction:

- `WORKING`: a current StaffingSegment identifies an Employee.
- `RUNTIME_ACTIVE_UNATTRIBUTED`: runtime/duty evidence exists but no Employee attribution is asserted.

The latter never inflates staffed-position counts.

### Dossiers

- Position dossier: topology, appointments, duties, runtime sessions, qualification, evaluation and usage by Employee.
- Run dossier: positions, duties, staffing history, runtime graph, activity and usage.

## 6. Finance and performance evidence

The domain deliberately separates:

- `actualCost`: upstream/request cost evidence;
- `allocatedCost`: a share of a subscription/fixed commercial cost;
- `marketValue`: value calculated from a versioned reference price.

Reference-price changes and allocation re-runs are append-only overlays; closed UsageEntry facts are never rewritten.

Evaluation evidence is Position-aware. Performance is aggregated by Position/role context rather than declaring that a model has one universal quality score.

**Production policy:** when no reliable price, subscription cost or evaluation source exists, the system records no invented number. Zero/empty evidence is preferable to fabricated business truth.

## 7. Replayable operational governance

`v2_events` is append-only operational/domain evidence. Incidents are derived projections with checkpoints.

Implemented incident triggers include dispatch failure, invocation failure, execution-sync failure, runtime disappearance and usage-reconciliation mismatch.

Recovery can be automatic when the event stream proves recovery. Operator ACK/Resolve actions themselves become V2 events, so deleting and rebuilding the Incident projection preserves operator decisions.

## 8. Retention and maintenance

The default retention rule is intentionally conservative:

**Never automatically delete core business evidence.**

Supplier/Employee/Employment/Appointment/Run/Duty/Staffing/Invocation/Usage/Evaluation/Capability/Qualification/V2Event are retained until a future explicit archival policy is approved.

Automatic maintenance currently touches only:

1. expired `IdempotencyKey` replay-cache records;
2. crashed `ExecutionSyncRun` records left permanently `RUNNING`, which are repaired to `FAILED` with `STALE_SYNC_RUN`.

Deployments use a maintenance dry-run first. The normal background interval is daily.

## 9. V1 compatibility and retirement state

V1 is intentionally still present as a compatibility layer. It is **not** business authority for V2 concepts.

`GET /api/v2/compatibility/status` is the machine-readable cutover gate.

The production mode is currently expected to be `DUAL_RUN`, because:

- CPA discovery/sync still maintains the V1 Provider/Channel/Worker compatibility model;
- `position:*` aliases are still reconciled through the compatibility control plane;
- `/api/v1/*` and `/api/model/*` remain protected consumer contracts;
- V1 Worker (`Channel × Model`) is semantically different from V2 Employee and must never be numerically equated.

Retirement becomes permissible only when **all** blockers are removed, all technical gates are green, every protected consumer has migrated, and explicit cutover approval is present.

This means keeping V1 today is an intentional safe architecture state, not an unfinished V2 domain implementation.

## 10. Verification gate used for every batch

A batch is releasable only after:

1. focused domain tests;
2. MCP TypeScript type-check, build and full test suite;
3. root/server/webview type-check and full tests;
4. production build;
5. `git diff --check` and pre-commit secret scan;
6. Git commit + push;
7. SQLite backup before migration;
8. service restart and health/migration assertion;
9. direct V2 and Office proxy read checks;
10. workforce identity invariants;
11. SQLite integrity and foreign-key checks;
12. browser verification for material UI changes where Playwright is available.

## 11. Remaining work classification

There is no remaining hidden first-slice stub in the V2 business model that requires inventing a new identity model.

Remaining work is operational cutover, not another V2 rewrite:

- migrate remaining V1/CPA compatibility consumers when their replacements are proven;
- intentionally disable V1 sync/alias ownership only after the compatibility endpoint reports no blockers;
- perform the final V1 public-contract retirement as a separately approved release.

Until then, dual-run is the correct production state.

## 12. Production verification snapshot — 2026-08-16

The 008–010 release was verified against the running oracle2 services after an online SQLite backup:

- `hermes-model-control-plane.service`, `hermes-office.service`, and `hermes-office-bridge.service` are active;
- `/api/v2/health` reports all ten checksum-verified migrations through `010_maintenance`;
- HermesProvider continuously forwards normalized OrgStore snapshots and completed `ExecutionSyncRun` records are observed;
- seven Hermes Profiles were projected into WorkScopes/Profile Lead Positions while the durable Employee count remained exactly one, proving runtime/model hints did not create employees;
- the Office facade returns JSON for `/api/model/v2/projections/office` and `/api/model/v2/incidents` rather than falling through to the SPA;
- Incident projection checkpoint refresh is part of compatibility-status evaluation, so the technical checkpoint gate is evaluated against a current projection;
- the maintenance release check was executed with `dryRun=true` and reported zero deletions/repairs;
- `PRAGMA integrity_check` returned `ok` and `PRAGMA foreign_key_check` returned no rows;
- `GET /api/v2/compatibility/status` reports every technical gate green while the intentional V1 blockers remain, so production correctly stays `DUAL_RUN`.

Webview unit tests (55), server tests (460), package-contract tests (7), MCP tests (97), TypeScript checks, lint, production builds, generated-file drift checks, and gitleaks all passed during the release sequence. The host does not currently have a Chrome/Chromium binary installed for Playwright, so this release does **not** claim a new browser screenshot pass; UI acceptance is limited to the automated Webview suite, production build, and live HTTP facade checks.
