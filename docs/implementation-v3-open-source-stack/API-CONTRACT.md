# AI Office V3 API Contract

## 1. Philosophy

V3 intentionally exposes a small API. It is a facade over authoritative upstream systems, not a full workforce platform API.

Proposed namespace:

```text
/api/v3/development/*
/api/v3/office/*
/api/v3/policy/*
```

The Hermes plugin may call this over loopback/private network only.

## 2. Common identifiers

```text
executionId        globally unique V3 correlation ID
conversationId     OpenHands conversation ID
traceId            Langfuse trace ID when available
projectKey         stable human/project identifier
phase              DevelopmentPhase
```

All timestamps are RFC 3339 UTC on the wire.

## 3. Start execution

```http
POST /api/v3/development/executions
```

Request:

```json
{
  "phase": "INVESTIGATE_PLAN",
  "objective": "Investigate why the initial white screen lasts too long and propose a fix.",
  "projectKey": "memoflow",
  "repository": {
    "path": "/workspace/repos/memoflow",
    "baseRevision": "HEAD"
  },
  "context": {
    "previousExecutionId": null,
    "previousResult": null,
    "acceptanceCriteria": []
  },
  "hints": {
    "complexity": "MEDIUM",
    "risk": "MEDIUM",
    "parallelism": 1,
    "quality": "PREMIUM",
    "budget": "NORMAL"
  },
  "override": {
    "backend": null,
    "modelClass": null,
    "transportMode": null
  },
  "hermes": {
    "profile": "memoflow",
    "sessionId": "...",
    "turnId": "..."
  },
  "await": true
}
```

Response when `await=false`:

```json
{
  "executionId": "exec_...",
  "status": "STARTING",
  "selection": {
    "backend": "codex-acp",
    "modelClass": "planning-premium",
    "transportMode": "LITELLM_MANAGED"
  },
  "openhands": {
    "conversationId": "..."
  },
  "links": {
    "self": "/api/v3/development/executions/exec_..."
  }
}
```

Response when `await=true` and terminal:

```json
{
  "executionId": "exec_...",
  "phase": "INVESTIGATE_PLAN",
  "status": "SUCCEEDED",
  "selection": {
    "backend": "codex-acp",
    "modelClass": "planning-premium",
    "transportMode": "LITELLM_MANAGED",
    "reasons": ["premium investigation policy", "backend healthy"]
  },
  "result": {
    "finalText": "...",
    "workspaceRef": "...",
    "git": {
      "branch": null,
      "changedFiles": []
    }
  },
  "timing": {
    "startedAt": "...",
    "endedAt": "...",
    "durationMs": 402000
  },
  "usage": {
    "source": "LITELLM_REPORTED",
    "input": 382000,
    "output": 18100,
    "cachedInput": 220000,
    "reasoningOutput": null,
    "costUsd": 0.42
  },
  "refs": {
    "openhandsConversationId": "...",
    "langfuseTraceId": "..."
  }
}
```

## 4. Get execution

```http
GET /api/v3/development/executions/:executionId
```

The service queries OpenHands for current lifecycle state and enriches it from the correlation index and observability adapters.

Response may be partial:

```json
{
  "executionId": "exec_...",
  "status": "RUNNING",
  "timing": {
    "startedAt": "...",
    "durationMs": 280000
  },
  "usage": null,
  "sourceHealth": {
    "openhands": "OK",
    "litellm": "OK",
    "langfuse": "DEGRADED"
  }
}
```

## 5. Continue execution

```http
POST /api/v3/development/executions/:executionId/messages
```

Request:

```json
{
  "message": "Address the review finding about the loading fallback and rerun the focused tests.",
  "await": true
}
```

Only use when workflow policy permits session reuse.

## 6. Cancel execution

```http
POST /api/v3/development/executions/:executionId/cancel
```

The adapter asks OpenHands to cancel/pause according to supported semantics. AI Office does not mark the run cancelled until OpenHands confirms/reflects the resulting state.

## 7. List active work

```http
GET /api/v3/office/active
```

Response:

```json
{
  "items": [
    {
      "executionId": "exec_...",
      "projectKey": "memoflow",
      "phase": "IMPLEMENT",
      "objectiveSummary": "Reduce bootstrap white-screen duration",
      "backend": "opencode-acp",
      "modelClass": "implementation-efficient",
      "transportMode": "LITELLM_MANAGED",
      "status": "RUNNING",
      "durationMs": 511000,
      "lastObservedRoute": {
        "model": "...",
        "provider": "..."
      },
      "usage": {
        "input": 2100000,
        "output": 71000,
        "costUsd": 0.18
      }
    }
  ],
  "sourceHealth": {
    "openhands": "OK",
    "litellm": "OK",
    "langfuse": "OK"
  }
}
```

## 8. Execution history

```http
GET /api/v3/office/history?projectKey=memoflow&phase=IMPLEMENT&limit=50
```

History is a projection, not a second authoritative ledger. It joins the minimal correlation index to OpenHands/Langfuse data.

## 9. Gateway/provider summary

```http
GET /api/v3/office/models
GET /api/v3/office/providers
GET /api/v3/office/usage?window=24h
```

These are read-only facade endpoints over LiteLLM/Langfuse for the default UI.

Advanced provider administration should prefer native LiteLLM tooling.

## 10. Policy API

```http
GET /api/v3/policy/development
PUT /api/v3/policy/development
```

Policy is safe business configuration, for example:

```json
{
  "INVESTIGATE_PLAN": {
    "backends": ["codex-acp", "opencode-acp"],
    "modelClass": "planning-premium",
    "transportPreference": ["LITELLM_MANAGED", "NATIVE_SUBSCRIPTION"]
  }
}
```

The policy API must not accept raw provider secrets.

## 11. Idempotency

Start calls require an idempotency key or deterministic request token derived from the Hermes tool call.

Recommended header:

```text
Idempotency-Key: <hermes-turn/tool-call-id>
```

Rule:

> Retrying a timed-out Hermes request must return/reconnect to the same V3 execution rather than spawn a duplicate coding agent.

## 12. Error model

```json
{
  "error": {
    "code": "EXECUTION_BACKEND_UNAVAILABLE",
    "message": "No eligible OpenHands execution backend is currently available.",
    "retryable": true,
    "details": {
      "phase": "IMPLEMENT"
    }
  }
}
```

Core codes:

```text
INVALID_REQUEST
POLICY_NO_ELIGIBLE_BACKEND
EXECUTION_BACKEND_UNAVAILABLE
WORKSPACE_PROVISION_FAILED
MODEL_GATEWAY_UNAVAILABLE
EXECUTION_FAILED
EXECUTION_NOT_FOUND
EXECUTION_NOT_CONTINUABLE
OBSERVABILITY_DEGRADED   # usually warning, not hard error
OVERRIDE_REJECTED
```

## 13. Streaming

Optional V3 stream:

```http
GET /api/v3/development/executions/:executionId/events
```

The facade should proxy/normalize only enough OpenHands events for Hermes/Desktop progress UI. It should not persist a second complete event store.

Useful normalized event kinds:

```text
execution.started
execution.progress
execution.agent_message
execution.tool_activity_summary
execution.completed
execution.failed
```

Raw upstream event inspection belongs in OpenHands debugging tools.

## 14. Versioning

V3 facade schemas are ours and may remain stable across OpenHands/LiteLLM/Langfuse upgrades.

All upstream-specific fields must stay under namespaced `refs`/`upstream` objects rather than leaking into top-level domain semantics.
