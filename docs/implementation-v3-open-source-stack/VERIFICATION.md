# Verification

Promotion requires evidence, not probe volume.

Current readiness gates include:

- representative real workflows;
- phase coverage;
- strict review verdict / durable evidence;
- fix-loop behavior;
- provider fallback;
- gateway reconnect survival;
- workspace isolation;
- operator recovery;
- exact execution observability.

Representative workflow count remains intentionally below the required threshold until real production work accumulates. The dependency-security remediation is recorded as a real representative workflow because its implementation, independent review, CI, merge, and GitHub dependency-graph result are all verifiable.
Core phase coverage follows the durable-plan model-backed path (`ORCHESTRATE` → `IMPLEMENT` → `VERIFY_REVIEW`). `INVESTIGATE_PLAN` is optional, while integration and finalization are deterministic control-plane operations rather than required worker executions. Repair coverage remains a separate fix-loop gate.
