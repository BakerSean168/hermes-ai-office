from __future__ import annotations

from typing import Any, Dict, Mapping

from .common import _number, _required_string, _usage

_TERMINAL = {"SUCCEEDED", "FAILED", "STUCK", "CANCELLED"}
_CAPABILITIES = {"IMPLEMENTATION", "REASONING"}
_TRANSPORTS = {"LITELLM_MANAGED", "PROVIDER_NATIVE"}
_RESOURCE_TIERS = {"PROMOTIONAL", "FREE", "SUBSCRIPTION", "METERED", "OTHER"}
_RESOURCE_STATES = {"ACTIVE", "SUSPENDED", "DISABLED"}


def _resource_selection(raw: Any) -> Dict[str, Any] | None:
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        raise RuntimeError("control-plane contract violation: resourceSelection must be an object or null")
    result: Dict[str, Any] = {}
    for key in ("capability", "modelFamily", "agentBackend", "resourceId", "selectionReason"):
        value = raw.get(key)
        if not isinstance(value, str) or not value.strip():
            raise RuntimeError(f"control-plane contract violation: resourceSelection.{key} must be a non-empty string")
        result[key] = value.strip()
    result["capability"] = result["capability"].upper()
    if result["capability"] not in _CAPABILITIES:
        raise RuntimeError("control-plane contract violation: resourceSelection.capability is invalid")
    result["transport"] = raw.get("transport")
    if not isinstance(result["transport"], str) or result["transport"].upper() not in _TRANSPORTS:
        raise RuntimeError("control-plane contract violation: resourceSelection.transport is invalid")
    result["transport"] = result["transport"].upper()
    result["resourceTier"] = raw.get("resourceTier")
    if not isinstance(result["resourceTier"], str) or result["resourceTier"].upper() not in _RESOURCE_TIERS:
        raise RuntimeError("control-plane contract violation: resourceSelection.resourceTier is invalid")
    result["resourceTier"] = result["resourceTier"].upper()
    result["resourceState"] = raw.get("resourceState")
    if not isinstance(result["resourceState"], str) or result["resourceState"].upper() not in _RESOURCE_STATES:
        raise RuntimeError("control-plane contract violation: resourceSelection.resourceState is invalid")
    result["resourceState"] = result["resourceState"].upper()
    sequence = raw.get("resourceSequence")
    if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 0:
        raise RuntimeError("control-plane contract violation: resourceSelection.resourceSequence must be a non-negative integer")
    result["resourceSequence"] = sequence
    if result["selectionReason"] != "STATIC_POLICY":
        raise RuntimeError("control-plane contract violation: resourceSelection.selectionReason is invalid")
    for key in ("routeModel", "deploymentId", "protocol"):
        value = raw.get(key)
        if value is not None:
            if not isinstance(value, str):
                raise RuntimeError(f"control-plane contract violation: resourceSelection.{key} must be a string or null")
            value = value.strip() or None
        result[key] = value
    # Keep the canonical DTO order and do not pass through unknown fields.
    canonical = {
        "capability": result["capability"],
        "modelFamily": result["modelFamily"],
        "agentBackend": result["agentBackend"],
        "transport": result["transport"],
        "resourceId": result["resourceId"],
        "resourceTier": result["resourceTier"],
        "resourceSequence": result["resourceSequence"],
        "resourceState": result["resourceState"],
        "selectionReason": result["selectionReason"],
    }
    for key in ("routeModel", "deploymentId", "protocol"):
        if key in raw and result[key] is not None:
            canonical[key] = result[key]
    return canonical

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
        "modelGroup": str(raw.get("modelGroup") or deployment.get("group") or "") or None,
        "credential": str(raw.get("credential") or deployment.get("credential") or "") or None,
        "commercialType": str(raw.get("commercialType") or deployment.get("commercialType") or "") or None,
        "supplyOrigin": str(raw.get("supplyOrigin") or deployment.get("supplyOrigin") or "") or None,
        "order": raw.get("order") if raw.get("order") is not None else deployment.get("order"),
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
        route.update({
            "successfulCalls": int(_number(route_raw.get("successfulCalls"))),
            "failedCalls": int(_number(route_raw.get("failedCalls"))),
            "responseCacheHits": int(_number(route_raw.get("responseCacheHits"))),
            "successfulRequestDurationMs": int(_number(route_raw.get("successfulRequestDurationMs"))),
        })
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
    result = {
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
    resource_selection = _resource_selection(raw.get("resourceSelection"))
    if resource_selection is not None:
        result["resourceSelection"] = resource_selection
    return result


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
        "successfulCalls": 0,
        "failedCalls": 0,
        "responseCacheHits": 0,
        "successfulRequestDurationMs": 0,
        "costUsd": 0.0,
        "durationMs": 0,
        "usageAvailable": False,
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
    for key in (
        "input",
        "output",
        "cachedInput",
        "reasoningOutput",
        "calls",
        "successfulCalls",
        "failedCalls",
        "responseCacheHits",
        "successfulRequestDurationMs",
    ):
        bucket[key] += int(_number(usage.get(key)))
    bucket["costUsd"] += _number(usage.get("costUsd"))
    if duration:
        bucket["durationMs"] += int(_number(execution.get("durationMs")))


def _finish_buckets(values: Mapping[str, Dict[str, Any]]) -> list[Dict[str, Any]]:
    return _finish_buckets_with_nullability(values, nullable_usage=False)


def _finish_buckets_with_nullability(
    values: Mapping[str, Dict[str, Any]],
    *,
    nullable_usage: bool,
) -> list[Dict[str, Any]]:
    rows = []
    for bucket in values.values():
        executions = len(bucket["executions"])
        succeeded = len(bucket["succeeded"])
        failed = len(bucket["failed"])
        total_tokens = bucket["input"] + bucket["output"]
        measured_calls = bucket["successfulCalls"] + bucket["failedCalls"]
        row = {
            k: v
            for k, v in bucket.items()
            if k not in {"executions", "succeeded", "failed", "successfulRequestDurationMs", "usageAvailable"}
        }
        row.update(
            {
                "executions": executions,
                "succeeded": succeeded,
                "failed": failed,
                "successRate": (succeeded / (succeeded + failed)) if succeeded + failed else None,
                "totalTokens": total_tokens,
                "callSuccessRate": (bucket["successfulCalls"] / measured_calls) if measured_calls else None,
                "promptCacheRate": (bucket["cachedInput"] / bucket["input"]) if bucket["input"] else None,
                "responseCacheHitRate": (bucket["responseCacheHits"] / bucket["calls"]) if bucket["calls"] else None,
                "costPerMillionTokens": (bucket["costUsd"] * 1_000_000 / total_tokens) if total_tokens else None,
                "avgSuccessfulLatencyMs": (bucket["successfulRequestDurationMs"] / bucket["successfulCalls"]) if bucket["successfulCalls"] else None,
            }
        )
        if nullable_usage and not bucket["usageAvailable"]:
            for key in (
                "totalTokens", "input", "output", "cachedInput", "reasoningOutput", "calls",
                "successfulCalls", "failedCalls", "responseCacheHits", "callSuccessRate",
                "promptCacheRate", "responseCacheHitRate", "costPerMillionTokens", "costUsd",
            ):
                row[key] = None
        rows.append(row)
    rows.sort(
        key=lambda row: (
            -(float(row["costUsd"]) if row["costUsd"] is not None else -1.0),
            -(int(row["totalTokens"]) if row["totalTokens"] is not None else -1),
            str(row["key"]),
        )
    )
    return rows


def _analytics(executions: list[Mapping[str, Any]]) -> Dict[str, Any]:
    groups = {
        name: {}
        for name in (
            "projects",
            "phases",
            "logicalModels",
            "providers",
            "providerModels",
            "physicalModels",
            "selectedModels",
            "agents",
            "resources",
        )
    }
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
            provider_model = provider_key + " · " + physical_model
            _add(
                groups["providerModels"].setdefault(provider_model, _new_bucket(provider_model)),
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
        selection = execution.get("resourceSelection")
        if isinstance(selection, Mapping):
            selection_usage = execution.get("usage") if isinstance(execution.get("usage"), Mapping) else {}
            usage_available = any(
                _number(selection_usage.get(key)) > 0
                for key in ("input", "output", "cachedInput", "reasoningOutput")
            )
            for group_name, key in (
                ("selectedModels", selection.get("modelFamily")),
                ("agents", selection.get("agentBackend")),
                ("resources", selection.get("resourceId")),
            ):
                if not isinstance(key, str) or not key.strip():
                    continue
                bucket = groups[group_name].setdefault(key, _new_bucket(key))
                _add(bucket, execution, selection_usage if usage_available else {})
                if usage_available:
                    bucket["usageAvailable"] = True
    return {
        name: (_finish_buckets_with_nullability(values, nullable_usage=True) if name in {"selectedModels", "agents", "resources"} else _finish_buckets(values))
        for name, values in groups.items()
    }


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
