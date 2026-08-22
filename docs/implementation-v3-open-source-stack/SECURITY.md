# V3 Security and Secret Boundaries

## 1. Security objective

V3 intentionally composes powerful systems that can execute shell commands and modify repositories. The security model must prevent convenience from turning the Hermes Brain or AI Office database into a universal secret holder or host-level remote shell.

## 2. Trust zones

```text
Zone A: Hermes Brain / user conversation
Zone B: AI Office facade / policy
Zone C: OpenHands execution/workspaces
Zone D: LiteLLM gateway credentials
Zone E: Langfuse observability data
Zone F: host infrastructure / Docker daemon
```

Cross-zone data should be minimal and explicit.

## 3. Secret ownership

### Provider API secrets

Owner: LiteLLM protected configuration/database/environment.

Never store in:

- Hermes memory;
- AI Office correlation DB;
- Development Skill;
- Langfuse metadata;
- Git repository.

### ACP/native subscription credentials

Owner: execution-host credential store or provider CLI native credential store.

AI Office stores only availability/capability metadata.

### LiteLLM virtual key

May be injected into an OpenHands execution environment, but should be scoped to the models/budget needed by that worker where feasible.

### Langfuse ingestion credentials

Owned by LiteLLM/telemetry adapter runtime environment, never the coding-agent prompt.

## 4. No secret in model context

A central V3 invariant:

> Hermes and coding-agent prompts never contain raw provider API keys because of AI Office routing.

The tool returns safe identifiers such as:

```text
backend
logical model class
transport mode
```

Secret resolution happens below the LLM context boundary.

## 5. OpenHands workspace isolation

Write-capable agents should run in isolated workspaces/containers.

Do not mount:

- the full host home directory;
- unrelated project repositories;
- global `.env` collections;
- host SSH private keys unless a narrowly scoped use case explicitly requires them;
- Docker socket into each worker by default.

If Git network access is needed, prefer scoped deploy credentials or host-mediated operations.

## 6. Docker daemon risk

An Agent Server that can create containers may need privileged access to a container runtime. Direct access to `/var/run/docker.sock` is effectively host-level power in many deployments.

Preferred mitigations:

1. dedicated OpenHands host or VM;
2. rootless/isolated container runtime where supported;
3. dedicated system user and narrowly controlled socket access;
4. never expose Agent Server publicly without authentication/network controls.

On oracle2, treat the OpenHands service as highly privileged infrastructure even if its HTTP API is loopback-only.

## 7. ACP permission behavior

ACP coding agents may request permissions for tool actions. Upstream OpenHands behavior can auto-approve in certain ACP execution paths.

Therefore:

- isolation is the primary safety boundary;
- do not rely solely on interactive permission prompts that may not occur;
- review backend behavior before granting infrastructure/network secrets;
- high-risk infra changes should remain a separate explicit capability lane.

## 8. Network policy

Preferred service exposure:

```text
Hermes -> AI Office: loopback/private
AI Office -> OpenHands: private
AI Office -> LiteLLM admin API: private
OpenHands workers -> LiteLLM: private
LiteLLM -> providers: outbound internet
LiteLLM -> Langfuse: outbound/private depending deployment
```

Do not expose LiteLLM master/admin API or OpenHands Agent Server directly to the public internet without proper auth and TLS.

## 9. Observability privacy

Langfuse may receive code prompts and outputs depending on integration settings.

Project-level privacy modes:

```text
FULL
METADATA_ONLY
MINIMAL
```

`METADATA_ONLY` is recommended when repository content should not leave the execution environment.

Always exclude:

- provider secrets;
- raw environment variables;
- auth files;
- unrelated user personal data.

## 10. Prompt injection from repository content

A coding agent reading a repository can encounter malicious/instruction-like text.

Mitigations:

- treat repository content as untrusted data, not higher-priority policy;
- keep phase constraints in trusted agent/system configuration;
- do not give investigation-only workers unnecessary write/secrets access;
- use fresh review against actual diff/evidence.

## 11. Repository write controls

`INVESTIGATE_PLAN` should be read-oriented.

`IMPLEMENT` receives write access only to its isolated workspace.

`VERIFY_REVIEW` defaults to read-only review access.

Merging to protected/main branches remains a distinct operation governed by Git/CI/user policy.

## 12. Command injection in configuration

Custom ACP commands are code execution configuration.

Therefore:

- only operator-controlled backend registry may define ACP commands;
- repository `.ai-office.yaml` cannot specify arbitrary `command`/`args`;
- Hermes user prompt cannot directly inject a raw worker launch command through normal policy fields.

Explicit admin/debug escape hatches can exist but must be visibly separate.

## 13. Idempotency and replay safety

Hermes/Gateway retries must not duplicate write-capable workers.

`Idempotency-Key` maps to one `execution_id` and one OpenHands conversation creation attempt.

Cancellation/retry logic must distinguish:

```text
retry HTTP request for same execution
vs
create a new workflow execution after a failed run
```

## 14. Supply-chain security

Pin and verify upstream runtime versions.

Particularly sensitive:

- ACP npm packages launched by `npx`;
- OpenHands images/packages;
- LiteLLM image/package;
- Langfuse images/client libraries;
- OpenCode/Codex/Claude CLI updates.

Avoid floating `latest` in production after the exploratory phase.

## 15. Logging

Service logs should record identifiers and error classes, not secrets.

Recommended safe fields:

```text
execution_id
conversation_id
phase
backend
model class
status
error type
duration
```

Redact Authorization headers, API keys, raw auth files, and provider payloads unless explicitly needed in a secure debug mode.
