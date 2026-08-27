"""AI Office V3 dashboard backend.

This module is deliberately read-only. It projects authoritative V3 execution facts
and LiteLLM registry/usage facts into one operational dashboard payload. Provider
mutation belongs to LiteLLM Admin; AI Office owns no parallel provider state.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Mapping

from fastapi import APIRouter, HTTPException

router = APIRouter()

_BASE_URL = os.environ.get(
    "HERMES_AI_OFFICE_CONTROL_PLANE_URL", "http://127.0.0.1:8320"
).rstrip("/")
_CONTRACT_PATH = Path(__file__).resolve().parents[1] / "contracts" / "dashboard.schema.json"
_CONTRACT = json.loads(_CONTRACT_PATH.read_text(encoding="utf-8"))
_DASHBOARD_SCHEMA_VERSION = int(_CONTRACT["properties"]["schemaVersion"]["const"])
_TERMINAL = {"SUCCEEDED", "FAILED", "STUCK", "CANCELLED"}
_CACHE_LOCK = threading.Lock()
_CACHE: tuple[float, int, Dict[str, Any]] | None = None
_CACHE_TTL_SECONDS = 5.0
_HISTORY_PAGE_SIZE = 500


def _fetch_json(path: str, *, timeout: float = 12.0) -> Dict[str, Any]:
    if not path.startswith("/api/v3/") and path != "/api/health":
        raise ValueError("dashboard may access only V3 control-plane APIs")
    request = urllib.request.Request(_BASE_URL + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        value = json.load(response)
    if not isinstance(value, dict):
        raise RuntimeError("control plane returned a non-object payload")
    return value


def _number(value: Any) -> float:
    try:
        result = float(value or 0)
        return result if result == result else 0.0
    except (TypeError, ValueError):
        return 0.0


def _required_string(value: Mapping[str, Any], key: str, source: str) -> str:
    raw = value.get(key)
    if not isinstance(raw, str) or not raw.strip():
        raise RuntimeError(f"control-plane contract violation: {source}.{key} must be a non-empty string")
    return raw


def _usage(value: Any) -> Dict[str, Any]:
    raw = value if isinstance(value, Mapping) else {}
    return {
        "input": int(_number(raw.get("input"))),
        "output": int(_number(raw.get("output"))),
        "cachedInput": int(_number(raw.get("cachedInput"))),
        "reasoningOutput": int(_number(raw.get("reasoningOutput"))),
        "calls": int(_number(raw.get("calls"))),
        "costUsd": _number(raw.get("costUsd")),
    }


def _route_catalog(registry: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    deployments = registry.get("deployments") if isinstance(registry.get("deployments"), Mapping) else {}
    result: Dict[str, Dict[str, Any]] = {}
    for raw in deployments.get("items", []) if isinstance(deployments.get("items"), list) else []:
        if not isinstance(raw, Mapping):
            continue
        deployment_id = str(raw.get("id") or "").strip()
        if deployment_id:
            result[deployment_id] = dict(raw)
    return result


def _has_complete_route_identity(raw: Mapping[str, Any]) -> bool:
    return all(isinstance(raw.get(key), str) and str(raw.get(key)).strip() for key in ("deploymentId", "providerKey", "model"))


def _enrich_route(raw: Mapping[str, Any], catalog: Mapping[str, Mapping[str, Any]]) -> Dict[str, Any]:
    deployment_id = _required_string(raw, "deploymentId", "refs.upstream.route")
    provider_key = _required_string(raw, "providerKey", "refs.upstream.route")
    physical_model = _required_string(raw, "model", "refs.upstream.route")
    deployment = catalog.get(deployment_id, {})
    return {
        "deploymentId": deployment_id,
        "providerKey": provider_key,
        "physicalModel": physical_model,
        "modelGroup": str(deployment.get("group") or "") or None,
        "credential": str(deployment.get("credential") or "") or None,
        "commercialType": str(deployment.get("commercialType") or "") or None,
        "supplyOrigin": str(deployment.get("supplyOrigin") or "") or None,
        "order": deployment.get("order"),
    }


def _execution(raw: Mapping[str, Any], catalog: Mapping[str, Mapping[str, Any]]) -> Dict[str, Any]:
    timing = raw.get("timing") if isinstance(raw.get("timing"), Mapping) else {}
    usage = _usage(raw.get("usage"))
    selection = raw.get("selection")
    if not isinstance(selection, Mapping):
        raise RuntimeError("control-plane contract violation: selection must be an object")
    refs = raw.get("refs") if isinstance(raw.get("refs"), Mapping) else {}
    upstream = refs.get("upstream") if isinstance(refs.get("upstream"), Mapping) else {}
    route_usage_raw = upstream.get("routeUsage") if isinstance(upstream.get("routeUsage"), list) else []
    routes = []
    for route_raw in route_usage_raw:
        if not isinstance(route_raw, Mapping) or not _has_complete_route_identity(route_raw):
            continue
        route = _enrich_route(route_raw, catalog)
        route.update(_usage(route_raw))
        routes.append(route)
    last_raw = upstream.get("route") if isinstance(upstream.get("route"), Mapping) else {}
    last_route = (
        _enrich_route(last_raw, catalog)
        if last_raw and _has_complete_route_identity(last_raw)
        else (routes[0] if routes else None)
    )
    execution_id = _required_string(raw, "executionId", "execution")
    project_key = _required_string(raw, "projectKey", "execution")
    objective = _required_string(raw, "objectiveSummary", "execution")
    phase = _required_string(raw, "phase", "execution")
    status = _required_string(raw, "status", "execution").upper()
    logical_model = _required_string(selection, "modelClass", "execution.selection")
    backend = _required_string(selection, "backend", "execution.selection")
    workspace_mode = _required_string(selection, "workspaceMode", "execution.selection")
    started_at = str(timing.get("startedAt") or "") or None
    ended_at = str(timing.get("endedAt") or "") or None
    duration_ms = int(_number(timing.get("durationMs"))) if timing.get("durationMs") is not None else None
    return {
        "executionId": execution_id,
        "projectKey": project_key,
        "objective": objective,
        "phase": phase,
        "status": status,
        "startedAt": started_at,
        "endedAt": ended_at,
        "durationMs": duration_ms,
        "logicalModel": logical_model,
        "backend": backend,
        "workspaceMode": workspace_mode,
        "previousExecutionId": raw.get("previousExecutionId"),
        "usage": usage,
        "totalTokens": usage["input"] + usage["output"],
        "route": last_route,
        "routeUsage": routes,
        "terminal": status in _TERMINAL,
    }


def _new_bucket(key: str) -> Dict[str, Any]:
    return {
        "key": key,
        "executions": set(),
        "succeeded": set(),
        "failed": set(),
        "input": 0,
        "output": 0,
        "cachedInput": 0,
        "reasoningOutput": 0,
        "calls": 0,
        "costUsd": 0.0,
        "durationMs": 0,
    }


def _add(
    bucket: Dict[str, Any],
    execution: Mapping[str, Any],
    usage: Mapping[str, Any],
    *,
    duration: bool = True,
    outcome: bool = True,
) -> None:
    execution_id = str(execution.get("executionId") or "")
    if execution_id:
        bucket["executions"].add(execution_id)
        if outcome:
            status = str(execution.get("status") or "")
            if status == "SUCCEEDED":
                bucket["succeeded"].add(execution_id)
            elif status in {"FAILED", "STUCK", "CANCELLED"}:
                bucket["failed"].add(execution_id)
    for key in ("input", "output", "cachedInput", "reasoningOutput", "calls"):
        bucket[key] += int(_number(usage.get(key)))
    bucket["costUsd"] += _number(usage.get("costUsd"))
    if duration:
        bucket["durationMs"] += int(_number(execution.get("durationMs")))


def _finish_buckets(values: Mapping[str, Dict[str, Any]]) -> list[Dict[str, Any]]:
    rows = []
    for bucket in values.values():
        executions = len(bucket["executions"])
        succeeded = len(bucket["succeeded"])
        failed = len(bucket["failed"])
        row = {k: v for k, v in bucket.items() if k not in {"executions", "succeeded", "failed"}}
        row.update(
            {
                "executions": executions,
                "succeeded": succeeded,
                "failed": failed,
                "successRate": (succeeded / (succeeded + failed)) if succeeded + failed else None,
                "totalTokens": bucket["input"] + bucket["output"],
            }
        )
        rows.append(row)
    rows.sort(key=lambda row: (-float(row["costUsd"]), -int(row["totalTokens"]), str(row["key"])))
    return rows


def _analytics(executions: list[Mapping[str, Any]]) -> Dict[str, Any]:
    groups = {name: {} for name in ("projects", "phases", "logicalModels", "providers", "physicalModels")}
    for execution in executions:
        usage = execution.get("usage") if isinstance(execution.get("usage"), Mapping) else {}
        for group_name, key in (
            ("projects", str(execution["projectKey"])),
            ("phases", str(execution["phase"])),
            ("logicalModels", str(execution["logicalModel"])),
        ):
            bucket = groups[group_name].setdefault(key, _new_bucket(key))
            _add(bucket, execution, usage)
        routes = execution.get("routeUsage") if isinstance(execution.get("routeUsage"), list) else []
        for route in routes:
            if not isinstance(route, Mapping):
                continue
            provider_key = str(route["providerKey"])
            physical_model = str(route["physicalModel"])
            _add(
                groups["providers"].setdefault(provider_key, _new_bucket(provider_key)),
                execution,
                route,
                duration=False,
                outcome=False,
            )
            _add(
                groups["physicalModels"].setdefault(physical_model, _new_bucket(physical_model)),
                execution,
                route,
                duration=False,
                outcome=False,
            )
    return {name: _finish_buckets(values) for name, values in groups.items()}


def _summary(executions: list[Mapping[str, Any]]) -> Dict[str, Any]:
    terminal = [item for item in executions if item.get("terminal")]
    active = [item for item in executions if not item.get("terminal")]
    usage = _usage({})
    duration_ms = 0
    succeeded = 0
    failed = 0
    for item in executions:
        item_usage = item.get("usage") if isinstance(item.get("usage"), Mapping) else {}
        for key in ("input", "output", "cachedInput", "reasoningOutput", "calls"):
            usage[key] += int(_number(item_usage.get(key)))
        usage["costUsd"] += _number(item_usage.get("costUsd"))
        duration_ms += int(_number(item.get("durationMs")))
        if item.get("status") == "SUCCEEDED":
            succeeded += 1
        elif item.get("status") in {"FAILED", "STUCK", "CANCELLED"}:
            failed += 1
    return {
        "totalExecutions": len(executions),
        "activeExecutions": len(active),
        "terminalExecutions": len(terminal),
        "succeeded": succeeded,
        "failed": failed,
        "successRate": (succeeded / (succeeded + failed)) if succeeded + failed else None,
        "totalDurationMs": duration_ms,
        "totalTokens": usage["input"] + usage["output"],
        **usage,
    }


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
        }

    latest = _latest_execution(item)
    selection = (latest or {}).get("selection")
    selection = selection if isinstance(selection, Mapping) else {}
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
        "backend": selection.get("backend"),
        "model": selection.get("modelClass"),
        "reason": reason,
        "revision": revision,
        "executionId": execution_id,
        "startedAt": timing.get("startedAt") or (latest or {}).get("createdAt"),
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
                "currentActivity": _current_activity(raw, current),
            }
        )
        summary["total"] += 1
        if status in {"PENDING", "RUNNING"}:
            summary["active"] += 1
        elif status == "BLOCKED":
            summary["blocked"] += 1
        elif status == "SUCCEEDED":
            summary["succeeded"] += 1
    return plans, summary



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


def _timeline_execution(raw: Mapping[str, Any], plan: Mapping[str, Any]) -> Dict[str, Any]:
    selection = raw.get("selection") if isinstance(raw.get("selection"), Mapping) else {}
    timing = raw.get("timing") if isinstance(raw.get("timing"), Mapping) else {}
    error = raw.get("error") if isinstance(raw.get("error"), Mapping) else {}
    usage = _usage(raw.get("usage"))
    execution_id = _required_string(raw, "executionId", "plan.execution")
    detail = _event_detail(plan, execution_id=execution_id)
    attempt = detail.get("attempt") if isinstance(detail.get("attempt"), int) else None
    return {
        "executionId": execution_id,
        "phase": _required_string(raw, "phase", "plan.execution"),
        "status": _required_string(raw, "status", "plan.execution").upper(),
        "attempt": attempt,
        "backend": str(selection.get("backend") or "") or None,
        "model": str(selection.get("modelClass") or "") or None,
        "startedAt": str(timing.get("startedAt") or "") or None,
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
                        _timeline_execution(execution, raw)
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
    return {
        "schemaVersion": _DASHBOARD_SCHEMA_VERSION,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "plan": projected[0],
        "batches": batches,
        "deliveryEvents": delivery_events,
    }

def _fetch_all_executions(max_items: int) -> list[Mapping[str, Any]]:
    # Dashboard reads must remain observational. Execution-host hydration can block on
    # remote workers and belongs to explicit control-plane reconciliation, not UI loads.
    offset = 0
    items: list[Mapping[str, Any]] = []
    while max_items == 0 or len(items) < max_items:
        page_limit = _HISTORY_PAGE_SIZE
        if max_items:
            page_limit = min(page_limit, max_items - len(items))
        query = {"limit": page_limit, "offset": offset, "hydrate": "0"}
        payload = _fetch_json(
            "/api/v3/development/executions?" + urllib.parse.urlencode(query),
            timeout=12.0,
        )
        page = [item for item in payload.get("items", []) if isinstance(item, Mapping)]
        items.extend(page)
        if len(page) < page_limit:
            break
        offset += len(page)
    return items


def _build_dashboard(limit: int) -> Dict[str, Any]:
    global _CACHE
    with _CACHE_LOCK:
        if (
            _CACHE
            and _CACHE[1] == limit
            and time.monotonic() - _CACHE[0] < _CACHE_TTL_SECONDS
        ):
            return _CACHE[2]

    runtime = _fetch_json("/api/v3/development/runtime-summary")
    readiness = _fetch_json("/api/v3/development/readiness")
    registry = _fetch_json("/api/v3/development/model-registry")
    plan_payload = _fetch_json("/api/v3/development/plans?limit=100&view=summary")
    catalog = _route_catalog(registry)
    executions = [_execution(item, catalog) for item in _fetch_all_executions(limit)]
    active = [item for item in executions if not item["terminal"]]
    history = [item for item in executions if item["terminal"]]
    plans, plan_summary = _plans(plan_payload.get("items"))
    result: Dict[str, Any] = {
        "schemaVersion": _DASHBOARD_SCHEMA_VERSION,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "summary": _summary(executions),
        "active": active,
        "history": history,
        "analytics": _analytics(executions),
        "plans": plans,
        "planSummary": plan_summary,
        "runtime": runtime,
        "readiness": readiness,
        "registry": registry,
    }
    with _CACHE_LOCK:
        _CACHE = (time.monotonic(), limit, result)
    return result


@router.get("/health")
async def health() -> Dict[str, Any]:
    try:
        value = await asyncio.to_thread(_fetch_json, "/api/v3/health")
        return {"ok": True, "controlPlane": value}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc



@router.get("/plans/{plan_id}")
async def plan_detail(plan_id: str) -> Dict[str, Any]:
    safe_plan_id = urllib.parse.quote(str(plan_id), safe="")
    try:
        raw = await asyncio.to_thread(_fetch_json, f"/api/v3/development/plans/{safe_plan_id}")
        return _plan_detail(raw)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise HTTPException(status_code=404, detail="plan not found") from exc
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

@router.get("/dashboard")
async def dashboard(limit: int = 0) -> Dict[str, Any]:
    raw_limit = int(limit)
    safe_limit = 0 if raw_limit <= 0 else min(50_000, raw_limit)
    try:
        return await asyncio.to_thread(_build_dashboard, safe_limit)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/model-registry")
async def model_registry() -> Dict[str, Any]:
    try:
        return await asyncio.to_thread(_fetch_json, "/api/v3/development/model-registry")
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
