# V3 Risks, Trade-offs, and Escape Hatches

## 1. Purpose

V3 intentionally buys lower custom maintenance by depending more heavily on upstream projects. This document records the cost of that decision so future changes are deliberate rather than reactive.

## 2. Risk: upstream API churn

### Problem

OpenHands, LiteLLM, Langfuse and ACP ecosystems evolve quickly. A direct dependency on internal APIs would create frequent breakage.

### Mitigation

- pin versions;
- depend on documented public APIs;
- keep thin adapters;
- contract-test upgrades;
- never let upstream identifiers leak throughout the domain.

### Escape hatch

Replace one adapter while preserving V3 ports.

## 3. Risk: OpenHands becomes too much infrastructure

### Problem

Agent Server + workspace/container orchestration may itself be significant operational machinery.

### Why still acceptable

Those are exactly the hard lifecycle concerns we do not want to reimplement.

### Escape hatch

For a specific simple backend, implement a direct `ExecutionHostPort` adapter later. Do not abandon the port or reintroduce execution logic into Hermes Brain.

## 4. Risk: ACP support differs by agent

### Problem

Codex, OpenCode, Claude Code and custom agents have different auth, model override, permission, metric and base-URL behavior.

### Mitigation

Maintain a tested compatibility matrix rather than claiming universal ACP equivalence.

Each backend declares:

```text
managed transport support
native subscription support
model override support
usage metric quality
write capability
permission behavior
```

## 5. Risk: native subscriptions bypass LiteLLM

### Problem

The economically best Codex/Claude path may be provider-native subscription/OAuth, so LiteLLM cannot see or route those LLM calls.

### Mitigation

Model this honestly as `NATIVE_SUBSCRIPTION`.

- OpenHands owns execution status;
- ACP/OpenHands metrics provide usage when available;
- provider route/cost may be unknown;
- UI labels source quality.

### Trade-off

Central observability is less complete, but native subscription economics/capabilities are preserved.

## 6. Risk: LiteLLM becomes a model single point of failure

### Problem

All managed-lane model traffic depends on one gateway service.

### Mitigation

- keep it private and simple;
- use supported persistence;
- health-check it;
- allow native-subscription lane where appropriate;
- do not make normal Hermes Brain calls depend on it unless separately chosen.

### Escape hatch

Selected OpenHands/ACP backends can be temporarily configured for direct provider access, clearly labelled as unmanaged mode.

## 7. Risk: incorrect routing across non-equivalent models

### Problem

A broad LiteLLM model group may fallback from a premium reasoning model to a materially weaker model while pretending semantics are unchanged.

### Mitigation

Only group **business-equivalent** deployments under one logical alias. Cross-tier fallback requires AI Office/Hermes policy, not silent gateway fallback.

## 8. Risk: cost semantics are misleading

### Problem

PAYG list price, free credits and subscription marginal cost are different concepts.

### Mitigation

Separate:

```text
usage
provider/list cost evidence
commercial class
effective marginal-cost interpretation
```

Do not display one fake "true cost" number when data does not support it.

## 9. Risk: Langfuse self-hosting is heavier than expected

### Problem

Modern Langfuse self-hosting includes substantial storage/analytics infrastructure.

### Mitigation

Use managed Langfuse first when privacy permits, or host it separately. Do not make same-host self-hosting a V3 acceptance criterion.

## 10. Risk: observability leaks source code

### Problem

Prompts/tool outputs can include proprietary code, secrets, logs or personal data.

### Mitigation

Per-project privacy modes and metadata-only tracing. Treat full trace content as sensitive data.

## 11. Risk: Docker socket / execution host compromise

### Problem

OpenHands workspace orchestration can require privileged container-runtime access.

### Mitigation

Dedicated user/host, rootless isolation where possible, private API exposure, minimal mounts, no unrelated secrets.

## 12. Risk: ACP auto-approval grants excessive actions

### Problem

Automated ACP sessions may not provide interactive permission boundaries identical to local CLI usage.

### Mitigation

Use workspace/container isolation as the real security boundary. High-risk infrastructure work remains outside the ordinary coding lane.

## 13. Risk: parallel agents cause merge chaos

### Problem

Parallelism can increase conflicts and integration cost faster than it reduces wall time.

### Mitigation

Only parallelize independently bounded tasks and always isolate writers. Parallelism is a workflow decision, not a router optimization.

## 14. Risk: AI Office slowly grows back into V2

### Problem

Every missing upstream field may tempt implementation of another local ledger/state machine.

### Guardrail

Before adding local persistence ask:

1. Which upstream system owns this fact?
2. Can it be queried or tagged there?
3. Is this actually Hermes-specific policy/correlation?
4. What breaks if we only store a reference?

Only #3 justifies first-class V3 state by default.

## 15. Risk: upstream native UIs duplicate AI Office

### Problem

OpenHands, LiteLLM and Langfuse each already have admin/inspection interfaces.

### Mitigation

AI Office only builds the cross-system everyday view. Deep operations remain in native upstream UIs through links.

## 16. Risk: workflow becomes over-engineered

### Problem

The phase model can become another complex orchestration engine.

### Mitigation

Keep phase semantics in Skill + a few high-level tools. Add durable scheduling only when real unattended workloads prove the need.

## 17. Trade-off summary

| Choice                   | Gain                                 | Cost                                          |
| ------------------------ | ------------------------------------ | --------------------------------------------- |
| OpenHands execution host | mature lifecycle/workspaces/ACP      | upstream dependency and privileged runtime    |
| LiteLLM data plane       | routing/usage/provider reuse         | extra hop and central managed-lane dependency |
| Langfuse observability   | mature tracing/analytics             | privacy/ops considerations                    |
| thin AI Office           | much lower maintenance               | less bespoke control                          |
| native subscription lane | preserves strong subscription agents | incomplete centralized provider telemetry     |
| fresh review             | better independence                  | extra context/token cost                      |

## 18. Decision rule for future complexity

Prefer upstream composition until there is measured evidence that a missing feature materially harms workflow quality, reliability, cost, or safety.

Only then reclaim that specific responsibility into custom code.
