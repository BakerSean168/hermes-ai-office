# Langfuse Observability Strategy

## 1. Decision

Use **Langfuse as the primary trace and model-usage analytics system** for V3 instead of implementing custom token/cost dashboards and trace storage.

AI Office consumes Langfuse data for summaries and deep-links users into Langfuse for detailed trace inspection.

## 2. What Langfuse owns

- trace storage;
- generation observations;
- token usage by usage type;
- model/cost metadata;
- latency and performance attributes where ingested;
- tags and arbitrary metadata;
- historical filtering/search;
- metrics aggregation;
- observability dashboards.

AI Office does not persist duplicate raw generations.

## 3. Trace hierarchy

Recommended semantic hierarchy:

```text
Trace: development execution
  execution_id = exec-...
  project = MemoFlow
  phase = INVESTIGATE_PLAN
  backend = codex-acp

  ├─ Observation: model generation 1
  ├─ Observation: model generation 2
  ├─ Observation: model generation 3
  └─ optional non-LLM spans/events
```

For LiteLLM-managed traffic, the gateway integration should emit the generation observations.

For execution-level events that do not naturally pass through LiteLLM, the thin adapter may create a parent trace/span or attach metadata to the correlated trace.

## 4. Required metadata

Every execution trace should make these dimensions filterable:

```text
execution_id
project_key
phase
hermes_profile
hermes_session_id
openhands_conversation_id
execution_backend
logical_model_class
transport_mode
workspace/branch ref if non-sensitive
```

Optional:

```text
risk_class
parallel_group_id
review_of_execution_id
fix_of_execution_id
commercial_class
```

Do not put secrets, full environment dumps, or unrelated user profile data into metadata.

## 5. Usage types

Langfuse supports multiple usage buckets; preserve provider-reported semantics rather than flattening everything into a single token number.

Preferred categories when available:

```text
input
input_cached/cache_read
cache_creation
output
output_reasoning/reasoning
other provider-specific units
```

The integration must avoid double counting inclusive provider counters. Prefer upstream LiteLLM/Langfuse integrations that already normalize provider usage.

## 6. Cost semantics

Langfuse may ingest explicit cost or infer cost from model definitions.

V3 priority:

```text
1. provider/LiteLLM-reported cost
2. Langfuse model-price inference
3. AI Office commercial metadata for effective marginal-cost interpretation
```

Subscription/free routes should be labelled rather than forcing PAYG list-price cost to represent user economics.

AI Office may present both:

```text
provider/list cost evidence
commercial class / effective marginal cost interpretation
```

## 7. Execution-level summary

AI Office UI should use Langfuse Metrics API or trace queries to derive:

```text
total input usage
total output usage
cache usage
reasoning usage
total provider cost
model/provider breakdown
number of LLM calls
time window
errors
```

This summary is derived; Langfuse remains the analytic store.

## 8. Active execution observability

Langfuse is excellent for model-call observability but is not the execution lifecycle authority.

For active work:

```text
status/duration       <- OpenHands
phase/task metadata   <- AI Office correlation
model/provider usage  <- Langfuse/LiteLLM
```

The AI Office active card joins these three sources.

Do not infer "agent still running" merely because recent generations appear in Langfuse.

## 9. Native-subscription lane

When an ACP backend uses native OAuth/subscription and bypasses LiteLLM:

- create/maintain an execution trace if useful;
- ingest OpenHands/ACP-reported usage when reliable;
- label `usage_source`;
- do not invent provider request-level fallback history;
- cost may remain unknown or subscription-class.

Potential usage source metadata:

```text
usage_source = litellm | acp | openhands | native | estimated | unknown
```

## 10. Prompt/output privacy modes

Because code prompts and model outputs may contain repository content, V3 must support an observability privacy policy.

Recommended levels:

```text
FULL
  store prompts/outputs + metadata

METADATA_ONLY
  store usage/model/latency/status, redact prompt/output

MINIMAL
  store execution correlation + aggregate usage only
```

Default for personal source-code repos can be configured per project. Sensitive/proprietary repositories should be able to force `METADATA_ONLY`.

## 11. Langfuse Cloud vs self-hosted

The architecture does not depend on one deployment mode.

### Preferred initial mode: managed Langfuse

Reason:

- lowest operational burden;
- easiest way to validate traces/metrics;
- avoids operating a significant analytics stack on the Hermes development server.

Use only if repository/prompt privacy requirements permit the selected privacy mode.

### Self-hosted mode

Current Langfuse self-hosting is not a trivial single-container observability service. Modern versions use application containers plus persistent infrastructure such as PostgreSQL, ClickHouse, Redis/Valkey and blob storage.

Therefore:

> Do not casually deploy full Langfuse on oracle2 merely because it is open source.

For self-hosting, prefer:

- a separate VM/host; or
- explicit resource planning and durable backups;
- low-scale Docker Compose only when its operational limitations are acceptable.

## 11.1 Current oracle2 operational observability

Langfuse is intentionally not deployed on oracle2 today. Operational V3 execution
observability is exact rather than absent: LiteLLM spend rows are queried by
`end_user=<executionId>`, because both managed OpenHands built-in and OpenCode ACP
propagate the V3 execution ID into the standard OpenAI-compatible `user` field.

This supplies:

- input/output/cache/reasoning token buckets where LiteLLM reports them;
- spend/cost;
- physical model;
- provider;
- deployment ID;
- model-call count.

It does **not** supply a Langfuse trace tree. AI Office therefore reports separate
health: `observability=OK` and `langfuse=UNCONFIGURED`. Old runs that predate exact
correlation remain unlinked; AI Office never backfills a physical route by timestamp.

This is a complementary operational source, not a replacement for the ADR that makes
Langfuse the preferred future deep analytics/trace authority when such a deployment
is justified.

## 12. AI Office UI behavior

AI Office should avoid rebuilding Langfuse.

Good custom UI:

```text
Today: 12 executions
Input: 8.2M
Output: 310K
Cost: ...
Top logical class: implementation-efficient
Provider failures: 2
```

Then provide a native Langfuse link for:

- full trace tree;
- individual generation prompts/outputs where allowed;
- model latency distribution;
- deep filtering;
- custom dashboards.

## 13. Availability behavior

Langfuse failure must not stop coding execution by default.

Policy:

```text
execution availability > observability availability
```

When observability is down:

- continue OpenHands execution;
- keep LiteLLM request handling if its callback failure policy allows it;
- surface `OBSERVABILITY_DEGRADED` in AI Office;
- avoid blocking the Development Workflow solely for trace ingestion failure.

## 14. Retention

Retention is an observability concern, not a code-execution concern.

Recommended policy dimensions:

```text
prompt/output retention
trace metadata retention
aggregate metric retention
sensitive project overrides
```

Keep the correlation index longer than raw prompt/output only if required for historical AI Office views.

## 15. No custom trace schema lock-in

AI Office code should depend on a narrow `ObservabilityPort`:

```text
get_execution_summary(execution_id)
get_active_usage(execution_id)
get_project_metrics(project, window)
get_trace_link(execution_id)
health()
```

Langfuse-specific query syntax stays inside the adapter.
