# Architecture

## Authority boundaries

| Concern                                                   | Authority                                      |
| --------------------------------------------------------- | ---------------------------------------------- |
| Phase and causal execution state                          | AI Office V3 Control Plane                     |
| Workspace isolation / review snapshots                    | AI Office V3 Control Plane                     |
| Worker lifecycle                                          | OpenHands                                      |
| Logical aliases, credentials, deployments, retry/fallback | LiteLLM                                        |
| Spend and token facts                                     | LiteLLM spend logs, correlated by execution ID |
| Operator dashboard                                        | AI Office read-only projection                 |

There is no fallback to the retired V2 control plane and no direct-harness placement path.

## Execution phases

```text
PLAN -> IMPLEMENT -> VERIFY_REVIEW
                    | FAIL -> IMPLEMENT_FIX -> VERIFY_REVIEW
                    | PASS -> BATCH_INTEGRATE -> next batch
                                               -> authorized delivery
                                                  -> PR checks
                                                     | FAIL -> delivery-fix batch
                                                     | PASS -> merge -> post-merge checks
```

`VERIFY_REVIEW` is strict: its first non-empty line is exactly `PASS` or `FAIL`.
The control plane persists terminal review evidence first-write-wins. Caller supplied `previousResult` is never authoritative for a review verdict.

Remote delivery sits behind the small `PlanDeliveryPort.reconcile` interface.
The coordinator owns durable causal state; the GitHub adapter owns Git push, PR
reuse, check interpretation, protected merge, and merge-revision verification.

## Provider routing

Model-backed phases use `LITELLM_MANAGED` only. Current backends are:

- `openhands-builtin`
- `opencode-acp` through OpenHands
- `control-plane-finalizer` for deterministic FINALIZE

Physical provider routing can retry/fallback across deployments. Per-deployment usage is retained so provider/channel analytics do not incorrectly attribute a multi-route execution to only its final route.
