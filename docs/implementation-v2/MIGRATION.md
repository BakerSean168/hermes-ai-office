# Migration Plan V1 -> V2

## 1. Migration objective

Move from the deployed V1 identity model:

```text
provider
 -> channel
    -> worker = channel x model
position
 -> assignment -> worker
```

to V2:

```text
Supplier
 -> SupplierModel -> Employee
SupplyAgreement -> Employment -> Employee
SupplyAgreement -> Channel / CapacityPool
Position -> Appointment -> Employee
Run -> DutySession -> StaffingSegment -> Employee
Invocation -> Attempt -> Employment + Channel
```

without breaking the current Office, current CPA production routing, usage history, or secret boundary. CPA is treated as migration evidence/compatibility infrastructure, not as a V2 architectural prerequisite.

## 2. Migration strategy

Use an additive strangler migration:

```text
Phase A: V2 schema exists, V1 authoritative
Phase B: V2 discovery projection populated from current state
Phase C: selected V2 commands dual-write/bridge to V1 where required
Phase D: one vertical path becomes V2 authoritative
Phase E: V1 reads generated from compatibility projections
Phase F: V1 writes retired
Phase G: legacy tables retained read-only until explicit cleanup
```

Do not perform a one-shot destructive schema rewrite.

### Gateway migration is independent from business-data migration

Do not require a "CPA -> LiteLLM database migration" before V2 can exist. Instead:

```text
current CPA -> CPA Gateway Adapter ----\
                                      -> normalized V2 gateway evidence
LiteLLM     -> LiteLLM Gateway Adapter-/
```

A controlled V2 Position may use LiteLLM while other production traffic remains on CPA. Business tables never encode which gateway is permanent.

## 3. Protected baseline

Before migration code lands, capture:

- current V1 DB backup;
- V1 schema checksum;
- `/api/v1/dashboard/workforce` fixture;
- current `/api/model/workforce` fixture;
- current logical position aliases;
- current gateway/CPA route inventory without secrets;
- existing usage aggregate totals by worker/channel/model;
- current test commands/results.

## 4. Step 1 — Add the minimal V2 schema spine

Create `v2_schema_migrations` plus only the tables required by the first vertical slice. The implementation order is defined in `FIRST-VERTICAL-SLICE.md`; richer conceptual tables from `PERSISTENCE.md` are added later when their workflow is implemented.

The first slice does **not** require every V2 entity, physical Channel discovery, Capability/Qualification tables, StaffingRule DSL, CapacityPool, Evaluation, or full finance tables.

No V1 table is changed except optional indexes/metadata required for safe bridge operation.

Acceptance:

- service starts with the minimal empty V2 spine;
- future migrations can add deferred V2 tables without changing existing identities;
- V1 APIs return identical outputs;
- rolling back binary leaves V1 DB usable.

## 5. Step 2 — Classify legacy providers as Suppliers

Current `providers` rows are migration evidence.

Create/get V2 Supplier for each usable source.

Potential ambiguity:

- V1 provider may represent OpenAI/Anthropic model publisher;
- or an aggregator/service such as OpenCode/Kiro;
- or a generic `openai-compatible` provider label.

Migration rule: prefer operational Supplier identity—the entity supplying capacity to us. Store publisher mapping separately when known.

Never guess a high-confidence Supplier when evidence is weak; use provenance metadata.

## 6. Step 3 — Build SupplierModel and Employee identity

For each legacy worker:

```text
legacy worker
 -> legacy channel -> Supplier
 -> model definition / provider model key
 -> normalize supplier model key
 -> get/create SupplierModel
 -> get/create Employee UNIQUE(Supplier, SupplierModel)
```

### Deduplication

Legacy workers that differ only by Channel but resolve to the same Supplier + SupplierModel converge to one Employee.

Record mapping table or metadata:

```text
legacy_worker_id -> employee_id
```

Do not delete legacy workers.

### Ambiguous aliases

If `deepseek-v4-flash` and `ds-v4-flash` might be the same but evidence is uncertain:

- create separate provisional SupplierModels;
- mark reconciliation needed;
- do not silently merge history.

## 7. Step 4 — Infer SupplyAgreements and Employments

Current `channels` + `contracts` + adapter metadata are inputs.

Create SupplyAgreement conservatively around a real account/subscription/entitlement boundary.

Where several channels clearly share one account/subscription, they may share one SupplyAgreement.

Where evidence is missing, create an imported agreement per existing channel/account boundary rather than pretending commercial consolidation.

For each Employee reachable through that agreement, create CURRENT Employment.

Important: if future discovery shows the same Employee under a new agreement, create another Employment, not another Employee.

## 8. Step 5 — Migrate Channels and CapacityPools

Create V2 Channel for each legacy channel, preserving:

- external legacy channel ID;
- protocol;
- enabled/quarantine semantics;
- health;
- base URL hint only if non-secret;
- test metadata.

Map quotas/contracts into CapacityPools and SupplyAgreement terms.

If a quota is truly worker/model-specific, preserve that constraint through pool applicability metadata rather than forcing all quotas to be agreement-global.

## 9. Step 6 — Migrate Profiles and Positions

Each legacy profile becomes:

```text
WorkScope
+ Profile Lead Position when evidence supports a lead job
```

Existing model-control-plane positions become V2 Positions with legacy external refs.

Do not fabricate organizational relations that were not previously known.

## 10. Step 7 — Migrate assignments into Appointments

Legacy assignment is migration evidence, not a one-to-one semantic match.

Mapping guidance:

```text
legacy active   -> CURRENT PRIMARY Appointment
legacy standby  -> CURRENT BACKUP/RESERVE Appointment according to priority
legacy disabled -> ended/suspended or migration-only record depending evidence
```

Preserve:

- priority;
- effective dates;
- reason;
- legacy assignment ID as external reference.

Do not copy legacy `active` status into a permanent claim that this Employee handles every request.

## 11. Step 8 — Runtime/Run migration

Legacy runs can become V2 Run records where identity is trustworthy.

Historical DutySession/StaffingSegment creation is conservative:

- if legacy run has one worker/position with clear interval, a legacy-derived staffing record may be created with provenance;
- if exact employee switching or timings were not observed, do not invent them;
- mark `historicalPrecision = LEGACY_COARSE`.

Current live runtime observations should create precise V2 DutySession/StaffingSegment after the vertical slice is enabled.

## 12. Step 9 — Usage migration

Preserve V1 usage rows exactly as legacy accounting facts.

Options:

1. import into `v2_usage_entries` with `source = LEGACY_V1` and nullable invocation attempt when no request-level detail exists; or
2. keep a dedicated `v2_legacy_usage_facts` projection source.

Recommended implementation choice can be decided when coding, but **do not invent InvocationAttempt IDs for aggregate snapshots**.

Totals before/after migration must reconcile by:

- legacy worker;
- mapped Employee;
- channel/agreement;
- model;
- time window.

## 13. Step 10 — Introduce gateway-neutral discovery reconciliation

`GatewayDiscoveryPort` writes/reconciles V2 SupplierModel/Employee/Employment/Channel facts. The first production evidence may come from CPA; the reference V2 adapter is LiteLLM. Both must normalize through the same contract.

Identity tests must prove repeated sync is idempotent.

Key regression:

```text
same SupplierModel + new Channel -> same Employee
same SupplierModel + new Agreement -> same Employee + new Employment
same canonical model + different Supplier -> different Employee
```

## 14. Step 11 — V2 staffing vertical slice

Choose one existing Position, likely `hermes-brain` or a controlled non-critical position.

Enable:

- V2 Appointment;
- Qualification;
- DispatchDecision;
- DutySession;
- StaffingSegment;
- logical route resolution.

Keep V1 alias behavior as fallback/rollback.

## 15. Step 12 — Invocation/usage vertical slice

For the selected position:

- create ModelInvocation;
- record InvocationAttempts with Employee/Employment/Channel;
- record UsageEntry;
- compare totals with current gateway/provider evidence and the CPA/V1 aggregate baseline during migration.

Do not cut over accounting until reconciliation is demonstrated.

## 16. Step 13 — V2 projections

Build V2 workforce/employee/position projection first.

Then compatibility projection for current Pixel UI.

Only after compatibility is proven should frontend components migrate to `/api/v2/projections/*`.

## 17. Dual-write rules

Avoid generic bidirectional dual-write between V1 and V2; it creates conflict ownership.

Preferred patterns:

### V1 authoritative phase

```text
V1 command
 -> V1 write
 -> migration/reconciliation adapter derives V2
```

### V2 authoritative for a migrated capability

```text
V2 command
 -> V2 write
 -> compatibility projection/adapter updates required V1 surface
```

For each capability, document one authoritative writer.

## 18. Rollback

Rollback before V2 authority cutover:

- stop V2 reconciliation;
- deploy previous binary;
- V1 remains untouched/authoritative;
- retain V2 tables for diagnosis or drop only from backup-tested procedure.

Rollback after a V2 capability becomes authoritative:

- use feature flag/cutover record;
- restore compatibility adapter path;
- do not delete V2 facts generated while authoritative;
- if necessary, replay V2 facts into V1 compatibility state through an explicit repair tool.

## 19. Feature flags / cutover markers

Recommended flags:

```text
MODEL_CP_V2_SCHEMA=1
MODEL_CP_V2_GATEWAY_DISCOVERY=1
MODEL_CP_V2_READS=1
MODEL_CP_V2_STAFFING_POSITION_IDS=...
MODEL_CP_V2_INVOCATION_LEDGER=1
MODEL_CP_V2_GATEWAY_IDS=litellm-reference,cpa-compat
MODEL_CP_V2_COMPAT_PROJECTION=1
```

Prefer persisted migration/cutover records for permanent state; environment flags are operational controls, not historical evidence.

## 20. Gateway cutover rules

Gateway cutover is a deployment decision after adapter parity, not a domain migration step.

A position/employment route may move from CPA to LiteLLM only when:

- request/stream protocol behavior is characterized;
- usage/deployment evidence can be correlated;
- gateway retry is constrained to the selected Employment;
- rollback to the previous gateway route is tested;
- Employee/Employment/Appointment IDs remain unchanged.

Special CPA-only subscription routes may remain behind the CPA adapter or be exposed as an upstream behind LiteLLM. No business-table rewrite is required.

## 21. Data reconciliation checks

After each migration batch:

```text
legacy worker count
vs
employee count + dedup mapping

usage token totals V1
vs
V2 imported/projected totals

active legacy assignments
vs
current V2 appointments

legacy channel health
vs
V2 channel projection
```

Differences must be explainable by documented deduplication or semantic split.

## 22. Migration finding classes

```text
IDENTITY_AMBIGUITY
AGREEMENT_AMBIGUITY
MODEL_ALIAS_AMBIGUITY
HISTORICAL_PRECISION_LOSS
USAGE_RECONCILIATION_MISMATCH
UNMAPPED_ASSIGNMENT
UNMAPPED_CHANNEL
```

Migration should surface these as reports, not silently guess.

## 23. Migration completion criteria

V1 can be considered ready for retirement only when:

1. all current UI/API consumers have V2 or compatibility coverage;
2. V2 identity sync is stable and idempotent;
3. staffing/routing is V2 authoritative for all intended positions;
4. request-level accounting reconciles sufficiently with the selected gateway/provider evidence; CPA totals remain one migration baseline while CPA is active;
5. V1 writes are disabled;
6. historical V1 data remains queryable or migrated with documented precision;
7. rollback procedure has been tested before final cleanup.

## Current migration/cutover state — 2026-08-16

Additive V2 schema migrations 001–010 are deployed. V1 remains in `DUAL_RUN` compatibility mode by design. `GET /api/v2/compatibility/status` is the cutover gate and reports blockers rather than comparing V1 Worker one-to-one with V2 Employee. V1 must not be disabled until CPA sync/position-alias ownership and protected consumers have migrated and explicit retirement approval is present.
