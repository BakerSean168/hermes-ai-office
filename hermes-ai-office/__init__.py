"""Hermes AI Office V3 facade.

AI Office is intentionally thin: Hermes delegates semantic development phases to the
V3 control plane, while OpenHands owns execution lifecycle and LiteLLM owns all model,
provider, routing, health, and spend authority. No secondary placement layer or
provider mutation is implemented here.
"""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Mapping
from pathlib import Path
import re
import time
from typing import Any
import urllib.parse
import urllib.request

_CONTROL_PLANE_BASE = os.environ.get(
    "HERMES_AI_OFFICE_CONTROL_PLANE_URL", "http://127.0.0.1:8320"
).rstrip("/")
_V3_PHASES = {"ORCHESTRATE", "INVESTIGATE_PLAN", "IMPLEMENT", "IMPLEMENT_FIX", "VERIFY_REVIEW", "FINALIZE"}
_V3_TERMINAL_STATUSES = {"SUCCEEDED", "FAILED", "STUCK", "CANCELLED"}
_V3_ATTENTION_STATUSES = {"PAUSED", "WAITING_FOR_CONFIRMATION"}
_V3_DEFAULT_AWAIT = {
    "ORCHESTRATE": False,
    "INVESTIGATE_PLAN": True,
    "IMPLEMENT": False,
    "IMPLEMENT_FIX": False,
    "VERIFY_REVIEW": True,
    "FINALIZE": True,
}
_V3_DEFAULT_WAIT_SECONDS = {
    "ORCHESTRATE": 0.0,
    "INVESTIGATE_PLAN": 240.0,
    "IMPLEMENT": 0.0,
    "IMPLEMENT_FIX": 0.0,
    "VERIFY_REVIEW": 240.0,
    "FINALIZE": 30.0,
}
_CTX: Any = None

_RUN_PHASE_SCHEMA = {
    "name": "ai_office_run_phase",
    "description": (
        "Run one AI Office development phase. AI Office chooses the execution backend and logical model, "
        "OpenHands owns lifecycle/workspaces, and LiteLLM owns provider routing and spend."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "phase": {"type": "string", "enum": sorted(_V3_PHASES)},
            "objective": {"type": "string"},
            "project_key": {"type": "string"},
            "repository_path": {
                "type": "string",
                "description": "Required for ORCHESTRATE, initial INVESTIGATE_PLAN, or IMPLEMENT.",
            },
            "base_revision": {"type": "string"},
            "previous_execution_id": {
                "type": "string",
                "description": "Causal parent execution for phase handoff.",
            },
            "acceptance_criteria": {"type": "array", "items": {"type": "string"}},
            "complexity_hint": {"type": "string", "enum": ["LOW", "MEDIUM", "HIGH"]},
            "risk_hint": {"type": "string", "enum": ["LOW", "MEDIUM", "HIGH"]},
            "quality_hint": {"type": "string", "enum": ["FAST", "STANDARD", "PREMIUM"]},
            "budget_hint": {"type": "string", "enum": ["LOW", "NORMAL", "HIGH"]},
            "parallelism": {"type": "integer", "minimum": 1, "maximum": 16},
            "preferred_backend": {"type": "string"},
            "preferred_model_class": {"type": "string"},
            "await": {"type": "boolean"},
            "wait_timeout_seconds": {"type": "number", "minimum": 0, "maximum": 600},
        },
        "required": ["phase", "objective"],
    },
}

_GET_EXECUTION_SCHEMA = {
    "name": "ai_office_get_execution",
    "description": "Get authoritative status, result, usage, timing, route, and workspace metadata for an execution.",
    "parameters": {
        "type": "object",
        "properties": {"execution_id": {"type": "string"}},
        "required": ["execution_id"],
    },
}

_CONTINUE_EXECUTION_SCHEMA = {
    "name": "ai_office_continue_execution",
    "description": "Resume the same PAUSED execution. Review corrections should use IMPLEMENT_FIX instead.",
    "parameters": {
        "type": "object",
        "properties": {
            "execution_id": {"type": "string"},
            "message": {"type": "string"},
            "await": {"type": "boolean"},
            "wait_timeout_seconds": {"type": "number", "minimum": 0, "maximum": 600},
        },
        "required": ["execution_id", "message"],
    },
}

_CANCEL_EXECUTION_SCHEMA = {
    "name": "ai_office_cancel_execution",
    "description": "Cancel a non-terminal AI Office execution.",
    "parameters": {
        "type": "object",
        "properties": {"execution_id": {"type": "string"}},
        "required": ["execution_id"],
    },
}

_LIST_ACTIVE_SCHEMA = {
    "name": "ai_office_list_active",
    "description": "List current non-terminal AI Office executions, optionally scoped to one project.",
    "parameters": {
        "type": "object",
        "properties": {
            "project_key": {"type": "string"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 200},
        },
    },
}

_LIST_PROVIDERS_SCHEMA = {
    "name": "ai_office_list_providers",
    "description": (
        "Read the authoritative LiteLLM provider/model registry. Provider mutation belongs in LiteLLM Admin, not AI Office."
    ),
    "parameters": {"type": "object", "properties": {}},
}

_CREATE_PLAN_SCHEMA = {
    "name": "ai_office_create_plan",
    "description": (
        "Create one durable development plan. The control plane automatically runs each work item through "
        "IMPLEMENT, independent VERIFY_REVIEW, IMPLEMENT_FIX when needed, deterministic batch integration, dependent batches, "
        "and, when explicitly authorized, remote checks and merge."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "project_key": {"type": "string"},
            "objective": {"type": "string"},
            "repository_path": {"type": "string"},
            "base_revision": {"type": "string"},
            "delivery": {
                "type": "object",
                "description": "Optional explicit authorization to push, open/reuse a PR, wait for checks, merge, and verify post-merge checks.",
                "properties": {
                    "remote": {"type": "string"},
                    "branch": {"type": "string"},
                    "target_branch": {"type": "string"},
                    "auto_merge": {"type": "boolean", "const": True},
                    "merge_method": {"type": "string", "enum": ["merge", "squash", "rebase"]},
                },
                "required": ["branch", "auto_merge"],
            },
            "batches": {
                "type": "array",
                "minItems": 1,
                "items": {
                    "type": "object",
                    "properties": {
                        "key": {"type": "string"},
                        "title": {"type": "string"},
                        "depends_on": {"type": "array", "items": {"type": "string"}},
                        "work_items": {
                            "type": "array",
                            "minItems": 1,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "key": {"type": "string"},
                                    "title": {"type": "string"},
                                    "objective": {"type": "string"},
                                    "acceptance_criteria": {"type": "array", "items": {"type": "string"}},
                                },
                                "required": ["key", "title", "objective"],
                            },
                        },
                    },
                    "required": ["key", "title", "work_items"],
                },
            },
        },
        "required": ["objective", "repository_path", "batches"],
    },
}

_GET_PLAN_SCHEMA = {
    "name": "ai_office_get_plan",
    "description": "Get the durable plan, batch, work-item, execution, review-gate, and integration projection.",
    "parameters": {
        "type": "object",
        "properties": {
            "plan_id": {"type": "string"},
            "reconcile": {"type": "boolean", "description": "Request an immediate recovery/reconcile pass before reading."},
        },
        "required": ["plan_id"],
    },
}

_LIST_PLANS_SCHEMA = {
    "name": "ai_office_list_plans",
    "description": "List durable development plans for recovery after Telegram, Hermes, or gateway reconnects.",
    "parameters": {
        "type": "object",
        "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 200}},
    },
}

_AI_OFFICE_RE = re.compile(r"\bai[\s_-]*office\b", re.IGNORECASE)
_PROVIDER_RE = re.compile(r"provider|supplier|channel|model|供应商|提供商|渠道|模型", re.IGNORECASE)
_PROVIDER_STATUS_RE = re.compile(r"status|health|available|list|current|状态|健康|可用|列表|当前|哪些", re.IGNORECASE)
_DEVELOPMENT_RE = re.compile(
    r"implement|review|plan|debug|test|fix|refactor|code|coding|"
    r"实施|实现|审查|评审|规划|计划|调试|测试|修复|重构|编码|代码",
    re.IGNORECASE,
)


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
        _CONTROL_PLANE_BASE + path,
        data=body,
        headers=headers,
        method=method,
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        value = json.load(response)
    if not isinstance(value, dict):
        raise RuntimeError("control plane returned a non-object payload")
    return value


def _active_profile_name() -> str:
    if _CTX is None:
        return "default"
    return str(getattr(_CTX, "profile_name", "") or "default")[:120]


def _session_id(kwargs: Mapping[str, Any]) -> str:
    return str(kwargs.get("session_id") or kwargs.get("task_id") or "")[:200]


def _v3_execution_path(execution_id: str, suffix: str = "") -> str:
    value = str(execution_id or "").strip()
    if not value:
        raise ValueError("execution_id is required")
    return f"/api/v3/development/executions/{urllib.parse.quote(value, safe='')}{suffix}"


def _v3_execution_snapshot(execution_id: str) -> dict[str, Any]:
    return _control_plane_request(_v3_execution_path(execution_id), timeout=4.0)


def _text_list(value: Any, *, limit: int = 24, item_limit: int = 1200) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value[:limit]:
        text = str(item or "").strip()
        if text:
            result.append(text[:item_limit])
    return result


def _project_key(args: Mapping[str, Any], previous: Mapping[str, Any] | None = None) -> str:
    explicit = str(args.get("project_key") or "").strip()
    if explicit:
        return explicit[:160]
    if previous:
        inherited = str(previous.get("projectKey") or "").strip()
        if inherited:
            return inherited[:160]
    repository = str(args.get("repository_path") or "").strip().rstrip("/")
    if repository:
        name = Path(repository).name.strip()
        if name:
            return name[:160]
    return _active_profile_name()


def _idempotency_key(phase: str, payload: Mapping[str, Any], kwargs: Mapping[str, Any]) -> str:
    call_id = str(kwargs.get("tool_call_id") or "").strip()
    seed: dict[str, Any] = {
        "phase": phase,
        "profile": _active_profile_name(),
        "session": _session_id(kwargs),
        "turn": str(kwargs.get("turn_id") or kwargs.get("parent_turn_id") or ""),
        "call": call_id,
    }
    if not call_id:
        seed["request"] = payload
    digest = hashlib.blake2b(
        json.dumps(seed, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"),
        digest_size=16,
    ).hexdigest()
    return f"hermes-v3-{phase.lower()}-{digest}"


def _plan_idempotency_key(payload: Mapping[str, Any]) -> str:
    digest = hashlib.blake2b(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"),
        digest_size=16,
    ).hexdigest()
    return f"hermes-v3-plan-{digest}"


def _compact_plan(plan: Mapping[str, Any], *, detail: bool = True) -> dict[str, Any]:
    compact: dict[str, Any] = {
        key: plan.get(key)
        for key in (
            "planId",
            "projectKey",
            "objective",
            "status",
            "blockedReason",
            "currentRevision",
            "createdAt",
            "updatedAt",
            "deliveryStage",
            "deliveryEvidence",
            "pullRequestUrl",
            "mergeRevision",
        )
        if plan.get(key) is not None
    }
    batches = []
    for batch in plan.get("batches") or []:
        if not isinstance(batch, Mapping):
            continue
        compact_batch = {
            key: batch.get(key)
            for key in (
                "batchId",
                "key",
                "title",
                "status",
                "baseRevision",
                "integratedRevision",
                "integrationRef",
                "blockedReason",
            )
            if batch.get(key) is not None
        }
        if detail:
            work_items = []
            for item in batch.get("workItems") or []:
                if not isinstance(item, Mapping):
                    continue
                compact_item = {
                    key: item.get(key)
                    for key in ("workItemId", "key", "title", "status", "blockedReason")
                    if item.get(key) is not None
                }
                executions = []
                for execution in item.get("executions") or []:
                    if not isinstance(execution, Mapping):
                        continue
                    result = execution.get("result") if isinstance(execution.get("result"), Mapping) else {}
                    final_text = str(result.get("finalText") or "").strip()
                    selection = execution.get("selection") if isinstance(execution.get("selection"), Mapping) else {}
                    executions.append(
                        {
                            "executionId": execution.get("executionId"),
                            "phase": execution.get("phase"),
                            "status": execution.get("status"),
                            "backend": selection.get("backend"),
                            **({"verdict": final_text.splitlines()[0][:80]} if final_text else {}),
                            "timing": execution.get("timing"),
                            "usage": execution.get("usage"),
                        }
                    )
                compact_item["executions"] = executions
                work_items.append(compact_item)
            compact_batch["workItems"] = work_items
        batches.append(compact_batch)
    compact["batches"] = batches
    if detail:
        compact["events"] = [
            {
                key: event.get(key)
                for key in ("eventId", "type", "batchId", "workItemId", "executionId", "createdAt")
                if event.get(key) is not None
            }
            for event in (plan.get("events") or [])[-6:]
            if isinstance(event, Mapping)
        ]
    return compact


def _wait_for_execution(
    snapshot: dict[str, Any], *, wait: bool, timeout_seconds: float
) -> tuple[dict[str, Any], bool]:
    if not wait:
        return snapshot, False
    execution_id = str(snapshot.get("executionId") or "").strip()
    if not execution_id:
        raise RuntimeError("execution response did not include executionId")
    status = str(snapshot.get("status") or "UNKNOWN").upper()
    if status in _V3_TERMINAL_STATUSES or status in _V3_ATTENTION_STATUSES:
        return snapshot, False
    timeout_seconds = max(0.0, min(float(timeout_seconds), 600.0))
    deadline = time.monotonic() + timeout_seconds
    while timeout_seconds > 0 and time.monotonic() < deadline:
        time.sleep(min(2.0, max(0.0, deadline - time.monotonic())))
        snapshot = _v3_execution_snapshot(execution_id)
        status = str(snapshot.get("status") or "UNKNOWN").upper()
        if status in _V3_TERMINAL_STATUSES or status in _V3_ATTENTION_STATUSES:
            return snapshot, False
    return snapshot, True


def _run_development_phase_tool(args: dict[str, Any], **kwargs: Any) -> str:
    try:
        phase = str(args.get("phase") or "").strip().upper()
        if phase not in _V3_PHASES:
            raise ValueError("invalid development phase")
        objective = str(args.get("objective") or "").strip()
        if not objective:
            raise ValueError("objective is required")
        previous_execution_id = str(args.get("previous_execution_id") or "").strip()
        previous = _v3_execution_snapshot(previous_execution_id) if previous_execution_id else None
        repository_path = str(args.get("repository_path") or "").strip()
        if phase in {"ORCHESTRATE", "INVESTIGATE_PLAN", "IMPLEMENT"} and not repository_path:
            raise ValueError("repository_path is required for ORCHESTRATE, INVESTIGATE_PLAN, and IMPLEMENT")

        context: dict[str, Any] = {}
        if previous_execution_id:
            context["previousExecutionId"] = previous_execution_id
        if previous:
            result = previous.get("result") if isinstance(previous.get("result"), dict) else {}
            previous_result = str(result.get("finalText") or "").strip()
            if previous_result:
                context["previousResult"] = previous_result[:30_000]
        acceptance = _text_list(args.get("acceptance_criteria"))
        if acceptance:
            context["acceptanceCriteria"] = acceptance

        hints: dict[str, Any] = {}
        for arg_name, wire_name, allowed in (
            ("complexity_hint", "complexity", {"LOW", "MEDIUM", "HIGH"}),
            ("risk_hint", "risk", {"LOW", "MEDIUM", "HIGH"}),
            ("quality_hint", "quality", {"FAST", "STANDARD", "PREMIUM"}),
            ("budget_hint", "budget", {"LOW", "NORMAL", "HIGH"}),
        ):
            raw = str(args.get(arg_name) or "").strip().upper()
            if raw:
                if raw not in allowed:
                    raise ValueError(f"invalid {arg_name}")
                hints[wire_name] = raw
        if args.get("parallelism") is not None:
            parallelism = int(args["parallelism"])
            if parallelism < 1 or parallelism > 16:
                raise ValueError("parallelism must be between 1 and 16")
            hints["parallelism"] = parallelism

        override: dict[str, Any] = {}
        if str(args.get("preferred_backend") or "").strip():
            override["backend"] = str(args["preferred_backend"]).strip()[:160]
        if str(args.get("preferred_model_class") or "").strip():
            override["modelClass"] = str(args["preferred_model_class"]).strip()[:160]

        base_revision = str(args.get("base_revision") or "").strip()
        payload: dict[str, Any] = {
            "phase": phase,
            "objective": objective[:20_000],
            "projectKey": _project_key(args, previous),
            "repository": {
                "path": repository_path,
                **({"baseRevision": base_revision[:240]} if base_revision else {}),
            },
            "hermes": {
                "profile": _active_profile_name(),
                "sessionId": _session_id(kwargs),
                "turnId": str(kwargs.get("turn_id") or kwargs.get("parent_turn_id") or "")[:200],
            },
            "await": False,
        }
        if context:
            payload["context"] = context
        if hints:
            payload["hints"] = hints
        if override:
            payload["override"] = override

        requested_wait = args.get("await")
        wait = _V3_DEFAULT_AWAIT[phase] if requested_wait is None else bool(requested_wait)
        raw_timeout = args.get("wait_timeout_seconds")
        wait_timeout = (
            _V3_DEFAULT_WAIT_SECONDS[phase]
            if raw_timeout is None
            else max(0.0, min(float(raw_timeout), 600.0))
        )
        snapshot = _control_plane_request(
            "/api/v3/development/executions",
            method="POST",
            payload=payload,
            idempotency_key=_idempotency_key(phase, payload, kwargs),
            timeout=8.0,
        )
        snapshot, timed_out = _wait_for_execution(snapshot, wait=wait, timeout_seconds=wait_timeout)
        return json.dumps(
            {"ok": True, "awaitRequested": wait, "awaitTimedOut": timed_out, **snapshot},
            ensure_ascii=False,
        )
    except Exception as exc:
        return json.dumps(
            {"ok": False, "error": type(exc).__name__, "message": str(exc)[:500]},
            ensure_ascii=False,
        )


def _get_development_execution_tool(args: dict[str, Any], **_kwargs: Any) -> str:
    try:
        return json.dumps({"ok": True, **_v3_execution_snapshot(str(args.get("execution_id") or ""))}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)[:500]}, ensure_ascii=False)


def _continue_development_execution_tool(args: dict[str, Any], **_kwargs: Any) -> str:
    try:
        execution_id = str(args.get("execution_id") or "").strip()
        message = str(args.get("message") or "").strip()
        if not message:
            raise ValueError("message is required")
        snapshot = _control_plane_request(
            _v3_execution_path(execution_id, "/messages"),
            method="POST",
            payload={"message": message[:20_000]},
            timeout=8.0,
        )
        wait = bool(args.get("await", False))
        timeout = max(0.0, min(float(args.get("wait_timeout_seconds") or 0.0), 600.0))
        snapshot, timed_out = _wait_for_execution(snapshot, wait=wait, timeout_seconds=timeout)
        return json.dumps({"ok": True, "awaitRequested": wait, "awaitTimedOut": timed_out, **snapshot}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)[:500]}, ensure_ascii=False)


def _cancel_development_execution_tool(args: dict[str, Any], **_kwargs: Any) -> str:
    try:
        snapshot = _control_plane_request(
            _v3_execution_path(str(args.get("execution_id") or ""), "/cancel"),
            method="POST",
            timeout=6.0,
        )
        return json.dumps({"ok": True, **snapshot}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)[:500]}, ensure_ascii=False)


def _list_active_development_executions_tool(args: dict[str, Any], **_kwargs: Any) -> str:
    try:
        limit = max(1, min(int(args.get("limit") or 50), 200))
        query = {"limit": str(limit)}
        project_key = str(args.get("project_key") or "").strip()
        if project_key:
            query["projectKey"] = project_key[:160]
        value = _control_plane_request(
            "/api/v3/development/executions?" + urllib.parse.urlencode(query), timeout=5.0
        )
        items = [item for item in value.get("items", []) if isinstance(item, dict)]
        active = [item for item in items if str(item.get("status") or "").upper() not in _V3_TERMINAL_STATUSES]
        return json.dumps({"ok": True, "count": len(active), "items": active}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)[:500]}, ensure_ascii=False)


def _list_shared_providers_tool(_args: dict[str, Any], **_kwargs: Any) -> str:
    try:
        registry = _control_plane_request("/api/v3/development/model-registry", timeout=5.0)
        deployments = registry.get("deployments") if isinstance(registry.get("deployments"), dict) else {}
        grouped: dict[str, dict[str, Any]] = {}
        for raw in deployments.get("items", []) if isinstance(deployments.get("items"), list) else []:
            if not isinstance(raw, dict):
                continue
            key = str(raw.get("providerKey") or raw.get("credential") or "unclassified")
            item = grouped.setdefault(
                key,
                {"providerKey": key, "active": 0, "paused": 0, "modelGroups": set(), "commercialTypes": set()},
            )
            item["paused" if raw.get("blocked") is True else "active"] += 1
            if raw.get("group"):
                item["modelGroups"].add(str(raw["group"]))
            if raw.get("commercialType"):
                item["commercialTypes"].add(str(raw["commercialType"]))
        providers = []
        for item in grouped.values():
            item["modelGroups"] = sorted(item["modelGroups"])
            item["commercialTypes"] = sorted(item["commercialTypes"])
            providers.append(item)
        providers.sort(key=lambda item: item["providerKey"])
        return json.dumps(
            {
                "ok": True,
                "authority": "LITELLM",
                "health": registry.get("health"),
                "adminUrl": registry.get("adminUrl"),
                "summary": {
                    "credentials": (registry.get("credentials") or {}).get("count", 0),
                    "deployments": deployments.get("count", 0),
                    "active": deployments.get("active", 0),
                    "paused": deployments.get("paused", 0),
                },
                "providers": providers,
                "modelGroups": deployments.get("groups", {}),
                "aliases": registry.get("aliases", {}),
            },
            ensure_ascii=False,
        )
    except Exception as exc:
        return json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)[:500]}, ensure_ascii=False)


def _create_development_plan_tool(args: dict[str, Any], **_kwargs: Any) -> str:
    try:
        objective = str(args.get("objective") or "").strip()
        repository_path = str(args.get("repository_path") or "").strip()
        raw_batches = args.get("batches")
        if not objective:
            raise ValueError("objective is required")
        if not repository_path:
            raise ValueError("repository_path is required")
        if not isinstance(raw_batches, list) or not raw_batches:
            raise ValueError("batches is required")
        batches = []
        for raw_batch in raw_batches[:24]:
            if not isinstance(raw_batch, Mapping):
                raise ValueError("each batch must be an object")
            work_items = []
            raw_items = raw_batch.get("work_items")
            if not isinstance(raw_items, list) or not raw_items:
                raise ValueError("each batch requires work_items")
            for raw_item in raw_items[:48]:
                if not isinstance(raw_item, Mapping):
                    raise ValueError("each work item must be an object")
                work_items.append(
                    {
                        "key": str(raw_item.get("key") or "")[:160],
                        "title": str(raw_item.get("title") or "")[:500],
                        "objective": str(raw_item.get("objective") or "")[:20_000],
                        "acceptanceCriteria": _text_list(raw_item.get("acceptance_criteria")),
                    }
                )
            batches.append(
                {
                    "key": str(raw_batch.get("key") or "")[:160],
                    "title": str(raw_batch.get("title") or "")[:500],
                    "dependsOn": _text_list(raw_batch.get("depends_on"), limit=24, item_limit=160),
                    "workItems": work_items,
                }
            )
        base_revision = str(args.get("base_revision") or "").strip()
        payload = {
            "projectKey": _project_key(args),
            "objective": objective[:20_000],
            "repository": {
                "path": repository_path,
                **({"baseRevision": base_revision[:240]} if base_revision else {}),
            },
            "batches": batches,
        }
        raw_delivery = args.get("delivery")
        if raw_delivery is not None:
            if not isinstance(raw_delivery, Mapping):
                raise ValueError("delivery must be an object")
            branch = str(raw_delivery.get("branch") or "").strip()
            if not branch:
                raise ValueError("delivery.branch is required")
            if raw_delivery.get("auto_merge") is not True:
                raise ValueError("delivery.auto_merge must be explicitly true")
            payload["delivery"] = {
                "remote": str(raw_delivery.get("remote") or "origin")[:160],
                "branch": branch[:240],
                "targetBranch": str(raw_delivery.get("target_branch") or "main")[:240],
                "autoMerge": True,
                "mergeMethod": str(raw_delivery.get("merge_method") or "merge")[:20],
            }
        plan = _control_plane_request(
            "/api/v3/development/plans",
            method="POST",
            payload=payload,
            idempotency_key=_plan_idempotency_key(payload),
            timeout=12.0,
        )
        return json.dumps({"ok": True, **_compact_plan(plan)}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)[:500]}, ensure_ascii=False)


def _get_development_plan_tool(args: dict[str, Any], **_kwargs: Any) -> str:
    try:
        plan_id = str(args.get("plan_id") or "").strip()
        if not plan_id:
            raise ValueError("plan_id is required")
        suffix = "/reconcile" if args.get("reconcile") else ""
        plan = _control_plane_request(
            f"/api/v3/development/plans/{urllib.parse.quote(plan_id, safe='')}{suffix}",
            method="POST" if suffix else "GET",
            payload={} if suffix else None,
            timeout=12.0,
        )
        return json.dumps({"ok": True, **_compact_plan(plan)}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)[:500]}, ensure_ascii=False)


def _list_development_plans_tool(args: dict[str, Any], **_kwargs: Any) -> str:
    try:
        limit = max(1, min(int(args.get("limit") or 50), 200))
        plans = _control_plane_request(
            "/api/v3/development/plans?" + urllib.parse.urlencode({"limit": limit}),
            timeout=8.0,
        )
        items = plans.get("items") if isinstance(plans, Mapping) else []
        return json.dumps(
            {
                "ok": True,
                "items": [
                    _compact_plan(plan, detail=False)
                    for plan in items
                    if isinstance(plan, Mapping)
                ],
            },
            ensure_ascii=False,
        )
    except Exception as exc:
        return json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)[:500]}, ensure_ascii=False)


def _on_pre_llm_call(user_message: Any = "", **_kwargs: Any) -> dict[str, str] | None:
    text = str(user_message or "").strip()
    if not text:
        return None
    provider_topic = bool(_AI_OFFICE_RE.search(text) or (_PROVIDER_RE.search(text) and _PROVIDER_STATUS_RE.search(text)))
    development_topic = bool(_DEVELOPMENT_RE.search(text))
    if not provider_topic and not development_topic:
        return None

    sections: list[str] = []
    if development_topic:
        sections.append(
            "AI Office is the development execution authority. For a complete multi-step task, create one durable graph with ai_office_create_plan; the control plane then automatically runs IMPLEMENT, independent VERIFY_REVIEW, IMPLEMENT_FIX after FAIL, deterministic batch integration, and dependent batches without Hermes polling. "
            "Use ai_office_run_phase only for a standalone investigation or operator-directed single phase. VERIFY_REVIEW enforces a strict first-line PASS/FAIL protocol. Preserve planId across turns and recover with ai_office_get_plan or ai_office_list_plans after Telegram, Hermes, or gateway reconnects. "
            "Backend and logical model are policy decisions; physical provider selection, fallback, health, and spend are exclusively LiteLLM decisions."
        )
    if provider_topic:
        sections.append(
            "LiteLLM is the single provider/model authority. Use ai_office_list_providers for safe runtime status and the LiteLLM Admin UI for provider mutation; do not infer provider state from retired AI Office state."
        )
        try:
            registry = _control_plane_request("/api/v3/development/model-registry", timeout=3.0)
            deployments = registry.get("deployments") if isinstance(registry.get("deployments"), dict) else {}
            sections.append(
                "Current LiteLLM snapshot: "
                f"credentials={(registry.get('credentials') or {}).get('count', 0)}, "
                f"deployments={deployments.get('count', 0)}, active={deployments.get('active', 0)}, paused={deployments.get('paused', 0)}."
            )
        except Exception:
            sections.append("LiteLLM registry is currently unreachable; report that state explicitly.")
    return {"context": "\n\n".join(sections)}


def register(ctx: Any) -> None:
    global _CTX
    _CTX = ctx
    tools = (
        (_LIST_PROVIDERS_SCHEMA, _list_shared_providers_tool, "📡"),
        (_CREATE_PLAN_SCHEMA, _create_development_plan_tool, "🗺️"),
        (_GET_PLAN_SCHEMA, _get_development_plan_tool, "🧭"),
        (_LIST_PLANS_SCHEMA, _list_development_plans_tool, "📚"),
        (_RUN_PHASE_SCHEMA, _run_development_phase_tool, "🚀"),
        (_GET_EXECUTION_SCHEMA, _get_development_execution_tool, "🔎"),
        (_CONTINUE_EXECUTION_SCHEMA, _continue_development_execution_tool, "▶️"),
        (_CANCEL_EXECUTION_SCHEMA, _cancel_development_execution_tool, "⛔"),
        (_LIST_ACTIVE_SCHEMA, _list_active_development_executions_tool, "📋"),
    )
    for schema, handler, emoji in tools:
        ctx.register_tool(
            name=schema["name"],
            toolset="ai_office",
            schema=schema,
            handler=handler,
            description=schema["description"],
            emoji=emoji,
        )
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
