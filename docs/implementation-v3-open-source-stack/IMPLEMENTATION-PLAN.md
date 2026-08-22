# V3 Implementation Plan

## 1. Delivery philosophy

The goal is not to implement every document at once. The goal is to prove the composition with the smallest **complete** vertical slices and then delete unnecessary V2 ownership.

Every phase ends with a runnable, observable result.

## 2. P0 — Version and capability spike

### Tasks

- pin candidate OpenHands Agent Server/SDK version;
- pin LiteLLM Proxy version;
- select Langfuse deployment mode for PoC;
- pin/record Codex ACP package version;
- pin OpenCode version supporting `opencode acp`;
- verify Claude Code ACP only if needed in initial roster;
- inventory current provider endpoints suitable for LiteLLM-managed access;
- classify each desired agent backend as managed/native/both.

### Deliverable

`docs/implementation-v3-open-source-stack/COMPATIBILITY-MATRIX.md` generated from real probes.

### Gate

At least one premium planning backend and one efficient implementation backend are proven runnable.

## 3. P1 — LiteLLM + Langfuse foundation

### Tasks

- deploy LiteLLM privately;
- configure `planning-premium` and `implementation-efficient` logical groups;
- create scoped test key;
- configure Langfuse callback/integration;
- send direct test calls;
- verify actual model/provider, usage, cache fields and cost appear;
- test provider failure/fallback;
- verify secrets are absent from logs/repo.

### Gate

For a test request, the system can answer:

```text
logical class
actual provider/model
tokens
cost
latency
trace ID
```

without AI Office implementing a custom usage parser.

## 4. P2 — OpenHands execution foundation

### Tasks

- deploy Agent Server privately;
- run built-in Agent with LiteLLM Proxy;
- run one ACP backend through OpenHands;
- run OpenCode via custom ACP command;
- run Codex ACP with chosen auth mode;
- verify create/run/get/cancel/event behavior;
- verify workspace isolation and cleanup;
- record upstream IDs needed for correlation.

### Gate

A standalone script can run:

```text
prompt -> OpenHands -> selected agent -> repository -> final result
```

and correlate model usage when managed transport is used.

## 5. P3 — Thin AI Office V3 service

### Modules

```text
policy
execution_links
openhands adapter
litellm adapter
langfuse adapter
v3 API
```

### Tasks

- implement `execution_id` generation;
- implement policy config loader;
- implement backend capability registry;
- implement minimal SQLite correlation store;
- implement start/get/cancel;
- implement usage-summary lookup;
- implement source-health response;
- implement idempotency.

### Gate

`POST /api/v3/development/executions` can run a complete read-only execution and return normalized metadata.

## 6. P4 — First Hermes vertical slice: INVESTIGATE_PLAN

### Tasks

- add Development Skill;
- add `ai_office_v3_run_phase` Hermes tool;
- auto-attach profile/session/turn metadata;
- implement `await=true` mode;
- build bounded prompt from objective + phase contract;
- return final_text + deterministic metadata;
- opt in only one development profile.

### Scenario

```text
"Investigate why this page has a long white-screen startup and propose a fix."
```

### Gate

Hermes can naturally reason over the returned root-cause/plan without knowing provider credentials or subprocess details.

## 7. P5 — Isolated IMPLEMENT

### Tasks

- create workspace provisioner;
- create deterministic branch/worktree naming;
- add write-capable OpenHands execution;
- collect Git diff/changed-file summary;
- run repository test/build commands as agent responsibility;
- preserve branch/workspace on success;
- clean abandoned workspace safely;
- implement cancellation/timeouts.

### Gate

A real repository task produces isolated changes and leaves the main checkout clean.

## 8. P6 — VERIFY_REVIEW and fix loop

### Tasks

- create fresh review conversation;
- default to `review-premium`;
- provide original objective + plan + actual diff;
- normalize PASS/FAIL only if reliable, otherwise let Hermes interpret final text;
- add fix continuation path;
- re-review in another fresh conversation.

### Gate

A seeded bad implementation is detected and corrected through the workflow.

**Status (2026-08-22): VERIFIED.** A real isolated Python probe completed
`IMPLEMENT -> blocking VERIFY_REVIEW -> IMPLEMENT_FIX -> fresh VERIFY_REVIEW`.
The fix execution used the failed review as its causal parent, automatically followed
that review back to the implementation workspace, received the reviewer findings,
restored 6/6 tests, and the fresh reviewer returned `APPROVED`.

## 9. P7 — Async/parallel execution

### Tasks

- add `await=false`;
- add query/list-active;
- add safe parallel execution groups;
- one workspace per writer;
- add max-concurrency policy;
- test Hermes/Gateway reconnect while workers continue.

### Gate

Two independent implementation workers can run concurrently without modifying the same worktree.

**Status (2026-08-22): IMPLEMENTED / CONTRACT-VERIFIED.** V3 has durable
`await=false`, get/list/continue/cancel recovery, a global writer cap of 4, a
per-project writer cap of 2, and a single-writer lease for reused implementation
workspaces. Admission reconciles non-terminal writers against OpenHands first and
fails closed if state cannot be established. Gateway restart recovery was verified
with a real external OpenCode worker that survived Gateway PID `47776 -> 48493` and
completed under the same execution ID. The concurrency collision invariants are
covered by service contract tests; do not reinterpret probe volume as representative
production load.

## 10. P8 — AI Office Desktop V3

### Build only these initial views

```text
Active Work
History
Routing Policy
Models/Providers summary
Usage/Trace summary
```

### Tasks

- add native Desktop plugin route/sidebar entry;
- aggregate OpenHands active state;
- show logical model class and transport mode;
- show last/observed physical route from Langfuse/LiteLLM;
- show elapsed time and usage;
- provide links to native OpenHands/LiteLLM/Langfuse views;
- expose partial/degraded source health.

### Gate

The UI answers "what is working now, for what task, using what agent/model route, for how long, and at what observed usage/cost?"

**Status (2026-08-22): VERIFIED.** The live `Development` tab projects Active Work,
History, routing policy, runtime/provider health, writer concurrency, observed
usage/cost, exact physical model/provider routes when correlated, and cutover
readiness. Exact physical routing is derived from LiteLLM spend rows keyed by
`end_user=<executionId>`; old executions without that exact correlation remain
unlinked rather than being guessed. Langfuse remains explicitly `UNCONFIGURED`.

## 11. P9 — Shadow comparison and cutover

### Compare V2 and V3 on real work

Metrics:

```text
execution success
human correction required
startup latency
wall-clock completion time
provider failure recovery
observability completeness
maintenance complexity
operator interventions
```

### Cutover

- opt in only explicitly authorized profiles with `plugins.entries.hermes-ai-office.settings.execution_mode: v3`;
- disable V2 terminal staffing interception on V3-controlled profiles to avoid dual routing;
- retain `v2` as a configuration-driven rollback path and `disabled` as an explicit no-execution mode;
- expand only after the readiness report passes its representative-work gate.

**Current oracle2 state (2026-08-22): PARTIAL / NOT READY FOR FINAL CUTOVER.**
Default, BodySense, Digital Biome, and Orchestrator are explicitly `v3`. MemoFlow
remains intentionally opted out through `.ai-office-disabled` and MUST NOT be
re-enabled merely to satisfy this plan. Real failure fallback, Gateway reconnect,
V3->V2->V3 rollback, workspace isolation, operator recovery, exact observability,
and the full fix loop are verified. The remaining hard gate is **10 representative
real development workflows; current verified count is 1/10**. Architecture probes
and intentional failure injections do not count toward that number.

## 12. P10 — V2 retirement

- stop V2 runtime writes;
- remove obsolete workforce-domain paths;
- keep historical DB read-only;
- update documentation authority;
- simplify deployment and tests;
- remove adapters that became unnecessary after OpenHands/ACP proof.

## 13. Implementation order rule

Do **not** begin with:

```text
new office animations
provider management mega-UI
complex learned router
full migration of V2 history
self-hosted Langfuse cluster
```

First prove the real execution chain.

## 14. Definition of done for V3

V3 is not done because all services start. It is done when a real Hermes development task can repeatedly complete:

```text
INVESTIGATE_PLAN
  -> IMPLEMENT
  -> VERIFY_REVIEW
  -> FINALIZE
```

with:

- isolated code execution;
- explainable routing;
- no raw secret in Hermes context;
- visible active status;
- token/cost/trace evidence;
- failure recovery;
- V2 runtime ownership retired.
