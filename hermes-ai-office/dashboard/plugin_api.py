"""Hermes AI Office dashboard backend.

Mounted by Hermes at ``/api/plugins/hermes-ai-office/``. The module is a thin,
authenticated adapter over the local AI Workforce Domain Service. It never
loads provider credentials and never proxies model traffic.
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Mapping

import yaml

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

try:
    from hermes_cli import config as config_mod
    from hermes_cli.config import get_hermes_home
except Exception:  # pragma: no cover - only used by isolated import tests
    config_mod = None  # type: ignore[assignment]
    get_hermes_home = None  # type: ignore[assignment]

router = APIRouter()

_PLUGIN_ID = "hermes-ai-office"
_DEFAULT_BASE_URL = "http://127.0.0.1:8320"
_ALLOWED_HOSTS = {"127.0.0.1", "localhost", "::1"}
_SETTINGS_LOCK = threading.Lock()


class RuntimePolicySettings(BaseModel):
    mode: str = "prefer"
    opencode_position: str = "coding-executor"
    codex_position: str = "codex-executor"


def _base_url() -> str:
    raw = os.environ.get("HERMES_AI_OFFICE_CONTROL_PLANE_URL", _DEFAULT_BASE_URL).strip()
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme != "http" or parsed.hostname not in _ALLOWED_HOSTS:
        return _DEFAULT_BASE_URL
    return raw.rstrip("/")


def _fetch_json(path: str, *, timeout: float = 1.5) -> Dict[str, Any]:
    if not path.startswith("/"):
        raise ValueError("control-plane path must be absolute")
    request = urllib.request.Request(
        _base_url() + path,
        headers={"Accept": "application/json"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            value = json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"control plane returned HTTP {exc.code}") from exc
    except (OSError, urllib.error.URLError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("control plane unavailable") from exc
    if not isinstance(value, dict):
        raise RuntimeError("control plane returned a non-object payload")
    return value


def _model_config(value: Any) -> Dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    provider = str(value.get("provider") or "").strip()
    model = str(value.get("default") or value.get("model") or "").strip()
    if not model:
        return {}
    return {"provider": provider, "model": model}


def _hermes_model_defaults() -> Dict[str, Dict[str, str]]:
    defaults: Dict[str, Dict[str, str]] = {}
    if config_mod is not None:
        try:
            config = config_mod.load_config_readonly() or {}
            global_model = _model_config(config.get("model") if isinstance(config, Mapping) else None)
            if global_model:
                defaults["*"] = {**global_model, "source": "HERMES_GLOBAL_CONFIG"}
        except Exception:
            pass
    if get_hermes_home is None:
        return defaults
    try:
        profiles_root = Path(get_hermes_home()) / "profiles"
    except Exception:
        return defaults
    if not profiles_root.exists():
        return defaults
    for config_path in profiles_root.glob("*/config.yaml"):
        try:
            value = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
        except Exception:
            continue
        model = _model_config(value.get("model") if isinstance(value, Mapping) else None)
        if model:
            defaults[config_path.parent.name] = {**model, "source": "HERMES_PROFILE_CONFIG"}
    return defaults


def _normalized(value: Any) -> str:
    return str(value or "").strip().lower()


def _default_employee(workforce: Mapping[str, Any], provider: str, model: str) -> Dict[str, Any] | None:
    model_key = _normalized(model).split("/")[-1]
    candidates = []
    for employee in workforce.get("employees") or []:
        if not isinstance(employee, Mapping):
            continue
        supplier_model = employee.get("supplierModel") if isinstance(employee.get("supplierModel"), Mapping) else {}
        key = _normalized(supplier_model.get("key"))
        if key != model_key:
            continue
        candidates.append(employee)
    provider_key = _normalized(provider)
    if provider_key and candidates:
        scoped = []
        for employee in candidates:
            supplier = employee.get("supplier") if isinstance(employee.get("supplier"), Mapping) else {}
            slug = _normalized(supplier.get("slug"))
            if slug and (provider_key == slug or provider_key.startswith(slug + "-")):
                scoped.append(employee)
        if len(scoped) == 1:
            return dict(scoped[0])
    return dict(candidates[0]) if len(candidates) == 1 else None


def _enrich_organization(organization: Dict[str, Any], workforce: Mapping[str, Any]) -> Dict[str, Any]:
    defaults = _hermes_model_defaults()
    positions = organization.get("positions") if isinstance(organization.get("positions"), list) else []
    explicit = 0
    defaulted = 0
    unfilled = 0
    for position in positions:
        if not isinstance(position, dict):
            continue
        appointments = position.get("currentAppointments") if isinstance(position.get("currentAppointments"), list) else []
        active_appointments = [item for item in appointments if isinstance(item, Mapping) and item.get("status") == "CURRENT"]
        if active_appointments:
            primary = active_appointments[0]
            position["effectiveStaffing"] = {
                "state": "APPOINTED",
                "source": "APPOINTMENT",
                "employeeId": primary.get("employeeId"),
                "employeeName": primary.get("employeeName"),
                "appointmentId": primary.get("id"),
            }
            explicit += 1
            continue
        if str(position.get("runtimeKind") or "").upper() == "HERMES_PROFILE":
            scope = position.get("workScope") if isinstance(position.get("workScope"), Mapping) else {}
            scope_slug = str(scope.get("slug") or "")
            configured = defaults.get(scope_slug) or defaults.get("*")
            if configured and configured.get("model"):
                employee = _default_employee(workforce, configured.get("provider", ""), configured["model"])
                position["effectiveStaffing"] = {
                    "state": "DEFAULTED" if employee else "DEFAULT_MODEL",
                    "source": configured.get("source", "HERMES_PROFILE_CONFIG"),
                    "provider": configured.get("provider", ""),
                    "model": configured["model"],
                    "employeeId": employee.get("id") if employee else None,
                    "employeeName": employee.get("displayName") if employee else None,
                    "attribution": "PROVIDER_MODEL" if employee else "MODEL_IDENTITY_AMBIGUOUS",
                }
                defaulted += 1
                if position.get("status") == "UNFILLED":
                    position["status"] = position["effectiveStaffing"]["state"]
                continue
        position["effectiveStaffing"] = {"state": "UNFILLED", "source": "NONE"}
        unfilled += 1
    summary = organization.get("summary") if isinstance(organization.get("summary"), dict) else {}
    summary["explicitlyAppointedPositions"] = explicit
    summary["defaultedPositions"] = defaulted
    summary["configuredPositions"] = explicit + defaulted
    summary["unfilledPositions"] = unfilled
    organization["summary"] = summary
    organization["hermesModelDefaults"] = defaults
    return organization


def _entry_settings() -> Dict[str, Any]:
    if config_mod is None:
        return {}
    try:
        config = config_mod.load_config_readonly() or {}
    except Exception:
        return {}
    plugins = config.get("plugins") if isinstance(config, Mapping) else None
    entries = plugins.get("entries") if isinstance(plugins, Mapping) else None
    entry = entries.get(_PLUGIN_ID) if isinstance(entries, Mapping) else None
    settings = entry.get("settings") if isinstance(entry, Mapping) else None
    return dict(settings) if isinstance(settings, Mapping) else {}


def _runtime_policy_settings() -> Dict[str, str]:
    settings = _entry_settings()
    runtime = settings.get("runtime_policy")
    runtime = runtime if isinstance(runtime, Mapping) else {}
    positions = runtime.get("positions")
    positions = positions if isinstance(positions, Mapping) else {}
    mode = str(runtime.get("mode") or "prefer").strip().lower()
    if mode not in {"observe", "prefer", "enforce"}:
        mode = "prefer"
    return {
        "mode": mode,
        "opencodePosition": str(positions.get("opencode") or "coding-executor"),
        "codexPosition": str(positions.get("codex") or "codex-executor"),
    }


def _save_runtime_policy(value: RuntimePolicySettings) -> Dict[str, str]:
    if config_mod is None:
        raise RuntimeError("Hermes config service unavailable")
    mode = value.mode.strip().lower()
    if mode not in {"observe", "prefer", "enforce"}:
        raise ValueError("runtime policy mode must be observe, prefer, or enforce")
    partial = {
        "plugins": {
            "entries": {
                _PLUGIN_ID: {
                    "settings": {
                        "runtime_policy": {
                            "mode": mode,
                            "positions": {
                                "opencode": value.opencode_position.strip() or "coding-executor",
                                "codex": value.codex_position.strip() or "codex-executor",
                            },
                        }
                    }
                }
            }
        }
    }
    with _SETTINGS_LOCK:
        try:
            config_mod.save_config(partial, merge_existing=True)
        except Exception as exc:
            raise RuntimeError("could not persist Hermes plugin settings") from exc
    return _runtime_policy_settings()


async def _partial(name: str, path: str) -> tuple[str, Dict[str, Any]]:
    try:
        return name, await asyncio.to_thread(_fetch_json, path)
    except Exception as exc:
        return name, {"error": str(exc), "unavailable": True}


@router.get("/health")
async def health() -> Dict[str, Any]:
    try:
        control = await asyncio.to_thread(_fetch_json, "/api/v2/health")
        return {"status": "ok", "controlPlane": control, "runtimePolicy": _runtime_policy_settings()}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/overview")
async def overview() -> Dict[str, Any]:
    requests = [
        _partial("workforce", "/api/v2/projections/workforce"),
        _partial("supply", "/api/v2/projections/supply"),
        _partial("organization", "/api/v2/projections/office"),
        _partial("incidents", "/api/v2/incidents?limit=200"),
        _partial("runtimeDecisions", "/api/v2/runtime-launch-decisions?limit=100"),
    ]
    values = dict(await asyncio.gather(*requests))
    organization_value = values.get("organization")
    workforce_value = values.get("workforce")
    if isinstance(organization_value, dict) and not organization_value.get("unavailable") and isinstance(workforce_value, Mapping):
        values["organization"] = _enrich_organization(organization_value, workforce_value)
    values.update(
        {
            "generatedAt": int(time.time() * 1000),
            "runtimePolicy": _runtime_policy_settings(),
            "controlPlaneUrl": "local",
        }
    )
    return values


@router.get("/workforce")
async def workforce() -> Dict[str, Any]:
    try:
        return await asyncio.to_thread(_fetch_json, "/api/v2/projections/workforce")
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/supply")
async def supply() -> Dict[str, Any]:
    try:
        return await asyncio.to_thread(_fetch_json, "/api/v2/projections/supply")
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/organization")
async def organization() -> Dict[str, Any]:
    try:
        org, workforce = await asyncio.gather(
            asyncio.to_thread(_fetch_json, "/api/v2/projections/office"),
            asyncio.to_thread(_fetch_json, "/api/v2/projections/workforce"),
        )
        return _enrich_organization(org, workforce)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/runtime-decisions")
async def runtime_decisions(limit: int = 100) -> Dict[str, Any]:
    safe_limit = min(500, max(1, int(limit)))
    try:
        return await asyncio.to_thread(
            _fetch_json, f"/api/v2/runtime-launch-decisions?limit={safe_limit}"
        )
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/incidents")
async def incidents(limit: int = 200) -> Dict[str, Any]:
    safe_limit = min(500, max(1, int(limit)))
    try:
        return await asyncio.to_thread(_fetch_json, f"/api/v2/incidents?limit={safe_limit}")
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/settings/runtime-policy")
async def get_runtime_policy() -> Dict[str, str]:
    return _runtime_policy_settings()


@router.post("/settings/runtime-policy")
async def set_runtime_policy(body: RuntimePolicySettings) -> Dict[str, Any]:
    try:
        return {"ok": True, "runtimePolicy": await asyncio.to_thread(_save_runtime_policy, body)}
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
