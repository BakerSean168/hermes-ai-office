from __future__ import annotations

import concurrent.futures
import threading
import time
import urllib.parse
from typing import Any, Callable, Dict, Mapping

from . import config
from .executions import _analytics, _execution, _resource_selection, _route_catalog, _summary
from .plans import _plans
from .resources import resources as _resources

FetchJson = Callable[..., Dict[str, Any]]

_CACHE_LOCK = threading.Lock()
_CACHE_BUILD_LOCK = threading.Lock()
_CACHE: tuple[float, int, Dict[str, Any]] | None = None
_CACHE_TTL_SECONDS = 5.0

_V4_TERMINAL_STATUSES = {"SUCCEEDED", "FAILED", "CANCELLED"}
_V4_BLOCKED_PLAN_STATUSES = {
    "WAITING_FOR_RESOURCE",
    "WAITING_FOR_SYSTEM_REPAIR",
    "WAITING_FOR_EXTERNAL_EVIDENCE",
    "SAFETY_HOLD",
}


def _v4_execution(
    raw: Mapping[str, Any],
    project_keys: Mapping[str, str],
) -> Dict[str, Any]:
    identity = raw.get("identity") if isinstance(raw.get("identity"), Mapping) else {}
    execution_id = str(identity.get("executionId") or "").strip()
    plan_id = str(identity.get("planId") or "").strip()
    route = str(identity.get("route") or "").strip()
    status = str(raw.get("status") or "").upper()
    if not execution_id or not plan_id or not route or not status:
        raise RuntimeError("control-plane V4 execution identity is incomplete")
    created_at = str(raw.get("createdAt") or "") or None
    updated_at = str(raw.get("updatedAt") or "") or None
    telemetry = raw.get("telemetry") if isinstance(raw.get("telemetry"), Mapping) else {}
    usage = telemetry.get("usage") if isinstance(telemetry.get("usage"), Mapping) else {}
    route_identity = telemetry.get("route") if isinstance(telemetry.get("route"), Mapping) else None
    route_usage = [
        item for item in telemetry.get("routeUsage", [])
        if isinstance(item, Mapping)
    ] if isinstance(telemetry.get("routeUsage"), list) else []
    result = {
        "executionId": execution_id,
        "projectKey": project_keys.get(plan_id, plan_id),
        "objectiveSummary": str(raw.get("objective") or execution_id),
        "phase": str(identity.get("phase") or "IMPLEMENT"),
        "status": status,
        "selection": {
            "modelClass": route,
            "backend": "openhands",
            "workspaceMode": "isolated_workspace",
        },
        "timing": {
            "startedAt": created_at,
            "endedAt": updated_at if status in _V4_TERMINAL_STATUSES else None,
        },
        "usage": usage,
        "refs": {
            "upstream": {
                "route": route_identity,
                "routeUsage": route_usage,
            }
        },
        "previousExecutionId": identity.get("parentExecutionId"),
        "createdAt": created_at,
    }
    resource_selection = _resource_selection(raw.get("resourceSelection"))
    if resource_selection is not None:
        result["resourceSelection"] = resource_selection
    return result


def _v4_plan(
    aggregate: Mapping[str, Any],
    project_keys: Mapping[str, str],
) -> Dict[str, Any]:
    source = aggregate.get("plan") if isinstance(aggregate.get("plan"), Mapping) else {}
    plan = dict(source)
    plan_status = str(plan.get("status") or "").upper()
    if plan_status in _V4_BLOCKED_PLAN_STATUSES:
        plan["status"] = "BLOCKED"
    elif plan_status in {"DRAFT", "READY"}:
        plan["status"] = "PENDING"
    graph = aggregate.get("graph") if isinstance(aggregate.get("graph"), Mapping) else {}
    executions_by_item: Dict[str, list[Dict[str, Any]]] = {}
    for raw_execution in aggregate.get("executions") or []:
        if not isinstance(raw_execution, Mapping):
            continue
        identity = (
            raw_execution.get("identity")
            if isinstance(raw_execution.get("identity"), Mapping)
            else {}
        )
        item_id = str(identity.get("workItemId") or "")
        executions_by_item.setdefault(item_id, []).append(
            _v4_execution(raw_execution, project_keys)
        )
    work_items = []
    statuses = []
    for raw_item in aggregate.get("workItems") or []:
        if not isinstance(raw_item, Mapping):
            continue
        item = dict(raw_item)
        item["key"] = item.get("itemKey")
        item["executions"] = executions_by_item.get(
            str(item.get("workItemId") or ""), []
        )
        work_items.append(item)
        statuses.append(str(item.get("status") or "").upper())
    if str(plan.get("status") or "").upper() == "SUCCEEDED":
        batch_status = "SUCCEEDED"
    elif any(status in {"FAILED", "BLOCKED"} for status in statuses):
        batch_status = "BLOCKED"
    elif any(status == "RUNNING" for status in statuses):
        batch_status = "RUNNING"
    else:
        batch_status = "PENDING"
    plan["batches"] = [
        {
            "batchId": graph.get("graphVersionId")
            or (str(plan.get("planId") or "") + ":graph"),
            "key": "v4-work-graph",
            "title": "V4 Work Graph",
            "status": batch_status,
            "createdAt": graph.get("createdAt") or plan.get("createdAt"),
            "updatedAt": plan.get("updatedAt"),
            "workItems": work_items,
        }
    ]
    return plan


def _health_views(health: Mapping[str, Any]) -> tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    execution_runtime = (
        health.get("executionRuntime")
        if isinstance(health.get("executionRuntime"), Mapping)
        else {}
    )
    implementation_routes = [
        str(route) for route in execution_runtime.get("implementationRoutes") or []
    ]
    review_routes = [str(route) for route in execution_runtime.get("reviewRoutes") or []]
    enabled = bool(execution_runtime.get("enabled"))
    runtime = {
        "sourceHealth": {
            "openhands": "OK" if enabled else "DISABLED",
            "litellm": "OK" if implementation_routes and review_routes else "UNCONFIGURED",
        },
        "apiVersion": health.get("apiVersion"),
        "mode": health.get("mode"),
        "autonomousPolling": bool(execution_runtime.get("autonomousPolling")),
    }
    readiness = {
        "ready": enabled and health.get("status") == "ok",
        "gates": {
            "representativeWorkflows": {
                "current": 1 if enabled else 0,
                "required": 1,
            }
        },
    }
    routes = [
        {"id": route, "group": route, "role": role, "status": "ACTIVE"}
        for role, values in (
            ("IMPLEMENTATION", implementation_routes),
            ("REVIEW", review_routes),
        )
        for route in values
    ]
    registry = {
        "adminUrl": None,
        "health": "OK" if routes else "UNCONFIGURED",
        "deployments": {
            "active": len(routes),
            "paused": 0,
            "items": routes,
        },
    }
    return runtime, readiness, registry


def fetch_all_executions(max_items: int, fetch_json: FetchJson) -> list[Mapping[str, Any]]:
    limit = min(1000, max_items) if max_items > 0 else 1000
    payload = fetch_json(
        "/api/v4/executions?" + urllib.parse.urlencode({"limit": limit, "view": "dashboard"}),
        timeout=12.0,
    )
    return [
        item
        for item in payload.get("items", [])
        if isinstance(item, Mapping)
    ][:limit]


def build_dashboard(limit: int, fetch_json: FetchJson) -> Dict[str, Any]:
    global _CACHE

    def cached() -> Dict[str, Any] | None:
        with _CACHE_LOCK:
            if (
                _CACHE
                and _CACHE[1] == limit
                and time.monotonic() - _CACHE[0] < _CACHE_TTL_SECONDS
            ):
                return _CACHE[2]
        return None

    hit = cached()
    if hit is not None:
        return hit

    with _CACHE_BUILD_LOCK:
        hit = cached()
        if hit is not None:
            return hit
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            health_future = pool.submit(fetch_json, "/api/health")
            plans_future = pool.submit(
                fetch_json, "/api/v4/plans?limit=100&view=summary"
            )
            executions_future = pool.submit(fetch_all_executions, limit, fetch_json)
            resources_future = pool.submit(fetch_json, "/api/v4/resources")
            health = health_future.result()
            raw_plan_payload = plans_future.result()
            raw_executions = executions_future.result()
            resource_payload = resources_future.result()

        raw_aggregates = [
            item
            for item in raw_plan_payload.get("items", [])
            if isinstance(item, Mapping)
        ]
        project_keys = {
            str(item["plan"].get("planId")): str(item["plan"].get("projectKey"))
            for item in raw_aggregates
            if isinstance(item.get("plan"), Mapping)
        }
        runtime, readiness, registry = _health_views(health)
        resource_rows = _resources(resource_payload)
        plan_payload = {
            "items": [_v4_plan(item, project_keys) for item in raw_aggregates]
        }
        catalog = _route_catalog(registry)
        executions = [
            _execution(_v4_execution(item, project_keys), catalog)
            for item in raw_executions
        ]
        active = [item for item in executions if not item["terminal"]]
        history = [item for item in executions if item["terminal"]]
        plans, plan_summary = _plans(plan_payload.get("items"))
        result: Dict[str, Any] = {
            "schemaVersion": config.DASHBOARD_SCHEMA_VERSION,
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
            "resources": resource_rows,
        }
        with _CACHE_LOCK:
            _CACHE = (time.monotonic(), limit, result)
        return result
