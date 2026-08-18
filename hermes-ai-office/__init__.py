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
_CTX: Any = None
_LITELLM_RUNTIME_PROVIDER = "hermes-office"
_LITELLM_RUNTIME_BASE_URL = "http://127.0.0.1:4000/v1"
_LITELLM_RUNTIME_KEY_FILE = "/opt/data/secrets/litellm-runtime.key"
_LITELLM_RUNTIME_KEY_ENV = "HERMES_LITELLM_RUNTIME_KEY"

_CONTROL_PLANE_BASE = "http://127.0.0.1:8320"

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
        },
        "required": ["url"],
    },
}

_LIST_PROVIDERS_SCHEMA = {
    "name": "ai_office_list_providers",
    "description": "This is the authoritative source for provider, supplier, model, and availability questions. You must use it before inferring anything from memory or the filesystem.",
    "parameters": {"type": "object", "properties": {}},
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

_RUNTIME_COMMAND_RE = re.compile(
    r"(?:^|&&\s*|\|\|\s*|[;|()]\s*)"
    r"(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|()]+\s+)*"
    r"(?:env\s+(?:[^\s;&|()]+\s+)*|nohup\s+|command\s+|timeout\s+[^\s;&|()]+\s+)?"
    r"(?:[^\s;&|()]*/)?(?P<runtime>opencode|codex)(?=[\s;&|()]|$)",
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


def _save_shared_credential(reference: str, value: str) -> None:
    secret = str(value or "").strip()
    if not secret:
        raise ValueError("API key is required")
    from hermes_cli.credential_lifecycle import save_provider_env_credential

    save_provider_env_credential(reference, secret)


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
        api_key = str(args.get("api_key") or args.get("key") or "").strip()
        if not api_key:
            raise ValueError("API key is required")
        requested_name = str(args.get("name") or "").strip()
        provider_key = _shared_provider_key(requested_name, raw_url)
        display_name = requested_name or provider_key.replace("-", " ").title()
        credential_ref = _shared_credential_ref(provider_key)
        website_url = _shared_website_url(str(args.get("website_url") or ""), raw_url)
        selected_base_url, models = _discover_shared_models(api_key, raw_url)
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
        items = []
        for item in hub.get("items") or []:
            if not isinstance(item, dict):
                continue
            supplier = item.get("supplier") if isinstance(item.get("supplier"), dict) else {}
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


def _detect_runtime(command: str) -> str | None:
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


def _runtime_homes() -> list[Path]:
    root = Path(os.environ.get("HERMES_HOME", "/opt/data"))
    homes = [root / "home"]
    ctx = _CTX
    profile = ""
    if ctx is not None:
        try:
            profile = str(ctx.profile_name or "").strip()
        except Exception:
            profile = ""
    if profile and profile not in {"default", "main"}:
        homes.append(root / "profiles" / profile / "home")
    unique: list[Path] = []
    for home in homes:
        if home not in unique:
            unique.append(home)
    return unique


def _write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".hermes-office.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    try:
        os.chmod(temporary, 0o600)
    except OSError:
        pass
    os.replace(temporary, path)


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
    return str(os.environ.get(name) or "").strip()


def _runtime_secret_file(reference: str) -> str | None:
    value = _credential_value(reference)
    if not value:
        return None
    root = Path(os.environ.get("HERMES_HOME", "/opt/data")) / "secrets" / "hermes-ai-office"
    digest = hashlib.blake2b(reference.encode("utf-8"), digest_size=8).hexdigest()
    path = root / f"credential-{digest}.key"
    try:
        root.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text(value, encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        os.chmod(path, 0o600)
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
    profile_lines = [
        f"[profiles.{_toml_string(profile_ref)}]",
        f"model_provider = {_toml_string(provider_ref)}",
        f"model = {_toml_string(model)}",
    ]

    for home in _runtime_homes():
        path = home / ".codex" / "config.toml"
        try:
            current = path.read_text(encoding="utf-8") if path.exists() else ""
            without_managed_provider = _remove_managed_toml_block(
                current, "PROVIDER", provider_ref
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
            updated = _replace_managed_toml_block(
                updated, "PROFILE", profile_ref, "\n".join(profile_lines)
            )
            try:
                tomllib.loads(updated)
            except tomllib.TOMLDecodeError:
                return False
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(path.name + ".hermes-office.tmp")
            temporary.write_text(updated, encoding="utf-8")
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)
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
    managed = """# BEGIN HERMES AI OFFICE GATEWAY\n[model_providers.hermes-office]\nname = \"Hermes AI Office\"\nbase_url = \"http://127.0.0.1:4000/v1\"\nenv_key = \"HERMES_LITELLM_RUNTIME_KEY\"\nwire_api = \"responses\"\n\n[profiles.hermes-office]\nmodel_provider = \"hermes-office\"\n# END HERMES AI OFFICE GATEWAY\n"""
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
            except OSError:
                pass
            os.replace(temporary, path)
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
    runtime = _detect_runtime(command)
    if not runtime:
        return None

    decision = _resolve_runtime_policy(runtime, command, args, kwargs)
    mode = _policy_mode()
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
    if match:
        result["httpStatus"] = int(match.group(1))
    if safe and error_kind:
        result["message"] = safe
    return result


def _needs_ai_office_authority(user_message: Any) -> bool:
    text = str(user_message or "").strip()
    if not text:
        return False
    if _AI_OFFICE_NAME_RE.search(text):
        return True
    return bool(_PROVIDER_TOPIC_RE.search(text) and _PROVIDER_STATUS_RE.search(text))


def _on_pre_llm_call(user_message: Any = "", **_: Any) -> dict[str, str] | None:
    """Inject current AI Office authority into relevant turns.

    This hook is turn-scoped so long-lived profile sessions created before the
    plugin was installed still receive the current authority contract.
    """
    if not _needs_ai_office_authority(user_message):
        return None

    header = (
        "Hermes AI Office is an internal control-plane/dashboard capability, "
        "not an upstream model provider. Do not search the filesystem or the "
        "Hermes built-in provider catalog to decide whether AI Office exists. "
        "For current provider/model/supplier availability, use the native "
        "ai_office_list_providers tool first (use tool_search for 'ai_office' "
        "if the tool is deferred). Memory and local config are fallback "
        "troubleshooting evidence only."
    )
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
        return {"context": header + "\n\n" + snapshot}
    except Exception:
        return {
            "context": header
            + "\n\nAI Office Provider Hub is currently unreachable. State that explicitly before any stale/local fallback."
        }


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
    ctx.register_hook("subagent_start", _on_subagent_start)
    ctx.register_hook("subagent_stop", _on_subagent_stop)
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
