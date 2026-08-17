# Hermes AI Office V2 — Implementation Status

> Status date: 2026-08-17
> Scope: product/domain/architecture implementation for the AI-company model described by `DOMAIN-MODEL-V2.md` and `implementation-v2/*`.
> Rule: this document records what is deployed, what remains compatibility-only, and what must not be inferred from missing commercial evidence.

## 1. Current state

The V2 north-star architecture is the production business authority and public control-plane surface. The V1 runtime compatibility surface has been retired; historical V1 database evidence is retained read-only for audit/rollback archaeology.

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

## 2. Dynamic supplier onboarding and LiteLLM provisioning

The supplier UI now supports a compact CC-Switch-style flow: choose a preset provider or custom OpenAI-compatible URL, provide/reuse a key, discover models, select only the models that should become Employees, and choose the supplier default Employee. Unselected discovered models remain catalog evidence only and are not materialized as active workforce.

For custom OpenAI-compatible suppliers the deployed path is now end-to-end routable:

```text
Hermes credential lifecycle
  -> explicit Supplier/SupplierModel/Employee/Employment registration
  -> GatewayProvisioningPort
  -> LiteLLM Credential Store (one credential per SupplyAgreement)
  -> DB-backed employment:<employmentId> deployment
  -> Channel + GatewayBinding
  -> runtime selector
  -> OpenCode/Codex gateway provider
```

The production LiteLLM reference gateway now has a dedicated PostgreSQL technical-state database on loopback and `store_model_in_db=true`. A separate protected LiteLLM virtual runtime key is used by OpenCode/Codex; the master key never enters runtime configuration. The original static CPA-backed reference route remains compatibility-only and was not modified by dynamic provisioning.

A production integration smoke on 2026-08-17 used a temporary MCP/business database, provisioned a real LiteLLM Employment route, verified the route through the runtime key, completed one real upstream invocation, then deleted the temporary LiteLLM deployment and credential. The production workforce database was not polluted by smoke-test identities.

## 3. Persistence migrations deployed

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
| `011_runtime_launch_policy`  | persisted OpenCode/Codex runtime launch selection and audit              |

Production deployment uses a SQLite `.backup` before every new migration and validates `PRAGMA integrity_check` and `PRAGMA foreign_key_check` after restart.

## 4. Implemented execution invariants

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

## 5. Hermes execution projection

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

## 6. Purpose-built read models

Pixel Office reads V2 projections rather than joining domain tables itself.

### Workforce projection

Answers: who are our Employees, which Appointments do they hold, what work is actually staffed now, and what career usage can be attributed to each durable Employee? Gateway administration is intentionally absent from this employee-centric read model.

### Supply projection

`GET /api/v2/projections/supply` is the supplier-centric HR/commercial read model. It groups:

```text
Supplier
  → SupplierModel / Employee
  → Plan / SupplyAgreement
       → Employment
       → CapacityPool
       → mapped Channel evidence
       → GatewayBinding
```

Unmapped gateway Channels are returned separately as infrastructure evidence grouped by gateway/channel name. They do **not** become Supplier or Employee identity merely because a technical route exists.

Commercial identity is registered explicitly through the idempotent `supply-catalog.register` command. Registration may associate observed Channel evidence with a SupplyAgreement, but it does not create an Appointment and does not activate a dispatch binding unless that is explicitly requested.

### Office projection

Answers: what Positions exist, which are standing/run-scoped, which are staffed, which are working, and which only have runtime evidence?

Important status distinction:

- `WORKING`: a current StaffingSegment identifies an Employee.
- `RUNTIME_ACTIVE_UNATTRIBUTED`: runtime/duty evidence exists but no Employee attribution is asserted.

The latter never inflates staffed-position counts.

### Dossiers

- Position dossier: topology, appointments, duties, runtime sessions, qualification, evaluation and usage by Employee.
- Run dossier: positions, duties, staffing history, runtime graph, activity and usage.

## 7. Finance and performance evidence

The domain deliberately separates:

- `actualCost`: upstream/request cost evidence;
- `allocatedCost`: a share of a subscription/fixed commercial cost;
- `marketValue`: value calculated from a versioned reference price.

Reference-price changes and allocation re-runs are append-only overlays; closed UsageEntry facts are never rewritten.

Evaluation evidence is Position-aware. Performance is aggregated by Position/role context rather than declaring that a model has one universal quality score.

**Production policy:** when no reliable price, subscription cost or evaluation source exists, the system records no invented number. Zero/empty evidence is preferable to fabricated business truth.

## 8. Replayable operational governance

`v2_events` is append-only operational/domain evidence. Incidents are derived projections with checkpoints.

Implemented incident triggers include dispatch failure, invocation failure, execution-sync failure, runtime disappearance and usage-reconciliation mismatch.

Recovery can be automatic when the event stream proves recovery. Operator ACK/Resolve actions themselves become V2 events, so deleting and rebuilding the Incident projection preserves operator decisions.

## 9. Retention and maintenance

The default retention rule is intentionally conservative:

**Never automatically delete core business evidence.**

Supplier/Employee/Employment/Appointment/Run/Duty/Staffing/Invocation/Usage/Evaluation/Capability/Qualification/V2Event are retained until a future explicit archival policy is approved.

Automatic maintenance currently touches only:

1. expired `IdempotencyKey` replay-cache records;
2. crashed `ExecutionSyncRun` records left permanently `RUNNING`, which are repaired to `FAILED` with `STALE_SYNC_RUN`.

Deployments use a maintenance dry-run first. The normal background interval is daily.

## 10. V1 retirement state

V1 runtime compatibility was retired in production on 2026-08-16 after the V2 business model, execution sync, gateway discovery, Office projections, incident projection and maintenance path were already deployed and healthy.

The retirement removed:

- `ControlPlaneStore` and the legacy Provider/Channel/Worker/Assignment runtime model;
- all `/api/v1/*` routes and legacy V1 SSE;
- the former `/api/v2/compatibility/status` transition gate;
- Pixel Office `/api/model/workforce`, `/api/model/config`, `/api/model/events` and `/api/model/admin/*` compatibility facade;
- the legacy Channel/Worker/Assignment/Quota/Contract/Price management UI;
- CPA → V1 synchronization and assignment reconciliation;
- automatic `position:*` alias ownership/reconciliation;
- legacy `server.mjs`, `store.mjs`, `domain.mjs` and their characterization suites;
- legacy schema creation from `openDb()`.

The three old CPA aliases `position:hermes-brain`, `position:codex-general`, and `position:coding-review` were explicitly removed after the V2-only service restarted. The active `employment:*` V2 route remained intact. Observation for longer than the retired 60-second sync cadence confirmed the old aliases did not reappear.

The durable V2 gateway slug `cpa-compat` remains unchanged to preserve existing V2 foreign keys/bindings. Its name is now only an external reference; it does not imply a live V1 Worker compatibility model.

## 11. Historical data retention after retirement

Retirement removed code and public contracts, **not evidence**.

Before cutover an online SQLite backup was created at:

```text
/srv/hermes-personal/backups/model-control-plane/pre-v1-retirement-20260816T123818Z.sqlite
```

The pre-V2 tables remain physically present in the long-lived production database for rollback archaeology/historical evidence, but no running source reads or writes them. Their row counts were unchanged across cutover, including:

- providers: 1
- channels: 6
- model definitions: 13
- workers: 16
- positions: 3
- assignments: 36
- legacy events: 81,669
- external usage snapshots: 7

A fresh database does not create those tables. `openDb()` now only opens SQLite/applies pragmas; migrations `001_spine` through `011_runtime_launch_policy` are the sole schema owner.

## 12. Verification gate used for every batch

A batch is releasable only after:

1. focused domain tests;
2. MCP TypeScript type-check, build and full test suite;
3. root/server/webview type-check and full tests;
4. production build;
5. `git diff --check` and pre-commit secret scan;
6. Git commit + push;
7. SQLite backup before migration/cutover risk;
8. service restart and health/migration assertion;
9. direct V2 and Office proxy read checks;
10. workforce identity invariants;
11. SQLite integrity and foreign-key checks;
12. browser verification for material UI changes where Playwright is available.

## 13. V1-retirement production verification — 2026-08-16

The cutover was verified against the running oracle2 services:

- `hermes-model-control-plane.service`, `hermes-office.service`, and `hermes-office-bridge.service` remained active;
- MCP root health now declares `apiVersion: 2`, and `/api/v2/health` reports migrations through `011_runtime_launch_policy`;
- `/api/v1/snapshot`, `/api/v1/dashboard/workforce`, and the old compatibility-status endpoint return 404;
- Office unknown `/api/*` paths no longer fall through to `index.html`, so retired `/api/model/workforce`, `/api/model/config`, `/api/model/events`, and `/api/model/admin/*` return JSON 404;
- Hermes execution synchronization continued after cutover with completed sync runs and no issues;
- V2 Workforce continued to report exactly one durable Employee/Employment;
- V2 gateway discovery remained healthy for both `cpa-compat` and `litellm-reference`;
- the three old `position:*` CPA aliases were removed and remained absent after more than 60 seconds, while the `employment:*` route remained present;
- V1 systemd sync/alias environment variables and the Office admin environment variable were removed;
- a production-source audit found no `/api/v1`, old Office facade, `ControlPlaneStore`, legacy sync/alias environment variables, or compatibility-audit implementation references;
- legacy SQLite table row counts were identical before and after cutover;
- `PRAGMA integrity_check` returned `ok` and `PRAGMA foreign_key_check` returned no rows.

Final automated gates for the retirement release were MCP **86/86**, Webview **55/55**, Server **461/461**, and package-contract **7/7**, plus TypeScript checks, lint (with only the pre-existing App hook warning), production builds, generated-file drift checks, `git diff --check`, and gitleaks.

The host still has no Chrome/Chromium executable for Playwright, so this release does not claim a browser screenshot pass. UI acceptance is based on the Webview suite, production build and live HTTP facade behavior.

## 14. Remaining work classification

There is no live V1 compatibility runtime left to retire. Future work is normal V2 product evolution: richer supply discovery, additional staffing policy, evaluation/analytics, gateway adapters, and UI ergonomics. Reintroducing a V1 Worker/Assignment authority path or a generic Office gateway-admin proxy would be an architectural regression.

## 15. AI Company console and supplier catalog — 2026-08-16

The former single long Organization page has been split into first-class product sections:

```text
Overview | Organization | Workforce | Suppliers | Operations | Incidents
```

- **Overview** summarizes WorkScopes, Positions, Employees, HR Suppliers and attention items.
- **Organization** groups Positions by WorkScope and keeps Appointment/Runtime evidence on each seat.
- **Workforce** is Employee-centric and no longer mixes Gateway inventory into the employee list.
- **Suppliers** exposes the Supplier → Agreement/Plan → Employment/Employee → infrastructure chain.
- **Operations** owns Hermes Profile/Run/runtime observations that previously appeared below the business panels.
- **Incidents** remains the replayable operational problem view.

A production catalog reconciliation explicitly registered high-confidence commercial sources without altering staffing:

- OpenCode / OpenCode Go: DeepSeek V4 Flash and DeepSeek V4 Pro;
- Kiro: Claude Sonnet 4.5, Claude Opus 4.6 and Claude Haiku 4.5;
- AnyRouter: Claude Opus 5, Claude Opus 4.7 and Claude 3.7 Sonnet.

At verification time the production catalog contained 4 Suppliers, 9 Employees, 9 current Employments, 4 active SupplyAgreements, 1 Plan and only 1 current Appointment. The new catalog entries therefore expanded HR visibility without changing the active Coding Reviewer assignment or creating new dispatch bindings.

`nico-free-deepseek` and unclassified `planner-pool` physical routes remain technical evidence where commercial identity is not sufficiently proven. Missing commercial evidence is displayed as unclassified rather than guessed.

The LiteLLM route deployment script was also decoupled from business bootstrap. It now validates and binds an already-existing CURRENT Employment; it cannot create Supplier/Employee/Agreement/Appointment identity from a channel/model name. The standalone production bootstrap CLI was removed, and the MCP build cleans `dist/` before compiling so deleted runtime entrypoints cannot survive as stale artifacts.
