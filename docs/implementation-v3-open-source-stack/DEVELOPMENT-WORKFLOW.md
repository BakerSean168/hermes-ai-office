# Hermes Development Workflow V3

## 1. Purpose

This workflow is the project-independent engineering method Hermes should follow when a software-development request is complex enough to benefit from a specialist coding agent.

It is intentionally separate from AI Office routing. The workflow says **what engineering phase is needed**; AI Office says **what execution backend/model class should perform it**.

## 2. Complexity gate

Hermes Brain performs a lightweight semantic gate before using external execution.

### Handle directly in Hermes when

- the question is explanatory and does not require repository inspection;
- a tiny config/text edit is obviously local and low risk;
- the answer can be produced from already available context;
- spawning a coding agent would cost more time than the task itself.

### Enter Development Workflow when

- root cause is unknown;
- repository inspection is required;
- several modules may be involved;
- implementation likely requires tests/build/review;
- the user explicitly asks for investigation, refactor, review, or full implementation;
- parallel exploration may materially help.

The gate is guidance, not a permanent model classification. Hermes can escalate after discovering hidden complexity.

## 3. Core phase graph

```text
                   ┌──────────────────┐
                   │ INVESTIGATE_PLAN │
                   └────────┬─────────┘
                            │
                  no change │ change needed
                 needed     ▼
                     ┌──────────────┐
                     │  IMPLEMENT   │
                     └──────┬───────┘
                            │
                            ▼
                   ┌────────────────┐
                   │ VERIFY_REVIEW  │
                   └───────┬────────┘
                           │
                  pass ────┼──── fail
                           │       │
                           ▼       ▼
                       FINALIZE  IMPLEMENT_FIX
                                   │
                                   └────► VERIFY_REVIEW
```

## 4. INVESTIGATE_PLAN

### Goal

Produce one coherent artifact that answers:

1. what is actually happening;
2. what evidence supports the root cause;
3. what alternatives were considered;
4. what should change;
5. how the change should be validated.

### Why investigation and planning are combined

Repository exploration creates expensive contextual state. Splitting diagnosis and plan into unrelated agent conversations forces the second agent to reread the repository and often loses causal evidence.

Default rule:

> investigation + solution planning stay in one OpenHands conversation and one logical execution.

This may also improve upstream prompt/cache locality, but cache savings are a secondary benefit; context continuity is the primary reason.

### Access policy

Default:

```text
filesystem: read-oriented
shell: allowed for diagnostics/tests that do not mutate source intentionally
source edits: prohibited unless explicitly upgraded
```

If the selected backend has a native plan/read-only mode, prefer it.

### Expected result

The final response should contain:

```text
Root cause
Evidence
Affected scope
Recommended solution
Implementation steps
Risks
Verification plan
Open questions
```

The adapter does not need to force strict JSON in V3. Hermes can interpret the returned final text plus deterministic metadata.

## 5. IMPLEMENT

### Goal

Execute an approved/accepted plan and produce verifiable repository changes.

### Workspace policy

Every write-capable execution gets an isolated branch/worktree/workspace.

Recommended naming:

```text
ai-office/<execution-id>
```

For one implementation worker:

```text
source repository
   └── isolated workspace A
```

For parallel workers:

```text
source repository
   ├── workspace A
   ├── workspace B
   └── workspace C
```

No two concurrent writers share the same working tree.

### Agent instructions

The implementation prompt should include:

- objective;
- investigation/plan result;
- acceptance criteria;
- workspace constraints;
- required tests/build commands if known;
- explicit instruction to avoid unrelated refactors.

### Completion evidence

The system should collect mechanically where practical:

```text
workspace/branch
changed-file list
git diff stat
head commit if committed
agent final response
run duration
trace link
```

Do not rely only on the agent saying "done".

## 6. Parallel implementation

Parallelism is allowed only when the plan identifies independent work partitions.

Hermes/Skill may request:

```text
parallelism = N
```

AI Office creates separate executions. Each execution gets:

- unique execution ID;
- isolated workspace;
- its own OpenHands conversation;
- its own trace;
- explicit bounded objective.

A later integration step combines results. Parallelism is not used simply because multiple providers are available.

## 7. VERIFY_REVIEW

### Goal

Independently test and review the actual implementation.

### Freshness rule

Default:

> review starts in a fresh conversation and preferably a different execution backend/model family when economics allow.

This reduces confirmation bias and forces the reviewer to evaluate actual code/diff/evidence rather than inherit the implementer's narrative.

### Inputs

- original user objective;
- investigation/plan result;
- implementation branch/diff;
- acceptance criteria;
- test results available so far.

### Review checks

At minimum:

```text
correctness
regression risk
architecture consistency
security/safety relevant to change
test adequacy
build/type/lint status
unnecessary scope expansion
```

### Output

```text
PASS
or
FAIL + concrete findings + required fixes
```

Hermes, not AI Office, decides whether findings warrant `IMPLEMENT_FIX`, user escalation, or finalization.

## 8. IMPLEMENT_FIX

A fix execution receives only the verified review findings plus the original implementation context needed to repair them.

Default behavior:

- may continue the implementation conversation when context reuse is clearly beneficial;
- must remain in the same isolated branch/workspace unless a new branch is intentionally created;
- after changes, always return to a **fresh** VERIFY_REVIEW execution.

## 9. FINALIZE

Usually no external agent is needed.

Hermes should summarize:

- what was wrong;
- what changed;
- what was verified;
- any remaining risks or manual steps;
- references to branch/PR/trace only when useful.

## 10. Session reuse policy

| Transition                                        | Default                                    |
| ------------------------------------------------- | ------------------------------------------ |
| investigate -> plan within `INVESTIGATE_PLAN`     | same conversation                          |
| plan -> implementation                            | new conversation by default                |
| implementation -> small fix during same execution | same conversation                          |
| implementation -> review                          | fresh conversation                         |
| failed review -> fix                              | implementation conversation may be resumed |
| fix -> re-review                                  | fresh review conversation                  |

The rule optimizes for context reuse where it helps execution and context independence where it helps judgment.

## 11. Model class defaults

Initial policy, intentionally expressed as capability classes rather than concrete vendors:

| Phase                            | Default model class        |
| -------------------------------- | -------------------------- |
| INVESTIGATE_PLAN                 | `planning-premium`         |
| IMPLEMENT                        | `implementation-efficient` |
| IMPLEMENT high-risk/very complex | `implementation-premium`   |
| VERIFY_REVIEW                    | `review-premium`           |
| tiny delegated helper            | `fast-general`             |

AI Office may change mappings without changing this workflow document.

## 12. Example: long white-screen issue

```text
User
  "White screen is too long; investigate the cause and review it."

Hermes
  complexity = medium/high
  -> INVESTIGATE_PLAN

OpenHands + Codex/OpenCode
  inspect bootstrap/render/data loading
  inspect network waterfall / hydration / bundle behavior
  produce evidence and plan

Hermes
  judges implementation worthwhile
  -> IMPLEMENT

OpenHands implementation worker
  changes code in isolated workspace
  runs tests/build

Hermes
  -> VERIFY_REVIEW

fresh reviewer
  checks diff, regression, performance evidence and tests

Hermes
  -> FINALIZE
  explains result to user
```

## 13. Non-goals

This workflow does not define:

- specific provider credentials;
- LiteLLM routing algorithms;
- OpenHands REST schemas;
- Langfuse storage schemas;
- a general project-management/Kanban lifecycle.

Those concerns stay outside the workflow.
