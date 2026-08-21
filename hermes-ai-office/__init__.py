"""Hermes AI Office native plugin.

The plugin has two deliberately separate responsibilities:

1. emit bounded orchestration/runtime telemetry for the Office projections;
2. resolve an appointed Employee before Hermes launches OpenCode or Codex and,
   when policy permits, inject the selected runtime model into the terminal call.

The hook is fail-open in OBSERVE/PREFER mode and fail-closed only when the
operator explicitly configures ENFORCE mode. Raw prompts, tool results, and
provider credentials are never sent to the Office control plane.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shlex
import shutil
import subprocess
import threading
import tomllib
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

_SCHEMA = "hermes.office.observer.v1"
_OBSERVER_ENDPOINT = os.environ.get(
    "HERMES_OFFICE_OBSERVER_URL", "http://127.0.0.1:8787/api/observer"
)
_DEFAULT_POLICY_ENDPOINT = "http://127.0.0.1:8320/api/v2/commands/runtime-launch/resolve"
_QUEUE: "queue.Queue[dict[str, Any]]" = queue.Queue(maxsize=1024)
_WORKER_STARTED = False
_WORKER_LOCK = threading.Lock()
_PENDING: dict[str, dict[str, Any]] = {}
_PENDING_LOCK = threading.Lock()
_API_TELEMETRY_LOCK = threading.Lock()
_PROVIDER_CONNECTION_CACHE: dict[tuple[str, str], tuple[float, str]] = {}
_API_SUCCESS_LAST_RECORDED: dict[str, float] = {}
_PROVIDER_CACHE_TTL_SECONDS = 60.0
_SUCCESS_EVIDENCE_MIN_INTERVAL_SECONDS = 60.0
_PLACEMENT_RECONCILE_LOCK = threading.Lock()
_PLACEMENT_RECONCILE_LAST = 0.0
_PLACEMENT_RECONCILE_TTL_SECONDS = 60.0
_CTX: Any = None
_LITELLM_RUNTIME_PROVIDER = "hermes-office"
_LITELLM_RUNTIME_BASE_URL = "http://127.0.0.1:4000/v1"
_LITELLM_RUNTIME_KEY_FILE = "/opt/data/secrets/litellm-runtime.key"
_LITELLM_RUNTIME_KEY_ENV = "HERMES_LITELLM_RUNTIME_KEY"

_CONTROL_PLANE_BASE = "http://127.0.0.1:8320"
_SUPPLY_ORIGINS = {"OFFICIAL", "COMMERCIAL_RELAY", "COMMUNITY_RELAY", "EVENT_GRANT", "PERSONAL_HOSTED", "INTERNAL_POOL", "UNKNOWN"}
_COMMERCIAL_TYPES = {"FREE", "SPONSORED", "SUBSCRIPTION", "PREPAID", "METERED", "OTHER"}
_ROUTING_POLICIES = {"AUTO", "MANUAL_ONLY", "BRAIN_ONLY", "DISABLED"}


def _shared_economics(args: Mapping[str, Any]) -> dict[str, str]:
    origin = str(args.get("supply_origin") or "COMMERCIAL_RELAY").strip().upper()
    commercial = str(args.get("commercial_type") or "METERED").strip().upper()
    routing = str(args.get("routing_policy") or "AUTO").strip().upper()
    if origin not in _SUPPLY_ORIGINS:
        raise ValueError("invalid supply_origin")
    if commercial not in _COMMERCIAL_TYPES:
        raise ValueError("invalid commercial_type")
    if routing not in _ROUTING_POLICIES:
        raise ValueError("invalid routing_policy")
    return {"supplyOrigin": origin, "commercialType": commercial, "routingPolicy": routing}

_ADD_PROVIDER_SCHEMA = {
    "name": "ai_office_add_provider",
    "description": (
        "Add or update a shared provider connection in Hermes AI Office. "
        "Use this when the user provides an API URL and API key. The key is stored only in Hermes credential storage; "
        "the shared Provider Hub stores only a credential reference."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "Provider API base URL. OpenAI-compatible endpoints may be given with or without /v1."},
            "api_key": {"type": "string", "description": "Provider API key. Never echoed back by the tool."},
            "key": {"type": "string", "description": "Alias for api_key, compatible with newapi_channel_conn payloads."},
            "name": {"type": "string", "description": "Shared channel/provider name. Optional; derived from hostname when omitted."},
            "website_url": {"type": "string", "description": "Official website URL. Optional; defaults to the API origin."},
            "supply_origin": {"type": "string", "enum": ["OFFICIAL", "COMMERCIAL_RELAY", "COMMUNITY_RELAY", "EVENT_GRANT", "PERSONAL_HOSTED", "INTERNAL_POOL", "UNKNOWN"], "description": "Supply origin tag used by AI Office economics policy."},
            "commercial_type": {"type": "string", "enum": ["FREE", "SPONSORED", "SUBSCRIPTION", "PREPAID", "METERED", "OTHER"], "description": "Commercial plan type. FREE/SPONSORED routes are consumed before subscriptions and metered APIs."},
            "routing_policy": {"type": "string", "enum": ["AUTO", "MANUAL_ONLY", "BRAIN_ONLY", "DISABLED"], "description": "Whether this supplier may participate in automatic execution placement."},
            "models": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional known model ids for providers that do not expose a models endpoint. Discovered models remain authoritative when available; the lists are merged.",
            },
        },
        "required": ["url"],
    },
}

_LIST_PROVIDERS_SCHEMA = {
    "name": "ai_office_list_providers",
    "description": "This is the authoritative source for provider, supplier, model, and availability questions. You must use it before inferring anything from memory or the filesystem.",
    "parameters": {"type": "object", "properties": {}},
}

_RESOLVE_EXECUTION_SCHEMA = {
    "name": "ai_office_resolve_execution",
    "description": (
        "Ask AI Office for a per-execution workforce placement before choosing a coding model or external coding harness. "
        "Use PLAN/REVIEW for high-end planning or review work and IMPLEMENT/DEBUG/TEST/QUICK_FIX for implementation work. "
        "Intent selects a work class only; it never fixes the model or harness. The selected model family determines the preferred harness, "
        "and runtime/provider compatibility determines the actual harness. The response includes the Employee, safe provider connection metadata, "
        "preferred official harness, profile action, command template, and usage guidance."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "intent": {
                "type": "string",
                "enum": ["PLAN", "REVIEW", "IMPLEMENT", "DEBUG", "TEST", "RESEARCH", "QUICK_FIX"],
            },
            "requested_model": {
                "type": "string",
                "description": "Optional exact model request. Omit to let AI Office choose from the fixed policy tiers.",
            },
            "project_path": {
                "type": "string",
                "description": "Optional current project/repository path. Provide it for coding work so Agent Harness can materialize project MCP, Skills, and Instructions for the selected Harness.",
            },
        },
        "required": ["intent"],
    },
}

_SET_PROVIDER_STATE_SCHEMA = {
    "name": "ai_office_set_provider_state",
    "description": "Enable or disable a shared provider connection by connection_id or an unambiguous provider_key.",
    "parameters": {"type": "object", "properties": {
        "connection_id": {"type": "string"},
        "provider_key": {"type": "string"},
        "enabled": {"type": "boolean"},
        "reason": {"type": "string"},
    }, "required": ["enabled"]},
}

_AI_OFFICE_NAME_RE = re.compile(r"\bai[\s_-]*office\b", re.IGNORECASE)
_PROVIDER_TOPIC_RE = re.compile(
    r"(?:provider|supplier|供应商|提供商|模型|model|codex|opencode)",
    re.IGNORECASE,
)
_PROVIDER_STATUS_RE = re.compile(
    r"(?:available|availability|status|health|usable|current|which|list|"
    r"可用|状态|健康|当前|现在|哪些|列表|拥挤|限流|不可用)",
    re.IGNORECASE,
)
_EXECUTION_TOPIC_RE = re.compile(
    r"(?:implement|implementation|review|plan|planning|debug|test|fix|refactor|code|coding|"
    r"实施|实现|审查|评审|规划|计划|调试|测试|修一下|修复|重构|编码|写代码)",
    re.IGNORECASE,
)

_RUNTIME_COMMAND_RE = re.compile(
    r"(?:^|&&\s*|\|\|\s*|[;|()]\s*)"
    r"(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|()]+\s+)*"
    r"(?:env\s+(?:[^\s;&|()]+\s+)*|nohup\s+|command\s+|timeout\s+[^\s;&|()]+\s+)?"
    r"(?:[^\s;&|()]*/)?(?P<runtime>opencode|codex)(?=[\s;&|()]|$)",
    re.IGNORECASE,
)
_MANAGED_HARNESS_COMMAND_RE = re.compile(
    r"(?:^|&&\s*|\|\|\s*|[;|()]\s*)"
    r"(?:[A-Za-z_][A-Za-z0-9_]*=(?:\"[^\"]*\"|'[^']*'|[^\s;&|()]+)\s+)*"
    r"(?:env\s+(?:[^\s;&|()]+\s+)*)?"
    r"(?:[^\s;&|()]*/)?harnessctl\s+exec\s+"
    r"(?:--project\s+[^\s;&|()]+\s+)?"
    r"(?:--profile\s+[^\s;&|()]+\s+)?"
    r"(?P<runtime>codex|dsh|claude|opencode)(?=[\s;&|()]|$)",
    re.IGNORECASE,
)
_MODEL_RE = re.compile(r"(?:^|\s)(?:-m|--model)(?:=|\s+)([^\s;&|]+)", re.IGNORECASE)
_VERB_RE = re.compile(r"(?:^|[\s/])(opencode|codex)\s+([a-z][a-z0-9_-]*)", re.IGNORECASE)



def _control_plane_request(
    path: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    idempotency_key: str = "",
    timeout: float = 6.0,
) -> dict[str, Any]:
    if not path.startswith("/"):
        raise ValueError("invalid control-plane path")
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key[:200]
    request = urllib.request.Request(
        _CONTROL_PLANE_BASE + path, data=body, headers=headers, method=method
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        value = json.load(response)
    if not isinstance(value, dict):
        raise RuntimeError("control plane returned a non-object payload")
    return value


def _normalize_shared_url(value: str) -> str:
    raw = str(value or "").strip().rstrip("/")
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("A valid HTTP(S) provider URL is required")
    return raw


def _shared_website_url(value: str, base_url: str) -> str:
    explicit = str(value or "").strip()
    if explicit:
        return _normalize_shared_url(explicit)
    parsed = urllib.parse.urlparse(base_url)
    return f"{parsed.scheme}://{parsed.netloc}"


def _shared_provider_key(name: str, base_url: str) -> str:
    hostname = urllib.parse.urlparse(base_url).hostname or "provider"
    seed = str(name or "").strip().lower() or hostname.split(".")[0].lower()
    cleaned = re.sub(r"[^a-z0-9]+", "-", seed).strip("-")
    if not cleaned:
        cleaned = "provider-" + hashlib.blake2b(base_url.encode("utf-8"), digest_size=4).hexdigest()
    return cleaned[:80]


def _shared_credential_ref(provider_key: str) -> str:
    safe = re.sub(r"[^A-Z0-9]+", "_", provider_key.upper()).strip("_") or "PROVIDER"
    return (safe[:100] + "_API_KEY")[:120]


def _global_hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home, get_process_hermes_home

        candidates = [Path(get_process_hermes_home()), Path(get_hermes_home())]
    except Exception:
        candidates = [Path(os.environ.get("HERMES_HOME", "/opt/data"))]
    for candidate in candidates:
        if candidate.parent.name == "profiles":
            return candidate.parent.parent
        parts = candidate.parts
        if "profiles" in parts:
            index = parts.index("profiles")
            if index > 0:
                return Path(*parts[:index])
    return candidates[0]


def _env_value_at_home(home: Path, reference: str) -> str:
    name = str(reference or "").strip()
    if not name:
        return ""
    try:
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override
        from hermes_cli import config as config_mod

        token = set_hermes_home_override(home)
        try:
            return str((config_mod.load_env() or {}).get(name) or "").strip()
        finally:
            reset_hermes_home_override(token)
    except Exception:
        return ""


def _save_shared_credential(reference: str, value: str) -> None:
    secret = str(value or "").strip()
    if not secret:
        raise ValueError("API key is required")
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from hermes_cli.credential_lifecycle import save_provider_env_credential

    token = set_hermes_home_override(_global_hermes_home())
    try:
        save_provider_env_credential(reference, secret)
    finally:
        reset_hermes_home_override(token)


def _connection_source_profile(connection: dict[str, Any]) -> str:
    direct = str(
        connection.get("source_profile_id") or connection.get("sourceProfileId") or ""
    ).strip()
    if direct:
        return direct
    metadata = connection.get("metadata") if isinstance(connection.get("metadata"), dict) else {}
    return str(
        metadata.get("addedFromProfile") or metadata.get("discoveredFromProfile") or ""
    ).strip()


def _promote_global_connection_credential(connection: dict[str, Any]) -> bool:
    reference = str(
        connection.get("credential_ref") or connection.get("credentialRef") or ""
    ).strip()
    if not reference:
        return True
    global_home = _global_hermes_home()
    if _env_value_at_home(global_home, reference):
        return True
    profile = _connection_source_profile(connection)
    if not profile:
        return False
    profile_home = global_home / "profiles" / _safe_runtime_name(profile)
    value = _env_value_at_home(profile_home, reference)
    if not value:
        return False
    _save_shared_credential(reference, value)
    return bool(_env_value_at_home(global_home, reference))


def _provider_connection_credential_ready(
    connection: dict[str, Any], profile_name: str
) -> bool:
    auth_kind = str(connection.get("auth_kind") or connection.get("authKind") or "NONE").upper()
    scope = str(
        connection.get("credential_scope") or connection.get("credentialScope") or "GLOBAL"
    ).upper()
    reference = str(
        connection.get("credential_ref") or connection.get("credentialRef") or ""
    ).strip()
    source_profile = _connection_source_profile(connection)
    if auth_kind == "NONE" or not reference:
        return True
    if scope == "OAUTH_PROFILE":
        if source_profile and source_profile != profile_name:
            return False
        home = _global_hermes_home() / "profiles" / _safe_runtime_name(source_profile or profile_name)
        return (home / "home" / ".codex" / "auth.json").is_file()
    if scope == "PROFILE_LOCAL":
        if source_profile and source_profile != profile_name:
            return False
        home = _global_hermes_home() / "profiles" / _safe_runtime_name(source_profile or profile_name)
        return bool(_env_value_at_home(home, reference))
    if scope == "GLOBAL":
        if auth_kind == "API_KEY":
            return _promote_global_connection_credential(connection)
        return True
    return False


def _discover_shared_models(api_key: str, base_url: str) -> tuple[str, list[str]]:
    from hermes_cli.models import fetch_api_models

    normalized = _normalize_shared_url(base_url)
    candidates = [normalized]
    parsed = urllib.parse.urlparse(normalized)
    if not parsed.path.rstrip("/").endswith("/v1"):
        candidates.append(normalized + "/v1")
    for candidate in candidates:
        try:
            models = fetch_api_models(
                api_key, candidate, timeout=8.0, api_mode="chat_completions"
            )
        except Exception:
            models = None
        cleaned = sorted(
            {str(item).strip() for item in (models or []) if str(item).strip()}
        )
        if cleaned:
            return candidate, cleaned[:800]
    return normalized, []


_POLICY_WORKFORCE_MODELS = {
    "deepseek-v4-flash",
    "glm-5.2",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
}
_GPT_NON_AGENT_MARKERS = ("image", "audio", "realtime", "tts", "transcribe")


def _is_gpt_execution_model(model: str) -> bool:
    normalized = str(model or "").strip().lower()
    return normalized.startswith("gpt-") and not any(
        marker in normalized for marker in _GPT_NON_AGENT_MARKERS
    )


def _policy_workforce_models(models: list[str]) -> list[str]:
    selected: list[str] = []
    seen: set[str] = set()
    for model in models:
        normalized = str(model or "").strip().lower()
        supported = normalized in _POLICY_WORKFORCE_MODELS or _is_gpt_execution_model(normalized)
        if not supported or normalized in seen:
            continue
        selected.append(str(model).strip())
        seen.add(normalized)
    return selected


def _codex_protocol_compatible(protocol: str) -> bool:
    normalized = str(protocol or "").strip().lower()
    return any(token in normalized for token in ("responses", "codex", "chatgpt"))


def _codex_transport_mode(protocol: str) -> str:
    normalized = str(protocol or "").strip().lower()
    if _codex_protocol_compatible(normalized):
        return "NATIVE_RESPONSES"
    if "chat" in normalized:
        return "BRIDGED_CHAT"
    return ""


def _register_shared_policy_workforce(
    *,
    provider_key: str,
    display_name: str,
    website_url: str,
    supplier_slug: str | None = None,
    supplier_name: str | None = None,
    base_url: str,
    protocol: str,
    credential_ref: str,
    connection_id: str,
    models: list[str],
    supply_origin: str = "UNKNOWN",
    commercial_type: str = "OTHER",
    routing_policy: str = "AUTO",
) -> list[dict[str, Any]]:
    registrations: list[dict[str, Any]] = []
    for model in _policy_workforce_models(models):
        normalized = model.lower()
        catalog_payload = {
            "supplier": {
                "slug": supplier_slug or provider_key,
                "name": supplier_name or display_name,
                "websiteUrl": website_url,
                "sourceKind": "EXTERNAL",
                "supplyOrigin": supply_origin,
                "routingPolicy": routing_policy,
            },
            "supplierModel": {"key": model, "name": model},
            "agreement": {
                "externalAccountRef": f"provider-hub:{connection_id}",
                "name": f"{display_name} shared connection",
            },
            "plan": {
                "slug": "default",
                "name": f"{display_name} access",
                "commercialType": commercial_type,
            },
        }
        catalog_seed = json.dumps(catalog_payload, sort_keys=True, ensure_ascii=False)
        catalog = _control_plane_request(
            "/api/v2/commands/supply-catalog/register",
            method="POST",
            payload=catalog_payload,
            idempotency_key="provider-tool-workforce-v2-"
            + hashlib.blake2b(catalog_seed.encode("utf-8"), digest_size=10).hexdigest(),
        )
        employee = catalog.get("employee") if isinstance(catalog.get("employee"), dict) else {}
        employment = catalog.get("employment") if isinstance(catalog.get("employment"), dict) else {}
        employment_id = str(employment.get("id") or "").strip()
        if not employment_id:
            continue

        opencode_access = {
            "runtimeKind": "OPENCODE",
            "adapterKind": "NATIVE_CONFIG",
            "providerRef": provider_key,
            "modelRef": model,
            "baseUrl": base_url,
            "credentialRef": credential_ref,
            "protocol": protocol,
            "config": {
                "managedProvider": True,
                "package": "@ai-sdk/openai-compatible",
                "providerHubConnectionId": connection_id,
            },
            "priority": 100,
        }
        access_seed = json.dumps(opencode_access, sort_keys=True, ensure_ascii=False)
        opencode = _control_plane_request(
            f"/api/v2/commands/employments/{urllib.parse.quote(employment_id, safe='')}/runtime-access",
            method="POST",
            payload=opencode_access,
            idempotency_key="provider-tool-runtime-v1-"
            + hashlib.blake2b(access_seed.encode("utf-8"), digest_size=10).hexdigest(),
        )
        accesses: list[dict[str, Any]] = [opencode]

        codex_transport = _codex_transport_mode(protocol)
        if _is_gpt_execution_model(normalized) and codex_transport:
            digest = hashlib.blake2b(
                f"{provider_key}|{base_url}".encode("utf-8"), digest_size=4
            ).hexdigest()
            codex_provider = f"hao-{provider_key}-{digest}"[:120]
            profile_digest = hashlib.blake2b(
                f"{provider_key}|{base_url}|{model}".encode("utf-8"), digest_size=5
            ).hexdigest()
            codex_access = {
                "runtimeKind": "CODEX",
                "adapterKind": "NATIVE_CONFIG",
                "providerRef": codex_provider,
                "modelRef": model,
                "profileRef": f"hao-{provider_key[:40]}-{profile_digest}"[:120],
                "baseUrl": base_url,
                "credentialRef": credential_ref,
                "protocol": protocol,
                "config": {
                    "wireApi": "responses",
                    "transportMode": codex_transport,
                    "bridgeKind": "CC_SWITCH_CODEX_CHAT" if codex_transport == "BRIDGED_CHAT" else None,
                    "upstreamProtocol": protocol if codex_transport == "BRIDGED_CHAT" else None,
                    "providerHubConnectionId": connection_id,
                },
                "priority": 120,
            }
            codex_seed = json.dumps(codex_access, sort_keys=True, ensure_ascii=False)
            accesses.append(
                _control_plane_request(
                    f"/api/v2/commands/employments/{urllib.parse.quote(employment_id, safe='')}/runtime-access",
                    method="POST",
                    payload=codex_access,
                    idempotency_key="provider-tool-codex-v2-"
                    + hashlib.blake2b(codex_seed.encode("utf-8"), digest_size=10).hexdigest(),
                )
            )

        registrations.append(
            {
                "model": model,
                "employeeId": employee.get("id"),
                "employeeName": employee.get("displayName"),
                "employmentId": employment_id,
                "runtimeAccessIds": [item.get("id") for item in accesses if isinstance(item, dict)],
            }
        )
    return registrations


def _save_shared_custom_provider(
    provider_key: str, display_name: str, base_url: str, credential_ref: str
) -> None:
    from hermes_cli import config as config_mod

    current = config_mod.load_config_readonly() or {}
    raw = current.get("custom_providers") if isinstance(current, dict) else None
    rows = [dict(item) for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []
    replacement = {
        "name": display_name,
        "provider_key": provider_key,
        "base_url": base_url.rstrip("/"),
        "key_env": credential_ref,
        "api_mode": "chat_completions",
    }
    found = False
    for index, item in enumerate(rows):
        if str(item.get("provider_key") or "") == provider_key:
            rows[index] = {**item, **replacement}
            found = True
            break
    if not found:
        rows.append(replacement)
    config_mod.save_config({"custom_providers": rows}, merge_existing=True)


def _add_shared_provider_tool(args: dict[str, Any], **_kwargs: Any) -> str:
    try:
        raw_url = _normalize_shared_url(str(args.get("url") or ""))
        if _is_official_deepseek_endpoint(raw_url):
            raise ValueError(
                "DeepSeek official API is reserved for Hermes brain configuration and cannot be added to AI Office workforce routing"
            )
        economics = _shared_economics(args)
        api_key = str(args.get("api_key") or args.get("key") or "").strip()
        if not api_key:
            raise ValueError("API key is required")
        requested_name = str(args.get("name") or "").strip()
        provider_key = _shared_provider_key(requested_name, raw_url)
        display_name = requested_name or provider_key.replace("-", " ").title()
        credential_ref = _shared_credential_ref(provider_key)
        website_url = _shared_website_url(str(args.get("website_url") or ""), raw_url)
        selected_base_url, models = _discover_shared_models(api_key, raw_url)
        declared_models = [
            str(item).strip()
            for item in (args.get("models") or [])
            if isinstance(item, str) and str(item).strip()
        ]
        models = sorted(set(models).union(declared_models))[:800]
        _save_shared_credential(credential_ref, api_key)
        _save_shared_custom_provider(
            provider_key, display_name, selected_base_url, credential_ref
        )
        profile = ""
        if _CTX is not None:
            try:
                profile = str(getattr(_CTX, "profile_name", "") or "").strip()
            except Exception:
                profile = ""
        source_payload = {
            "slug": provider_key,
            "name": display_name,
            "websiteUrl": website_url,
            "sourceKind": "EXTERNAL",
            "supplyOrigin": economics["supplyOrigin"],
            "routingPolicy": economics["routingPolicy"],
        }
        source_seed = json.dumps(source_payload, sort_keys=True, ensure_ascii=False)
        source = _control_plane_request(
            "/api/v2/commands/workforce-sources/upsert",
            method="POST",
            payload=source_payload,
            idempotency_key="provider-tool-source-v1-"
            + hashlib.blake2b(source_seed.encode("utf-8"), digest_size=10).hexdigest(),
        )
        payload = {
            "providerKey": provider_key,
            "supplierId": source.get("id"),
            "displayName": display_name,
            "baseUrl": selected_base_url,
            "websiteUrl": website_url,
            "protocol": "openai-chat-completions",
            "authKind": "API_KEY",
            "credentialRef": credential_ref,
            "credentialScope": "GLOBAL",
            "sourceKind": "HERMES_TOOL_ONBOARDING",
            "shareScope": "GLOBAL",
            "health": "READY" if models else "DEGRADED",
            "models": models,
            "metadata": {
                "addedFromProfile": profile or None,
                "managedBy": "hermes-ai-office",
                "economics": economics,
            },
        }
        seed = json.dumps(payload, sort_keys=True, ensure_ascii=False)
        connection = _control_plane_request(
            "/api/v2/commands/provider-connections/upsert",
            method="POST",
            payload=payload,
            idempotency_key="provider-tool-v1-"
            + hashlib.blake2b(seed.encode("utf-8"), digest_size=10).hexdigest(),
        )
        connection_id = str(connection.get("id") or "").strip()
        workforce = (
            _register_shared_policy_workforce(
                provider_key=provider_key,
                display_name=display_name,
                website_url=website_url,
                base_url=selected_base_url,
                protocol="openai-chat-completions",
                credential_ref=credential_ref,
                connection_id=connection_id,
                models=models,
                supply_origin=economics["supplyOrigin"],
                commercial_type=economics["commercialType"],
                routing_policy=economics["routingPolicy"],
            )
            if connection_id
            else []
        )
        return json.dumps(
            {
                "ok": True,
                "connectionId": connection.get("id"),
                "supplierId": source.get("id"),
                "name": display_name,
                "providerKey": provider_key,
                "baseUrl": selected_base_url,
                "websiteUrl": website_url,
                "credentialRef": credential_ref,
                "health": connection.get("health") or payload["health"],
                "models": models,
                "workforce": workforce,
                "economics": economics,
                "shared": True,
                "message": (
                    "Added as a shared external supplier connection. Other profiles discover it through the common registry; "
                    "the API key is stored only in Hermes credential storage."
                ),
            },
            ensure_ascii=False,
        )
    except Exception as exc:
        return json.dumps(
            {"ok": False, "error": type(exc).__name__, "message": str(exc)[:300]},
            ensure_ascii=False,
        )


def _list_shared_providers_tool(_args: dict[str, Any], **_kwargs: Any) -> str:
    try:
        hub = _control_plane_request("/api/v2/projections/provider-hub", timeout=3.0)
        try:
            supply = _control_plane_request("/api/v2/projections/supply", timeout=3.0)
        except Exception:
            supply = {"suppliers": []}
        supplier_economics: dict[str, dict[str, Any]] = {}
        for supplier_row in supply.get("suppliers") or []:
            if not isinstance(supplier_row, dict):
                continue
            supplier_id = str(supplier_row.get("id") or "").strip()
            commercial_type = "OTHER"
            for plan in supplier_row.get("plans") or []:
                if isinstance(plan, dict) and str(plan.get("lifecycle") or "ACTIVE").upper() == "ACTIVE":
                    candidate = str(plan.get("commercialType") or "OTHER").upper()
                    if candidate != "OTHER":
                        commercial_type = candidate
                        break
            spend_tier = (
                "ZERO_COST"
                if commercial_type in {"FREE", "SPONSORED"}
                else "COMMITTED_EXPIRING"
                if commercial_type in {"SUBSCRIPTION", "PREPAID"}
                else "PAY_AS_YOU_GO"
                if commercial_type == "METERED"
                else "UNKNOWN"
            )
            if supplier_id:
                supplier_economics[supplier_id] = {
                    "supplyOrigin": str(supplier_row.get("supplyOrigin") or "UNKNOWN"),
                    "routingPolicy": str(supplier_row.get("routingPolicy") or "AUTO"),
                    "commercialType": commercial_type,
                    "spendTier": spend_tier,
                }
        items = []
        for item in hub.get("items") or []:
            if not isinstance(item, dict):
                continue
            supplier = item.get("supplier") if isinstance(item.get("supplier"), dict) else {}
            economics = supplier_economics.get(
                str(supplier.get("id") or ""),
                {
                    "supplyOrigin": str(supplier.get("supplyOrigin") or "UNKNOWN"),
                    "routingPolicy": str(supplier.get("routingPolicy") or "AUTO"),
                    "commercialType": "OTHER",
                    "spendTier": "UNKNOWN",
                },
            )
            profiles = sorted(
                {
                    str(link.get("profile_id"))
                    for link in (item.get("profileLinks") or [])
                    if isinstance(link, dict) and link.get("profile_id")
                }
            )
            items.append(
                {
                    "name": item.get("display_name"),
                    "providerKey": item.get("provider_key"),
                    "baseUrl": item.get("base_url"),
                    "websiteUrl": item.get("website_url"),
                    "health": item.get("health"),
                    "adminState": item.get("admin_state", item.get("adminState")),
                    "availabilityState": item.get("availability_state", item.get("availabilityState")),
                    "effectiveState": item.get("effective_state", item.get("effectiveState")),
                    "routable": item.get("routable"),
                    "retryable": item.get("retryable"),
                    "consecutiveFailures": item.get("consecutive_failures", item.get("consecutiveFailures")),
                    "totalSuccesses": item.get("total_successes", item.get("totalSuccesses")),
                    "totalFailures": item.get("total_failures", item.get("totalFailures")),
                    "lastSuccessAt": item.get("last_success_at", item.get("lastSuccessAt")),
                    "lastFailureAt": item.get("last_failure_at", item.get("lastFailureAt")),
                    "lastErrorKind": item.get("last_error_kind", item.get("lastErrorKind")),
                    "lastErrorStatus": item.get("last_error_status", item.get("lastErrorStatus")),
                    "lastErrorMessage": item.get("last_error_message", item.get("lastErrorMessage")),
                    "retryAfterAt": item.get("retry_after_at", item.get("retryAfterAt")),
                    "credentialScope": item.get("credential_scope"),
                    "models": item.get("models") or [],
                    "supplier": supplier.get("name"),
                    "supplyOrigin": economics["supplyOrigin"],
                    "commercialType": economics["commercialType"],
                    "routingPolicy": economics["routingPolicy"],
                    "spendTier": economics["spendTier"],
                    "profiles": profiles,
                }
            )
        return json.dumps(
            {"ok": True, "summary": hub.get("summary") or {}, "items": items},
            ensure_ascii=False,
        )
    except Exception as exc:
        return json.dumps(
            {"ok": False, "error": type(exc).__name__, "message": str(exc)[:300]},
            ensure_ascii=False,
        )


def _reconcile_policy_workforce_from_hub(force: bool = False) -> dict[str, int]:
    global _PLACEMENT_RECONCILE_LAST
    now = time.monotonic()
    if not force and now - _PLACEMENT_RECONCILE_LAST < _PLACEMENT_RECONCILE_TTL_SECONDS:
        return {"connections": 0, "models": 0}
    with _PLACEMENT_RECONCILE_LOCK:
        now = time.monotonic()
        if not force and now - _PLACEMENT_RECONCILE_LAST < _PLACEMENT_RECONCILE_TTL_SECONDS:
            return {"connections": 0, "models": 0}
        hub = _control_plane_request("/api/v2/projections/provider-hub", timeout=3.0)
        workforce = _control_plane_request("/api/v2/projections/workforce", timeout=3.0)
        supply = _control_plane_request("/api/v2/projections/supply", timeout=3.0)
        existing: set[tuple[str, str]] = set()
        employee_ids: dict[tuple[str, str], str] = {}
        for employee in workforce.get("employees") or []:
            if not isinstance(employee, dict):
                continue
            supplier = employee.get("supplier") if isinstance(employee.get("supplier"), dict) else {}
            supplier_model = (
                employee.get("supplierModel")
                if isinstance(employee.get("supplierModel"), dict)
                else {}
            )
            supplier_id = str(supplier.get("id") or "").strip()
            model = str(supplier_model.get("key") or "").strip().lower()
            current = int(employee.get("currentEmploymentCount") or 0)
            if supplier_id and model and current > 0:
                key = (supplier_id, model)
                existing.add(key)
                employee_ids[key] = str(employee.get("id") or "").strip()

        supplier_economics: dict[str, dict[str, str]] = {}
        bridge_ready_employee_ids: set[str] = set()
        for supplier_projection in supply.get("suppliers") or []:
            if isinstance(supplier_projection, dict):
                sid = str(supplier_projection.get("id") or "").strip()
                active_agreements = [
                    agreement
                    for agreement in (supplier_projection.get("agreements") or [])
                    if isinstance(agreement, dict) and str(agreement.get("lifecycle") or "") == "ACTIVE"
                ]
                commercial_type = "OTHER"
                for agreement in active_agreements:
                    candidate_type = str(agreement.get("commercialType") or "OTHER").upper()
                    if candidate_type != "OTHER":
                        commercial_type = candidate_type
                        break
                if sid:
                    supplier_economics[sid] = {
                        "supplyOrigin": str(supplier_projection.get("supplyOrigin") or "UNKNOWN").upper(),
                        "routingPolicy": str(supplier_projection.get("routingPolicy") or "AUTO").upper(),
                        "commercialType": commercial_type,
                    }
        for supplier_projection in supply.get("suppliers") or []:
            if not isinstance(supplier_projection, dict):
                continue
            for agreement in supplier_projection.get("agreements") or []:
                if not isinstance(agreement, dict):
                    continue
                for employment in agreement.get("employments") or []:
                    if not isinstance(employment, dict):
                        continue
                    employee_id = str(employment.get("employeeId") or "").strip()
                    for access in employment.get("runtimeAccess") or []:
                        if not isinstance(access, dict):
                            continue
                        config = access.get("config") if isinstance(access.get("config"), dict) else {}
                        if (
                            str(access.get("runtimeKind") or "").upper() == "CODEX"
                            and str(access.get("lifecycle") or "ACTIVE").upper() == "ACTIVE"
                            and str(config.get("wireApi") or "").lower() == "responses"
                            and str(config.get("transportMode") or "").upper() == "BRIDGED_CHAT"
                            and str(config.get("bridgeKind") or "").upper() == "CC_SWITCH_CODEX_CHAT"
                            and employee_id
                        ):
                            bridge_ready_employee_ids.add(employee_id)

        reconciled_connections = 0
        reconciled_models = 0
        for connection in hub.get("items") or []:
            if not isinstance(connection, dict):
                continue
            if _brain_only_provider_connection(connection):
                continue
            auth_kind = str(connection.get("auth_kind") or connection.get("authKind") or "").upper()
            admin_state = str(
                connection.get("admin_state") or connection.get("adminState") or "ENABLED"
            ).upper()
            if auth_kind != "API_KEY" or admin_state == "DISABLED":
                continue
            if not _provider_connection_credential_ready(connection, _active_profile_name()):
                continue
            supplier = connection.get("supplier") if isinstance(connection.get("supplier"), dict) else {}
            supplier_id = str(supplier.get("id") or connection.get("supplier_id") or "").strip()
            supplier_slug = str(supplier.get("slug") or "").strip()
            supplier_name = str(supplier.get("name") or "").strip()
            provider_key = str(connection.get("provider_key") or connection.get("providerKey") or "").strip()
            display_name = str(connection.get("display_name") or connection.get("displayName") or provider_key).strip()
            base_url = str(connection.get("base_url") or connection.get("baseUrl") or "").strip()
            credential_ref = str(
                connection.get("credential_ref") or connection.get("credentialRef") or ""
            ).strip()
            connection_id = str(connection.get("id") or "").strip()
            website_url = str(
                connection.get("website_url")
                or connection.get("websiteUrl")
                or supplier.get("websiteUrl")
                or ""
            ).strip()
            models = _policy_workforce_models(
                [str(item) for item in (connection.get("models") or []) if str(item).strip()]
            )
            protocol = str(connection.get("protocol") or "openai-chat-completions")
            transport_mode = _codex_transport_mode(protocol)
            to_reconcile: list[str] = []
            for model in models:
                key = (supplier_id, model.lower())
                is_missing = not supplier_id or key not in existing
                employee_id = employee_ids.get(key, "")
                needs_bridge_upgrade = (
                    _is_gpt_execution_model(model)
                    and transport_mode == "BRIDGED_CHAT"
                    and employee_id not in bridge_ready_employee_ids
                )
                if is_missing or needs_bridge_upgrade:
                    to_reconcile.append(model)
            if (
                not to_reconcile
                or not provider_key
                or not connection_id
                or not base_url
                or not credential_ref
            ):
                continue
            try:
                economics = supplier_economics.get(
                    supplier_id,
                    {"supplyOrigin": "UNKNOWN", "commercialType": "OTHER", "routingPolicy": "AUTO"},
                )
                registrations = _register_shared_policy_workforce(
                    provider_key=provider_key,
                    display_name=display_name,
                    website_url=website_url,
                    supplier_slug=supplier_slug or provider_key,
                    supplier_name=supplier_name or display_name,
                    base_url=base_url,
                    protocol=protocol,
                    credential_ref=credential_ref,
                    connection_id=connection_id,
                    models=to_reconcile,
                    supply_origin=economics["supplyOrigin"],
                    commercial_type=economics["commercialType"],
                    routing_policy=economics["routingPolicy"],
                )
            except Exception:
                continue
            if registrations:
                reconciled_connections += 1
                reconciled_models += len(registrations)
                for registration in registrations:
                    model = str(registration.get("model") or "").lower()
                    if supplier_id and model:
                        key = (supplier_id, model)
                        existing.add(key)
                        employee_id = str(registration.get("employeeId") or "").strip()
                        if employee_id:
                            employee_ids[key] = employee_id
                            if transport_mode == "BRIDGED_CHAT" and _is_gpt_execution_model(model):
                                bridge_ready_employee_ids.add(employee_id)
        _PLACEMENT_RECONCILE_LAST = time.monotonic()
        return {"connections": reconciled_connections, "models": reconciled_models}


def _is_official_deepseek_endpoint(value: Any) -> bool:
    raw = str(value or "").strip()
    if not raw:
        return False
    try:
        host = str(urllib.parse.urlparse(raw).hostname or "").lower()
    except ValueError:
        return False
    return host == "api.deepseek.com"


def _brain_only_provider_connection(connection: dict[str, Any]) -> bool:
    provider_key = str(
        connection.get("provider_key") or connection.get("providerKey") or ""
    ).strip().lower()
    base_url = str(connection.get("base_url") or connection.get("baseUrl") or "").strip()
    return provider_key == "deepseek" or _is_official_deepseek_endpoint(base_url)


def _available_execution_provider_ids(profile_name: str) -> list[str]:
    hub = _control_plane_request("/api/v2/projections/provider-hub", timeout=3.0)
    ready: list[str] = []
    for connection in hub.get("items") or []:
        if not isinstance(connection, dict):
            continue
        if _brain_only_provider_connection(connection):
            continue
        connection_id = str(connection.get("id") or "").strip()
        admin_state = str(
            connection.get("admin_state") or connection.get("adminState") or "ENABLED"
        ).upper()
        routable = connection.get("routable")
        if not connection_id or admin_state == "DISABLED" or routable is False:
            continue
        if not _provider_connection_credential_ready(connection, profile_name):
            continue
        ready.append(connection_id)
    return ready


def _runtime_binary(name: str) -> str:
    found = shutil.which(name)
    if found:
        return found
    for candidate in (
        Path("/opt/data/runtime/npm/bin") / name,
        Path("/home/ubuntu/.npm-global/bin") / name,
        Path("/usr/local/bin") / name,
    ):
        try:
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
        except OSError:
            continue
    return ""


def _execution_runtime_inventory() -> list[dict[str, str]]:
    runtimes: list[dict[str, str]] = []
    for kind, binary in (
        ("CLAUDE_CODE", "claude"),
        ("CODEX", "codex"),
        ("DSH", "dsh"),
        ("OPENCODE", "opencode"),
    ):
        path = _runtime_binary(binary)
        if path:
            runtimes.append({"kind": kind, "path": path, "mode": "HEADLESS"})
    # ZCode is currently a desktop ADE. Do not advertise it as a Hermes-headless
    # runtime until an explicit automation contract is available and enabled.
    if os.environ.get("HERMES_AI_OFFICE_ENABLE_ZCODE_AUTOMATION") == "1":
        path = _runtime_binary("zcode")
        if path:
            runtimes.append({"kind": "ZCODE", "path": path, "mode": "DESKTOP"})
    return runtimes


def _agent_harnessctl_path() -> str:
    configured = str(os.environ.get("HERMES_AI_OFFICE_HARNESSCTL") or "").strip()
    candidates = [
        configured,
        "/home/ubuntu/projects/agent-harness/bin/harnessctl",
        "/opt/data/runtime/agent-harness/bin/harnessctl",
        str(Path.home() / ".local" / "share" / "agent-harness" / "current" / "bin" / "harnessctl"),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate)
        try:
            if path.is_file() and os.access(path, os.X_OK):
                return str(path)
        except OSError:
            continue
    return ""


def _execution_project_path(args: dict[str, Any] | None = None) -> str:
    requested = str((args or {}).get("project_path") or "").strip()
    candidates: list[Path] = []
    if requested:
        candidates.append(Path(requested).expanduser())
    configured = str(os.environ.get("HERMES_AI_OFFICE_PROJECT_ROOT") or "").strip()
    if configured:
        candidates.append(Path(configured).expanduser())
    profile = _active_profile_name()
    if profile and profile not in {"default", "main"}:
        candidates.append(Path("/home/ubuntu/projects") / _safe_runtime_name(profile))
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
            current = resolved if resolved.is_dir() else resolved.parent
            for root in (current, *current.parents):
                if (root / ".git").exists():
                    return str(root)
        except OSError:
            continue
    return ""


def _prepare_agent_harness_environment(
    project_path: str,
    host: str,
    route_config: str = "",
) -> dict[str, Any]:
    harnessctl = _agent_harnessctl_path()
    if not harnessctl:
        raise RuntimeError("Agent Harness controller is not available")
    if not project_path:
        raise RuntimeError("Agent Harness project path is not available")
    profile_home = _active_runtime_hermes_home() / "home"
    profile_home.mkdir(parents=True, exist_ok=True)
    _adopt_active_runtime_owner(profile_home)
    env = os.environ.copy()
    env["HOME"] = str(profile_home)
    command = [harnessctl, "prepare", project_path, "--host", host]
    if route_config:
        command.extend(["--route-config", route_config])
    command.append("--json")
    process = subprocess.run(
        command,
        env=env,
        cwd=project_path,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=15,
        check=False,
    )
    if process.returncode != 0:
        detail = (process.stderr or process.stdout or "Agent Harness prepare failed").strip()
        raise RuntimeError(detail[:500])
    try:
        payload = json.loads(process.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Agent Harness returned invalid JSON") from exc
    environment = payload.get("environment") if isinstance(payload, dict) else None
    admission = payload.get("admission") if isinstance(payload, dict) else None
    if not isinstance(environment, dict):
        raise RuntimeError("Agent Harness prepare did not return an environment")
    if not isinstance(admission, dict):
        raise RuntimeError("Agent Harness prepare did not return an admission decision")
    return {
        "controller": harnessctl,
        "profileHome": str(profile_home),
        "projectRoot": str(environment.get("projectRoot") or project_path),
        "capabilityHash": str(environment.get("capabilityHash") or ""),
        "environmentId": str(environment.get("environmentId") or ""),
        "environmentRoot": str(environment.get("root") or ""),
        "admission": admission,
    }


def _safe_runtime_name(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(value or "").strip()).strip("-")
    return cleaned[:100] or "runtime"


def _write_runtime_text(path: Path, content: str) -> str:
    previous = None
    try:
        previous = path.read_text(encoding="utf-8") if path.exists() else None
    except OSError:
        previous = None
    if previous == content:
        _adopt_active_runtime_owner(path)
        return "REUSE_EXISTING"
    path.parent.mkdir(parents=True, exist_ok=True)
    _adopt_active_runtime_owner(path.parent)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    try:
        os.chmod(temporary, 0o600)
        _adopt_active_runtime_owner(temporary)
    except OSError:
        pass
    os.replace(temporary, path)
    _adopt_active_runtime_owner(path)
    return "CREATE_MANAGED"


def _execution_selected(result: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    selected = result.get("selected")
    if not isinstance(selected, dict):
        raise RuntimeError("AI Office did not select an execution employee")
    runtime = selected.get("runtime")
    if not isinstance(runtime, dict):
        raise RuntimeError("AI Office selection is missing runtime guidance")
    connection = selected.get("providerConnection")
    if not isinstance(connection, dict):
        raise RuntimeError("AI Office selection is missing provider connection metadata")
    return selected, runtime, connection


def _prepare_dsh_execution(
    selected: dict[str, Any], runtime: dict[str, Any], connection: dict[str, Any]
) -> None:
    model = str(selected.get("model") or "").strip()
    base_url = str(connection.get("baseUrl") or "").strip().rstrip("/")
    credential_ref = str(connection.get("credentialRef") or "").strip()
    connection_id = str(connection.get("id") or connection.get("providerKey") or "provider").strip()
    executable = str(runtime.get("executable") or _runtime_binary("dsh") or "dsh").strip()
    if not model or not base_url or not credential_ref:
        raise RuntimeError("DSH selection is missing model, baseUrl, or credentialRef")
    secret_file = _runtime_secret_file(credential_ref)
    if not secret_file:
        raise RuntimeError("DSH selected provider credential is not available")
    root = _active_runtime_hermes_home()
    digest = hashlib.blake2b(
        f"{connection_id}|{base_url}|{model}|{credential_ref}".encode("utf-8"), digest_size=8
    ).hexdigest()
    patch = root / "runtime" / "dsh" / "ai-office" / (
        f"{_safe_runtime_name(connection_id)}-{_safe_runtime_name(model)}-{digest}.patch.yml"
    )
    content = (
        "- id: agent-default-model\n"
        "  config:\n"
        "    provider: deepseek-official\n"
        f"    model: {json.dumps(model, ensure_ascii=False)}\n"
        "- id: llm-deepseek\n"
        "  config:\n"
        f"    apiKeyEnv: {json.dumps(credential_ref)}\n"
        f"    baseURL: {json.dumps(base_url)}\n"
    )
    action = _write_runtime_text(patch, content)
    runtime.update(
        {
            "profileAction": action,
            "profileReady": True,
            "profileRef": "headless",
            "managedProfilePath": str(patch),
            "commandTemplate": (
                f'{credential_ref}="$(cat {shlex.quote(secret_file)})" '
                f"{shlex.quote(executable)} --profile headless --patch {shlex.quote(str(patch))} <task>"
            ),
        }
    )


def _prepare_codex_execution(
    selected: dict[str, Any], runtime: dict[str, Any], connection: dict[str, Any]
) -> None:
    model = str(selected.get("model") or "").strip()
    provider_key = str(connection.get("providerKey") or "provider").strip()
    base_url = str(connection.get("baseUrl") or "").strip().rstrip("/")
    credential_ref = str(connection.get("credentialRef") or "").strip()
    protocol = str(connection.get("protocol") or "openai-chat-completions").strip()
    auth_kind = str(connection.get("authKind") or "API_KEY").strip().upper()
    provider_ref = str(runtime.get("providerRef") or "").strip()
    profile_ref = str(runtime.get("profileRef") or "").strip()
    executable = str(runtime.get("executable") or _runtime_binary("codex") or "codex").strip()
    if auth_kind == "OAUTH":
        if not runtime.get("accessProfileId") or not profile_ref or not provider_ref:
            raise RuntimeError("Codex OAuth selection requires an existing profile access")
        if not _codex_profile_exists(profile_ref, provider_ref, model):
            raise RuntimeError("Codex OAuth profile file is not ready")
        runtime.update(
            {
                "profileAction": "REUSE_EXISTING",
                "profileReady": True,
                "commandTemplate": f"{shlex.quote(executable)} --profile {shlex.quote(profile_ref)} exec <task>",
            }
        )
        return
    transport_mode = str(runtime.get("transportMode") or _codex_transport_mode(protocol)).strip().upper()
    if transport_mode == "BRIDGED_CHAT":
        bridge_kind = str(runtime.get("bridgeKind") or "").strip().upper()
        if "chat" not in protocol.lower() or bridge_kind != "CC_SWITCH_CODEX_CHAT":
            raise RuntimeError("Codex bridged route is missing a valid Chat Completions bridge contract")
        if not provider_ref or not profile_ref or not model or not base_url or not credential_ref:
            raise RuntimeError("Codex bridged route is missing provider, profile, model, baseUrl, or credentialRef")
        secret_file = _runtime_secret_file(credential_ref)
        if not secret_file:
            raise RuntimeError("Codex bridged provider credential is not available")
        route_seed = f"{provider_ref}|{profile_ref}|{model}|{base_url}|{credential_ref}"
        route_digest = hashlib.blake2b(route_seed.encode("utf-8"), digest_size=8).hexdigest()
        route_path = (
            _active_runtime_hermes_home()
            / "runtime"
            / "agent-harness"
            / "routes"
            / f"codex-{_safe_runtime_name(provider_ref)}-{route_digest}.json"
        )
        _write_json_atomic(
            route_path,
            {
                "version": 1,
                "transportMode": "BRIDGED_CHAT",
                "bridgeKind": "CC_SWITCH_CODEX_CHAT",
                "providerRef": provider_ref,
                "profileRef": profile_ref,
                "model": model,
                "upstreamModel": model,
                "upstreamBaseUrl": base_url,
                "upstreamProtocol": protocol,
                "credentialRef": credential_ref,
                "providerHubConnectionId": str(connection.get("id") or ""),
            },
        )
        runtime.update(
            {
                "profileAction": "REUSE_EXISTING" if runtime.get("accessProfileId") else "CREATE_MANAGED",
                "profileReady": True,
                "profileRef": profile_ref,
                "providerRef": provider_ref,
                "bridgeRouteConfig": str(route_path),
                "commandTemplate": (
                    f'{credential_ref}="$(cat {shlex.quote(secret_file)})" '
                    f"{shlex.quote(executable)} --profile {shlex.quote(profile_ref)} exec <task>"
                ),
            }
        )
        return
    if not _codex_protocol_compatible(protocol):
        raise RuntimeError(f"Codex does not support selected provider protocol natively: {protocol or 'unknown'}")
    if not provider_ref:
        provider_ref = (
            "hao-"
            + _safe_runtime_name(provider_key)
            + "-"
            + hashlib.blake2b(base_url.encode("utf-8"), digest_size=4).hexdigest()
        )[:120]
    if not profile_ref:
        profile_ref = (
            "hao-"
            + _safe_runtime_name(provider_key)[:40]
            + "-"
            + hashlib.blake2b(f"{base_url}|{model}".encode("utf-8"), digest_size=5).hexdigest()
        )[:120]
    profile_existed = _codex_profile_exists(profile_ref, provider_ref, model)
    synthetic = {
        "selectedModel": model,
        "selectedProfile": profile_ref,
        "selectedAccess": {
            "id": runtime.get("accessProfileId") or "execution-resolve-managed",
            "adapterKind": "NATIVE_CONFIG",
            "providerRef": provider_ref,
            "baseUrl": base_url or None,
            "credentialRef": credential_ref or None,
            "protocol": protocol,
            "config": {"wireApi": "responses", "transportMode": "NATIVE_RESPONSES"},
        },
    }
    if not _ensure_codex_native_access(synthetic):
        raise RuntimeError("Codex profile could not be prepared for the selected provider")
    prefix = ""
    if credential_ref:
        secret_file = _runtime_secret_file(credential_ref)
        if not secret_file:
            raise RuntimeError("Codex selected provider credential is not available")
        prefix = f'{credential_ref}="$(cat {shlex.quote(secret_file)})" '
    runtime.update(
        {
            "profileAction": "REUSE_EXISTING" if profile_existed else "CREATE_MANAGED",
            "profileReady": True,
            "profileRef": profile_ref,
            "providerRef": provider_ref,
            "commandTemplate": f"{prefix}{shlex.quote(executable)} --profile {shlex.quote(profile_ref)} exec <task>",
        }
    )


def _opencode_provider_model_exists(provider_ref: str, model_ref: str) -> bool:
    for home in _runtime_homes():
        path = home / ".config" / "opencode" / "opencode.json"
        if not path.exists():
            continue
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        providers = value.get("provider") if isinstance(value, dict) else None
        provider = providers.get(provider_ref) if isinstance(providers, dict) else None
        models = provider.get("models") if isinstance(provider, dict) else None
        if isinstance(models, dict) and model_ref in models:
            return True
    return False


def _prepare_opencode_execution(
    selected: dict[str, Any], runtime: dict[str, Any], connection: dict[str, Any]
) -> None:
    model = str(selected.get("model") or "").strip()
    provider_ref = str(runtime.get("providerRef") or connection.get("providerKey") or "").strip()
    base_url = str(connection.get("baseUrl") or "").strip().rstrip("/")
    credential_ref = str(connection.get("credentialRef") or "").strip()
    protocol = str(connection.get("protocol") or "openai-chat-completions").strip()
    if not provider_ref or not model:
        raise RuntimeError("OpenCode selection is missing provider or model")
    profile_existed = _opencode_provider_model_exists(provider_ref, model)
    synthetic = {
        "selectedModel": f"{provider_ref}/{model}",
        "selectedAccess": {
            "id": runtime.get("accessProfileId") or "execution-resolve-managed",
            "adapterKind": "NATIVE_CONFIG",
            "providerRef": provider_ref,
            "baseUrl": base_url or None,
            "credentialRef": credential_ref or None,
            "protocol": protocol,
            "config": {
                "managedProvider": True,
                "package": "@ai-sdk/openai-compatible",
            },
        },
    }
    if not _ensure_opencode_native_access(synthetic):
        raise RuntimeError("OpenCode provider profile could not be prepared")
    executable = str(runtime.get("executable") or _runtime_binary("opencode") or "opencode").strip()
    runtime.update(
        {
            "profileAction": "REUSE_EXISTING" if profile_existed else "CREATE_MANAGED",
            "profileReady": True,
            "providerRef": provider_ref,
            "commandTemplate": (
                f"{shlex.quote(executable)} run --model {shlex.quote(provider_ref + '/' + model)} <task>"
            ),
        }
    )


def _prepare_claude_execution(
    selected: dict[str, Any], runtime: dict[str, Any], connection: dict[str, Any]
) -> None:
    base_url = str(connection.get("baseUrl") or "").strip().rstrip("/")
    credential_ref = str(connection.get("credentialRef") or "").strip()
    executable = str(runtime.get("executable") or _runtime_binary("claude") or "claude").strip()
    if not credential_ref:
        raise RuntimeError("Claude Code selection is missing credentialRef")
    secret_file = _runtime_secret_file(credential_ref)
    if not secret_file:
        raise RuntimeError("Claude Code selected provider credential is not available")
    auth_env = "ANTHROPIC_AUTH_TOKEN" if "AUTH_TOKEN" in credential_ref.upper() else "ANTHROPIC_API_KEY"
    prefixes = [f'{auth_env}="$(cat {shlex.quote(secret_file)})"']
    if base_url:
        prefixes.append(f"ANTHROPIC_BASE_URL={shlex.quote(base_url)}")
    runtime.update(
        {
            "profileAction": "REUSE_EXISTING" if runtime.get("accessProfileId") else "CREATE_MANAGED",
            "profileReady": True,
            "commandTemplate": " ".join(prefixes)
            + f" {shlex.quote(executable)} <task>",
        }
    )


def _apply_agent_harness_launch(
    selected: dict[str, Any],
    runtime: dict[str, Any],
    connection: dict[str, Any],
    environment: dict[str, Any],
) -> None:
    selected_harness = str(runtime.get("selectedHarness") or "").strip().upper()
    host = {
        "CODEX": "codex",
        "CLAUDE_CODE": "claude",
        "DSH": "dsh",
        "OPENCODE": "opencode",
    }.get(selected_harness)
    if not host:
        return
    controller = str(environment["controller"])
    profile_home = str(environment["profileHome"])
    project_root = str(environment["projectRoot"])
    route_option = ""
    if selected_harness == "CODEX":
        route_config = str(runtime.get("bridgeRouteConfig") or "").strip()
        if route_config:
            route_option = f"--route-config {shlex.quote(route_config)} "
    base = (
        f"HOME={shlex.quote(profile_home)} {shlex.quote(controller)} exec "
        f"--project {shlex.quote(project_root)} {route_option}{host} -- "
    )
    prefix = ""
    args = ""
    credential_ref = str(connection.get("credentialRef") or "").strip()
    auth_kind = str(connection.get("authKind") or "API_KEY").strip().upper()
    if selected_harness == "DSH":
        provider_patch = str(runtime.get("managedProfilePath") or "").strip()
        secret_file = _runtime_secret_file(credential_ref) if credential_ref else None
        if not provider_patch or not credential_ref or not secret_file:
            raise RuntimeError("DSH provider overlay is not ready for Agent Harness")
        prefix = f'{credential_ref}="$(cat {shlex.quote(secret_file)})" '
        args = f"--patch {shlex.quote(provider_patch)} <task>"
    elif selected_harness == "CODEX":
        profile_ref = str(runtime.get("profileRef") or "").strip()
        if not profile_ref:
            raise RuntimeError("Codex profile is not ready for Agent Harness")
        if credential_ref and auth_kind != "OAUTH":
            secret_file = _runtime_secret_file(credential_ref)
            if not secret_file:
                raise RuntimeError("Codex provider credential is not ready for Agent Harness")
            prefix = f'{credential_ref}="$(cat {shlex.quote(secret_file)})" '
        args = f"--profile {shlex.quote(profile_ref)} exec <task>"
    elif selected_harness == "OPENCODE":
        model = str(selected.get("model") or "").strip()
        provider_ref = str(runtime.get("providerRef") or connection.get("providerKey") or "").strip()
        if not model or not provider_ref:
            raise RuntimeError("OpenCode provider/model is not ready for Agent Harness")
        args = f"run --model {shlex.quote(provider_ref + '/' + model)} <task>"
    elif selected_harness == "CLAUDE_CODE":
        secret_file = _runtime_secret_file(credential_ref) if credential_ref else None
        if not credential_ref or not secret_file:
            raise RuntimeError("Claude Code provider credential is not ready for Agent Harness")
        auth_env = "ANTHROPIC_AUTH_TOKEN" if "AUTH_TOKEN" in credential_ref.upper() else "ANTHROPIC_API_KEY"
        parts = [f'{auth_env}="$(cat {shlex.quote(secret_file)})"']
        base_url = str(connection.get("baseUrl") or "").strip().rstrip("/")
        if base_url:
            parts.append(f"ANTHROPIC_BASE_URL={shlex.quote(base_url)}")
        prefix = " ".join(parts) + " "
        args = "<task>"
    runtime.update(
        {
            "capabilityPlane": "AGENT_HARNESS_V1",
            "capabilityPlaneStatus": "READY",
            "capabilityHash": environment.get("capabilityHash"),
            "capabilityEnvironmentId": environment.get("environmentId"),
            "capabilityEnvironmentRoot": environment.get("environmentRoot"),
            "projectRoot": project_root,
            "launchContract": "HARNESSCTL_EXEC",
            "commandTemplate": prefix + base + args,
        }
    )


def _prepare_execution_result(result: dict[str, Any], project_path: str = "") -> dict[str, Any]:
    if str(result.get("status") or "") != "SELECTED":
        return result
    selected, runtime, connection = _execution_selected(result)
    harness = str(runtime.get("selectedHarness") or "").strip().upper()
    if harness == "DSH":
        _prepare_dsh_execution(selected, runtime, connection)
    elif harness == "CODEX":
        _prepare_codex_execution(selected, runtime, connection)
    elif harness == "OPENCODE":
        _prepare_opencode_execution(selected, runtime, connection)
    elif harness == "CLAUDE_CODE":
        _prepare_claude_execution(selected, runtime, connection)
    if harness in {"DSH", "CODEX", "OPENCODE", "CLAUDE_CODE"}:
        if not project_path:
            runtime.update(
                {
                    "capabilityPlane": "AGENT_HARNESS_V1",
                    "capabilityPlaneStatus": "PROJECT_REQUIRED",
                    "profileReady": False,
                    "launchContract": "BLOCKED_UNTIL_PROJECT_RESOLVED",
                }
            )
            runtime.pop("commandTemplate", None)
            selected["guidance"] = (
                str(selected.get("guidance") or "").strip()
                + " A repository path is required before launch so Agent Harness can materialize project MCP, Skills, and Instructions. Resolve this execution again with project_path."
            ).strip()
            return result
        host = {
            "CODEX": "codex",
            "CLAUDE_CODE": "claude",
            "DSH": "dsh",
            "OPENCODE": "opencode",
        }[harness]
        route_config = str(runtime.get("bridgeRouteConfig") or "").strip()
        environment = _prepare_agent_harness_environment(
            project_path,
            host,
            route_config=route_config,
        )
        admission = environment.get("admission") if isinstance(environment.get("admission"), dict) else {}
        if str(admission.get("status") or "") != "READY":
            runtime.update(
                {
                    "capabilityPlane": "AGENT_HARNESS_V1",
                    "capabilityPlaneStatus": "BLOCKED",
                    "capabilityHash": environment.get("capabilityHash"),
                    "capabilityEnvironmentId": environment.get("environmentId"),
                    "capabilityEnvironmentRoot": environment.get("environmentRoot"),
                    "capabilityBlockers": admission.get("blockers") or [],
                    "profileReady": False,
                    "projectRoot": environment.get("projectRoot"),
                    "launchContract": "BLOCKED_CAPABILITY_ADMISSION",
                }
            )
            runtime.pop("commandTemplate", None)
            selected["guidance"] = (
                str(selected.get("guidance") or "").strip()
                + " Agent Harness materialized the project environment but blocked launch because required capabilities are not ready. Inspect capabilityBlockers; do not bypass the admission decision with a direct Harness launch."
            ).strip()
            return result
        _apply_agent_harness_launch(selected, runtime, connection, environment)
    selected["guidance"] = (
        str(selected.get("guidance") or "").strip()
        + " AI Office prepared provider access and Agent Harness prepared the project capability environment. Use commandTemplate as the per-execution launch contract and replace only <task>."
    ).strip()
    return result


def _resolve_execution_tool(args: dict[str, Any], **_kwargs: Any) -> str:
    try:
        intent = str(args.get("intent") or "").strip().upper()
        allowed = {"PLAN", "REVIEW", "IMPLEMENT", "DEBUG", "TEST", "RESEARCH", "QUICK_FIX"}
        if intent not in allowed:
            raise ValueError("intent must be PLAN, REVIEW, IMPLEMENT, DEBUG, TEST, RESEARCH, or QUICK_FIX")
        profile = "default"
        if _CTX is not None:
            try:
                profile = str(getattr(_CTX, "profile_name", "") or "default")[:120]
            except Exception:
                profile = "default"
        try:
            reconciliation = _reconcile_policy_workforce_from_hub()
        except Exception:
            reconciliation = {"connections": 0, "models": 0}
        try:
            available_connections = _available_execution_provider_ids(profile)
        except Exception:
            available_connections = []
        project_path = _execution_project_path(args)
        payload: dict[str, Any] = {
            "intent": intent,
            "availableRuntimes": _execution_runtime_inventory(),
            "availableProviderConnectionIds": available_connections,
            "at": int(time.time() * 1000),
            "timezone": "Asia/Shanghai",
            "metadata": {
                "profileName": profile,
                "source": "hermes-ai-office-tool",
                "projectRoot": project_path or None,
            },
        }
        requested_model = str(args.get("requested_model") or "").strip()
        if requested_model:
            payload["requestedModel"] = requested_model[:240]
        result = _control_plane_request(
            "/api/v2/commands/execution/resolve",
            method="POST",
            payload=payload,
            timeout=3.0,
        )
        prepared = _prepare_execution_result(result, project_path=project_path)
        return json.dumps(
            {"ok": True, "workforceReconciliation": reconciliation, **prepared},
            ensure_ascii=False,
        )
    except Exception as exc:
        return json.dumps(
            {"ok": False, "error": type(exc).__name__, "message": str(exc)[:300]},
            ensure_ascii=False,
        )


def _set_provider_state_tool(args: dict[str, Any], **_kwargs: Any) -> str:
    try:
        connection_id = str(args.get("connection_id") or "").strip()
        provider_key = str(args.get("provider_key") or "").strip()
        if not connection_id:
            if not provider_key:
                raise ValueError("connection_id or provider_key is required")
            hub = _control_plane_request("/api/v2/projections/provider-hub", timeout=3.0)
            matches = [i for i in (hub.get("items") or []) if isinstance(i, dict) and str(i.get("provider_key") or "") == provider_key]
            if len(matches) != 1:
                raise ValueError("provider_key must resolve to exactly one connection")
            match = matches[0]
            connection_id = str(match.get("id") or match.get("connection_id") or (match.get("connection") or {}).get("id") or "").strip()
        if not connection_id:
            raise ValueError("provider connection id is unavailable")
        enabled = args.get("enabled")
        if not isinstance(enabled, bool):
            raise ValueError("enabled must be a boolean")
        payload = {"enabled": enabled}
        reason = str(args.get("reason") or "").strip()
        if reason:
            payload["reason"] = reason[:300]
        result = _control_plane_request(f"/api/v2/commands/provider-connections/{urllib.parse.quote(connection_id, safe='')}/control", method="POST", payload=payload)
        return json.dumps({"ok": True, "connectionId": connection_id, "enabled": payload["enabled"], "result": result}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)[:300]}, ensure_ascii=False)

def _session_id(kwargs: dict[str, Any]) -> str:
    return str(kwargs.get("session_id") or kwargs.get("task_id") or "")


def _correlation_key(tool_name: str, kwargs: dict[str, Any]) -> str:
    call_id = str(kwargs.get("tool_call_id") or "")
    if call_id:
        return call_id
    return "%s:%s:%s:%s" % (
        _session_id(kwargs),
        str(kwargs.get("task_id") or ""),
        tool_name,
        threading.get_ident(),
    )


def _detect_managed_harness_runtime(command: str) -> str | None:
    match = _MANAGED_HARNESS_COMMAND_RE.search(command or "")
    if not match:
        return None
    runtime = match.group("runtime").lower()
    return "claude" if runtime == "claude" else runtime


def _detect_runtime(command: str) -> str | None:
    managed = _detect_managed_harness_runtime(command)
    if managed:
        return managed
    match = _RUNTIME_COMMAND_RE.search(command or "")
    return match.group("runtime").lower() if match else None


def _model_from_command(command: str) -> str | None:
    match = _MODEL_RE.search(command or "")
    if not match:
        return None
    return match.group(1).strip("'\"")[:240] or None


def _command_summary(command: str, runtime: str) -> str:
    verb_match = _VERB_RE.search(command or "")
    verb = verb_match.group(2).lower() if verb_match else ""
    allowed_verbs = {"run", "exec", "review", "resume", "serve", "agent"}
    parts = [runtime]
    if verb in allowed_verbs:
        parts.append(verb)
    model = _model_from_command(command)
    if model:
        parts.extend(["--model", model])
    if command:
        parts.append("…")
    return " ".join(parts)


def _config(key: str, default: Any) -> Any:
    ctx = _CTX
    if ctx is None:
        return default
    try:
        return ctx.get_config(key, default)
    except Exception:
        return default


def _policy_mode() -> str:
    mode = str(_config("runtime_policy.mode", "prefer") or "prefer").strip().upper()
    return mode if mode in {"OBSERVE", "PREFER", "ENFORCE"} else "PREFER"


def _position_hint(runtime: str) -> str:
    default = "coding-executor" if runtime == "opencode" else "codex-executor"
    value = _config(f"runtime_policy.positions.{runtime}", default)
    return str(value or default).strip()[:160]


def _policy_endpoint() -> str:
    value = _config("runtime_policy.endpoint", _DEFAULT_POLICY_ENDPOINT)
    endpoint = str(value or _DEFAULT_POLICY_ENDPOINT).strip()
    if not endpoint.startswith(("http://127.0.0.1:", "http://localhost:")):
        return _DEFAULT_POLICY_ENDPOINT
    return endpoint


def _enqueue(event: dict[str, Any]) -> None:
    _ensure_worker()
    event.setdefault("schema", _SCHEMA)
    event.setdefault("observedAt", time.time())
    try:
        _QUEUE.put_nowait(event)
    except queue.Full:
        pass


def _delivery_loop() -> None:
    while True:
        event = _QUEUE.get()
        try:
            raw = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            req = urllib.request.Request(
                _OBSERVER_ENDPOINT,
                data=raw,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=0.5) as response:
                response.read(1)
        except Exception:
            pass
        finally:
            _QUEUE.task_done()


def _ensure_worker() -> None:
    global _WORKER_STARTED
    if _WORKER_STARTED:
        return
    with _WORKER_LOCK:
        if _WORKER_STARTED:
            return
        threading.Thread(
            target=_delivery_loop,
            name="hermes-ai-office-observer",
            daemon=True,
        ).start()
        _WORKER_STARTED = True


def _base_event(kwargs: dict[str, Any]) -> dict[str, Any]:
    return {
        "sessionId": _session_id(kwargs),
        "taskId": str(kwargs.get("task_id") or ""),
        "turnId": str(kwargs.get("turn_id") or kwargs.get("parent_turn_id") or ""),
        "toolCallId": str(kwargs.get("tool_call_id") or ""),
    }


def _on_subagent_start(**kwargs: Any) -> None:
    event = _base_event(kwargs)
    event.update(
        {
            "event": "subagent_start",
            "parentSessionId": str(kwargs.get("parent_session_id") or ""),
            "childSessionId": str(kwargs.get("child_session_id") or ""),
            "parentTurnId": str(kwargs.get("parent_turn_id") or ""),
            "parentSubagentId": str(kwargs.get("parent_subagent_id") or ""),
            "childSubagentId": str(kwargs.get("child_subagent_id") or ""),
            "childRole": str(kwargs.get("child_role") or ""),
            "childGoal": str(kwargs.get("child_goal") or "")[:500],
        }
    )
    _enqueue(event)


def _on_subagent_stop(**kwargs: Any) -> None:
    event = _base_event(kwargs)
    event.update(
        {
            "event": "subagent_stop",
            "parentSessionId": str(kwargs.get("parent_session_id") or ""),
            "childSessionId": str(kwargs.get("child_session_id") or ""),
            "parentTurnId": str(kwargs.get("parent_turn_id") or ""),
            "parentSubagentId": str(kwargs.get("parent_subagent_id") or ""),
            "childSubagentId": str(kwargs.get("child_subagent_id") or ""),
            "childRole": str(kwargs.get("child_role") or ""),
            "childStatus": str(kwargs.get("child_status") or ""),
            "durationMs": int(kwargs.get("duration_ms") or 0),
        }
    )
    _enqueue(event)


def _resolve_runtime_policy(
    runtime: str,
    command: str,
    args: dict[str, Any],
    kwargs: dict[str, Any],
) -> dict[str, Any] | None:
    ctx = _CTX
    profile_name = "default"
    if ctx is not None:
        try:
            profile_name = str(ctx.profile_name or "default")
        except Exception:
            pass
    payload = {
        "runtimeKind": runtime.upper(),
        "policyMode": _policy_mode(),
        "positionSlug": _position_hint(runtime),
        "sessionId": _session_id(kwargs),
        "taskId": str(kwargs.get("task_id") or ""),
        "toolCallId": str(kwargs.get("tool_call_id") or ""),
        "workdir": str(args.get("workdir") or args.get("cwd") or ""),
        "commandName": _command_summary(command, runtime).replace(" …", ""),
        "requestedModel": _model_from_command(command),
        "metadata": {"profileName": profile_name, "source": "hermes-pre-tool-hook"},
    }
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if payload["toolCallId"]:
        headers["Idempotency-Key"] = "runtime-launch:%s" % payload["toolCallId"]
    request = urllib.request.Request(_policy_endpoint(), data=raw, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=0.8) as response:
            body = json.load(response)
            return body if isinstance(body, dict) else None
    except (OSError, urllib.error.URLError, urllib.error.HTTPError, ValueError, json.JSONDecodeError):
        return None


def _active_runtime_hermes_home() -> Path:
    root = _global_hermes_home()
    profile = _active_profile_name()
    if profile and profile not in {"default", "main"}:
        return root / "profiles" / _safe_runtime_name(profile)
    return root


def _adopt_active_runtime_owner(path: Path) -> None:
    """Keep root-run maintenance replays from creating runtime files unreadable by Hermes."""
    if os.geteuid() != 0:
        return
    try:
        owner = _active_runtime_hermes_home().stat()
        os.chown(path, owner.st_uid, owner.st_gid)
    except OSError:
        pass


def _runtime_homes() -> list[Path]:
    return [_active_runtime_hermes_home() / "home"]


def _write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _adopt_active_runtime_owner(path.parent)
    temporary = path.with_name(path.name + ".hermes-office.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    try:
        os.chmod(temporary, 0o600)
        _adopt_active_runtime_owner(temporary)
    except OSError:
        pass
    os.replace(temporary, path)
    _adopt_active_runtime_owner(path)


def _credential_value(reference: str) -> str:
    name = reference.strip()
    if not name:
        return ""
    try:
        from hermes_cli import config as config_mod

        if hasattr(config_mod, "get_env_value_prefer_dotenv"):
            value = config_mod.get_env_value_prefer_dotenv(name)
            if value:
                return str(value).strip()
        if hasattr(config_mod, "load_env"):
            value = (config_mod.load_env() or {}).get(name)
            if value:
                return str(value).strip()
    except Exception:
        pass
    global_value = _env_value_at_home(_global_hermes_home(), name)
    if global_value:
        return global_value
    return str(os.environ.get(name) or "").strip()


def _runtime_secret_file(reference: str) -> str | None:
    value = _credential_value(reference)
    if not value:
        return None
    root = _active_runtime_hermes_home() / "secrets" / "hermes-ai-office"
    digest = hashlib.blake2b(reference.encode("utf-8"), digest_size=8).hexdigest()
    path = root / f"credential-{digest}.key"
    try:
        root.mkdir(parents=True, exist_ok=True)
        _adopt_active_runtime_owner(root)
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text(value, encoding="utf-8")
        os.chmod(temporary, 0o600)
        _adopt_active_runtime_owner(temporary)
        os.replace(temporary, path)
        os.chmod(path, 0o600)
        _adopt_active_runtime_owner(path)
        return str(path)
    except OSError:
        return None


def _selected_access(decision: dict[str, Any]) -> dict[str, Any]:
    value = decision.get("selectedAccess")
    return dict(value) if isinstance(value, dict) else {}


def _ensure_opencode_native_access(decision: dict[str, Any]) -> bool:
    access = _selected_access(decision)
    config = access.get("config") if isinstance(access.get("config"), dict) else {}
    managed_provider = bool(config.get("managedProvider"))
    provider_ref = str(access.get("providerRef") or "").strip()
    selected_model = str(decision.get("selectedModel") or "").strip()
    if not provider_ref or not selected_model.startswith(provider_ref + "/"):
        return False
    model_ref = selected_model[len(provider_ref) + 1 :].strip()
    base_url = str(access.get("baseUrl") or "").strip()
    credential_ref = str(access.get("credentialRef") or "").strip()
    if not model_ref:
        return False
    if not managed_provider and not base_url and not credential_ref:
        return True
    if managed_provider and not base_url:
        return False
    secret_file = _runtime_secret_file(credential_ref) if credential_ref else None
    if credential_ref and not secret_file:
        return False
    package = str(config.get("package") or "@ai-sdk/openai-compatible").strip()

    for home in _runtime_homes():
        path = home / ".config" / "opencode" / "opencode.json"
        try:
            current: dict[str, Any] = {}
            if path.exists():
                parsed = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(parsed, dict):
                    return False
                current = parsed
            providers = current.get("provider")
            if not isinstance(providers, dict):
                providers = {}
                current["provider"] = providers
            existing = providers.get(provider_ref)
            provider = dict(existing) if isinstance(existing, dict) else {}
            options = provider.get("options")
            options = dict(options) if isinstance(options, dict) else {}
            if base_url:
                options["baseURL"] = base_url.rstrip("/")
            if secret_file:
                options["apiKey"] = "{file:%s}" % secret_file
            models = provider.get("models")
            models = dict(models) if isinstance(models, dict) else {}
            model_config = models.get(model_ref)
            if not isinstance(model_config, dict):
                models[model_ref] = {"name": model_ref}
            provider.update(
                {
                    "name": str(provider.get("name") or ("Hermes AI Office · " + provider_ref)),
                    "options": options,
                    "models": models,
                }
            )
            if managed_provider:
                provider["npm"] = package
            providers[provider_ref] = provider
            _write_json_atomic(path, current)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return False
    return True


def _toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _managed_toml_pattern(marker_type: str, marker_name: str) -> re.Pattern[str]:
    safe_name = re.sub(r"[^A-Za-z0-9_.-]", "-", marker_name)[:120]
    begin = f"# BEGIN HERMES AI OFFICE {marker_type} {safe_name}"
    end = f"# END HERMES AI OFFICE {marker_type} {safe_name}"
    return re.compile(rf"(?ms)^{re.escape(begin)}\n.*?^{re.escape(end)}\n?")


def _remove_managed_toml_block(current: str, marker_type: str, marker_name: str) -> str:
    return _managed_toml_pattern(marker_type, marker_name).sub("", current)


def _replace_managed_toml_block(current: str, marker_type: str, marker_name: str, body: str) -> str:
    safe_name = re.sub(r"[^A-Za-z0-9_.-]", "-", marker_name)[:120]
    begin = f"# BEGIN HERMES AI OFFICE {marker_type} {safe_name}"
    end = f"# END HERMES AI OFFICE {marker_type} {safe_name}"
    managed = begin + "\n" + body.rstrip() + "\n" + end + "\n"
    pattern = _managed_toml_pattern(marker_type, marker_name)
    if pattern.search(current):
        return pattern.sub(managed, current)
    return current.rstrip() + ("\n\n" if current.strip() else "") + managed


def _existing_codex_provider(provider_ref: str) -> dict[str, str]:
    for home in _runtime_homes():
        path = home / ".codex" / "config.toml"
        if not path.exists():
            continue
        try:
            current = path.read_text(encoding="utf-8")
            current = _remove_managed_toml_block(current, "PROVIDER", provider_ref)
            parsed = tomllib.loads(current)
        except (OSError, tomllib.TOMLDecodeError):
            continue
        providers = parsed.get("model_providers")
        if not isinstance(providers, dict):
            continue
        value = providers.get(provider_ref)
        if not isinstance(value, dict):
            continue
        result: dict[str, str] = {}
        for source, target in (
            ("name", "name"),
            ("base_url", "baseUrl"),
            ("env_key", "credentialRef"),
            ("wire_api", "wireApi"),
        ):
            item = value.get(source)
            if isinstance(item, str) and item.strip():
                result[target] = item.strip()
        if result.get("baseUrl"):
            return result
    return {}


def _codex_profile_path(home: Path, profile_ref: str) -> Path:
    safe = _safe_runtime_name(profile_ref)
    if safe != profile_ref:
        raise ValueError("Codex profile name is not filesystem-safe")
    return home / ".codex" / f"{safe}.config.toml"


def _codex_profile_exists(profile_ref: str, provider_ref: str, model: str) -> bool:
    for home in _runtime_homes():
        try:
            path = _codex_profile_path(home, profile_ref)
            if not path.exists():
                continue
            parsed = tomllib.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, tomllib.TOMLDecodeError):
            continue
        if (
            str(parsed.get("model_provider") or "").strip() == provider_ref
            and str(parsed.get("model") or "").strip() == model
        ):
            return True
    return False


def _write_codex_profile(home: Path, profile_ref: str, provider_ref: str, model: str) -> bool:
    try:
        path = _codex_profile_path(home, profile_ref)
        if path.exists():
            current = path.read_text(encoding="utf-8")
            try:
                parsed = tomllib.loads(current)
            except tomllib.TOMLDecodeError:
                return False
            if (
                str(parsed.get("model_provider") or "").strip() == provider_ref
                and str(parsed.get("model") or "").strip() == model
            ):
                _adopt_active_runtime_owner(path)
                return True
            if "# HERMES AI OFFICE MANAGED PROFILE" not in current:
                return False
        content = (
            "# HERMES AI OFFICE MANAGED PROFILE\n"
            f"model_provider = {_toml_string(provider_ref)}\n"
            f"model = {_toml_string(model)}\n"
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        _adopt_active_runtime_owner(path.parent)
        temporary = path.with_name(path.name + ".hermes-office.tmp")
        temporary.write_text(content, encoding="utf-8")
        os.chmod(temporary, 0o600)
        _adopt_active_runtime_owner(temporary)
        os.replace(temporary, path)
        _adopt_active_runtime_owner(path)
        return True
    except (OSError, ValueError):
        return False


def _ensure_codex_native_access(decision: dict[str, Any]) -> bool:
    access = _selected_access(decision)
    provider_ref = str(access.get("providerRef") or "").strip()
    profile_ref = str(decision.get("selectedProfile") or "").strip()
    model = str(decision.get("selectedModel") or "").strip()
    base_url = str(access.get("baseUrl") or "").strip()
    credential_ref = str(access.get("credentialRef") or "").strip()
    protocol = str(access.get("protocol") or "").strip()
    config = access.get("config") if isinstance(access.get("config"), dict) else {}
    wire_api = str(config.get("wireApi") or ("responses" if protocol == "openai-responses" else "chat"))
    if not provider_ref or not profile_ref or not model:
        return False
    if not base_url:
        existing = _existing_codex_provider(provider_ref)
        base_url = existing.get("baseUrl", "")
        credential_ref = credential_ref or existing.get("credentialRef", "")
        wire_api = existing.get("wireApi", "") or wire_api
        if not base_url:
            return False
        selected_access = decision.get("selectedAccess")
        if isinstance(selected_access, dict):
            if not selected_access.get("baseUrl"):
                selected_access["baseUrl"] = base_url
            if credential_ref and not selected_access.get("credentialRef"):
                selected_access["credentialRef"] = credential_ref
            if wire_api:
                if not isinstance(selected_access.get("config"), dict):
                    selected_access["config"] = {}
                if not selected_access["config"].get("wireApi"):
                    selected_access["config"]["wireApi"] = wire_api
    credential_ready = not credential_ref or _runtime_secret_file(credential_ref) is not None

    provider_lines = [
        f"[model_providers.{_toml_string(provider_ref)}]",
        f"name = {_toml_string('Hermes AI Office · ' + provider_ref)}",
        f"base_url = {_toml_string(base_url.rstrip('/'))}",
    ]
    if credential_ref:
        provider_lines.append(f"env_key = {_toml_string(credential_ref)}")
    provider_lines.append(f"wire_api = {_toml_string(wire_api)}")
    for home in _runtime_homes():
        path = home / ".codex" / "config.toml"
        try:
            current = path.read_text(encoding="utf-8") if path.exists() else ""
            without_managed_provider = _remove_managed_toml_block(
                current, "PROVIDER", provider_ref
            )
            without_managed_provider = _remove_managed_toml_block(
                without_managed_provider, "PROFILE", profile_ref
            )
            try:
                parsed = tomllib.loads(without_managed_provider) if without_managed_provider.strip() else {}
            except tomllib.TOMLDecodeError:
                return False
            providers = parsed.get("model_providers") if isinstance(parsed, dict) else None
            native_provider_exists = isinstance(providers, dict) and isinstance(
                providers.get(provider_ref), dict
            )
            if native_provider_exists:
                updated = without_managed_provider
            else:
                updated = _replace_managed_toml_block(
                    without_managed_provider,
                    "PROVIDER",
                    provider_ref,
                    "\n".join(provider_lines),
                )
            try:
                tomllib.loads(updated)
            except tomllib.TOMLDecodeError:
                return False
            path.parent.mkdir(parents=True, exist_ok=True)
            _adopt_active_runtime_owner(path.parent)
            temporary = path.with_name(path.name + ".hermes-office.tmp")
            temporary.write_text(updated, encoding="utf-8")
            os.chmod(temporary, 0o600)
            _adopt_active_runtime_owner(temporary)
            os.replace(temporary, path)
            _adopt_active_runtime_owner(path)
            if not _write_codex_profile(home, profile_ref, provider_ref, model):
                return False
        except OSError:
            return False
    return credential_ready


def _ensure_native_runtime_access(runtime: str, decision: dict[str, Any]) -> bool:
    access = _selected_access(decision)
    if str(access.get("adapterKind") or "") != "NATIVE_CONFIG":
        return True
    if runtime == "opencode":
        return _ensure_opencode_native_access(decision)
    if runtime == "codex":
        return _ensure_codex_native_access(decision)
    return True

def _ensure_opencode_gateway_model(model: str) -> bool:
    prefix = _LITELLM_RUNTIME_PROVIDER + "/"
    if not model.startswith(prefix):
        return True
    route = model[len(prefix) :].strip()
    if not route.startswith("employment:"):
        return False
    for home in _runtime_homes():
        path = home / ".config" / "opencode" / "opencode.json"
        try:
            current: dict[str, Any] = {}
            if path.exists():
                parsed = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(parsed, dict):
                    return False
                current = parsed
            providers = current.get("provider")
            if not isinstance(providers, dict):
                providers = {}
                current["provider"] = providers
            existing = providers.get(_LITELLM_RUNTIME_PROVIDER)
            provider = dict(existing) if isinstance(existing, dict) else {}
            options = provider.get("options")
            options = dict(options) if isinstance(options, dict) else {}
            options.update(
                {
                    "baseURL": _LITELLM_RUNTIME_BASE_URL,
                    "apiKey": "{file:%s}" % _LITELLM_RUNTIME_KEY_FILE,
                }
            )
            models = provider.get("models")
            models = dict(models) if isinstance(models, dict) else {}
            model_config = models.get(route)
            if not isinstance(model_config, dict):
                models[route] = {"name": route}
            provider.update(
                {
                    "npm": "@ai-sdk/openai-compatible",
                    "name": "Hermes AI Office",
                    "options": options,
                    "models": models,
                }
            )
            providers[_LITELLM_RUNTIME_PROVIDER] = provider
            _write_json_atomic(path, current)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return False
    return True


def _ensure_codex_gateway_profile() -> bool:
    managed = """# BEGIN HERMES AI OFFICE GATEWAY\n[model_providers.hermes-office]\nname = \"Hermes AI Office\"\nbase_url = \"http://127.0.0.1:4000/v1\"\nenv_key = \"HERMES_LITELLM_RUNTIME_KEY\"\nwire_api = \"responses\"\n# END HERMES AI OFFICE GATEWAY\n"""
    profile = """# HERMES AI OFFICE MANAGED PROFILE\nmodel_provider = \"hermes-office\"\n"""
    pattern = re.compile(
        r"(?ms)^# BEGIN HERMES AI OFFICE GATEWAY\n.*?^# END HERMES AI OFFICE GATEWAY\n?"
    )
    for home in _runtime_homes():
        path = home / ".codex" / "config.toml"
        try:
            current = path.read_text(encoding="utf-8") if path.exists() else ""
            if pattern.search(current):
                updated = pattern.sub(managed, current)
            else:
                updated = current.rstrip() + ("\n\n" if current.strip() else "") + managed
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(path.name + ".hermes-office.tmp")
            temporary.write_text(updated, encoding="utf-8")
            try:
                os.chmod(temporary, 0o600)
                _adopt_active_runtime_owner(temporary)
            except OSError:
                pass
            os.replace(temporary, path)
            _adopt_active_runtime_owner(path)
            profile_path = path.parent / "hermes-office.config.toml"
            profile_temporary = profile_path.with_name(
                profile_path.name + ".hermes-office.tmp"
            )
            profile_temporary.write_text(profile, encoding="utf-8")
            os.chmod(profile_temporary, 0o600)
            _adopt_active_runtime_owner(profile_temporary)
            os.replace(profile_temporary, profile_path)
            _adopt_active_runtime_owner(profile_path)
        except OSError:
            return False
    return True


def _ensure_selected_runtime(runtime: str, decision: dict[str, Any]) -> bool:
    access = _selected_access(decision)
    if str(access.get("adapterKind") or "") == "NATIVE_CONFIG":
        return _ensure_native_runtime_access(runtime, decision)
    model = str(decision.get("selectedModel") or "").strip()
    profile = str(decision.get("selectedProfile") or "").strip()
    if runtime == "opencode":
        return _ensure_opencode_gateway_model(model)
    if runtime == "codex" and profile == _LITELLM_RUNTIME_PROVIDER:
        return _ensure_codex_gateway_profile()
    return True


def _replace_model_flag(command: str, model: str) -> str:
    quoted = shlex.quote(model)
    pattern = re.compile(
        r"(?P<prefix>(?:^|\s)(?:-m|--model)(?:=|\s+))(?P<value>[^\s;&|]+)",
        re.IGNORECASE,
    )
    return pattern.sub(lambda match: match.group("prefix") + quoted, command, count=1)


def _prefix_runtime_executable(command: str, runtime: str, markers: str) -> str:
    if not markers or "HERMES_OFFICE_DECISION_ID=" in command:
        return command
    pattern = re.compile(
        rf"(?P<exe>(?:[^\s;&|]*/)?{re.escape(runtime)})\b",
        re.IGNORECASE,
    )
    return pattern.sub(lambda match: markers + " " + match.group("exe"), command, count=1)


def _inject_selection(command: str, runtime: str, decision: dict[str, Any]) -> str:
    model = str(decision.get("selectedModel") or "").strip()
    if not model:
        return command
    current = _model_from_command(command)
    if current:
        if current == model:
            rewritten = command
        else:
            rewritten = _replace_model_flag(command, model)
    elif runtime == "opencode":
        pattern = re.compile(r"(?P<exe>(?:[^\s;&|]*/)?opencode)\s+(?P<verb>run)\b", re.IGNORECASE)
        rewritten, count = pattern.subn(
            lambda m: f"{m.group('exe')} {m.group('verb')} --model {shlex.quote(model)}",
            command,
            count=1,
        )
        if count == 0:
            return command
    else:
        pattern = re.compile(r"(?P<exe>(?:[^\s;&|]*/)?codex)\b", re.IGNORECASE)
        profile = str(decision.get("selectedProfile") or "").strip()
        access = _selected_access(decision)
        if str(access.get("adapterKind") or "") == "NATIVE_CONFIG" and profile:
            options = f" --profile {shlex.quote(profile)}"
        else:
            options = f" --model {shlex.quote(model)}"
            if profile:
                options += f" --profile {shlex.quote(profile)}"
        rewritten, count = pattern.subn(lambda m: m.group("exe") + options, command, count=1)
        if count == 0:
            return command

    marker_values = {
        "HERMES_OFFICE_DECISION_ID": decision.get("id"),
        "HERMES_OFFICE_POSITION_ID": (decision.get("position") or {}).get("id"),
        "HERMES_OFFICE_EMPLOYEE_ID": (decision.get("employee") or {}).get("id"),
        "HERMES_OFFICE_EMPLOYMENT_ID": (decision.get("employment") or {}).get("id"),
    }
    markers = " ".join(
        f"{key}={shlex.quote(str(value))}" for key, value in marker_values.items() if value
    )
    if runtime == "codex":
        access = _selected_access(decision)
        if str(access.get("adapterKind") or "") == "NATIVE_CONFIG":
            credential_ref = str(access.get("credentialRef") or "").strip()
            if credential_ref:
                secret_file = _runtime_secret_file(credential_ref)
                if secret_file:
                    runtime_key = '%s="$(cat %s)"' % (
                        credential_ref,
                        shlex.quote(secret_file),
                    )
                    markers = (runtime_key + " " + markers).strip()
        elif str(decision.get("selectedProfile") or "") == _LITELLM_RUNTIME_PROVIDER:
            runtime_key = '%s="$(cat %s)"' % (
                _LITELLM_RUNTIME_KEY_ENV,
                shlex.quote(_LITELLM_RUNTIME_KEY_FILE),
            )
            markers = (runtime_key + " " + markers).strip()
    return _prefix_runtime_executable(rewritten, runtime, markers)


def _on_pre_tool_call(
    tool_name: str = "", args: dict[str, Any] | None = None, **kwargs: Any
) -> dict[str, Any] | None:
    if tool_name != "terminal":
        return None
    args = dict(args or {})
    command = str(args.get("command") or "")
    managed_runtime = _detect_managed_harness_runtime(command)
    runtime = managed_runtime or _detect_runtime(command)
    if not runtime:
        return None

    mode = _policy_mode()
    if managed_runtime:
        base = _base_event(kwargs)
        key = _correlation_key(tool_name, kwargs)
        pending = {
            **base,
            "correlationId": key,
            "runtime": managed_runtime,
            "cwd": str(args.get("workdir") or args.get("cwd") or ""),
            "model": str(_model_from_command(command) or ""),
            "command": _command_summary(command, managed_runtime),
            "background": bool(args.get("background")),
            "pty": bool(args.get("pty")),
            "policyMode": mode,
            "policyStatus": "PRE_RESOLVED_CAPABILITY_PLANE",
            "runtimeLaunchDecisionId": "",
            "positionId": "",
            "employeeId": "",
            "employmentId": "",
            "providerHubConnectionId": "",
        }
        with _PENDING_LOCK:
            _PENDING[key] = pending
        _enqueue({"event": "runtime_spawn_requested", **pending})
        return None

    decision = _resolve_runtime_policy(runtime, command, args, kwargs)
    base = _base_event(kwargs)
    key = _correlation_key(tool_name, kwargs)
    selected = decision or {}
    pending = {
        **base,
        "correlationId": key,
        "runtime": runtime,
        "cwd": str(args.get("workdir") or args.get("cwd") or ""),
        "model": str(selected.get("selectedModel") or _model_from_command(command) or ""),
        "command": _command_summary(command, runtime),
        "background": bool(args.get("background")),
        "pty": bool(args.get("pty")),
        "policyMode": mode,
        "policyStatus": str(selected.get("status") or "UNAVAILABLE"),
        "runtimeLaunchDecisionId": str(selected.get("id") or ""),
        "positionId": str((selected.get("position") or {}).get("id") or ""),
        "employeeId": str((selected.get("employee") or {}).get("id") or ""),
        "employmentId": str((selected.get("employment") or {}).get("id") or ""),
        "providerHubConnectionId": str((_selected_access(selected).get("config") or {}).get("providerHubConnectionId") or ""),
    }
    with _PENDING_LOCK:
        _PENDING[key] = pending
    _enqueue({"event": "runtime_spawn_requested", **pending})

    if decision is None:
        if mode == "ENFORCE":
            return {
                "action": "block",
                "message": "Hermes AI Office could not reach the runtime staffing policy service.",
            }
        return None
    if decision.get("status") == "BLOCKED":
        return {
            "action": "block",
            "message": "Hermes AI Office found no eligible employee for %s (%s)."
            % (runtime, ", ".join(map(str, decision.get("reasons") or []))),
        }
    if decision.get("status") != "SELECTED" or mode == "OBSERVE":
        return None
    if not _ensure_selected_runtime(runtime, decision):
        selected_access = _selected_access(decision)
        if mode == "ENFORCE" or selected_access.get("id"):
            return {
                "action": "block",
                "message": "Hermes AI Office selected an employee, but that employee's runtime access is not ready.",
            }
        return None
    rewritten = _inject_selection(command, runtime, decision)
    if rewritten == command:
        return None
    modified = dict(args)
    modified["command"] = rewritten
    return {"action": "modify", "args": modified}


def _parse_tool_result(result: Any) -> dict[str, Any]:
    if isinstance(result, dict):
        return result
    if not isinstance(result, str) or not result:
        return {}
    try:
        parsed = json.loads(result)
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, json.JSONDecodeError):
        return {}


def _terminal_outcome(status: str, parsed: dict[str, Any]) -> dict[str, Any]:
    status = status.lower().strip()
    text = " ".join(str(parsed.get(k) or "") for k in ("error", "message", "stderr")).strip()
    lower = text.lower()
    exit_code = parsed.get("exit_code", parsed.get("exitCode"))
    try:
        nonzero_exit = exit_code is not None and int(exit_code) != 0
    except (TypeError, ValueError):
        nonzero_exit = False
    outcome, error_kind = "SUCCESS", None
    if status not in {"", "ok", "success", "completed", "complete"} or lower or nonzero_exit:
        outcome, error_kind = "FAILURE", "UNKNOWN"
        if "429" in lower or "rate limit" in lower or "too many requests" in lower:
            outcome, error_kind = "THROTTLED", "RATE_LIMIT"
        elif re.search(r"\b(?:401|403)\b", lower) or "invalid key" in lower or "unauthorized" in lower or "authentication" in lower:
            error_kind = "AUTH"
        elif "quota" in lower or "insufficient balance" in lower or "insufficient funds" in lower:
            error_kind = "QUOTA"
        elif "timeout" in lower or "timed out" in lower:
            error_kind = "TIMEOUT"
        elif "network" in lower or "connection" in lower or "connection refused" in lower:
            error_kind = "NETWORK"
        elif re.search(r"\b5\d\d\b", lower) or "server error" in lower:
            error_kind = "SERVER"
    match = re.search(r"\b([45]\d\d)\b", lower)
    safe = re.sub(r"\s+", " ", text).strip()
    safe = re.sub(r"(?i)sk-[A-Za-z0-9_-]+", "[redacted]", safe)
    safe = re.sub(r"(?i)Bearer\s+\S+", "Bearer [redacted]", safe)
    safe = re.sub(r"(?i)\b[A-Z0-9_]*_API_KEY\s*=\s*\S+", "API_KEY=[redacted]", safe)
    safe = re.sub(r"(?i)\b(token|password)\s*[:=]\s*\S+", r"\1=[redacted]", safe)
    safe = safe[:160]
    result: dict[str, Any] = {"outcome": outcome}
    if error_kind:
        result["errorKind"] = error_kind
    if error_kind == "QUOTA":
        reset_after_seconds = _quota_reset_after_seconds(safe)
        if reset_after_seconds is not None:
            result["resetAfterSeconds"] = reset_after_seconds
    if match:
        result["httpStatus"] = int(match.group(1))
    if safe and error_kind:
        result["message"] = safe
    return result


def _provider_item_value(item: dict[str, Any], camel: str, snake: str) -> Any:
    value = item.get(camel)
    return value if value is not None else item.get(snake)


def _normalized_provider_name(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(value or "").strip().lower()).strip("-")


def _normalized_endpoint(value: Any) -> str:
    raw = str(value or "").strip().rstrip("/")
    if not raw:
        return ""
    try:
        parsed = urllib.parse.urlparse(raw)
    except ValueError:
        return raw.lower()
    if not parsed.scheme or not parsed.netloc:
        return raw.lower()
    scheme = parsed.scheme.lower()
    hostname = (parsed.hostname or "").lower()
    port = parsed.port
    default_port = (scheme == "https" and port == 443) or (scheme == "http" and port == 80)
    authority = hostname if port is None or default_port else f"{hostname}:{port}"
    path = (parsed.path or "").rstrip("/")
    return f"{scheme}://{authority}{path}"


def _active_profile_name() -> str:
    if _CTX is None:
        return "default"
    try:
        return str(getattr(_CTX, "profile_name", "") or "default")[:120]
    except Exception:
        return "default"


def _resolve_provider_connection_id(provider: Any, base_url: Any) -> str:
    provider_name = _normalized_provider_name(provider)
    endpoint = _normalized_endpoint(base_url)
    if not provider_name and not endpoint:
        return ""
    cache_key = (provider_name, endpoint)
    now = time.monotonic()
    with _API_TELEMETRY_LOCK:
        cached = _PROVIDER_CONNECTION_CACHE.get(cache_key)
        if cached and now - cached[0] < _PROVIDER_CACHE_TTL_SECONDS:
            return cached[1]

    connection_id = ""
    try:
        hub = _control_plane_request("/api/v2/projections/provider-hub-summary", timeout=1.5)
        items = [item for item in (hub.get("items") or []) if isinstance(item, dict)]
        provider_matches = [
            item
            for item in items
            if provider_name
            and _normalized_provider_name(
                _provider_item_value(item, "providerKey", "provider_key")
            )
            == provider_name
        ]
        candidates = provider_matches
        if len(candidates) != 1 and endpoint:
            narrowed = [
                item
                for item in candidates
                if _normalized_endpoint(_provider_item_value(item, "baseUrl", "base_url"))
                == endpoint
            ]
            if len(narrowed) == 1:
                candidates = narrowed
        if not candidates and endpoint:
            endpoint_matches = [
                item
                for item in items
                if _normalized_endpoint(_provider_item_value(item, "baseUrl", "base_url"))
                == endpoint
            ]
            if len(endpoint_matches) == 1:
                candidates = endpoint_matches
        if len(candidates) == 1:
            connection_id = str(
                candidates[0].get("id")
                or candidates[0].get("connectionId")
                or candidates[0].get("connection_id")
                or ""
            ).strip()
    except Exception:
        connection_id = ""

    with _API_TELEMETRY_LOCK:
        _PROVIDER_CONNECTION_CACHE[cache_key] = (now, connection_id)
    return connection_id


def _safe_provider_error_text(*values: Any) -> str:
    text = " ".join(str(value or "") for value in values if value).strip()
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"(?i)sk-[A-Za-z0-9_-]+", "[redacted]", text)
    text = re.sub(r"(?i)Bearer\s+\S+", "Bearer [redacted]", text)
    text = re.sub(
        r"(?i)\b[A-Z0-9_]*_API_KEY\s*[:=]\s*\S+", "API_KEY=[redacted]", text
    )
    text = re.sub(
        r"(?i)\b(token|password|secret)\s*[:=]\s*\S+", r"\1=[redacted]", text
    )
    return text[:160]


def _quota_reset_after_seconds(value: Any) -> int | None:
    text = str(value or "").strip().lower()
    if not text:
        return None
    match = re.search(
        r"\bresets?\s+in\s+(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?|days?)\b",
        text,
    )
    if not match:
        return None
    amount = float(match.group(1))
    unit = match.group(2)
    multiplier = 1
    if unit.startswith("minute"):
        multiplier = 60
    elif unit.startswith("hour"):
        multiplier = 60 * 60
    elif unit.startswith("day"):
        multiplier = 24 * 60 * 60
    seconds = int(amount * multiplier)
    return max(1, seconds)


def _record_capacity_exhaustion_for_connection(
    connection_id: str,
    classification: dict[str, Any],
    kwargs: dict[str, Any],
) -> None:
    if str(classification.get("errorKind") or "").upper() != "QUOTA":
        return
    try:
        hub = _control_plane_request("/api/v2/projections/provider-hub", timeout=1.5)
        connection = next(
            (
                item
                for item in (hub.get("items") or [])
                if isinstance(item, dict) and str(item.get("id") or "") == connection_id
            ),
            None,
        )
        if not connection:
            return
        supplier = connection.get("supplier") if isinstance(connection.get("supplier"), dict) else {}
        supplier_id = str(
            connection.get("supplier_id") or supplier.get("id") or ""
        ).strip()
        if not supplier_id:
            return
        supply = _control_plane_request("/api/v2/projections/supply", timeout=1.5)
        supplier_row = next(
            (
                item
                for item in (supply.get("suppliers") or [])
                if isinstance(item, dict) and str(item.get("id") or "") == supplier_id
            ),
            None,
        )
        if not supplier_row:
            return
        reset_after = classification.get("resetAfterSeconds")
        try:
            reset_after_seconds = int(reset_after) if reset_after is not None else None
        except (TypeError, ValueError):
            reset_after_seconds = None
        reset_at = (
            int(time.time() * 1000) + max(1, reset_after_seconds) * 1000
            if reset_after_seconds is not None
            else None
        )
        provider = str(kwargs.get("provider") or connection.get("provider_key") or "")[:120]
        model = str(kwargs.get("model") or "")[:240]
        for agreement in supplier_row.get("agreements") or []:
            if not isinstance(agreement, dict):
                continue
            if str(agreement.get("lifecycle") or "").upper() != "ACTIVE":
                continue
            agreement_id = str(agreement.get("id") or "").strip()
            if not agreement_id:
                continue
            payload: dict[str, Any] = {
                "supplyAgreementId": agreement_id,
                "name": "Observed quota availability",
                "dimension": "CUSTOM",
                "remaining": 0,
                "unit": "quota",
                "source": "HERMES_LLM_API_QUOTA",
                "metadata": {
                    "provider": provider,
                    "model": model,
                    "providerConnectionId": connection_id,
                    "evidence": "QUOTA_ERROR",
                },
            }
            if reset_at is not None:
                payload["resetAt"] = reset_at
                payload["resetPolicy"] = {
                    "kind": "OBSERVED_RESET_AFTER",
                    "seconds": reset_after_seconds,
                }
            seed = json.dumps(payload, sort_keys=True, ensure_ascii=False)
            _control_plane_request(
                "/api/v2/commands/capacity-pools/upsert",
                method="POST",
                payload=payload,
                idempotency_key="provider-quota-capacity-v1-"
                + hashlib.blake2b(seed.encode("utf-8"), digest_size=10).hexdigest(),
                timeout=1.5,
            )
    except Exception:
        return


def _api_error_outcome(**kwargs: Any) -> dict[str, Any] | None:
    raw_status = kwargs.get("status_code")
    try:
        status = int(raw_status) if raw_status is not None else None
    except (TypeError, ValueError):
        status = None

    error = kwargs.get("error")
    error_type = kwargs.get("error_type")
    error_message = kwargs.get("error_message")
    if isinstance(error, dict):
        error_type = error_type or error.get("type")
        error_message = error_message or error.get("message")

    reason = str(kwargs.get("reason") or "").strip().lower()
    non_operational_reasons = {
        "context_overflow",
        "payload_too_large",
        "image_too_large",
        "model_not_found",
        "provider_policy_blocked",
        "content_policy_blocked",
        "format_error",
        "invalid_encrypted_content",
        "multimodal_tool_content_unsupported",
        "thinking_signature",
        "long_context_tier",
        "oauth_long_context_beta_forbidden",
        "llama_cpp_grammar_pattern",
    }
    if reason in non_operational_reasons:
        return None

    safe = _safe_provider_error_text(
        error_message,
        error_type,
        kwargs.get("error_code"),
    )
    lower = safe.lower()
    outcome = "FAILURE"
    kind = "UNKNOWN"
    reason_kinds = {
        "auth": "AUTH",
        "auth_permanent": "AUTH",
        "billing": "QUOTA",
        "rate_limit": "RATE_LIMIT",
        "upstream_rate_limit": "RATE_LIMIT",
        "overloaded": "SERVER",
        "server_error": "SERVER",
        "timeout": "TIMEOUT",
        "ssl_cert_verification": "NETWORK",
    }
    reason_kind = reason_kinds.get(reason)
    if reason_kind == "RATE_LIMIT":
        outcome, kind = "THROTTLED", "RATE_LIMIT"
    elif reason_kind:
        kind = reason_kind
    elif status == 429 or "rate limit" in lower or "too many requests" in lower:
        outcome, kind = "THROTTLED", "RATE_LIMIT"
    elif status in {401, 403} or any(
        marker in lower
        for marker in ("unauthorized", "authentication", "invalid key", "invalid api key")
    ):
        kind = "AUTH"
    elif any(
        marker in lower
        for marker in ("quota", "insufficient balance", "insufficient funds", "credits exhausted")
    ):
        kind = "QUOTA"
    elif any(marker in lower for marker in ("timeout", "timed out", "deadline exceeded")):
        kind = "TIMEOUT"
    elif any(
        marker in lower
        for marker in ("network", "connection refused", "connection reset", "dns", "name resolution")
    ):
        kind = "NETWORK"
    elif status is not None and 500 <= status <= 599:
        kind = "SERVER"
    elif status is not None and 400 <= status <= 499:
        return None

    result: dict[str, Any] = {"outcome": outcome, "errorKind": kind}
    if kind == "QUOTA":
        reset_after_seconds = _quota_reset_after_seconds(safe)
        if reset_after_seconds is not None:
            result["resetAfterSeconds"] = reset_after_seconds
    if status is not None and 400 <= status <= 599:
        result["httpStatus"] = status
    if safe:
        result["message"] = safe
    return result


def _api_attempt_idempotency_key(kind: str, connection_id: str, kwargs: dict[str, Any]) -> str:
    request_id = str(kwargs.get("api_request_id") or "").strip()
    if request_id:
        seed = request_id
        if kind == "error":
            seed += ":retry:" + str(kwargs.get("retry_count") or 0)
    else:
        seed = "|".join(
            str(kwargs.get(key) or "")
            for key in (
                "session_id",
                "task_id",
                "turn_id",
                "api_call_count",
                "provider",
                "model",
            )
        )
    digest = hashlib.blake2b(seed.encode("utf-8"), digest_size=12).hexdigest()
    return f"provider-api-{kind}-{connection_id}-{digest}"[:200]


def _record_api_provider_attempt(
    classification: dict[str, Any], *, event_kind: str, kwargs: dict[str, Any]
) -> None:
    connection_id = _resolve_provider_connection_id(
        kwargs.get("provider"), kwargs.get("base_url")
    )
    if not connection_id:
        return

    if classification.get("outcome") == "SUCCESS":
        now = time.monotonic()
        with _API_TELEMETRY_LOCK:
            last = _API_SUCCESS_LAST_RECORDED.get(connection_id)
            if last is not None and now - last < _SUCCESS_EVIDENCE_MIN_INTERVAL_SECONDS:
                return
            _API_SUCCESS_LAST_RECORDED[connection_id] = now

    payload = dict(classification)
    payload["source"] = "HERMES_LLM_API"
    payload["metadata"] = {
        "provider": str(kwargs.get("provider") or "")[:120],
        "model": str(kwargs.get("model") or "")[:240],
        "profile": _active_profile_name(),
        "apiMode": str(kwargs.get("api_mode") or "")[:80],
    }
    try:
        _control_plane_request(
            f"/api/v2/commands/provider-connections/{urllib.parse.quote(connection_id, safe='')}/attempts",
            method="POST",
            payload=payload,
            idempotency_key=_api_attempt_idempotency_key(event_kind, connection_id, kwargs),
            timeout=1.5,
        )
        if classification.get("errorKind") == "QUOTA":
            _record_capacity_exhaustion_for_connection(connection_id, classification, kwargs)
    except Exception:
        if classification.get("outcome") == "SUCCESS":
            with _API_TELEMETRY_LOCK:
                _API_SUCCESS_LAST_RECORDED.pop(connection_id, None)


def _on_post_api_request(**kwargs: Any) -> None:
    _record_api_provider_attempt(
        {"outcome": "SUCCESS"}, event_kind="success", kwargs=kwargs
    )


def _on_api_request_error(**kwargs: Any) -> None:
    classification = _api_error_outcome(**kwargs)
    if classification is None:
        return
    _record_api_provider_attempt(classification, event_kind="error", kwargs=kwargs)


def _needs_ai_office_authority(user_message: Any) -> bool:
    text = str(user_message or "").strip()
    if not text:
        return False
    if _AI_OFFICE_NAME_RE.search(text):
        return True
    return bool(_PROVIDER_TOPIC_RE.search(text) and _PROVIDER_STATUS_RE.search(text))


def _on_pre_llm_call(user_message: Any = "", **_: Any) -> dict[str, str] | None:
    """Inject AI Office authority and placement guidance into relevant turns."""
    text = str(user_message or "").strip()
    provider_authority = _needs_ai_office_authority(text)
    execution_placement = bool(text and _EXECUTION_TOPIC_RE.search(text))
    if not provider_authority and not execution_placement:
        return None

    sections: list[str] = []
    if execution_placement:
        sections.append(
            "When this task may use an external coding Agent/harness, do not choose the model, provider, or harness from memory. "
            "Call ai_office_resolve_execution before launching Claude Code, Codex, DSH, OpenCode, or another coding Agent; when working in a repository, pass its current project_path so Agent Harness can materialize project MCP, Skills, and Instructions. "
            "Use PLAN/REVIEW for high-end planning or review and IMPLEMENT/DEBUG/TEST/QUICK_FIX for implementation work. "
            "Intent selects the work class only; never infer a fixed mapping such as IMPLEMENT=DSH or REVIEW=CODEX. "
            "The returned model family determines the preferred harness, while current runtime/provider compatibility determines the selected harness. "
            "Treat every selection as per-execution and do not store a selected model or harness as a permanent Job Type mapping or memory rule. "
            "Follow the returned Employee, provider connection, preferred official harness, selected harness, capabilityPlaneStatus, profileAction, commandTemplate, and guidance. Never bypass PROJECT_REQUIRED or BLOCKED capabilityPlaneStatus with a direct Harness launch. "
            "Interpret officialHarnessAvailable as legacy per-route usability, not as proof that the runtime binary or auth is missing. Use officialHarnessRuntimeAvailable to judge whether the official runtime is installed and officialHarnessUsableForSelectedRoute to judge whether the selected provider route can use it. "
            "If the official harness is not usable for the selected route, use only the fallback returned by AI Office."
        )

    if not provider_authority:
        return {"context": "\n\n".join(sections)}

    header = (
        "Hermes AI Office is an internal control-plane/dashboard capability, "
        "not an upstream model provider. Do not search the filesystem or the "
        "Hermes built-in provider catalog to decide whether AI Office exists. "
        "For current provider/model/supplier availability, use the native "
        "ai_office_list_providers tool first (use tool_search for 'ai_office' "
        "if the tool is deferred). Memory and local config are fallback "
        "troubleshooting evidence only."
    )
    sections.append(header)
    try:
        hub = _control_plane_request("/api/v2/projections/provider-hub-summary", timeout=2.0)
        summary = hub.get("summary") if isinstance(hub.get("summary"), dict) else {}
        items = hub.get("items") if isinstance(hub.get("items"), list) else []
        facts: list[str] = []
        for raw in items[:20]:
            if not isinstance(raw, dict):
                continue
            name = str(raw.get("displayName") or raw.get("providerKey") or "provider").strip()
            state = str(raw.get("effectiveState") or raw.get("health") or "UNKNOWN").strip()
            if raw.get("routable") is True:
                routable = "yes"
            elif raw.get("routable") is False:
                routable = "no"
            else:
                routable = "unknown"
            facts.append(f"- {name}: {state}; routable={routable}")
        counts = (
            f"connections={summary.get('connections', '?')}, "
            f"available={summary.get('available', '?')}, "
            f"congested={summary.get('congested', '?')}, "
            f"unavailable={summary.get('unavailable', '?')}, "
            f"disabled={summary.get('disabled', '?')}"
        )
        snapshot = "AI Office Provider Hub turn snapshot: " + counts
        if facts:
            snapshot += "\n" + "\n".join(facts)
        sections.append(snapshot)
        return {"context": "\n\n".join(sections)}
    except Exception:
        sections.append(
            "AI Office Provider Hub is currently unreachable. State that explicitly before any stale/local fallback."
        )
        return {"context": "\n\n".join(sections)}


def _on_post_tool_call(
    tool_name: str = "",
    args: dict[str, Any] | None = None,
    result: Any = None,
    **kwargs: Any,
) -> None:
    if tool_name != "terminal":
        return
    key = _correlation_key(tool_name, kwargs)
    with _PENDING_LOCK:
        pending = _PENDING.pop(key, None)
    if pending is None:
        command = str((args or {}).get("command") or "")
        runtime = _detect_runtime(command)
        if not runtime:
            return
        pending = {
            **_base_event(kwargs),
            "correlationId": key,
            "runtime": runtime,
            "cwd": str((args or {}).get("workdir") or (args or {}).get("cwd") or ""),
            "model": _model_from_command(command) or "",
            "command": _command_summary(command, runtime),
            "background": bool((args or {}).get("background")),
            "pty": bool((args or {}).get("pty")),
        }
    parsed = _parse_tool_result(result)
    pid = parsed.get("pid")
    try:
        process_id = int(pid) if pid is not None else None
    except (TypeError, ValueError):
        process_id = None
    _enqueue(
        {
            "event": "runtime_spawn_result",
            **pending,
            "processId": process_id,
            "processSessionId": str(parsed.get("session_id") or ""),
            "resultStatus": str(kwargs.get("status") or parsed.get("status") or ""),
            "success": str(kwargs.get("status") or "ok") == "ok",
        }
    )
    background = bool(pending.get("background"))
    pty = bool(pending.get("pty"))
    status = str(kwargs.get("status") or parsed.get("status") or "").lower()
    classification = _terminal_outcome(status, parsed)
    should_record = classification["outcome"] == "SUCCESS" and not background and not pty
    should_record = should_record or (
        classification["outcome"] in {"FAILURE", "THROTTLED"}
        and bool(classification.get("message"))
    )
    if should_record:
        if pending.get("providerHubConnectionId"):
            try:
                _control_plane_request(
                    f"/api/v2/commands/provider-connections/{urllib.parse.quote(str(pending.get('providerHubConnectionId')), safe='')}/attempts",
                    method="POST",
                    payload=classification,
                )
            except Exception:
                pass


def register(ctx: Any) -> None:
    global _CTX
    _CTX = ctx
    _ensure_worker()
    ctx.register_tool(
        name="ai_office_add_provider",
        toolset="ai_office",
        schema=_ADD_PROVIDER_SCHEMA,
        handler=_add_shared_provider_tool,
        description=_ADD_PROVIDER_SCHEMA["description"],
        emoji="🔌",
    )
    ctx.register_tool(
        name="ai_office_set_provider_state",
        toolset="ai_office",
        schema=_SET_PROVIDER_STATE_SCHEMA,
        handler=_set_provider_state_tool,
        description=_SET_PROVIDER_STATE_SCHEMA["description"],
        emoji="🔧",
    )
    ctx.register_tool(
        name="ai_office_list_providers",
        toolset="ai_office",
        schema=_LIST_PROVIDERS_SCHEMA,
        handler=_list_shared_providers_tool,
        description=_LIST_PROVIDERS_SCHEMA["description"],
        emoji="📡",
    )
    ctx.register_tool(
        name="ai_office_resolve_execution",
        toolset="ai_office",
        schema=_RESOLVE_EXECUTION_SCHEMA,
        handler=_resolve_execution_tool,
        description=_RESOLVE_EXECUTION_SCHEMA["description"],
        emoji="🧭",
    )
    ctx.register_hook("subagent_start", _on_subagent_start)
    ctx.register_hook("subagent_stop", _on_subagent_stop)
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("post_api_request", _on_post_api_request)
    ctx.register_hook("api_request_error", _on_api_request_error)
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
