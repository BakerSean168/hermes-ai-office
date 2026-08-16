# Persistence Model V2

## 1. Persistence goals

The V2 persistence model must preserve durable identity, temporal history, immutable decision evidence, and compatibility with the existing SQLite deployment.

It must not collapse current state and history into the same mutable row when the history is business-relevant.

## 2. Storage strategy

For the next implementation phase:

- continue using SQLite with WAL and foreign keys;
- create V2 tables alongside V1 tables;
- use opaque IDs such as `emp_<ULID>`;
- store timestamps as integer epoch milliseconds or one consistently selected unit;
- avoid raw secrets entirely;
- do not mirror LiteLLM/CPA internal configuration databases; persist only safe gateway references/evidence needed by the business model;
- use JSON only for extensible metadata/evidence, not for relationships that require joins or constraints.

Recommended schema namespace is table-prefix based because SQLite has no schemas:

```text
v2_work_scopes
v2_roles
v2_positions
...
```

This avoids accidental collision with legacy `positions`, `workers`, and `assignments` during dual operation.

## 3. Organization tables

### `v2_work_scopes`

```text
id PK
slug UNIQUE
name
lifecycle                 // ACTIVE | PAUSED | ARCHIVED
external_profile_ref?
metadata_json
created_at
updated_at
archived_at?
```

Indexes:

- unique slug;
- lifecycle.

### `v2_role_definitions`

```text
id PK
slug UNIQUE
name
description
category?
metadata_json
created_at
updated_at
```

### `v2_position_templates`

```text
id PK
slug UNIQUE
role_id FK
name
runtime_kind?
lifecycle
requirement_set_id?
metadata_json
created_at
updated_at
```

### `v2_positions`

```text
id PK
work_scope_id FK?
role_id FK
position_template_id FK?
slug
name
lifecycle                 // PLANNED | ACTIVE | PAUSED | RETIRED | ARCHIVED
runtime_kind?
requirement_set_id FK?
created_from_run_id?
metadata_json
created_at
updated_at
retired_at?
archived_at?
```

Uniqueness should be explicit, for example `(work_scope_id, slug)` where appropriate. Run-scoped positions may require generated slugs and must not rely on human names for identity.

### `v2_position_relations`

```text
id PK
from_position_id FK
to_position_id FK
relation_type             // SUPERVISES | REVIEWS | DELEGATES | DEPENDS_ON
lifecycle
metadata_json
created_at
ended_at?
```

Do not encode supervision by Employee ID.

## 4. Workforce Supply tables

### `v2_model_definitions`

May initially reference/copy legacy `model_definitions`, but V2 should own a canonical mapping record.

```text
id PK
canonical_key UNIQUE
display_name
publisher_id?
context_window?
metadata_json
created_at
updated_at
```

### `v2_suppliers`

```text
id PK
slug UNIQUE
name
kind
lifecycle
metadata_json
created_at
updated_at
```

### `v2_supplier_models`

Durable supplier-scoped model identity.

```text
id PK
supplier_id FK
model_definition_id FK
supplier_model_key
aliases_json
display_name
lifecycle                 // ACTIVE | RETIRED
first_seen_at
retired_at?
metadata_json
UNIQUE(supplier_id, supplier_model_key)
```

Alias reconciliation must not silently change `id`.

### `v2_plans`

```text
id PK
supplier_id FK
slug
name
commercial_type
terms_json
lifecycle
created_at
updated_at
UNIQUE(supplier_id, slug)
```

### `v2_supply_agreements`

```text
id PK
supplier_id FK
plan_id FK?
external_account_ref?
lifecycle                 // PENDING | ACTIVE | SUSPENDED | EXPIRED | TERMINATED | ARCHIVED
valid_from
valid_to?
fixed_cost?
currency?
billing_period?
metadata_json
created_at
updated_at
ended_at?
archived_at?
```

No provider credential or gateway secret reference is required in this business table. Gateway-owned credential/configuration stays in the gateway or external secret manager.

### `v2_model_offerings`

```text
id PK
supplier_id FK
supplier_model_id FK
plan_id FK?
supply_agreement_id FK?
lifecycle
advertised_capabilities_json
protocol_options_json
commercial_metadata_json
valid_from?
valid_to?
created_at
updated_at
```

### `v2_employees`

```text
id PK
supplier_id FK
supplier_model_id FK
display_name
record_lifecycle          // ACTIVE | RETIRED | ARCHIVED
first_seen_at
retired_at?
archived_at?
archive_reason?
metadata_json
created_at
updated_at
UNIQUE(supplier_id, supplier_model_id)
```

There is no `supply_agreement_id` on Employee.

### `v2_employments`

Temporal commercial relationship.

```text
id PK
employee_id FK
supply_agreement_id FK
model_offering_id FK?
status                    // SCHEDULED | CURRENT | SUSPENDED | ENDED
effective_from
effective_to?
ended_reason?
created_at
updated_at
```

Recommended constraints:

- `effective_to > effective_from` when non-null;
- prevent duplicate overlapping CURRENT Employment for the exact same employee/agreement unless a real business case requires it;
- historical rows are closed, not overwritten.

### `v2_gateways`

Registry of gateway adapters known to the domain service. This stores safe connection/reference metadata only, never provider credentials.

```text
id PK
slug UNIQUE
kind                      // LITELLM | CPA | DIRECT | OTHER
display_name
base_url_hint?            // non-secret administrative hint only
capabilities_json
lifecycle                 // ACTIVE | DEGRADED | DISABLED | RETIRED
last_seen_at?
metadata_json
created_at
updated_at
```

### `v2_gateway_bindings`

Infrastructure mapping from a business Employment to a logical route exposed by one Gateway. This is the authoritative mapping used by `GatewayExecutionPort.resolveRoute(employmentId)`.

```text
id PK
employment_id FK
gateway_id FK
external_route_ref
protocol
lifecycle                 // ACTIVE | DISABLED | RETIRED
priority                  // deterministic business-side route preference
metadata_json             // non-secret evidence only
created_at
updated_at
UNIQUE(employment_id, gateway_id, external_route_ref)
```

A GatewayBinding is not Employee identity, Employment identity, or physical deployment identity. It may survive changes in the gateway's internal deployment pool as long as `external_route_ref` preserves the same business Employment semantics.

The first V2 vertical slice may use GatewayBinding without materializing physical Channel rows.

### `v2_channels`

Safe projection of a physical gateway route/deployment. It is not the gateway configuration source of truth.

```text
id PK
supply_agreement_id FK
gateway_id FK
external_route_ref
name
protocol
endpoint_hint?            // non-secret only
lifecycle                 // DISABLED | ENABLED | QUARANTINED | ARCHIVED
health                    // UNKNOWN | HEALTHY | DEGRADED | UNHEALTHY
last_test_json?
latency_stats_json?
last_checked_at?
metadata_json
created_at
updated_at
UNIQUE(gateway_id, external_route_ref)
```

A derived relation determines which Employees are reachable through a Channel by joining agreement -> Employment. V2 does not mirror LiteLLM/CPA provider credentials, retry configuration, or full deployment configuration.

### `v2_capacity_pools`

```text
id PK
supply_agreement_id FK
name
dimension                 // TOKENS | REQUESTS | COST | CONCURRENCY | CUSTOM
limit_value?
remaining_value?
unit?
reset_policy_json?
reset_at?
lifecycle
source
metadata_json
updated_at
```

## 5. Capability and staffing tables

### `v2_capability_definitions`

```text
id PK
slug UNIQUE
name
value_type
unit?
metadata_json
```

### `v2_capability_claims`

```text
id PK
subject_type
subject_id
capability_id FK
value_json
source                    // DECLARED | MEASURED | MANUAL | INFERRED
confidence?
observed_at?
expires_at?
evidence_json?
```

Use application validation for polymorphic subject references unless separate claim tables are preferable.

### `v2_requirement_sets`

```text
id PK
name
requirements_json
version
created_at
```

Requirement sets should be immutable/versioned once used by a recorded QualificationAssessment or DispatchDecision.

### `v2_qualification_assessments`

Append-only evidence:

```text
id PK
employee_id FK
position_id FK
requirement_set_id FK?
qualified INTEGER
reasons_json
effective_capabilities_json
input_version_refs_json
evaluated_at
```

### `v2_staffing_rules`

```text
id PK
name
employee_selector_json
position_selector_json
appointment_class
priority
effective_from
effective_to?
lifecycle
provenance_json
created_at
updated_at
```

### `v2_appointments`

```text
id PK
employee_id FK
position_id FK
class                     // PRIMARY | BACKUP | RESERVE
priority
status                    // SCHEDULED | CURRENT | SUSPENDED | ENDED | REVOKED
effective_from
effective_to?
source_rule_id FK?
source
ended_reason?
created_at
updated_at
```

Indexes:

- `(employee_id, status, effective_from)`;
- `(position_id, status, priority)`.

### `v2_staffing_constraints`

```text
id PK
scope_type
scope_id?
constraint_type
strength                  // HARD | SOFT
expression_json
lifecycle
created_at
updated_at
```

### `v2_dispatch_decisions`

Immutable audit record:

```text
id PK
duty_session_id FK
selected_employee_id FK?
selected_appointment_id FK?
policy_version
candidate_results_json
decided_at
trigger
correlation_id?
```

Candidate evidence is stored because selection must remain explainable after current health/priority changes.

## 6. Execution and ledger tables

### `v2_tasks`

```text
id PK
work_scope_id FK?
external_task_ref?
title
status
origin
metadata_json
created_at
updated_at
completed_at?
```

### `v2_runs`

```text
id PK
task_id FK?
work_scope_id FK?
external_run_ref?
status
started_at
completed_at?
metadata_json
created_at
updated_at
```

### `v2_duty_sessions`

```text
id PK
run_id FK
position_id FK
lifecycle
current_activity
opened_at
closed_at?
close_reason?
metadata_json
```

Indexes:

- `(run_id, lifecycle)`;
- `(position_id, lifecycle)`.

### `v2_staffing_segments`

```text
id PK
duty_session_id FK
employee_id FK
appointment_id FK?
dispatch_decision_id FK
started_at
ended_at?
ended_reason?
```

Invariant: normally at most one open StaffingSegment per DutySession. If future collaborative co-staffing is desired, introduce an explicit mode rather than accidentally allowing overlap.

Employee may have many open StaffingSegments across duties.

### `v2_runtime_sessions`

```text
id PK
duty_session_id FK
runtime_kind
external_session_id?
pid?
cwd?
workspace?
worktree?
branch?
started_at
ended_at?
metadata_json
```

### `v2_activity_events`

Append-only:

```text
seq INTEGER PK AUTOINCREMENT
id UNIQUE
runtime_session_id FK?
duty_session_id FK
kind
payload_json
occurred_at
source
```

Retention may be shorter than business history, but summaries needed by audits must survive compaction.

### `v2_model_invocations`

```text
id PK
run_id FK
duty_session_id FK
runtime_session_id FK?
logical_position_id FK
status
requested_at
completed_at?
correlation_id?
metadata_json
```

### `v2_invocation_attempts`

```text
id PK
invocation_id FK
attempt_number
employee_id FK
employment_id FK
supply_agreement_id FK
channel_id FK?
gateway_id FK?
gateway_request_ref?
gateway_deployment_ref?
model_offering_id FK?
outcome
error_class?
latency_ms?
started_at
ended_at?
metadata_json
UNIQUE(invocation_id, attempt_number)
```

### `v2_usage_entries`

Append-only accounting fact:

```text
id PK
invocation_attempt_id FK
run_id FK
duty_session_id FK
position_id FK
employee_id FK
supplier_id FK
employment_id FK
supply_agreement_id FK
model_definition_id FK
supplier_model_id FK
model_offering_id FK?
channel_id FK?
gateway_id FK?
input_tokens
output_tokens
cache_read_tokens
cache_write_tokens
reasoning_tokens
actual_cost
allocated_cost
market_value
currency
occurred_at
source
metadata_json
```

Indexes should support rollups by:

- employee/time;
- employment/time;
- position/time;
- work scope via position join;
- agreement/time;
- run/time.

### `v2_evaluations`

```text
id PK
subject_type
subject_id
role_id?
position_id?
employee_id?
dimensions_json
source
recorded_at
metadata_json
```

## 7. Business event store

Use one append-only table:

```text
v2_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  aggregate_version INTEGER,
  correlation_id TEXT,
  causation_id TEXT,
  payload_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  schema_version INTEGER NOT NULL
)
```

`seq` is transport ordering for one control-plane instance. `event_id` is globally durable identity.

## 8. Projection tables

Start with on-demand SQL projections where inexpensive. Materialize only expensive/high-frequency views.

Potential materialized tables later:

```text
v2_employee_summary
v2_position_summary
v2_workforce_availability
v2_office_current_state
v2_usage_daily_rollup
```

Materialized projections are rebuildable and never the source of truth.

## 9. Temporal rules

1. Current state is derived from temporal rows, not inferred by deleting history.
2. Closing an Employment/Appointment/StaffingSegment sets end/status fields; do not overwrite its beginning.
3. Correcting bad historical facts should create an explicit correction/audit event and preserve prior evidence where feasible.
4. SupplyAgreement end does not automatically end Appointment.
5. Employee archive does not cascade-delete Usage, Appointment, Employment, StaffingSegment, or Evaluation.

## 10. V1 compatibility mapping

| V1                  | V2 target                                          | Notes                                                                         |
| ------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `providers`         | Supplier                                           | provider may also contain publisher-like semantics; classify during migration |
| `channels`          | SupplyAgreement + Channel                          | infer agreement/account boundary conservatively                               |
| `model_definitions` | ModelDefinition                                    | preserve IDs as external refs, not necessarily V2 IDs                         |
| `workers`           | SupplierModel + Employee + Employment reachability | deduplicate legacy channel-specific workers                                   |
| `profiles`          | WorkScope + Profile Lead Position                  | preserve profile slug                                                         |
| `positions`         | Position                                           | expand semantics                                                              |
| `assignments`       | Appointment migration input                        | active/standby is not final V2 routing state                                  |
| `quotas`            | CapacityPool                                       | may remain channel-scoped when truly route-specific                           |
| `contracts`         | SupplyAgreement commercial terms                   | create/merge conservatively                                                   |
| `runs`              | Run + partial legacy staffing hints                | do not fabricate DutySessions unless evidence exists                          |
| `usage_ledger`      | legacy Usage fact / V2 import                      | preserve original IDs/source                                                  |
| `events`            | V1 event history                                   | do not rewrite as V2 facts without migration evidence                         |

## 11. Migration mechanics

Use a schema version table:

```text
v2_schema_migrations(version, name, applied_at, checksum)
```

Migrations must be idempotent at deployment level: already-applied versions are skipped; checksum mismatch is a hard failure.

Before destructive cleanup of V1 tables, require a separately approved future phase. V2 introduction itself is additive.

## Implemented persistence addendum — migrations 001–010

The production schema has advanced additively through `010_maintenance`. New durable areas include supply/capacity, finance/evaluation, qualification/staffing policy, organization topology, runtime projection, incidents/checkpoints, and maintenance history. Applied SQL migrations are checksum protected and must never be edited in place.

RuntimeSession and model hints are execution telemetry, not Employee identity. Finance recalculation uses append-only valuation/allocation overlays rather than rewriting closed UsageEntry facts. Core business evidence is retained by default; only expired idempotency cache is automatically deleted.
