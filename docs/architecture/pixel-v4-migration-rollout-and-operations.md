# Pixel V4 Migration, Rollout, and Operations

## Migration posture

Pixel V4 is additive. The V3 execution kernel remains the production authority while supervisor/program capabilities are introduced behind feature flags.

Do not create a parallel control-plane database or copy active plans into a new system. Add V4 records to the existing durable store and link them to existing `planId`, `executionId`, repository, PR, and delivery evidence.

## Schema migration rules

- use `CREATE TABLE IF NOT EXISTS` plus explicit additive-column migration where required;
- never infer missing provenance from status text alone;
- never backfill exact Git/review evidence without deterministic verification;
- migration startup must be idempotent across repeated service restarts;
- every new table receives bounded indexes for plan/program/status/cursor lookups;
- preserve SQLite online backup and `quick_check` deployment practice;
- downgrade must tolerate V4 tables remaining present and unused.

## Existing plan adoption

Existing V3 plans may opt into a supervisor only when:

- the plan/repository identity is valid;
- current execution/workspace ownership is coherent;
- exact result/review evidence required by its current phase exists or is safely recoverable;
- no incompatible manual recovery is in progress.

The initial supervisor cursor starts at a durable event boundary. Historical events may be summarized into a bootstrap projection, but they are not replayed as new actions.

## Feature modes

### `disabled`

No V4 scheduler or supervisor actions. V3 operates unchanged.

### `shadow`

Supervisor observes and records decisions. Validator simulates acceptance/rejection; no side effects.

### `advisory`

Validated actions require an operator approval token except explicitly safe no-op/read actions.

### `autonomous`

Policy-authorized actions execute automatically within budget. Safety/external/operator gates remain enforced.

Modes are configurable per project/program. Global mode is the upper bound; a project cannot widen it.

## Service rollout

1. merge independently reviewed code to the protected branch;
2. back up the control-plane database/configuration;
3. build and run full tests from the exact revision;
4. deploy with V4 globally disabled;
5. verify V3 health, plan listing, execution hydration, and migration idempotency;
6. enable shadow mode for test fixtures and selected historical plans;
7. enable Digital Biome maintenance in shadow, then advisory;
8. enable bounded autonomous low-risk actions;
9. enable system-repair and auto-merge only after their independent E2E gates;
10. expand to selected trusted product plans.

## Self-hosted system-repair deployment

A child plan repairing `pixel-agents` must not restart the running control plane while mutable writers or incompatible migrations require a protected window.

Required cutover record:

```text
childPlanId
candidateRevision
reviewExecutionId/verdict
verification commands/results
active writer snapshot
backup identity
previous deployed revision
new deployed revision
health result
rollback result/availability
parent plans to reconcile
```

A deployment coordinator, not the model, decides the safe cutover moment.

## Supervisor incident controls

Operators must be able to:

- disable all supervisor wakes;
- disable one supervisor/program;
- invalidate a pending action before execution;
- stop autonomous child-plan creation;
- stop auto-merge;
- cap or zero a resource budget;
- inspect sanitized projection/decision/action lineage;
- resume V3 deterministic reconciliation;
- roll back the service while retaining V4 audit records.

## Stuck supervisor detection

A supervisor is considered unhealthy when:

- it repeatedly decides against a stale cursor;
- it proposes the same rejected action beyond policy limits;
- its OpenHands conversation is unavailable past recovery thresholds;
- it consumes budget without advancing or parking the plan;
- it creates a child-plan cycle or repeated equivalent child repairs;
- it fails to sleep after the plan enters a stable executing/waiting state.

The deterministic watchdog may pause that supervisor and leave the underlying V3 plan intact.

## Operational state meanings

| State | Meaning | Expected operator action |
| --- | --- | --- |
| `SLEEPING` | healthy; no decision needed | none |
| `RECOVERING` | accepted action in progress | observe |
| `WAITING_FOR_RESOURCE` | authorized resource unavailable | none unless overriding policy |
| `WAITING_FOR_SYSTEM_REPAIR` | child plan owns the blocker | inspect child if needed |
| `WAITING_FOR_EXTERNAL_EVIDENCE` | native machine/secret/account evidence required | provide declared evidence |
| `SAFETY_HOLD` | deterministic policy refused continuation | review/authorize/change scope |
| `BLOCKED` | no safe recovery remains | operator diagnosis |

## Digital Biome canary operations

Before enabling auto-merge:

- verify Anti-Gravity worker/reviewer readiness and exhaustion behavior;
- set low candidate and writer concurrency;
- restrict allowed categories and paths;
- configure exact required GitHub checks;
- configure post-merge health/performance/security probes;
- prove force-push invalidation;
- prove program pause and global kill switches;
- run one advisory approval before autonomous promotion.

## Data retention

Retain compact durable evidence:

- supervisor decisions/actions and digests;
- graph versions and relationships;
- candidate/PR exact identities;
- resource observations/leases;
- review and delivery links;
- deployment/rollback evidence.

Large transient logs and read snapshots follow bounded retention. A retained record must reference immutable facts, not require preserving every full workspace clone.
