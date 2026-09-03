from __future__ import annotations

import re
from typing import Any, Dict, Mapping

from .common import _required_string

_SYSTEM_WORK_ITEM_PREFIXES = (
    "integration-repair-b",
    "batch-verify-b",
    "delivery-fix-",
    "post-merge-fix-",
)


def _is_system_work_item(item: Mapping[str, Any]) -> bool:
    key = str(item.get("key") or "")
    return any(key.startswith(prefix) for prefix in _SYSTEM_WORK_ITEM_PREFIXES)


def _is_system_batch(batch: Mapping[str, Any]) -> bool:
    return str(batch.get("key") or "").startswith("delivery-fix-")


def _latest_execution(item: Mapping[str, Any]) -> Mapping[str, Any] | None:
    executions = [value for value in item.get("executions", []) if isinstance(value, Mapping)]
    return executions[-1] if executions else None


def _synthetic_attempt(key: str) -> int | None:
    if not any(key.startswith(prefix) for prefix in _SYSTEM_WORK_ITEM_PREFIXES):
        return None
    match = re.search(r"-(\d+)$", key)
    return int(match.group(1)) if match else None


def _event_detail(raw: Mapping[str, Any], *, batch_id: Any = None, work_item_id: Any = None, execution_id: Any = None) -> Mapping[str, Any]:
    events = [event for event in raw.get("events", []) if isinstance(event, Mapping)]
    for event in reversed(events):
        if execution_id is not None and event.get("executionId") == execution_id:
            detail = event.get("detail")
            return detail if isinstance(detail, Mapping) else {}
        if work_item_id is not None and event.get("workItemId") == work_item_id:
            detail = event.get("detail")
            if isinstance(detail, Mapping) and detail:
                return detail
        if batch_id is not None and event.get("batchId") == batch_id:
            detail = event.get("detail")
            if isinstance(detail, Mapping) and detail:
                return detail
    return {}


def _event_reason(raw: Mapping[str, Any], *, batch_id: Any = None, work_item_id: Any = None) -> str | None:
    events = [event for event in raw.get("events", []) if isinstance(event, Mapping)]
    for event in reversed(events):
        matches_item = work_item_id is not None and event.get("workItemId") == work_item_id
        matches_batch = batch_id is not None and event.get("batchId") == batch_id
        if not matches_item and not matches_batch:
            continue
        detail = event.get("detail")
        if not isinstance(detail, Mapping):
            continue
        reason = detail.get("reason")
        if isinstance(reason, str) and reason.strip():
            return reason.strip()
    return None


def _activity_kind(item: Mapping[str, Any], latest: Mapping[str, Any] | None) -> str:
    key = str(item.get("key") or "")
    if key.startswith("post-merge-fix-"):
        return "POST_MERGE_REPAIR"
    if key.startswith("integration-repair-b"):
        return "INTEGRATION_REPAIR"
    if key.startswith("batch-verify-b"):
        return "BATCH_VERIFY"
    if key.startswith("delivery-fix-"):
        return "DELIVERY_REPAIR"
    phase = str((latest or {}).get("phase") or "").upper()
    if phase == "IMPLEMENT_FIX":
        return "TICKET_FIX"
    if phase == "VERIFY_REVIEW":
        return "TICKET_REVIEW"
    if phase == "IMPLEMENT":
        return "IMPLEMENTATION"
    return "WORK_ITEM"


def _current_activity(raw: Mapping[str, Any], current: Mapping[str, Any] | None) -> Dict[str, Any]:
    if current is None:
        delivery_stage = str(raw.get("deliveryStage") or "").upper()
        if delivery_stage:
            return {
                "kind": "DELIVERY",
                "status": str(raw.get("status") or "").upper() or None,
                "phase": delivery_stage,
                "batchKey": None,
                "batchTitle": None,
                "workItemKey": None,
                "workItemTitle": None,
                "attempt": None,
                "backend": None,
                "model": None,
                "reason": raw.get("blockedReason"),
                "revision": raw.get("mergeRevision") or raw.get("currentRevision"),
                "executionId": None,
                "startedAt": None,
                "lastObservedAt": None,
            }
        return {
            "kind": "COMPLETE" if str(raw.get("status") or "").upper() == "SUCCEEDED" else "IDLE",
            "status": str(raw.get("status") or "").upper() or None,
            "phase": None,
            "batchKey": None,
            "batchTitle": None,
            "workItemKey": None,
            "workItemTitle": None,
            "attempt": None,
            "backend": None,
            "model": None,
            "reason": raw.get("blockedReason"),
            "revision": raw.get("currentRevision"),
            "executionId": None,
            "startedAt": None,
            "lastObservedAt": None,
        }

    items = [item for item in current.get("workItems", []) if isinstance(item, Mapping)]
    item = next((value for value in items if str(value.get("status") or "").upper() == "RUNNING"), None)
    if item is None:
        item = next((value for value in items if str(value.get("status") or "").upper() == "BLOCKED"), None)
    if item is None:
        item = next((value for value in items if str(value.get("status") or "").upper() == "PENDING"), None)

    current_status = str(current.get("status") or "").upper()
    if item is None:
        if current_status == "BLOCKED":
            return {
                "kind": "BLOCKED",
                "status": "BLOCKED",
                "phase": "BATCH_INTEGRATION",
                "batchKey": current.get("key"),
                "batchTitle": current.get("title"),
                "workItemKey": None,
                "workItemTitle": None,
                "attempt": None,
                "backend": None,
                "model": None,
                "reason": current.get("blockedReason") or raw.get("blockedReason"),
                "revision": current.get("integratedRevision") or raw.get("currentRevision"),
                "executionId": None,
                "startedAt": None,
                "lastObservedAt": None,
            }
        candidate = current.get("integratedRevision")
        return {
            "kind": "INTEGRATION_CANDIDATE" if candidate else "INTEGRATING",
            "status": current_status or None,
            "phase": "BATCH_VERIFY_PENDING" if candidate else "BATCH_INTEGRATE",
            "batchKey": current.get("key"),
            "batchTitle": current.get("title"),
            "workItemKey": None,
            "workItemTitle": None,
            "attempt": None,
            "backend": None,
            "model": None,
            "reason": current.get("blockedReason") or raw.get("blockedReason"),
            "revision": candidate or raw.get("currentRevision"),
            "executionId": None,
            "startedAt": None,
            "lastObservedAt": None,
        }

    latest = _latest_execution(item)
    selection = (latest or {}).get("selection")
    selection = selection if isinstance(selection, Mapping) else {}
    resource_selection = (latest or {}).get("resourceSelection")
    resource_selection = resource_selection if isinstance(resource_selection, Mapping) else {}
    timing = (latest or {}).get("timing")
    timing = timing if isinstance(timing, Mapping) else {}
    execution_id = (latest or {}).get("executionId")
    execution_detail = _event_detail(raw, execution_id=execution_id) if execution_id else {}
    item_detail = _event_detail(
        raw,
        batch_id=current.get("batchId"),
        work_item_id=item.get("workItemId"),
    )
    key = str(item.get("key") or "")
    attempt = execution_detail.get("attempt")
    if not isinstance(attempt, int):
        attempt = item_detail.get("attempt") if isinstance(item_detail.get("attempt"), int) else None
    if attempt is None:
        attempt = _synthetic_attempt(key)
    reason = item.get("blockedReason") or _event_reason(
        raw,
        batch_id=current.get("batchId"),
        work_item_id=item.get("workItemId"),
    ) or current.get("blockedReason") or raw.get("blockedReason")
    kind = _activity_kind(item, latest)
    revision = current.get("integratedRevision")
    if kind == "POST_MERGE_REPAIR":
        revision = raw.get("mergeRevision") or revision
    return {
        "kind": kind,
        "status": str((latest or {}).get("status") or item.get("status") or "").upper() or None,
        "phase": str((latest or {}).get("phase") or "").upper() or None,
        "batchKey": current.get("key"),
        "batchTitle": current.get("title"),
        "workItemKey": item.get("key"),
        "workItemTitle": item.get("title"),
        "attempt": attempt,
        "backend": resource_selection.get("agentBackend") or selection.get("backend"),
        "model": resource_selection.get("modelFamily") or selection.get("modelClass"),
        "reason": reason,
        "revision": revision,
        "executionId": execution_id,
        "startedAt": timing.get("startedAt") or (latest or {}).get("createdAt"),
        "lastObservedAt": timing.get("lastObservedAt"),
    }


_HEALTH_PRIORITY_ORDER = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
_HEALTH_PRIORITY_PENALTY = {"P0": 60, "P1": 35, "P2": 15, "P3": 5}


def _issue_priority(issue: Mapping[str, Any]) -> str:
    reason = str(issue.get("reason") or "").upper()
    phase = str(issue.get("sourcePhase") or "").upper()
    kind = str(issue.get("kind") or "").upper()
    if reason == "DELIVERY_POST_MERGE_CHECKS_FAILED" or (
        "POST_MERGE" in phase and "FAILED" in reason
    ):
        return "P0"
    if (
        "LIMIT_EXCEEDED" in reason
        or reason in {
            "BATCH_INTEGRATION_FAILED",
            "BATCH_AGGREGATE_REVIEW_FAILED",
            "BATCH_VERIFY_VERDICT_UNKNOWN",
            "REVIEW_VERDICT_UNKNOWN",
            "PLAN_ORCHESTRATION_FAILED",
            "PLAN_ORCHESTRATION_INVALID",
            "DELIVERY_ADAPTER_UNCONFIGURED",
        }
        or kind == "CONTROL_PLANE_FAILURE"
    ):
        return "P1"
    if (
        reason == "FAIL"
        or reason.endswith("CHECKS_FAILED")
        or phase in {"VERIFY_REVIEW", "IMPLEMENT", "IMPLEMENT_FIX", "BATCH_VERIFY"}
    ):
        return "P2"
    return "P3"


def _health_state(score: int) -> str:
    if score >= 100:
        return "HEALTHY"
    if score >= 85:
        return "WATCH"
    if score >= 60:
        return "DEGRADED"
    return "CRITICAL"


def _health_from_attention(attention: list[Mapping[str, Any]]) -> Dict[str, Any]:
    open_items = []
    for item in attention:
        if item.get("resolved"):
            continue
        priority = str(item.get("priority") or _issue_priority(item))
        open_items.append((priority, item))
    open_items.sort(key=lambda pair: _HEALTH_PRIORITY_ORDER.get(pair[0], 99))
    score = max(
        0,
        100 - sum(_HEALTH_PRIORITY_PENALTY.get(priority, 0) for priority, _item in open_items),
    )
    top_issue = None
    top_priority = None
    if open_items:
        top_priority, item = open_items[0]
        top_issue = {
            "priority": top_priority,
            "kind": str(item.get("kind") or ""),
            "reason": str(item.get("reason") or "") or None,
            "batchKey": str(item.get("batchKey") or "") or None,
            "workItemKey": str(item.get("workItemKey") or "") or None,
            "sourceExecutionId": str(item.get("sourceExecutionId") or "") or None,
            "sourcePhase": str(item.get("sourcePhase") or "") or None,
        }
    return {
        "score": score,
        "state": _health_state(score),
        "topPriority": top_priority,
        "issueCount": len(open_items),
        "topIssue": top_issue,
    }


def _summary_plan_health(status: str, activity: Mapping[str, Any]) -> Dict[str, Any]:
    if status == "SUCCEEDED":
        return _health_from_attention([])
    kind = str(activity.get("kind") or "").upper()
    reason = activity.get("reason")
    if status == "BLOCKED":
        issue = {
            "kind": "CONTROL_PLANE_FAILURE",
            "reason": reason or status,
            "sourcePhase": activity.get("phase") or kind,
            "batchKey": activity.get("batchKey"),
            "workItemKey": activity.get("workItemKey"),
            "sourceExecutionId": activity.get("executionId"),
            "resolved": False,
        }
        return _health_from_attention([issue])
    if kind in {"TICKET_FIX", "INTEGRATION_REPAIR", "POST_MERGE_REPAIR", "DELIVERY_REPAIR"}:
        issue = {
            "kind": "FAILURE_REPAIR",
            "reason": reason or kind,
            "sourcePhase": activity.get("phase") or kind,
            "batchKey": activity.get("batchKey"),
            "workItemKey": activity.get("workItemKey"),
            "sourceExecutionId": activity.get("executionId"),
            "resolved": False,
        }
        health = _health_from_attention([issue])
        # An active repair is already making forward progress; keep the plan in WATCH
        # unless the underlying reason itself is critical (for example post-merge CI).
        if health["topPriority"] == "P2":
            health["score"] = 85
            health["state"] = "WATCH"
        return health
    return _health_from_attention([])


def _governance(raw: Mapping[str, Any]) -> Dict[str, Any] | None:
    source = raw.get("source") if isinstance(raw.get("source"), Mapping) else {}
    if str(source.get("kind") or "").upper() != "EXTERNAL_CHANGE":
        return None
    origin = source.get("origin") if isinstance(source.get("origin"), Mapping) else {}
    if str(origin.get("kind") or "").upper() != "GITHUB_PULL_REQUEST":
        return None
    number = origin.get("pullRequestNumber")
    return {
        "kind": "GITHUB_PULL_REQUEST",
        "repository": str(origin.get("repository") or "") or None,
        "pullRequestNumber": int(number) if isinstance(number, int) else None,
        "producer": str(origin.get("producer") or "") or None,
        "headRef": str(origin.get("headRef") or "") or None,
        "baseRef": str(origin.get("baseRef") or "") or None,
        "governedRevision": str(raw.get("externalHeadRevision") or source.get("revision") or "") or None,
        "publishedRevision": str(raw.get("governanceStatusRevision") or "") or None,
        "publishedPlanStatus": str(raw.get("governanceStatusPlanStatus") or "").upper() or None,
    }


def _plans(raw_plans: Any) -> tuple[list[Dict[str, Any]], Dict[str, int]]:
    plans = []
    summary = {"total": 0, "active": 0, "blocked": 0, "succeeded": 0}
    for raw in raw_plans if isinstance(raw_plans, list) else []:
        if not isinstance(raw, Mapping):
            continue
        batches = [batch for batch in raw.get("batches", []) if isinstance(batch, Mapping)]
        business_batches = [batch for batch in batches if not _is_system_batch(batch)]
        system_batches = [batch for batch in batches if _is_system_batch(batch)]
        all_work_items = [
            item
            for batch in batches
            for item in batch.get("workItems", [])
            if isinstance(item, Mapping)
        ]
        work_items = [item for item in all_work_items if not _is_system_work_item(item)]
        system_work_items = [item for item in all_work_items if _is_system_work_item(item)]
        status = _required_string(raw, "status", "plan").upper()
        current = next((batch for batch in batches if str(batch.get("status") or "").upper() == "RUNNING"), None)
        if current is None:
            current = next((batch for batch in batches if str(batch.get("status") or "").upper() == "BLOCKED"), None)
        if current is None:
            current = next((batch for batch in batches if str(batch.get("status") or "").upper() == "PENDING"), None)
        activity = _current_activity(raw, current)
        plans.append(
            {
                "planId": _required_string(raw, "planId", "plan"),
                "projectKey": _required_string(raw, "projectKey", "plan"),
                "objective": _required_string(raw, "objective", "plan"),
                "status": status,
                "currentRevision": _required_string(raw, "currentRevision", "plan"),
                "blockedReason": raw.get("blockedReason"),
                "deliveryStage": raw.get("deliveryStage"),
                "pullRequestUrl": raw.get("pullRequestUrl"),
                "mergeRevision": raw.get("mergeRevision"),
                "governance": _governance(raw),
                "createdAt": raw.get("createdAt"),
                "updatedAt": raw.get("updatedAt"),
                "batches": {"total": len(business_batches), "succeeded": sum(batch.get("status") == "SUCCEEDED" for batch in business_batches)},
                "systemBatches": {"total": len(system_batches), "succeeded": sum(batch.get("status") == "SUCCEEDED" for batch in system_batches)},
                "workItems": {"total": len(work_items), "succeeded": sum(item.get("status") == "SUCCEEDED" for item in work_items)},
                "systemWorkItems": {"total": len(system_work_items), "succeeded": sum(item.get("status") == "SUCCEEDED" for item in system_work_items)},
                "currentBatch": (
                    {
                        "key": current.get("key"),
                        "title": current.get("title"),
                        "status": current.get("status"),
                        "blockedReason": current.get("blockedReason"),
                        "integratedRevision": current.get("integratedRevision"),
                    }
                    if current
                    else None
                ),
                "currentActivity": activity,
                "health": _summary_plan_health(status, activity),
            }
        )
        summary["total"] += 1
        if status in {"ORCHESTRATING", "PENDING", "RUNNING"}:
            summary["active"] += 1
        elif status == "BLOCKED":
            summary["blocked"] += 1
        elif status == "SUCCEEDED":
            summary["succeeded"] += 1
    return plans, summary
