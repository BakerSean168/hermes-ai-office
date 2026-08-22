# Preliminary Agent/Gateway Compatibility Matrix

**Status:** research-based planning matrix; every `PROBE` item must be verified against pinned runtime versions before production enablement.

## 1. Purpose

ACP standardizes conversation transport, but it does not make every coding agent identical. This matrix keeps execution policy honest about what is proven upstream, what is expected, and what still needs a local integration probe.

## 2. Backend matrix

| Backend            | OpenHands path                                 |                ACP support |     Native subscription |          LiteLLM-managed route | Usage evidence                    | Initial phase fit               |
| ------------------ | ---------------------------------------------- | -------------------------: | ----------------------: | -----------------------------: | --------------------------------- | ------------------------------- |
| OpenHands built-in | native Agent                                   |                        n/a |                      no |                 **documented** | LiteLLM/Langfuse                  | all                             |
| Codex              | OpenHands ACPAgent / Agent Canvas preset       |             **documented** |          **documented** |   **PROBE / backend-specific** | ACP/OpenHands; LiteLLM if managed | plan, review, complex implement |
| OpenCode           | OpenHands custom ACP server via `opencode acp` | **documented by OpenCode** |      provider-dependent | **PROBE; expected strong fit** | ACP/OpenHands; LiteLLM if managed | plan, implement, review         |
| Claude Code        | OpenHands ACP preset                           |             **documented** |          **documented** |   **PROBE / backend-specific** | ACP/OpenHands; LiteLLM if managed | plan, review, premium implement |
| Gemini CLI         | OpenHands ACP preset                           |             **documented** |          **documented** |                          PROBE | ACP/OpenHands; LiteLLM if managed | optional                        |
| DSH                | external adapter                               |        unknown/not assumed | implementation-specific |        implementation-specific | unknown until adapter             | efficient implement if retained |

## 3. What "LiteLLM-managed" means

A backend is only marked production-capable for `LITELLM_MANAGED` after a real probe proves:

- model calls actually hit the LiteLLM Proxy;
- the scoped LiteLLM credential is accepted;
- expected model override is honored;
- tool/streaming behavior still works;
- usage/cost appears in LiteLLM and Langfuse;
- provider failures/fallback do not break agent protocol semantics.

A CLI merely supporting a "base URL" field is not enough evidence.

## 4. Native subscription semantics

When native OAuth/subscription is selected:

```text
AI Office route scope: choose backend + native lane
LiteLLM route scope: none
provider usage source: ACP/OpenHands/native if available
```

This lane is useful when subscriptions provide strong value, but must not be represented as centrally routed provider traffic.

## 5. Backend-specific probes

### Codex

- [ ] pinned Codex ACP package starts under OpenHands Agent Server;
- [ ] native ChatGPT login works in isolated execution host;
- [ ] API-key mode works;
- [ ] test custom gateway/base URL against LiteLLM;
- [ ] model override mapping works;
- [ ] cancellation and final metrics are observable;
- [ ] file/shell actions stay inside workspace.

### OpenCode

- [ ] pinned `opencode acp` starts under OpenHands ACPAgent;
- [ ] plan/read-only mode can be selected for INVESTIGATE_PLAN;
- [ ] build/write mode can be selected for IMPLEMENT;
- [ ] provider/base URL can be pointed at LiteLLM;
- [ ] logical model alias is accepted;
- [ ] usage events propagate through ACP/OpenHands;
- [ ] LSP/project behavior works in isolated workspace.

### Claude Code

- [ ] pinned ACP server starts;
- [ ] native login works when desired;
- [ ] API-key + LiteLLM gateway path is tested;
- [ ] fresh review conversation is reproducible;
- [ ] permission behavior is understood under Agent Server automation.

### DSH

- [ ] identify whether current DSH already exposes ACP;
- [ ] if not, decide whether its incremental value justifies one small adapter;
- [ ] if retained, define exact status/result/usage contract;
- [ ] do not build a generic worker framework merely for DSH.

## 6. Model-class compatibility

Logical model classes should declare backend compatibility rather than assuming every agent accepts every model:

```yaml
planning-premium:
  preferred_backends: [codex-acp, claude-code-acp, opencode-acp]

implementation-efficient:
  preferred_backends: [opencode-acp, openhands-builtin, dsh]

review-premium:
  preferred_backends: [codex-acp, claude-code-acp]
```

The final compatibility matrix is data produced by probes, not a permanent hard-coded belief.
