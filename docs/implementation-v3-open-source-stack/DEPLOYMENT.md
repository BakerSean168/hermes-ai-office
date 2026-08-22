# V3 Deployment Topology

## 1. Objective

Deploy V3 without coupling coding-agent infrastructure lifecycle to the existing multiplexed Hermes Gateway.

The key operational property is:

> OpenHands/LiteLLM/Langfuse maintenance must not require recreating the Hermes production container or terminating unrelated Hermes profiles.

## 2. Recommended logical topology

```text
oracle2 / Hermes host

Hermes Gateway + Profiles
        │
        ▼
AI Office V3 plugin
        │ loopback/private
        ▼
AI Office V3 facade
        │
        ├──────────────► OpenHands Agent Server
        │                    │
        │                    └─ isolated workspaces / ACP subprocesses
        │
        ├──────────────► LiteLLM Proxy
        │                    │
        │                    └─ providers
        │
        └──────────────► Langfuse API (cloud or self-hosted)
```

OpenHands workers also connect directly to LiteLLM when using `LITELLM_MANAGED` transport.

## 3. Service isolation

Prefer separate service units/containers:

```text
ai-office-v3
openhands-agent-server
litellm
```

Langfuse is either:

- managed external service initially; or
- separately self-hosted stack.

Do not put all components into the existing `hermes-personal` container.

## 4. Why Langfuse should not be casually co-located

Current Langfuse self-hosting is a multi-component analytics stack, typically involving:

- Langfuse Web;
- Langfuse Worker;
- PostgreSQL;
- ClickHouse;
- Redis/Valkey;
- object/blob storage.

This is operationally much heavier than the AI Office facade.

Recommended sequence:

```text
Phase 1: managed Langfuse or separate test instance
Phase 2: decide whether privacy/cost justifies self-hosting
Phase 3: if self-hosted, deploy on a separate VM/host when practical
```

Do not consume oracle2 development capacity merely to satisfy a philosophical preference for self-hosting.

## 5. Network names rather than fixed host ports

Inside a dedicated Compose/private network, prefer service DNS:

```text
http://ai-office-v3:<port>
http://openhands:<port>
http://litellm:4000
http://langfuse:<port>  # only self-hosted
```

Only expose host ports that Hermes/operator UI actually needs.

Proposed external host bindings must be selected after checking current oracle2 port usage; this document intentionally does not reserve a number prematurely.

## 6. OpenHands runtime placement

### Same-host initial deployment

Acceptable for PoC if:

- Agent Server API is private/loopback;
- workspace containers are isolated;
- CPU/memory limits prevent a coding run from starving Hermes;
- Docker daemon access is treated as privileged.

### Separate worker host

Preferred when:

- many concurrent coding agents run;
- build/test workloads are heavy;
- host security boundaries matter;
- oracle2 stability is more important than locality.

Because OpenHands Agent Server is remote-capable, moving execution later should not change the Hermes/AI Office contract.

## 7. LiteLLM placement

LiteLLM is latency-sensitive but lightweight compared with Langfuse analytics.

Recommended:

- same private network as OpenHands initially;
- persistent supported DB/config for virtual key/spend features;
- provider credentials only in LiteLLM secret boundary;
- no public admin endpoint.

## 8. Resource controls

At minimum apply limits to execution workspaces:

```text
CPU
memory
process count
workspace disk
execution timeout
```

The Agent Server itself should not be able to exhaust the host through unbounded parallel work.

AI Office policy also defines a maximum concurrent writer count per project/host.

## 9. Service dependency policy

Avoid hard boot dependency chains that prevent Hermes from starting.

```text
Hermes Gateway   -> independent
AI Office plugin -> loads even if V3 facade is unhealthy; tool reports unavailable
AI Office V3     -> can start with Langfuse unavailable
OpenHands        -> can start with LiteLLM unavailable, but managed executions fail until gateway returns
LiteLLM          -> should not require Langfuse availability to serve model traffic
```

Observability failure is degraded mode, not total service outage.

## 10. Health checks

V3 facade health summary:

```text
Hermes integration: local plugin loaded
OpenHands: API reachable + execution probe
LiteLLM: gateway reachable + configured model groups visible
Langfuse: API/auth check
Git workspace provisioner: writable capacity available
```

Expose component health separately; avoid one red/green aggregate that hides which subsystem failed.

## 11. Backups

### AI Office V3 correlation DB

Small but useful. Daily/simple backup is sufficient.

### LiteLLM database/config

Back up according to its deployment mode because it may contain gateway configuration/virtual-key state/spend data.

### Langfuse self-hosted

Requires real backup design across its persistent stores. This is another reason to defer self-hosting unless needed.

### OpenHands workspaces

Ephemeral execution workspaces are not the durable source of code history. Important changes must be committed/pushed or preserved through Git before cleanup.

## 12. Upgrade strategy

Upgrade one upstream boundary at a time:

```text
1. pin current versions
2. run adapter contract tests
3. upgrade OpenHands OR LiteLLM OR Langfuse, not all at once
4. run one real development vertical slice
5. verify traces/usage/cancel/recovery
6. proceed to next component
```

## 13. Hermes deployment safety

The repository's existing oracle2 safe deploy mechanism remains mandatory for Hermes plugin/dashboard changes.

External V3 services should have independent deployment commands so most V3 iteration does not restart the multiplexed Hermes Gateway.

Three Hermes-plugin change classes are enforced by `hermes-ai-office-deploy`:

1. **static dashboard** (`dashboard/dist/**`) — hot sync + plugin cache rescan; no process restart;
2. **dashboard backend** (`dashboard/plugin_api.py` / manifest) — restart only the s6-supervised Dashboard process and assert Gateway PID is unchanged;
3. **runtime plugin** — stage while Gateway is busy, then acquire native drain, restart only the Gateway, wait for health, cancel drain, and separately restart Dashboard if the staged tree also changed backend code.

The deployer never force-recreates `hermes-personal`. Runtime activation is deferred
when `active_agents` or `active_sessions` is non-zero. This behavior was exercised
live while unrelated development work was active.
