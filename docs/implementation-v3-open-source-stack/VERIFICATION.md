# V3 Verification and Release Gates

## 1. Verification philosophy

V3 integrates several independently evolving systems. Unit tests alone are insufficient. The release gate must verify **contracts across the full composition**.

## 2. Layered test suite

### Layer A — policy unit tests

Pure deterministic tests:

- phase -> default model class;
- complexity override;
- commercial-class preference;
- disabled backend/provider exclusion;
- explicit override validation;
- fresh-review rule;
- max parallel writers.

No network required.

### Layer B — adapter contract tests

Pinned upstream versions:

- OpenHands create/get/cancel/continue;
- ACP backend launch;
- LiteLLM model-list/health/managed request;
- Langfuse trace/metrics lookup;
- partial-source failure behavior.

### Layer C — local integration tests

Run real containers/services with fake/test provider where possible.

Verify correlation:

```text
execution_id
  == OpenHands metadata/reference
  == LiteLLM request metadata
  == Langfuse trace metadata
```

### Layer D — real-provider smoke tests

Minimal-cost calls against real configured providers.

### Layer E — Hermes end-to-end tests

A Hermes profile invokes the actual plugin tool and receives a usable execution result.

## 3. P1 gateway acceptance

For every initial logical model class:

- [ ] at least one healthy deployment serves a request;
- [ ] actual provider/model route is observable;
- [ ] input/output token usage is present;
- [ ] cost is present or explicitly `UNKNOWN` with reason;
- [ ] Langfuse trace is created;
- [ ] transient provider failure triggers only intended fallback;
- [ ] bad-request/context failures do not incorrectly poison provider health;
- [ ] scoped virtual key cannot access unauthorized model classes if restrictions are enabled.

## 4. OpenHands acceptance

For each enabled backend:

- [ ] conversation can be created;
- [ ] repository workspace is visible;
- [ ] final result is retrievable;
- [ ] cancellation works or documented upstream semantics are reflected honestly;
- [ ] server/client reconnect does not create duplicate execution;
- [ ] ACP subprocess failure produces a terminal failure;
- [ ] execution cannot access unrelated host paths under normal configuration;
- [ ] managed transport actually reaches LiteLLM when claimed;
- [ ] native subscription mode is labelled native and does not falsely claim LiteLLM route data.

## 5. Workspace acceptance

### Investigation

- [ ] source repository remains unchanged after `INVESTIGATE_PLAN`;
- [ ] any required temporary build/cache output is contained.

### Implementation

- [ ] changes occur only in execution workspace;
- [ ] main source checkout remains clean;
- [ ] branch/worktree mapping contains execution ID;
- [ ] changed-file/diff summary is mechanically queryable;
- [ ] failed worker does not delete another worker's workspace.

### Parallel

- [ ] two writers never receive the same mutable worktree;
- [ ] branch collisions are impossible/detected;
- [ ] concurrency cap is enforced.

## 6. Workflow acceptance

### INVESTIGATE_PLAN

Seed a known defect and verify output includes evidence and an actionable plan.

### IMPLEMENT

Apply the plan and verify actual source changes/tests.

### VERIFY_REVIEW

Seed a deliberate defect in the implementation and verify fresh review detects it.

### Fix loop

Verify:

```text
failed review -> fix -> fresh review -> pass
```

without accidentally reusing the reviewer conversation as implementer.

## 7. Observability acceptance

For one managed execution, AI Office must show:

```text
project
phase
agent backend
logical model class
transport mode
start time/duration
OpenHands status
provider/model breakdown
input/output/cache usage where available
cost
trace link
```

For native subscription execution:

- [ ] usage source is explicit;
- [ ] missing provider-level data is shown as unknown, not invented;
- [ ] execution duration/status remain available from OpenHands.

## 8. Failure injection matrix

| Failure                                        | Expected behavior                                         |
| ---------------------------------------------- | --------------------------------------------------------- |
| AI Office facade down before start             | new delegated phase fails; Hermes normal chat survives    |
| AI Office restarts during active OpenHands run | worker continues; query reconciles later                  |
| OpenHands unavailable                          | no duplicate/phantom worker; clear execution error        |
| ACP subprocess crash                           | OpenHands terminal failure reflected                      |
| LiteLLM primary provider 429                   | configured equivalent fallback/cooldown handles it        |
| all LiteLLM deployments unavailable            | model call fails clearly; outer workflow decides retry    |
| Langfuse down                                  | execution continues; UI marks observability degraded      |
| WebSocket disconnect                           | reconnect/query recovers status without duplicate run     |
| Hermes tool request retry                      | idempotency returns same execution                        |
| disk/workspace full                            | implementation fails safely; main checkout remains intact |

## 9. Security acceptance

- [ ] no provider API key appears in AI Office DB;
- [ ] no provider API key is returned to Hermes tool result;
- [ ] no secret appears in Langfuse metadata;
- [ ] source repository cannot inject arbitrary ACP launch command through project config;
- [ ] Agent Server is not publicly reachable unintentionally;
- [ ] LiteLLM admin/master endpoint is private;
- [ ] worker environment does not inherit unrelated host secrets;
- [ ] logs redact Authorization and secret values.

## 10. Performance acceptance

Measure overhead introduced by composition:

```text
Hermes -> AI Office facade latency
AI Office -> OpenHands start latency
LiteLLM gateway added latency
Langfuse callback impact
```

The objective is not zero overhead. The objective is that orchestration overhead remains small relative to coding-agent execution time and does not materially damage streaming responsiveness.

## 11. Upgrade contract gate

Before upgrading any upstream component:

- run adapter contract tests against old version;
- upgrade exactly one component;
- rerun contract tests;
- run one managed and one native execution if both lanes are enabled;
- verify usage/traces;
- verify cancellation and workspace behavior;
- pin the new version only after passing.

## 11.1 Oracle2 evidence snapshot — 2026-08-22

The following are observed facts, not inferred readiness:

| Gate                          | State                   | Evidence                                                                                                                                          |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Managed OpenHands -> LiteLLM  | VERIFIED                | built-in and OpenCode ACP executions both produced exact `LITELLM_REPORTED` usage                                                                 |
| Physical route correlation    | VERIFIED                | `user=<executionId>` persisted as LiteLLM spend `end_user`; physical model/provider/deployment are joined only on exact ID                        |
| Premium provider fallback     | VERIFIED                | injected order-1 connection failure produced `x-litellm-attempted-fallbacks: 1` and successful order-2 ForAPI response with preserved correlation |
| Gateway reconnect             | VERIFIED                | OpenCode worker survived native Gateway restart `47776 -> 48493` and completed under the same execution ID                                        |
| Rollback                      | VERIFIED                | default profile was switched `v3 -> v2 -> v3`; V3 start was blocked in V2 and legacy placement remained available                                 |
| Fix loop                      | VERIFIED                | real seeded defect: blocking reviewer -> `IMPLEMENT_FIX` -> fresh reviewer `APPROVED`; 6/6 tests passed after repair                              |
| Review isolation              | VERIFIED                | review snapshot freezes Git-visible implementation state read-only; write-requiring verification uses disposable scratch                          |
| Writer safety                 | CONTRACT-VERIFIED       | global/per-project caps and same-workspace writer lease are covered by V3 service tests                                                           |
| Representative real workflows | **NOT MET**             | 1/10 explicitly registered; probes/failure injections are excluded                                                                                |
| Langfuse                      | OPTIONAL / UNCONFIGURED | LiteLLM spend observability is live; no false Langfuse health/trace claim is made                                                                 |

The machine-readable authority is `GET /api/v3/development/readiness`, backed by
`config/v3-readiness-evidence.yaml` plus live execution facts. A manually written
`verified: true` for the fix loop is insufficient: the report validates the four
execution phases, statuses, causal parent IDs, blocking reviewer text, and final
`APPROVED` text against the live V3 execution store.

## 12. Cutover acceptance

V3 can become default only when all are true:

- [ ] at least 10 representative real development executions completed successfully or with understood failures;
- [ ] investigation, implementation and review were all exercised;
- [ ] at least one provider failure/fallback occurred or was injected;
- [ ] at least one restart/reconnect scenario was tested;
- [ ] no code changes escaped isolated workspaces;
- [ ] token/cost data is sufficiently complete for intended UI;
- [ ] rollback to V2 was tested once before V2 retirement;
- [ ] operator no longer needs to edit raw V3 databases for normal recovery.
