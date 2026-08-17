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

import json
import os
from pathlib import Path
import queue
import re
import shlex
import threading
import time
import urllib.error
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

_RUNTIME_COMMAND_RE = re.compile(
    r"(?:^|&&\s*|\|\|\s*|[;|()]\s*)"
    r"(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|()]+\s+)*"
    r"(?:env\s+(?:[^\s;&|()]+\s+)*|nohup\s+|command\s+|timeout\s+[^\s;&|()]+\s+)?"
    r"(?:[^\s;&|()]*/)?(?P<runtime>opencode|codex)(?=[\s;&|()]|$)",
    re.IGNORECASE,
)
_MODEL_RE = re.compile(r"(?:^|\s)(?:-m|--model)(?:=|\s+)([^\s;&|]+)", re.IGNORECASE)
_VERB_RE = re.compile(r"(?:^|[\s/])(opencode|codex)\s+([a-z][a-z0-9_-]*)", re.IGNORECASE)


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


def _ensure_gateway_runtime(runtime: str, decision: dict[str, Any]) -> bool:
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
    if runtime == "codex" and str(decision.get("selectedProfile") or "") == _LITELLM_RUNTIME_PROVIDER:
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
    if not _ensure_gateway_runtime(runtime, decision):
        if mode == "ENFORCE":
            return {
                "action": "block",
                "message": "Hermes AI Office could not configure the selected gateway runtime.",
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


def register(ctx: Any) -> None:
    global _CTX
    _CTX = ctx
    _ensure_worker()
    ctx.register_hook("subagent_start", _on_subagent_start)
    ctx.register_hook("subagent_stop", _on_subagent_stop)
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
