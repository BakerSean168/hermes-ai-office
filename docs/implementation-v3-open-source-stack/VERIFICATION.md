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

Representative workflow count remains intentionally below the required threshold until real production work accumulates. The ledger currently records three real workflows, including the BS-PROD-012 production delivery that exercised durable review/fix recovery, merge-conflict repair, CI repair, provider transport recovery, automatic merge, and exact-merge post-merge verification. The threshold remains 10; it is not lowered to manufacture a READY result.

Core phase coverage follows the durable-plan path (`ORCHESTRATE` → `IMPLEMENT` → `VERIFY_REVIEW`). `INVESTIGATE_PLAN` is optional, while deterministic integration/finalization is owned by the control plane rather than emitted as a `FINALIZE` worker execution. Repair-path coverage remains a separate fix-loop gate.
