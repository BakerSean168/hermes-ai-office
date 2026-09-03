"""AI Office dashboard API package.

The Hermes dashboard loader imports this ``__init__.py`` directly via
``spec_from_file_location``. Python recognizes an ``__init__.py`` location as a
package, so sibling projection modules remain normal relative imports without
sys.path mutation or custom module-loader shims.
"""
from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.parse
from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from . import assembly as _assembly
from . import config as _config
from .common import _number, _required_string, _usage
from .detail import (
    _audit_metrics,
    _decision_reason,
    _failed_execution,
    _is_repair_execution,
    _is_strong_model,
    _plan_audit,
    _plan_detail,
    _review_verdict,
    _timeline_event,
    _timeline_execution,
)
from .executions import _analytics, _execution, _resource_selection, _route_catalog, _summary
from .plans import (
    _activity_kind,
    _current_activity,
    _event_detail,
    _event_reason,
    _health_from_attention,
    _health_state,
    _is_system_batch,
    _is_system_work_item,
    _issue_priority,
    _plans,
    _summary_plan_health,
)
from .transport import fetch_json as _transport_fetch_json, post_json as _transport_post_json
from .resources import _resource, resources as _resources

router = APIRouter()

# Stable facade hooks: tests and callers can replace these without reaching into
# internal modules. Assembly receives the facade function explicitly.
_fetch_json = _transport_fetch_json
_post_json = _transport_post_json


def _build_dashboard(limit: int) -> Dict[str, Any]:
    return _assembly.build_dashboard(limit, _fetch_json)


def _fetch_all_executions(max_items: int):
    return _assembly.fetch_all_executions(max_items, _fetch_json)


@router.get("/health")
async def health() -> Dict[str, Any]:
    try:
        value = await asyncio.to_thread(_fetch_json, "/api/health")
        return {"ok": True, "controlPlane": value}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/plans/{plan_id}/resume-from-handoff")
async def resume_from_handoff(plan_id: str, handoff: Dict[str, Any]) -> Dict[str, Any]:
    safe_plan_id = urllib.parse.quote(str(plan_id), safe="")
    try:
        return await asyncio.to_thread(
            _post_json,
            f"/api/v3/development/plans/{safe_plan_id}/handoffs",
            handoff,
            timeout=12.0,
        )
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise HTTPException(status_code=404, detail="plan not found") from exc
        if exc.code in {400, 409, 422}:
            try:
                body = json.loads(exc.read().decode("utf-8"))
                detail = body.get("error", {}).get("code") if isinstance(body, dict) else None
            except Exception:
                detail = None
            raise HTTPException(status_code=exc.code, detail=detail or str(exc)) from exc
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/plans/{plan_id}/sync-and-continue")
async def sync_and_continue(plan_id: str) -> Dict[str, Any]:
    safe_plan_id = urllib.parse.quote(str(plan_id), safe="")
    try:
        return await asyncio.to_thread(
            _post_json,
            f"/api/v3/development/plans/{safe_plan_id}/reconcile",
            {"mode": "sync_external"},
            timeout=12.0,
        )
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise HTTPException(status_code=404, detail="plan not found") from exc
        if exc.code in {400, 409, 422}:
            try:
                body = json.loads(exc.read().decode("utf-8"))
                detail = body.get("error", {}).get("code") if isinstance(body, dict) else None
            except Exception:
                detail = None
            raise HTTPException(status_code=exc.code, detail=detail or str(exc)) from exc
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/plans/{plan_id}")
async def plan_detail(plan_id: str) -> Dict[str, Any]:
    safe_plan_id = urllib.parse.quote(str(plan_id), safe="")
    try:
        raw = await asyncio.to_thread(_fetch_json, f"/api/v4/plans/{safe_plan_id}")
        plan = raw.get("plan") if isinstance(raw.get("plan"), dict) else {}
        project_keys = {str(plan.get("planId") or ""): str(plan.get("projectKey") or "")}
        return _plan_detail(_assembly._v4_plan(raw, project_keys))
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
        health = await asyncio.to_thread(_fetch_json, "/api/health")
        return _assembly._health_views(health)[2]
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/resources")
async def resource_list() -> Dict[str, Any]:
    try:
        payload = await asyncio.to_thread(_fetch_json, "/api/v4/resources")
        return {
            "schemaVersion": _config.DASHBOARD_SCHEMA_VERSION,
            "items": _resources(payload),
        }
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def _resource_state_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=422, detail="resource state payload must be an object")
    state = payload.get("state")
    if not isinstance(state, str) or state.upper() not in {"ACTIVE", "SUSPENDED", "DISABLED"}:
        raise HTTPException(status_code=422, detail="state must be ACTIVE, SUSPENDED, or DISABLED")
    result: Dict[str, Any] = {"state": state.upper()}
    for key in ("reason", "suspendedUntil"):
        value = payload.get(key)
        if value is not None:
            if not isinstance(value, str):
                raise HTTPException(status_code=422, detail=f"{key} must be a string or null")
            if value.strip():
                result[key] = value.strip()
    if "expectedVersion" in payload and payload["expectedVersion"] is not None:
        expected_version = payload["expectedVersion"]
        if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version < 0:
            raise HTTPException(status_code=422, detail="expectedVersion must be a non-negative integer or null")
        result["expectedVersion"] = expected_version
    return result


@router.post("/resources/{resource_id}/state")
async def resource_state(resource_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    safe_resource_id = urllib.parse.quote(str(resource_id), safe="")
    if not safe_resource_id:
        raise HTTPException(status_code=422, detail="resource id is required")
    try:
        state_payload = _resource_state_payload(payload)
        await asyncio.to_thread(
            _post_json,
            f"/api/v4/resources/{safe_resource_id}/state",
            state_payload,
            timeout=12.0,
        )
        return {"resourceId": str(resource_id), "state": state_payload["state"]}
    except HTTPException:
        raise
    except urllib.error.HTTPError as exc:
        if exc.code in {400, 404, 409, 422}:
            try:
                body = json.loads(exc.read().decode("utf-8"))
                detail = body.get("error", {}).get("code") if isinstance(body, dict) else None
            except Exception:
                detail = None
            raise HTTPException(status_code=exc.code, detail=detail or str(exc)) from exc
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
