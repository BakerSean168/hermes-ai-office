from __future__ import annotations

from typing import Any, Dict, Mapping

from .common import _number, _required_string, _usage

_TERMINAL = {"SUCCEEDED", "FAILED", "STUCK", "CANCELLED"}

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
