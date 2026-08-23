"""OpenHands supervisor tool for launching isolated AI Office coding workers.

This tool deliberately delegates all write concurrency, workspace provisioning,
review snapshots, and causal phase validation to the V3 control plane.  The
supervisor never hands multiple coding agents the same mutable directory.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Sequence
from typing import Literal

from pydantic import BaseModel, Field

from openhands.sdk.tool import (
    Action,
    Observation,
    ToolAnnotations,
    ToolDefinition,
    ToolExecutor,
    register_tool,
)


WorkerPhase = Literal[
    "INVESTIGATE_PLAN",
    "IMPLEMENT",
    "VERIFY_REVIEW",
    "IMPLEMENT_FIX",
    "FINALIZE",
]
WorkerBackend = Literal[
    "openhands-builtin",
    "opencode-acp",
    "codex-review-headless",
    "claude-code-review-headless",
    "codex-acp",
    "claude-code-acp",
    "dsh-acp",
    "zcode-acp",
]
_TERMINAL = {"SUCCEEDED", "FAILED", "STUCK", "CANCELLED"}


class WorkerSpec(BaseModel):
    """One independent AI Office execution to start."""

    phase: WorkerPhase
    objective: str = Field(min_length=1, description="Bounded engineering objective for this worker.")
    project_key: str = Field(min_length=1)
    repository_path: str | None = Field(
        default=None,
        description="Host source repository path. Required for INVESTIGATE_PLAN and IMPLEMENT.",
    )
    backend: WorkerBackend | None = Field(
        default=None,
        description="Optional coding harness override. Leave unset to use phase policy.",
    )
    model_class: str | None = Field(
        default=None,
        description="Optional logical LiteLLM model-class override.",
    )
    previous_execution_id: str | None = Field(
        default=None,
        description="Required causal parent for review/fix/finalize phases.",
    )
    acceptance_criteria: list[str] = Field(default_factory=list)
    idempotency_key: str | None = None


class AiOfficeWorkerAction(Action):
    """Start, inspect, wait for, cancel, or list isolated coding-agent workers."""

    command: Literal["start", "get", "wait", "cancel", "list"]
    workers: list[WorkerSpec] = Field(
        default_factory=list,
        description="For start: one or more independent workers. Use several entries for safe fan-out.",
    )
    execution_ids: list[str] = Field(
        default_factory=list,
        description="Execution IDs used by get, wait, and cancel.",
    )
    project_key: str | None = Field(default=None, description="Optional list filter.")
    timeout_seconds: int = Field(default=900, ge=1, le=3600)


class AiOfficeWorkerObservation(Observation):
    command: Literal["start", "get", "wait", "cancel", "list"]


class AiOfficeWorkerExecutor(ToolExecutor[AiOfficeWorkerAction, AiOfficeWorkerObservation]):
    """Thin local client for the authoritative AI Office V3 control plane."""

    def __init__(self) -> None:
        self._base_url = os.environ.get(
            "AI_OFFICE_CONTROL_PLANE_URL", "http://127.0.0.1:8320"
        ).rstrip("/")

    def _request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: dict | None = None,
        headers: dict[str, str] | None = None,
        timeout: float = 30.0,
    ) -> dict:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            self._base_url + path,
            data=payload,
            method=method,
            headers={
                "Accept": "application/json",
                **({"Content-Type": "application/json"} if payload is not None else {}),
                **(headers or {}),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                value = json.load(response)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:2000]
            raise RuntimeError(f"AI_OFFICE_HTTP_{exc.code}:{detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"AI_OFFICE_UNAVAILABLE:{exc.reason}") from exc
        if not isinstance(value, dict):
            raise RuntimeError("AI_OFFICE_INVALID_RESPONSE")
        return value

    @staticmethod
    def _compact(snapshot: dict) -> dict:
        selection = snapshot.get("selection") if isinstance(snapshot.get("selection"), dict) else {}
        result = snapshot.get("result") if isinstance(snapshot.get("result"), dict) else {}
        return {
            "executionId": snapshot.get("executionId"),
            "projectKey": snapshot.get("projectKey"),
            "phase": snapshot.get("phase"),
            "status": snapshot.get("status"),
            "backend": selection.get("backend"),
            "modelClass": selection.get("modelClass"),
            "workspaceRef": result.get("workspaceRef"),
            "finalText": (str(result.get("finalText") or "")[:12000] or None),
        }

    def _start(self, action: AiOfficeWorkerAction) -> AiOfficeWorkerObservation:
        if not action.workers:
            return AiOfficeWorkerObservation.from_text(
                text="start requires at least one worker",
                command=action.command,
                is_error=True,
            )
        if len(action.workers) > 4:
            return AiOfficeWorkerObservation.from_text(
                text="start accepts at most four workers; the control plane may enforce a lower per-project writer cap",
                command=action.command,
                is_error=True,
            )

        started: list[dict] = []
        errors: list[dict] = []
        for spec in action.workers:
            if spec.phase in {"INVESTIGATE_PLAN", "IMPLEMENT"} and not spec.repository_path:
                errors.append({
                    "projectKey": spec.project_key,
                    "phase": spec.phase,
                    "backend": spec.backend,
                    "error": f"{spec.phase} requires repository_path",
                })
                continue
            context: dict[str, object] = {}
            if spec.previous_execution_id:
                context["previousExecutionId"] = spec.previous_execution_id
            if spec.acceptance_criteria:
                context["acceptanceCriteria"] = spec.acceptance_criteria
            override: dict[str, object] = {}
            if spec.backend:
                override["backend"] = spec.backend
            if spec.model_class:
                override["modelClass"] = spec.model_class

            key = spec.idempotency_key or f"supervisor-{uuid.uuid4()}"
            try:
                snapshot = self._request(
                    "/api/v3/development/executions",
                    method="POST",
                    headers={"Idempotency-Key": key},
                    body={
                        "phase": spec.phase,
                        "objective": spec.objective,
                        "projectKey": spec.project_key,
                        "repository": {"path": spec.repository_path or ""},
                        **({"context": context} if context else {}),
                        **({"override": override} if override else {}),
                        "await": False,
                    },
                )
                started.append(self._compact(snapshot))
            except Exception as exc:
                # Preserve IDs for workers that already started earlier in this fan-out.
                # Admission failures are per-worker facts, not a reason to lose track of
                # sibling executions that are already running.
                errors.append({
                    "projectKey": spec.project_key,
                    "phase": spec.phase,
                    "backend": spec.backend,
                    "error": str(exc)[:2000],
                })

        return AiOfficeWorkerObservation.from_text(
            text=json.dumps({"workers": started, "errors": errors}, ensure_ascii=False, indent=2),
            command=action.command,
            is_error=bool(errors) and not started,
        )

    def _get_many(self, ids: list[str]) -> list[dict]:
        if not ids:
            raise ValueError("execution_ids is required")
        return [
            self._compact(
                self._request(f"/api/v3/development/executions/{urllib.parse.quote(item, safe='')}")
            )
            for item in ids
        ]

    def _wait(self, action: AiOfficeWorkerAction) -> AiOfficeWorkerObservation:
        if not action.execution_ids:
            return AiOfficeWorkerObservation.from_text(
                text="wait requires execution_ids",
                command=action.command,
                is_error=True,
            )
        deadline = time.monotonic() + action.timeout_seconds
        latest: list[dict] = []
        while time.monotonic() < deadline:
            latest = self._get_many(action.execution_ids)
            if all(str(item.get("status")) in _TERMINAL for item in latest):
                return AiOfficeWorkerObservation.from_text(
                    text=json.dumps({"workers": latest}, ensure_ascii=False, indent=2),
                    command=action.command,
                )
            time.sleep(2)
        return AiOfficeWorkerObservation.from_text(
            text=json.dumps(
                {"timeout": True, "workers": latest or self._get_many(action.execution_ids)},
                ensure_ascii=False,
                indent=2,
            ),
            command=action.command,
            is_error=True,
        )

    def __call__(
        self,
        action: AiOfficeWorkerAction,
        conversation=None,  # noqa: ANN001, ARG002
    ) -> AiOfficeWorkerObservation:
        try:
            if action.command == "start":
                return self._start(action)
            if action.command == "get":
                rows = self._get_many(action.execution_ids)
                return AiOfficeWorkerObservation.from_text(
                    text=json.dumps({"workers": rows}, ensure_ascii=False, indent=2),
                    command=action.command,
                )
            if action.command == "wait":
                return self._wait(action)
            if action.command == "cancel":
                if not action.execution_ids:
                    raise ValueError("execution_ids is required")
                rows = [
                    self._compact(
                        self._request(
                            f"/api/v3/development/executions/{urllib.parse.quote(item, safe='')}/cancel",
                            method="POST",
                            body={},
                        )
                    )
                    for item in action.execution_ids
                ]
                return AiOfficeWorkerObservation.from_text(
                    text=json.dumps({"workers": rows}, ensure_ascii=False, indent=2),
                    command=action.command,
                )
            if action.command == "list":
                query = ""
                if action.project_key:
                    query = "?" + urllib.parse.urlencode({"projectKey": action.project_key, "limit": 100})
                payload = self._request("/api/v3/development/executions" + query)
                items = payload.get("items") if isinstance(payload.get("items"), list) else []
                rows = [self._compact(item) for item in items if isinstance(item, dict)]
                return AiOfficeWorkerObservation.from_text(
                    text=json.dumps({"workers": rows}, ensure_ascii=False, indent=2),
                    command=action.command,
                )
            raise ValueError(f"unsupported command: {action.command}")
        except Exception as exc:  # Fail closed and return a bounded diagnostic to the supervisor.
            return AiOfficeWorkerObservation.from_text(
                text=str(exc)[:4000],
                command=action.command,
                is_error=True,
            )


_WORKER_DESCRIPTION = """Launch and supervise isolated AI Office coding-agent workers.

Use `start` with multiple worker specs to fan out dependency-independent work. Each
IMPLEMENT worker receives its own control-plane workspace and writer lease. Prefer
OpenCode/DSH for implementation. Use Codex/Claude Code for premium planning/review
only when runtime readiness exposes those backends; if a premium reviewer times out
or returns no unambiguous PASS/FAIL verdict, cancel it and retry with an enabled
review backend. Never silently downgrade a premium review model to an implementation
model. Never assume a worker result is merged: after IMPLEMENT, launch VERIFY_REVIEW
using previous_execution_id; on FAIL launch IMPLEMENT_FIX; FINALIZE records verified
logical completion only.

Use `wait` to fan in several execution IDs, `get` for current state, `cancel` to stop,
and `list` for recovery. Do not bypass control-plane concurrency or review errors.
"""


class AiOfficeWorkerTool(ToolDefinition[AiOfficeWorkerAction, AiOfficeWorkerObservation]):
    @classmethod
    def create(cls, conv_state) -> Sequence["AiOfficeWorkerTool"]:  # noqa: ANN001, ARG003
        return [
            cls(
                description=_WORKER_DESCRIPTION,
                action_type=AiOfficeWorkerAction,
                observation_type=AiOfficeWorkerObservation,
                annotations=ToolAnnotations(
                    title="AI Office worker",
                    readOnlyHint=False,
                    destructiveHint=True,
                    idempotentHint=False,
                    openWorldHint=True,
                ),
                executor=AiOfficeWorkerExecutor(),
            )
        ]


register_tool(AiOfficeWorkerTool.name, AiOfficeWorkerTool)
