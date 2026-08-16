"""Hermes AI Office observer plugin.

Emits a deliberately small, sanitized telemetry stream to hermes-office-bridge.
The plugin never sends raw tool results or raw Codex/OpenCode prompts. Hooks are
fail-open and delivery happens on a daemon thread so the user's Hermes session
never waits on the dashboard.
"""

from __future__ import annotations

import json
import os
import queue
import re
import threading
import time
import urllib.request
from typing import Any

_SCHEMA = "hermes.office.observer.v1"
_ENDPOINT = os.environ.get(
    "HERMES_OFFICE_OBSERVER_URL", "http://127.0.0.1:8787/api/observer"
)
_QUEUE: "queue.Queue[dict[str, Any]]" = queue.Queue(maxsize=1024)
_WORKER_STARTED = False
_WORKER_LOCK = threading.Lock()
_PENDING: dict[str, dict[str, Any]] = {}
_PENDING_LOCK = threading.Lock()

_RUNTIME_RE = re.compile(r"(?:^|[\s/])(opencode|codex)(?=[\s]|$)", re.IGNORECASE)
_MODEL_RE = re.compile(r"(?:^|\s)(?:-m|--model)(?:=|\s+)([^\s]+)", re.IGNORECASE)
_VERB_RE = re.compile(r"(?:^|[\s/])(?:opencode|codex)\s+([a-z][a-z0-9_-]*)", re.IGNORECASE)


def _session_id(kwargs: dict[str, Any]) -> str:
    return str(kwargs.get("session_id") or kwargs.get("task_id") or "")


def _correlation_key(tool_name: str, kwargs: dict[str, Any]) -> str:
    call_id = str(kwargs.get("tool_call_id") or "")
    if call_id:
        return call_id
    # Plugin hooks are normally invoked pre/post on the same agent thread. This
    # fallback keeps concurrent tool calls separate when the provider omitted a
    # tool_call_id.
    return "%s:%s:%s:%s" % (
        _session_id(kwargs),
        str(kwargs.get("task_id") or ""),
        tool_name,
        threading.get_ident(),
    )


def _detect_runtime(command: str) -> str | None:
    match = _RUNTIME_RE.search(command or "")
    return match.group(1).lower() if match else None


def _model_from_command(command: str) -> str | None:
    match = _MODEL_RE.search(command or "")
    if not match:
        return None
    return match.group(1).strip("'\"")[:120] or None


def _command_summary(command: str, runtime: str) -> str:
    """Return a dashboard-safe command label without persisting the prompt."""
    verb_match = _VERB_RE.search(command or "")
    verb = verb_match.group(1).lower() if verb_match else ""
    allowed_verbs = {
        "run",
        "exec",
        "review",
        "resume",
        "serve",
        "agent",
    }
    parts = [runtime]
    if verb in allowed_verbs:
        parts.append(verb)
    model = _model_from_command(command)
    if model:
        parts.extend(["--model", model])
    if len(command or "") > 0:
        parts.append("…")
    return " ".join(parts)


def _enqueue(event: dict[str, Any]) -> None:
    _ensure_worker()
    event.setdefault("schema", _SCHEMA)
    event.setdefault("observedAt", time.time())
    try:
        _QUEUE.put_nowait(event)
    except queue.Full:
        # Visualization must never back-pressure the agent.
        pass


def _delivery_loop() -> None:
    while True:
        event = _QUEUE.get()
        try:
            raw = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            req = urllib.request.Request(
                _ENDPOINT,
                data=raw,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=0.5) as response:
                response.read(1)
        except Exception:
            # Dashboard availability can never affect Hermes execution.
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
        thread = threading.Thread(
            target=_delivery_loop,
            name="hermes-office-observer",
            daemon=True,
        )
        thread.start()
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


def _on_pre_tool_call(tool_name: str = "", args: dict[str, Any] | None = None, **kwargs: Any) -> None:
    if tool_name != "terminal":
        return
    args = args or {}
    command = str(args.get("command") or "")
    runtime = _detect_runtime(command)
    if not runtime:
        return
    base = _base_event(kwargs)
    key = _correlation_key(tool_name, kwargs)
    pending = {
        **base,
        "correlationId": key,
        "runtime": runtime,
        "cwd": str(args.get("workdir") or args.get("cwd") or ""),
        "model": _model_from_command(command) or "",
        "command": _command_summary(command, runtime),
        "background": bool(args.get("background")),
        "pty": bool(args.get("pty")),
    }
    with _PENDING_LOCK:
        _PENDING[key] = pending
    _enqueue({"event": "runtime_spawn_requested", **pending})


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
        # A plugin may have been hot-loaded between pre/post; recover from args.
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
    event = {
        "event": "runtime_spawn_result",
        **pending,
        "processId": process_id,
        "processSessionId": str(parsed.get("session_id") or ""),
        "resultStatus": str(kwargs.get("status") or parsed.get("status") or ""),
        "success": str(kwargs.get("status") or "ok") == "ok",
    }
    _enqueue(event)


def register(ctx: Any) -> None:
    """Register observer hooks; no tools or behavior-changing hooks are added."""
    _ensure_worker()
    ctx.register_hook("subagent_start", _on_subagent_start)
    ctx.register_hook("subagent_stop", _on_subagent_stop)
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
