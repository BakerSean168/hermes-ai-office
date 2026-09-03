# Pixel V4 Resource Policy and Safety Budgets

> Routing update (2026-09-03): ADR-003 is the governing decision for normal model/agent/provider selection. Normal task routing now has only two capability classes, `IMPLEMENTATION` and `REASONING`, uses a small curated model-agent affinity set, and selects resources by static `(tier, model rank, resource sequence)` order. The resource/budget concepts below remain applicable for project-specific restrictions, scarce provider-native resources, safety holds, and autonomous-maintenance programs. They must not be interpreted as permission to reintroduce dynamic cost/quality scoring or attempt-indexed model fallback.

## Why resource policy is a first-class contract

Provider/model choice is not merely routing. Some programs are valuable only when a particular prepaid, promotional, shared, or time-limited resource is available. Silently falling back to an ordinary paid route can violate the user's intent even when it would technically complete the task.

Pixel V4 therefore separates:

- **capability policy** — whether the work requires `IMPLEMENTATION` or `REASONING`, plus phase-specific backend/trust constraints;
- **resource policy** — which pools may be consumed and under what budget;
- **availability evidence** — whether an authorized pool is currently usable;
- **fallback policy** — whether another pool may be selected;
- **waiting policy** — how and when work resumes after resource recovery.

## Core records

### `ResourcePolicy`

```yaml
id: digital-biome-antigravity-first
implementation:
  allowedBackends:
    - antigravity-worker
  fallback: pause
review:
  allowedBackends:
    - antigravity-review
    - codex-business-review-headless
  fallback: bounded
  fallbackBudget:
    maxCallsPerCandidate: 1
    maxCallsPerDay: 4
planning:
  allowedBackends:
    - antigravity-review
  fallback: pause
availability:
  probeIntervalSeconds: 3600
  maxProbesPerDay: 12
  backoffMultiplier: 2
  maxBackoffSeconds: 21600
concurrency:
  maxActiveWriters: 1
  maxOpenCandidates: 3
```

### `ResourceObservation`

```text
resourceId
backend
state: AVAILABLE | DEGRADED | QUOTA_EXHAUSTED | AUTH_REQUIRED | UNAVAILABLE | UNKNOWN
observedAt
retryAfter
source: readiness probe | execution failure | provider metadata | operator
sanitizedReason
```

Secrets and raw authorization data are never stored in observations.

### `ResourceLease`

A short durable reservation prevents several plans from simultaneously assuming the same scarce pool is available.

```text
leaseId
resourcePolicyId
resourceId
planId/candidateId
purpose
status
claimedAt
expiresAt
usageBudget
```

A lease is an admission signal, not proof that a provider call will succeed. Actual failures still update availability.

## Failure classification

The adapter/gateway layer normalizes resource failures:

```text
AUTH_REQUIRED
QUOTA_EXHAUSTED
RATE_LIMITED
TEMPORARY_PROVIDER_FAILURE
MODEL_UNAVAILABLE
ROUTE_MISCONFIGURED
POLICY_DISALLOWED
UNKNOWN_PROVIDER_FAILURE
```

The supervisor may use these facts to propose an action, but deterministic policy decides whether to retry, switch, or pause.

## Pause semantics

`WAITING_FOR_RESOURCE` is a healthy suspended state.

It must record:

- the exact resource policy and missing resource class;
- the last safe availability observation;
- the next bounded probe time;
- whether review-only fallback is allowed;
- all retained execution/plan/candidate provenance;
- how an operator can explicitly override or cancel.

No writer slot or mutable workspace lease should remain occupied while waiting unless a resumable execution actually owns it.

## Digital Biome Anti-Gravity profile

Default behavior:

- discovery/planning: Anti-Gravity when available;
- implementation: Anti-Gravity only;
- implementation fallback: pause;
- review: Anti-Gravity first;
- optional premium independent review: a tightly bounded GPT-5.6/Codex Business allowance;
- no automatic LiteLLM implementation fallback;
- maintenance queue priority lower than user-requested product plans.

The existing `antigravity-worker` and `antigravity-review` backends should be brought under readiness and enabled-backend policy rather than merely declared in configuration. A backend is selectable only when:

1. configured and explicitly enabled for the deployment;
2. its authentication/runtime probe passes;
3. its resource observation is not exhausted/unavailable;
4. its capability matches the requested phase;
5. the plan/program policy permits it.

## Budget hierarchy

```text
global installation budget
  -> project/program budget
      -> plan/candidate budget
          -> phase/action budget
              -> individual execution lease
```

The most restrictive applicable rule wins.

Budget dimensions may include:

- calls;
- input/output tokens;
- cost;
- wall-clock execution time;
- active writers;
- supervisor decisions;
- repair/review cycles;
- child plans;
- external PRs;
- daily/weekly candidate count.

## Supervisor-loop controls

To prevent autonomous thrashing:

- do not wake on events already covered by the current observation cursor;
- suppress identical classifications/actions against an unchanged projection;
- cap consecutive actions for one normalized root cause;
- apply exponential backoff after repeated transient failures;
- require graph revision or escalation after route exhaustion;
- require a child plan for a control-plane defect instead of repeated parent retries;
- stop at safety/resource/external gates rather than fabricating progress.

Suggested initial limits for canary plans:

```yaml
maxSupervisorDecisionsPerHour: 6
maxSupervisorDecisionsPerDay: 30
maxSameCauseRecoveries: 3
maxGraphRevisions: 3
maxChildPlanDepth: 1
maxOpenSystemRepairPlans: 1
maxAutomaticRepairCyclesPerCandidate: 3
maxAutomaticMergeAttempts: 1
```

These are policy defaults, not hard-coded constants.

## Model role separation

Normal model selection has two capabilities:

```text
IMPLEMENTATION
REASONING
```

Planning and review both use `REASONING`; they remain separate execution phases because their permissions and provenance differ. Review must still be independent, read-only, and bound to the exact implementation revision.

- an implementation worker may not approve its own exact revision;
- a supervisor may reason about findings but may not substitute for the required independent review execution;
- the approved model-agent affinity registry determines which coding/reasoning harness may serve each model family;
- provider-native Business credentials remain unavailable to untrusted external-change implementations unless policy explicitly allows a safe review-only path;
- project-specific policies such as Digital Biome's Antigravity-only implementation may restrict the globally eligible resource set;
- normal routing uses static resource tier/model rank/resource sequence order rather than a dynamic quality or cost score.

## Self-repair safety budget

A system-repair child plan additionally requires:

- target repository/environment allow-list;
- no concurrent deployment-sensitive writer when cutover requires a safe window;
- full focused and regression verification;
- independent review by an allowed premium reviewer;
- database/config backup where applicable;
- canary or shadow validation;
- deterministic health check;
- rollback revision and command path;
- maximum one active self-repair child per parent/root cause.

The child supervisor cannot approve its own deployment.

## Operator controls

Required controls:

```text
pause program
resume program
cancel candidate/plan
approve one bounded fallback
authorize one additional repair cycle
disable auto-merge
disable self-repair deployment
change budget policy by versioned configuration
inspect sanitized decisions/actions/resource observations
```

Changing resource policy never retroactively approves an execution or PR revision.
