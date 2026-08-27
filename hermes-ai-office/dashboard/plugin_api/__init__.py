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
from .executions import _analytics, _execution, _route_catalog, _summary
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
        value = await asyncio.to_thread(_fetch_json, "/api/v3/health")
        return {"ok": True, "controlPlane": value}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


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
