"""Hermes AI Office dashboard backend.

Mounted by Hermes at ``/api/plugins/hermes-ai-office/``. The module is a thin,
authenticated adapter over Hermes native provider management and the local AI
Workforce Domain Service. Provider secrets are handed only to Hermes credential
storage; they are never forwarded into workforce projections or the domain DB.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Mapping, Sequence

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

class ProviderDiscoverRequest(BaseModel):
    preset_id: str
    api_key: str = ""
    base_url: str = ""
    supplier_name: str = ""


class ProviderRegisterRequest(ProviderDiscoverRequest):
    selected_models: list[str]
    default_model: str = ""


_PROVIDER_PRESETS: Dict[str, Dict[str, Any]] = {
    "opencode-go": {
        "id": "opencode-go",
        "name": "OpenCode Go",
        "supplierSlug": "opencode",
        "supplierName": "OpenCode",
        "baseUrl": "https://opencode.ai/zen/go/v1",
        "keyEnv": "OPENCODE_GO_API_KEY",
        "transport": "openai_chat",
        "plan": {"slug": "go", "name": "OpenCode Go", "commercialType": "SUBSCRIPTION"},
        "opencodePrefix": "opencode-go",
        "featured": True,
    },
    "deepseek": {
        "id": "deepseek",
        "name": "DeepSeek API",
        "supplierSlug": "deepseek",
        "supplierName": "DeepSeek",
        "baseUrl": "https://api.deepseek.com/v1",
        "keyEnv": "DEEPSEEK_API_KEY",
        "transport": "openai_chat",
        "plan": {"slug": "api", "name": "DeepSeek API", "commercialType": "METERED"},
        "opencodePrefix": "deepseek",
        "featured": True,
    },
    "openrouter": {
        "id": "openrouter",
        "name": "OpenRouter",
        "supplierSlug": "openrouter",
        "supplierName": "OpenRouter",
        "baseUrl": "https://openrouter.ai/api/v1",
        "keyEnv": "OPENROUTER_API_KEY",
        "transport": "openai_chat",
        "plan": {"slug": "api", "name": "OpenRouter API", "commercialType": "METERED"},
        "opencodePrefix": "openrouter",
    },
    "openai-api": {
        "id": "openai-api",
        "name": "OpenAI API",
        "supplierSlug": "openai",
        "supplierName": "OpenAI",
        "baseUrl": "https://api.openai.com/v1",
        "keyEnv": "OPENAI_API_KEY",
        "transport": "codex_responses",
        "plan": {"slug": "api", "name": "OpenAI API", "commercialType": "METERED"},
        "opencodePrefix": "openai",
    },
    "xai": {
        "id": "xai",
        "name": "xAI API",
        "supplierSlug": "xai",
        "supplierName": "xAI",
        "baseUrl": "https://api.x.ai/v1",
        "keyEnv": "XAI_API_KEY",
        "transport": "codex_responses",
        "plan": {"slug": "api", "name": "xAI API", "commercialType": "METERED"},
        "opencodePrefix": "xai",
    },
    "nvidia": {
        "id": "nvidia",
        "name": "NVIDIA NIM",
        "supplierSlug": "nvidia",
        "supplierName": "NVIDIA",
        "baseUrl": "https://integrate.api.nvidia.com/v1",
        "keyEnv": "NVIDIA_API_KEY",
        "transport": "openai_chat",
        "plan": {"slug": "api", "name": "NVIDIA NIM API", "commercialType": "METERED"},
        "opencodePrefix": "nvidia",
    },
    "custom": {
        "id": "custom",
        "name": "Custom OpenAI-compatible endpoint",
        "supplierSlug": "",
        "supplierName": "",
        "baseUrl": "",
        "keyEnv": "",
        "transport": "openai_chat",
        "plan": {"slug": "api", "name": "Custom API", "commercialType": "METERED"},
        "featured": True,
    },
}


def _base_url() -> str:
    raw = os.environ.get("HERMES_AI_OFFICE_CONTROL_PLANE_URL", _DEFAULT_BASE_URL).strip()
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme != "http" or parsed.hostname not in _ALLOWED_HOSTS:
        return _DEFAULT_BASE_URL
    return raw.rstrip("/")


def _control_plane_json(
    path: str,
    *,
    method: str = "GET",
    payload: Mapping[str, Any] | None = None,
    timeout: float = 3.0,
    idempotency_key: str = "",
) -> Dict[str, Any]:
    if not path.startswith("/"):
        raise ValueError("control-plane path must be absolute")
    headers = {"Accept": "application/json"}
    body = None
    if payload is not None:
        body = json.dumps(dict(payload)).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key[:200]
    request = urllib.request.Request(_base_url() + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            value = json.load(response)
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            detail = ""
        raise RuntimeError(f"control plane returned HTTP {exc.code}: {detail}") from exc
    except (OSError, urllib.error.URLError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("control plane unavailable") from exc
    if not isinstance(value, dict):
        raise RuntimeError("control plane returned a non-object payload")
    return value


def _fetch_json(path: str, *, timeout: float = 1.5) -> Dict[str, Any]:
    return _control_plane_json(path, timeout=timeout)


def _post_json(
    path: str,
    payload: Mapping[str, Any],
    *,
    timeout: float = 5.0,
    idempotency_key: str = "",
) -> Dict[str, Any]:
    return _control_plane_json(
        path,
        method="POST",
        payload=payload,
        timeout=timeout,
        idempotency_key=idempotency_key,
    )


def _safe_provider_id(value: Any) -> str:
    return str(value or "").strip().lower()


def _normalize_base_url(value: str) -> str:
    raw = value.strip().rstrip("/")
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("需要有效的 HTTP(S) API 请求地址")
    return raw


def _custom_supplier_identity(base_url: str, supplier_name: str = "") -> Dict[str, str]:
    normalized = _normalize_base_url(base_url)
    digest = hashlib.blake2b(normalized.encode("utf-8"), digest_size=6).hexdigest()
    hostname = urllib.parse.urlparse(normalized).hostname or "custom"
    generated_name = supplier_name.strip() or hostname.split(".")[0].replace("-", " ").title() or "Custom API"
    return {
        "providerId": f"custom:{digest}",
        "supplierSlug": f"custom-{digest}",
        "supplierName": generated_name,
        "keyEnv": f"HERMES_AI_OFFICE_{digest.upper()}_API_KEY",
        "baseUrl": normalized,
    }


def _provider_descriptor(preset_id: str, base_url: str = "", supplier_name: str = "") -> Dict[str, Any]:
    preset_key = _safe_provider_id(preset_id)
    preset = _PROVIDER_PRESETS.get(preset_key)
    if not preset:
        raise ValueError("未知供应商预设")
    if preset_key == "custom":
        identity = _custom_supplier_identity(base_url, supplier_name)
        return {**preset, **identity}
    descriptor = dict(preset)
    try:
        from hermes_cli.auth import PROVIDER_REGISTRY
        provider = PROVIDER_REGISTRY.get(preset_key)
        if provider:
            descriptor["name"] = provider.name or descriptor["name"]
            descriptor["baseUrl"] = provider.inference_base_url or descriptor["baseUrl"]
            descriptor["keyEnv"] = (provider.api_key_env_vars or (descriptor["keyEnv"],))[0]
    except Exception:
        pass
    return descriptor


def _existing_provider_key(descriptor: Mapping[str, Any]) -> str:
    provider_id = str(descriptor.get("id") or descriptor.get("providerId") or "")
    if provider_id and not provider_id == "custom" or provider_id.startswith("custom:"):
        try:
            from hermes_cli.auth import resolve_api_key_provider_credentials
            credentials = resolve_api_key_provider_credentials(provider_id)
            value = str(credentials.get("api_key") or "").strip()
            if value:
                return value
        except Exception:
            pass
    key_env = str(descriptor.get("keyEnv") or "").strip()
    if not key_env:
        return ""
    try:
        if config_mod is not None and hasattr(config_mod, "get_env_value_prefer_dotenv"):
            return str(config_mod.get_env_value_prefer_dotenv(key_env) or "").strip()
        if config_mod is not None and hasattr(config_mod, "load_env"):
            return str((config_mod.load_env() or {}).get(key_env) or "").strip()
    except Exception:
        pass
    return str(os.environ.get(key_env) or "").strip()


def _discover_provider_models(body: ProviderDiscoverRequest) -> tuple[Dict[str, Any], list[str], bool]:
    descriptor = _provider_descriptor(body.preset_id, body.base_url, body.supplier_name)
    api_key = body.api_key.strip() or _existing_provider_key(descriptor)
    if not api_key:
        raise ValueError("API Key 尚未配置")
    base_url = _normalize_base_url(str(descriptor.get("baseUrl") or body.base_url))
    transport = str(descriptor.get("transport") or "openai_chat")
    api_mode = {
        "codex_responses": "responses",
        "anthropic_messages": "anthropic_messages",
    }.get(transport, "chat_completions")
    models: Sequence[str] | None = None
    try:
        from hermes_cli.models import fetch_api_models
        models = fetch_api_models(api_key, base_url, timeout=8.0, api_mode=api_mode)
    except Exception:
        models = None
    if not models and body.preset_id != "custom":
        try:
            from hermes_cli.models import provider_model_ids
            models = provider_model_ids(body.preset_id, force_refresh=True)
        except Exception:
            models = None
    cleaned = sorted({str(model).strip() for model in (models or []) if str(model).strip()})
    if not cleaned:
        raise ValueError("没有从该供应商获取到可用模型")
    return descriptor, cleaned[:800], bool(_existing_provider_key(descriptor))


def _save_provider_secret(descriptor: Mapping[str, Any], api_key: str) -> None:
    value = api_key.strip()
    if not value:
        return
    key_env = str(descriptor.get("keyEnv") or "").strip()
    if not key_env:
        raise ValueError("该供应商没有可写入的 Hermes 凭证槽")
    from hermes_cli.credential_lifecycle import save_provider_env_credential
    save_provider_env_credential(key_env, value)


def _save_custom_provider(descriptor: Mapping[str, Any]) -> None:
    if config_mod is None:
        raise RuntimeError("Hermes config service unavailable")
    base_url = str(descriptor["baseUrl"])
    provider_id = str(descriptor["providerId"])
    name = str(descriptor["supplierName"])
    key_env = str(descriptor["keyEnv"])
    current = config_mod.load_config_readonly() or {}
    providers = current.get("custom_providers") if isinstance(current, Mapping) else None
    rows = [dict(item) for item in providers if isinstance(item, Mapping)] if isinstance(providers, list) else []
    replacement = {
        "name": name,
        "provider_key": provider_id,
        "base_url": base_url,
        "key_env": key_env,
        "api_mode": "chat_completions",
    }
    normalized = base_url.rstrip("/")
    for index, item in enumerate(rows):
        if str(item.get("base_url") or "").rstrip("/") == normalized:
            rows[index] = {**item, **replacement}
            break
    else:
        rows.append(replacement)
    config_mod.save_config({"custom_providers": rows}, merge_existing=True)


def _runtime_access_provider_ref(descriptor: Mapping[str, Any]) -> str:
    preset_id = str(descriptor.get("id") or "").strip().lower()
    if preset_id and preset_id != "custom":
        prefix = str(descriptor.get("opencodePrefix") or preset_id).strip().lower()
        if prefix:
            return prefix[:120]
    supplier_slug = str(descriptor.get("supplierSlug") or "custom").strip().lower()
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in supplier_slug)
    return ("hao-" + safe).strip("-")[:120]


def _codex_provider_ref(descriptor: Mapping[str, Any]) -> str:
    supplier_slug = str(descriptor.get("supplierSlug") or "custom").strip().lower()
    endpoint = str(descriptor.get("baseUrl") or "")
    digest = hashlib.blake2b(endpoint.encode("utf-8"), digest_size=4).hexdigest()
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in supplier_slug)
    return f"hao-{safe}-{digest}"[:120]


def _codex_profile_ref(descriptor: Mapping[str, Any], model: str) -> str:
    seed = f"{descriptor.get('supplierSlug')}|{descriptor.get('baseUrl')}|{model}"
    digest = hashlib.blake2b(seed.encode("utf-8"), digest_size=5).hexdigest()
    return f"hao-{str(descriptor.get('supplierSlug') or 'provider')[:40]}-{digest}"[:120]


def _runtime_access_payloads(descriptor: Mapping[str, Any], model: str) -> list[Dict[str, Any]]:
    transport = str(descriptor.get("transport") or "openai_chat")
    protocol = {
        "codex_responses": "openai-responses",
        "openai_chat": "openai-chat-completions",
        "anthropic_messages": "anthropic-messages",
    }.get(transport, transport)
    base_url = str(descriptor.get("baseUrl") or "").rstrip("/")
    credential_ref = str(descriptor.get("keyEnv") or "").strip()
    provider_id = str(descriptor.get("id") or descriptor.get("providerId") or "")
    opencode_provider = _runtime_access_provider_ref(descriptor)
    custom_provider = provider_id == "custom" or provider_id.startswith("custom:")

    accesses: list[Dict[str, Any]] = []
    if transport in {"openai_chat", "codex_responses"}:
        accesses.append(
            {
                "runtimeKind": "OPENCODE",
                "adapterKind": "NATIVE_CONFIG",
                "providerRef": opencode_provider,
                "modelRef": model,
                "baseUrl": base_url if custom_provider else None,
                "credentialRef": credential_ref or None,
                "protocol": protocol,
                "config": {
                    "managedProvider": custom_provider,
                    **({"package": "@ai-sdk/openai-compatible"} if custom_provider else {}),
                },
                "priority": 100,
            }
        )
        codex_provider = _codex_provider_ref(descriptor)
        accesses.append(
            {
                "runtimeKind": "CODEX",
                "adapterKind": "NATIVE_CONFIG",
                "providerRef": codex_provider,
                "modelRef": model,
                "profileRef": _codex_profile_ref(descriptor, model),
                "baseUrl": base_url or None,
                "credentialRef": credential_ref or None,
                "protocol": protocol,
                "config": {"wireApi": "responses" if transport == "codex_responses" else "chat"},
                "priority": 100,
            }
        )
    elif transport == "anthropic_messages":
        accesses.append(
            {
                "runtimeKind": "CLAUDE_CODE",
                "adapterKind": "NATIVE_CONFIG",
                "providerRef": "anthropic",
                "modelRef": model,
                "baseUrl": base_url or None,
                "credentialRef": credential_ref or None,
                "protocol": protocol,
                "config": {},
                "priority": 100,
            }
        )
    return accesses


def _catalog_payload(descriptor: Mapping[str, Any], model: str) -> Dict[str, Any]:
    provider_id = str(descriptor.get("id") or descriptor.get("providerId") or "custom")
    supplier_slug = str(descriptor["supplierSlug"])
    supplier_name = str(descriptor["supplierName"])
    plan = descriptor.get("plan") if isinstance(descriptor.get("plan"), Mapping) else None
    endpoint_tag = hashlib.blake2b(str(descriptor["baseUrl"]).encode("utf-8"), digest_size=5).hexdigest()
    payload: Dict[str, Any] = {
        "supplier": {"slug": supplier_slug, "name": supplier_name},
        "supplierModel": {"key": model, "name": model},
        "agreement": {
            "externalAccountRef": f"hermes-provider:{provider_id}:{endpoint_tag}",
            "name": f"{str(descriptor.get('name') or supplier_name)} via Hermes",
        },
    }
    if plan:
        payload["plan"] = dict(plan)
    return payload

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
        _partial("personalChannels", "/api/v2/projections/personal-channels"),
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


@router.get("/providers/presets")
async def provider_presets() -> Dict[str, Any]:
    items = []
    for preset_id, raw in _PROVIDER_PRESETS.items():
        descriptor = _provider_descriptor(preset_id, "https://example.invalid/v1" if preset_id == "custom" else "", "") if preset_id != "custom" else raw
        items.append(
            {
                "id": preset_id,
                "name": descriptor.get("name"),
                "supplierName": descriptor.get("supplierName"),
                "featured": bool(descriptor.get("featured")),
                "custom": preset_id == "custom",
                "configured": False if preset_id == "custom" else bool(_existing_provider_key(descriptor)),
            }
        )
    return {"items": items}


@router.post("/providers/discover")
async def discover_provider(body: ProviderDiscoverRequest) -> Dict[str, Any]:
    try:
        descriptor, models, configured = await asyncio.to_thread(_discover_provider_models, body)
        return {
            "provider": {
                "id": body.preset_id,
                "name": descriptor.get("name"),
                "supplierName": descriptor.get("supplierName"),
                "baseUrl": descriptor.get("baseUrl") if body.preset_id == "custom" else None,
                "configured": configured,
            },
            "models": [{"id": model, "name": model} for model in models],
        }
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail="供应商模型发现失败") from exc


@router.post("/providers/register")
async def register_provider(body: ProviderRegisterRequest) -> Dict[str, Any]:
    try:
        descriptor, discovered, _configured = await asyncio.to_thread(_discover_provider_models, body)
        selected = list(dict.fromkeys(model.strip() for model in body.selected_models if model.strip()))
        if not selected:
            raise ValueError("至少选择一个模型作为员工")
        unknown = [model for model in selected if model not in discovered]
        if unknown:
            raise ValueError("所选模型不在本次供应商发现结果中")
        default_model = body.default_model.strip() or selected[0]
        if default_model not in selected:
            raise ValueError("默认员工必须来自已选择的模型")

        if body.api_key.strip():
            await asyncio.to_thread(_save_provider_secret, descriptor, body.api_key)
        if body.preset_id == "custom":
            await asyncio.to_thread(_save_custom_provider, descriptor)

        registrations = []
        supplier_id = ""
        employee_ids: list[str] = []
        default_employee_id = ""
        for model in selected:
            payload = _catalog_payload(descriptor, model)
            digest = hashlib.blake2b(
                f"{payload['supplier']['slug']}|{model}".encode("utf-8"), digest_size=8
            ).hexdigest()
            result = await asyncio.to_thread(
                _post_json,
                "/api/v2/commands/supply-catalog/register",
                payload,
                idempotency_key=f"office-onboard-{digest}",
            )
            supplier = result.get("supplier") if isinstance(result.get("supplier"), Mapping) else {}
            employee = result.get("employee") if isinstance(result.get("employee"), Mapping) else {}
            if not supplier.get("id") or not employee.get("id"):
                raise RuntimeError("control plane did not return supplier/employee identity")
            supplier_id = str(supplier["id"])
            employee_id = str(employee["id"])
            employment = result.get("employment") if isinstance(result.get("employment"), Mapping) else {}
            employment_id = str(employment.get("id") or "")
            runtime_accesses = []
            if not employment_id:
                raise RuntimeError("control plane did not return employment identity")
            for access_payload in _runtime_access_payloads(descriptor, model):
                runtime_access = await asyncio.to_thread(
                    _post_json,
                    f"/api/v2/commands/employments/{employment_id}/runtime-access",
                    access_payload,
                    idempotency_key=(
                        f"office-runtime-access-{employment_id}-"
                        f"{str(access_payload.get('runtimeKind') or '').lower()}-"
                        f"{hashlib.blake2b(json.dumps(access_payload, sort_keys=True).encode('utf-8'), digest_size=5).hexdigest()}"
                    ),
                )
                runtime_accesses.append(runtime_access)
            employee_ids.append(employee_id)
            if model == default_model:
                default_employee_id = employee_id
            registrations.append(
                {
                    "model": model,
                    "employeeId": employee_id,
                    "employeeName": employee.get("displayName") or model,
                    "employmentId": employment_id or None,
                    "runtimeAccess": runtime_accesses,
                }
            )
        preference = await asyncio.to_thread(
            _post_json,
            f"/api/v2/commands/suppliers/{supplier_id}/staffing-preferences",
            {"enabledEmployeeIds": employee_ids, "defaultEmployeeId": default_employee_id},
            idempotency_key=f"office-supplier-pref-{supplier_id}-{hashlib.blake2b('|'.join(employee_ids).encode('utf-8'), digest_size=6).hexdigest()}",
        )
        return {
            "ok": True,
            "supplierId": supplier_id,
            "employees": registrations,
            "defaultEmployeeId": default_employee_id,
            "staffingPreferences": preference.get("metadata", {}).get("staffingPreferences", {}),
        }
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail="供应商保存失败") from exc


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
