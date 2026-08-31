# Autonomous Improvement Programs and External PR Governance

## Goal

Use the Pixel V4 supervisor/kernel model to run continuous, resource-bounded improvement programs for repositories such as Digital Biome.

The program should be able to:

- discover performance, security, reliability, maintainability, UX, and dependency opportunities;
- submit work to an approved external agent such as Google Jules or Anti-Gravity;
- ingest the resulting GitHub pull request;
- independently determine whether the problem is real and the change is justified;
- review correctness, architecture, repository conventions, style, tests, and operational risk;
- repair or request revision when needed;
- re-review the exact repaired revision;
- merge automatically only when deterministic project and GitHub gates pass;
- verify post-merge health and open a rollback/follow-up plan when necessary.

This is not a special second automation system. It is a recurring source of normal Pixel plans.

## Domain model

### `MaintenanceProgram`

A long-lived configuration describing *what may be improved and under which resource/merge policy*.

Suggested fields:

```text
programId
projectKey
repositoryPath / GitHub repository identity
targetBranch
discoveryPolicyId
resourcePolicyId
reviewPolicyId
deliveryPolicyId
schedule / webhook subscriptions
maxOpenCandidates
status
observationCursor
```

A maintenance program is not a mutable coding workspace and is not one endless plan. Every concrete improvement becomes an `ImprovementCandidate` and then a durable plan.

### `ImprovementCandidate`

```text
candidateId
programId
sourceType
sourceIdentity
category
problemStatement
evidence
estimatedImpact
risk
status
linkedPlanId
linkedPullRequest
createdAt / updatedAt
```

Candidate lifecycle:

```text
DISCOVERED
 -> TRIAGING
 -> ACCEPTED_FOR_WORK | REJECTED | DUPLICATE
 -> WAITING_FOR_RESOURCE
 -> PLANNED
 -> IMPLEMENTING | WAITING_FOR_EXTERNAL_PR
 -> REVIEWING
 -> REPAIRING
 -> MERGE_READY
 -> MERGED
 -> POST_MERGE_VERIFY
 -> SUCCEEDED | ROLLED_BACK | FOLLOW_UP_REQUIRED
```

## Discovery sources

A program may combine several sources. Each source produces evidence, not an automatic merge decision.

### Repository/static discovery

- dependency/security scanners;
- lint/type/test failures;
- dead code and duplication reports;
- performance budgets and bundle analysis;
- architecture rule violations;
- TODO/FIXME and deprecated API inventory;
- documentation/implementation drift;
- failed or flaky CI evidence.

### Runtime/operational discovery

- latency/error/resource regressions;
- browser/Web Vitals or server performance signals;
- production logs and alerts exposed through sanitized connectors;
- failed post-deploy checks;
- resource/cost anomalies.

### AI discovery

A read-only `INVESTIGATE_PLAN` or maintenance-discovery execution may inspect a bounded repository snapshot and propose candidates. AI-discovered candidates must include repository evidence, expected impact, verification criteria, and a duplicate search.

### GitHub PR and issue intake

Existing GitHub PR intake becomes a candidate source. A webhook must pin:

- installation/repository identity;
- PR number;
- base ref and exact base revision;
- head ref and exact head revision;
- author/source classification;
- changed files and current checks.

A later force-push creates a new candidate revision; prior review evidence cannot approve it.

### Jules

The existing `JulesApiPort` and session/source endpoints remain the adapter boundary. V4 adds a program action that may submit a bounded task to Jules when policy allows. Jules may return a session/result/PR, but Jules never marks the candidate accepted or merge-ready.

Required Jules task input:

- exact repository/source identity and starting branch;
- scoped problem statement and acceptance criteria;
- prohibited areas and protected contracts;
- instruction to commit/push through the configured integration;
- correlation metadata (`programId`, `candidateId`, `planId`).

Required result intake:

- verified GitHub PR or exact Git ref/head SHA;
- Jules session identifier;
- source/base identity;
- result summary as non-authoritative evidence.

If Jules cannot be reached or has no usable quota, the candidate follows its resource policy rather than silently changing provider.

## Digital Biome policy profile

The first canary program should target Digital Biome with an intentionally conservative policy.

### Resource policy

Implementation preference:

```text
1. antigravity-worker
2. no implementation fallback by default
```

Review preference:

```text
1. antigravity-review
2. optional bounded GPT-5.6/Codex Business review only when explicitly enabled
3. no implementation-tier model may self-approve
```

When Anti-Gravity is unavailable, quota-exhausted, or not readiness-approved:

```text
candidate/plan -> WAITING_FOR_RESOURCE
```

It must not automatically consume ordinary paid LiteLLM routes merely to keep the queue moving. Availability probes use exponential backoff and a maximum daily probe budget.

The program may separately permit a small premium review budget so a PR already produced by Anti-Gravity/Jules can be validated even if implementation credits are exhausted. This is an explicit policy field, not an implicit fallback.

### Scope policy

Candidate categories initially allowed:

- low/medium-risk performance improvements;
- dependency/security updates with reproducible evidence;
- test coverage and correctness defects;
- accessibility and UX consistency fixes;
- build/CI/release reliability;
- bounded refactors that preserve public contracts.

Initially disallowed without operator approval:

- destructive data migrations;
- authentication/authorization redesign;
- billing/financial behavior;
- irreversible production infrastructure changes;
- broad product-semantic changes;
- secret/credential changes;
- policy changes that reduce review, test, or delivery gates.

### Merge policy

Auto-merge requires all of the following:

1. the problem is validated as real (`PASS`, not merely “the diff looks plausible”);
2. the exact PR head SHA is independently reviewed;
3. blocking findings have been repaired and the repaired SHA re-reviewed;
4. repository-specific tests, lint, typecheck, build, security/performance checks, and policy checks pass;
5. architecture/style/project-standard checks pass;
6. required branch protection and GitHub checks are green;
7. the expected head SHA still matches at merge time;
8. the candidate is inside autonomous risk/scope limits;
9. the resource/delivery budget remains valid;
10. post-merge verification and rollback instructions are known.

Merge state is distinct from release/deploy state.

## External PR review pipeline

```text
PR webhook / Jules result
        |
        v
verify repository + base/head identity
        |
        v
create/reuse ImprovementCandidate
        |
        v
EXTERNAL_CHANGE plan
        |
        v
problem validation + independent code review
   | INVALID           | FAIL                      | PASS
   v                   v                           v
close/reject       create scoped repair       run project checks
                        |                           |
                        v                           v
                  push repaired head        exact-SHA merge gate
                        |
                        v
                  independent re-review
```

Review must answer two separate questions:

1. **Is the claimed problem/opportunity real and worth changing?**
2. **Is this exact implementation correct, minimal, elegant, and repository-consistent?**

For external changes, the verdict vocabulary remains:

```text
INVALID - the claimed problem/change is unsupported or unjustified
FAIL    - the problem is valid but the implementation has blocking defects
PASS    - both the change and exact implementation satisfy the policy
```

## Repair ownership

A failed PR review may result in one of three policy-controlled actions:

- ask the external agent/Jules to update the same branch;
- launch an Anti-Gravity/Pixel writer on a controlled repair branch;
- reject the candidate when repair cost/risk exceeds policy.

Every repair pins the prior candidate head and findings. It must preserve accepted behavior and produce a new exact head SHA for re-review.

## Program scheduling and queueing

The maintenance scheduler enforces:

- maximum open candidates and active writers;
- one candidate per deduplicated problem fingerprint;
- category/risk quotas;
- provider resource availability;
- quiet periods around releases/incidents;
- per-project and global concurrency;
- cooldown after failed/rolled-back candidates.

No new candidate should starve an active product plan. Maintenance capacity is a separate lower-priority queue.

## Candidate deduplication

Fingerprint inputs may include:

- repository and target branch;
- normalized problem class;
- affected ownership/module paths;
- scanner/rule identifier;
- issue/PR identity;
- relevant base revision range.

New evidence updates an existing open candidate when appropriate instead of creating repeated plans/PRs.

## Post-merge learning

A completed candidate records:

- discovery evidence and source;
- chosen agent/provider/model/resource usage;
- review findings and repair cycles;
- checks and exact merged revision;
- post-merge performance/security/reliability outcome;
- rollback/follow-up status;
- false-positive/invalid classification.

The supervisor may propose policy or prompt improvements from aggregate outcomes, but those changes enter a separate reviewed system-improvement plan. Runtime policy is never mutated directly by the learning loop.

## Jules and public task submission APIs

V4 should expose a bounded candidate submission API rather than allowing callers to create arbitrary privileged executions.

Suggested surface:

```text
POST /api/v4/maintenance/programs/:programId/candidates
POST /api/v4/maintenance/programs/:programId/discovery-runs
POST /api/v4/maintenance/candidates/:candidateId/dispatch/jules
GET  /api/v4/maintenance/candidates/:candidateId
POST /api/v4/maintenance/candidates/:candidateId/reconcile
```

Submission requires:

- stable idempotency key;
- source/auth identity;
- repository/program scope validation;
- problem statement and evidence;
- no raw provider credentials;
- no direct merge or deployment request.

GitHub/Jules callbacks update the candidate through verified adapters and wake its supervisor.

## Failure behavior

| Failure | Result |
| --- | --- |
| Anti-Gravity unavailable/quota exhausted | `WAITING_FOR_RESOURCE`; no unapproved fallback |
| Jules session fails before PR | retry within Jules budget or pause/reject |
| PR head changes after review | invalidate review, create new revision observation |
| Review FAIL | repair/re-review loop within budget |
| Review INVALID | reject candidate and retain false-positive evidence |
| Required checks fail | repair plan or reject; never merge |
| Merge head mismatch | re-read PR, invalidate stale approval |
| Post-merge regression | rollback/follow-up child plan, preserve incident evidence |
| Supervisor cannot classify safely | `SAFETY_HOLD` or operator escalation |

## Canary success criteria

Digital Biome becomes the first autonomous-maintenance canary only after:

- Anti-Gravity readiness and quota observation are reliable;
- a resource outage demonstrably pauses instead of falling back;
- one external/Jules PR completes exact-SHA review and repair without operator state edits;
- one invalid candidate is safely rejected;
- one approved candidate auto-merges and passes post-merge verification;
- a simulated stale-head/force-push cannot reuse prior review evidence;
- rollback and program pause controls are proven.
