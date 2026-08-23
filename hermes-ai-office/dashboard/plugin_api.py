"""AI Office V3 dashboard backend.

This module is deliberately read-only. It projects authoritative V3 execution facts
and LiteLLM registry/usage facts into one operational dashboard payload. Provider
mutation belongs to LiteLLM Admin; AI Office owns no parallel provider state.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import threading
import time
import urllib.parse
import urllib.request
from typing import Any, Dict, Mapping

from fastapi import APIRouter, HTTPException

router = APIRouter()

_BASE_URL = "http://127.0.0.1:8320"
_CONTRACT_PATH = Path(__file__).resolve().parents[1] / "contracts" / "dashboard.schema.json"
_CONTRACT = json.loads(_CONTRACT_PATH.read_text(encoding="utf-8"))
_DASHBOARD_SCHEMA_VERSION = int(_CONTRACT["properties"]["schemaVersion"]["const"])
_TERMINAL = {"SUCCEEDED", "FAILED", "STUCK", "CANCELLED"}
_CACHE_LOCK = threading.Lock()
_CACHE: tuple[float, int, Dict[str, Any]] | None = None
_CACHE_TTL_SECONDS = 5.0
_HISTORY_HYDRATED = False
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
        if not isinstance(route_raw, Mapping):
            continue
        route = _enrich_route(route_raw, catalog)
        route.update(_usage(route_raw))
        routes.append(route)
    last_raw = upstream.get("route") if isinstance(upstream.get("route"), Mapping) else {}
    last_route = _enrich_route(last_raw, catalog) if last_raw else (routes[0] if routes else None)
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


def _fetch_all_executions(max_items: int) -> list[Mapping[str, Any]]:
    global _HISTORY_HYDRATED
    hydrate = not _HISTORY_HYDRATED
    exhausted = False
    offset = 0
    items: list[Mapping[str, Any]] = []
    while max_items == 0 or len(items) < max_items:
        page_limit = _HISTORY_PAGE_SIZE
        if max_items:
            page_limit = min(page_limit, max_items - len(items))
        query = {
            "limit": page_limit,
            "offset": offset,
            "hydrate": "1" if hydrate else "0",
        }
        payload = _fetch_json(
            "/api/v3/development/executions?" + urllib.parse.urlencode(query),
            timeout=45.0,
        )
        page = [item for item in payload.get("items", []) if isinstance(item, Mapping)]
        items.extend(page)
        if len(page) < page_limit:
            exhausted = True
            break
        offset += len(page)
    if hydrate and exhausted:
        _HISTORY_HYDRATED = True
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
    catalog = _route_catalog(registry)
    executions = [_execution(item, catalog) for item in _fetch_all_executions(limit)]
    active = [item for item in executions if not item["terminal"]]
    history = [item for item in executions if item["terminal"]]
    result: Dict[str, Any] = {
        "schemaVersion": _DASHBOARD_SCHEMA_VERSION,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "summary": _summary(executions),
        "active": active,
        "history": history,
        "analytics": _analytics(executions),
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
