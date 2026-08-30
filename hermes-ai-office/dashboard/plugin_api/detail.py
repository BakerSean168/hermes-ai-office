from __future__ import annotations

import time
from typing import Any, Dict, Mapping

from .common import _number, _required_string, _usage
from .config import DASHBOARD_SCHEMA_VERSION
from .plans import (
    _event_detail,
    _health_from_attention,
    _is_system_batch,
    _is_system_work_item,
    _issue_priority,
    _plans,
)

def _review_verdict(raw: Mapping[str, Any]) -> str | None:
    result = raw.get("result")
    if not isinstance(result, Mapping):
        return None
    text = str(result.get("finalText") or "")
    for line in text.splitlines():
        token = line.strip().upper()
        if not token:
            continue
        return token if token in {"PASS", "FAIL"} else None
    return None


_STRONG_MODEL_CLASSES = {"gpt-5.6-sol", "planning-premium", "review-premium"}


def _is_strong_model(model: str | None) -> bool:
    value = str(model or "").strip().lower()
    return value in _STRONG_MODEL_CLASSES or value.startswith("claude-opus")


def _decision_reason(work_item_key: str, phase: str, strong_model: bool) -> str | None:
    if not strong_model:
        return None
    if work_item_key.startswith("batch-verify-b") or phase == "BATCH_VERIFY":
        return "BATCH_AGGREGATE_REVIEW"
    if work_item_key.startswith("integration-repair-b"):
        return "INTEGRATION_REPAIR"
    if work_item_key.startswith("post-merge-fix-"):
        return "POST_MERGE_RECOVERY"
    if work_item_key.startswith("delivery-fix-"):
        return "DELIVERY_REPAIR"
    if phase == "VERIFY_REVIEW":
        return "INDEPENDENT_REVIEW"
    if phase == "IMPLEMENT_FIX":
        return "FAILED_VERIFICATION_REPAIR"
    return "STRONG_MODEL_POLICY"


def _timeline_execution(raw: Mapping[str, Any], plan: Mapping[str, Any], work_item_key: str) -> Dict[str, Any]:
    selection = raw.get("selection") if isinstance(raw.get("selection"), Mapping) else {}
    timing = raw.get("timing") if isinstance(raw.get("timing"), Mapping) else {}
    error = raw.get("error") if isinstance(raw.get("error"), Mapping) else {}
    usage = _usage(raw.get("usage"))
    execution_id = _required_string(raw, "executionId", "plan.execution")
    phase = _required_string(raw, "phase", "plan.execution").upper()
    model = str(selection.get("modelClass") or "") or None
    strong_model = _is_strong_model(model)
    policy_reasons = [
        str(value) for value in selection.get("reasons", [])
        if isinstance(value, str) and value.strip()
    ] if isinstance(selection.get("reasons"), list) else []
    detail = _event_detail(plan, execution_id=execution_id)
    attempt = detail.get("attempt") if isinstance(detail.get("attempt"), int) else None
    return {
        "executionId": execution_id,
        "phase": phase,
        "status": _required_string(raw, "status", "plan.execution").upper(),
        "attempt": attempt,
        "backend": str(selection.get("backend") or "") or None,
        "model": model,
        "policyReasons": policy_reasons,
        "strongModel": strong_model,
        "decisionReason": _decision_reason(work_item_key, phase, strong_model),
        "startedAt": str(timing.get("startedAt") or "") or None,
        "lastObservedAt": str(timing.get("lastObservedAt") or "") or None,
        "endedAt": str(timing.get("endedAt") or "") or None,
        "durationMs": int(_number(timing.get("durationMs"))) if timing.get("durationMs") is not None else None,
        "totalTokens": usage["input"] + usage["output"],
        "costUsd": usage["costUsd"],
        "errorCode": str(error.get("code") or "") or None,
        "errorDetail": str(error.get("detail") or "") or None,
        "verdict": _review_verdict(raw),
    }


_TIMELINE_BATCH_EVENT_PREFIXES = (
    "BATCH_",
    "WORK_ITEM_",
)
_TIMELINE_DELIVERY_EVENT_PREFIXES = (
    "PLAN_DELIVERY_",
    "DELIVERY_",
)


def _timeline_event(event: Mapping[str, Any]) -> Dict[str, Any]:
    detail = event.get("detail") if isinstance(event.get("detail"), Mapping) else {}
    reason = detail.get("reason")
    message = detail.get("message")
    if not isinstance(reason, str) or not reason.strip():
        reason = None
    if not isinstance(message, str) or not message.strip():
        message = None
    return {
        "type": str(event.get("type") or "UNKNOWN"),
        "createdAt": str(event.get("createdAt") or "") or None,
        "reason": reason,
        "message": message,
        "executionId": str(event.get("executionId") or "") or None,
    }


def _plan_detail(raw: Mapping[str, Any]) -> Dict[str, Any]:
    projected, _summary_counts = _plans([raw])
    if not projected:
        raise RuntimeError("control-plane contract violation: plan detail missing plan")
    events = [event for event in raw.get("events", []) if isinstance(event, Mapping)]
    batches = []
    for batch in raw.get("batches", []) if isinstance(raw.get("batches"), list) else []:
        if not isinstance(batch, Mapping):
            continue
        batch_id = batch.get("batchId")
        work_items = []
        for item in batch.get("workItems", []) if isinstance(batch.get("workItems"), list) else []:
            if not isinstance(item, Mapping):
                continue
            work_items.append(
                {
                    "key": str(item.get("key") or ""),
                    "title": str(item.get("title") or ""),
                    "status": str(item.get("status") or "").upper(),
                    "system": _is_system_work_item(item),
                    "objective": str(item.get("objective") or ""),
                    "blockedReason": str(item.get("blockedReason") or "") or None,
                    "acceptanceCriteria": [
                        str(value)
                        for value in item.get("acceptanceCriteria", [])
                        if isinstance(value, str) and value.strip()
                    ],
                    "executions": [
                        _timeline_execution(execution, raw, str(item.get("key") or ""))
                        for execution in item.get("executions", [])
                        if isinstance(execution, Mapping)
                    ],
                }
            )
        batch_events = [
            _timeline_event(event)
            for event in events
            if event.get("batchId") == batch_id
            and any(str(event.get("type") or "").startswith(prefix) for prefix in _TIMELINE_BATCH_EVENT_PREFIXES)
            and str(event.get("type") or "") not in {"WORK_ITEM_VERIFIED"}
        ]
        batches.append(
            {
                "key": str(batch.get("key") or ""),
                "title": str(batch.get("title") or ""),
                "status": str(batch.get("status") or "").upper(),
                "system": _is_system_batch(batch),
                "ordinal": int(batch.get("ordinal")) if isinstance(batch.get("ordinal"), int) else None,
                "baseRevision": str(batch.get("baseRevision") or "") or None,
                "integratedRevision": str(batch.get("integratedRevision") or "") or None,
                "blockedReason": str(batch.get("blockedReason") or "") or None,
                "workItems": work_items,
                "events": batch_events,
            }
        )
    delivery_events = [
        _timeline_event(event)
        for event in events
        if any(str(event.get("type") or "").startswith(prefix) for prefix in _TIMELINE_DELIVERY_EVENT_PREFIXES)
        or str(event.get("type") or "") in {"PLAN_SUCCEEDED"}
    ]
    audit = _plan_audit(batches)
    projected[0]["health"] = audit["health"]
    return {
        "schemaVersion": DASHBOARD_SCHEMA_VERSION,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "plan": projected[0],
        "batches": batches,
        "deliveryEvents": delivery_events,
        "audit": audit,
    }



def _is_repair_execution(work_item_key: str, execution: Mapping[str, Any]) -> bool:
    phase = str(execution.get("phase") or "").upper()
    return phase == "IMPLEMENT_FIX" or (
        phase == "IMPLEMENT" and work_item_key.startswith(("integration-repair-b", "post-merge-fix-", "delivery-fix-"))
    )


def _failed_execution(execution: Mapping[str, Any]) -> bool:
    return str(execution.get("status") or "").upper() in {"FAILED", "STUCK"} or execution.get("verdict") == "FAIL"


def _audit_metrics(executions: list[Mapping[str, Any]], work_item_keys: list[str]) -> Dict[str, Any]:
    repairs = 0
    previous_by_key: dict[str, Mapping[str, Any]] = {}
    for key, execution in zip(work_item_keys, executions):
        previous = previous_by_key.get(key)
        retry_after_failure = (
            str(execution.get("phase") or "").upper() == "IMPLEMENT"
            and previous is not None
            and str(previous.get("phase") or "").upper() == "IMPLEMENT"
            and _failed_execution(previous)
        )
        if _is_repair_execution(key, execution) or retry_after_failure:
            repairs += 1
        previous_by_key[key] = execution
    return {
        "executions": len(executions),
        "failures": sum(_failed_execution(execution) for execution in executions),
        "repairs": repairs,
        "strongModelExecutions": sum(bool(execution.get("strongModel")) for execution in executions),
        "durationMs": sum(int(execution.get("durationMs") or 0) for execution in executions),
        "totalTokens": sum(int(execution.get("totalTokens") or 0) for execution in executions),
        "costUsd": sum(float(execution.get("costUsd") or 0.0) for execution in executions),
    }


def _plan_audit(batches: list[Mapping[str, Any]]) -> Dict[str, Any]:
    all_executions: list[Mapping[str, Any]] = []
    all_keys: list[str] = []
    batch_metrics = []
    attention = []
    strong_decisions = []
    for batch in batches:
        batch_executions: list[Mapping[str, Any]] = []
        batch_keys: list[str] = []
        for work in batch.get("workItems", []):
            if not isinstance(work, Mapping):
                continue
            key = str(work.get("key") or "")
            executions = [value for value in work.get("executions", []) if isinstance(value, Mapping)]
            for index, execution in enumerate(executions):
                batch_executions.append(execution)
                batch_keys.append(key)
                all_executions.append(execution)
                all_keys.append(key)
                if execution.get("strongModel"):
                    strong_decisions.append({
                        "batchKey": str(batch.get("key") or ""),
                        "workItemKey": key,
                        "executionId": execution.get("executionId"),
                        "phase": execution.get("phase"),
                        "model": execution.get("model"),
                        "backend": execution.get("backend"),
                        "reason": execution.get("decisionReason"),
                        "policyReasons": list(execution.get("policyReasons") or []),
                    })
                if _failed_execution(execution):
                    source_phase = str(execution.get("phase") or "").upper()
                    repair = next((
                        candidate for candidate in executions[index + 1:]
                        if _is_repair_execution(key, candidate)
                        or (source_phase == "IMPLEMENT" and str(candidate.get("phase") or "").upper() == "IMPLEMENT")
                    ), None)
                    attention.append({
                        "kind": "FAILURE_REPAIR",
                        "batchKey": str(batch.get("key") or ""),
                        "workItemKey": key,
                        "sourceExecutionId": execution.get("executionId"),
                        "sourcePhase": execution.get("phase"),
                        "reason": execution.get("errorCode") or execution.get("errorDetail") or execution.get("verdict"),
                        "repairExecutionId": repair.get("executionId") if repair else None,
                        "resolved": repair is not None and not _failed_execution(repair),
                    })
        metrics = _audit_metrics(batch_executions, batch_keys)
        batch_metrics.append({"key": str(batch.get("key") or ""), **metrics})
        for event in batch.get("events", []):
            if not isinstance(event, Mapping):
                continue
            event_type = str(event.get("type") or "")
            if "BLOCKED" not in event_type and "FAILED" not in event_type:
                continue
            attention.append({
                "kind": "CONTROL_PLANE_FAILURE",
                "batchKey": str(batch.get("key") or ""),
                "workItemKey": None,
                "sourceExecutionId": event.get("executionId"),
                "sourcePhase": event_type,
                "reason": event.get("reason") or event.get("message") or event_type,
                "repairExecutionId": None,
                "resolved": str(batch.get("status") or "").upper() == "SUCCEEDED",
            })
    for item in attention:
        item["priority"] = _issue_priority(item)
    return {
        "summary": _audit_metrics(all_executions, all_keys),
        "batches": batch_metrics,
        "attention": attention,
        "strongModelDecisions": strong_decisions,
        "health": _health_from_attention(attention),
    }
