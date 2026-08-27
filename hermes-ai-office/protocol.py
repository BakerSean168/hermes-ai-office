"""Stable Hermes-facing V3 tool protocol and schemas.

No runtime state or transport belongs here.
"""

from __future__ import annotations

_V3_PHASES = {"INVESTIGATE_PLAN", "IMPLEMENT", "IMPLEMENT_FIX", "VERIFY_REVIEW", "FINALIZE"}
_V3_TERMINAL_STATUSES = {"SUCCEEDED", "FAILED", "STUCK", "CANCELLED"}
_V3_ATTENTION_STATUSES = {"PAUSED", "WAITING_FOR_CONFIRMATION"}
_V3_DEFAULT_AWAIT = {
    "INVESTIGATE_PLAN": True,
    "IMPLEMENT": False,
    "IMPLEMENT_FIX": False,
    "VERIFY_REVIEW": True,
    "FINALIZE": True,
}
_V3_DEFAULT_WAIT_SECONDS = {
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
                "description": "Required for initial INVESTIGATE_PLAN or IMPLEMENT.",
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

_DELEGATE_PLAN_SCHEMA = {
    "name": "ai_office_delegate",
    "description": (
        "Delegate a complete development objective to the OpenHands supervisor. Hermes supplies only the objective and repository; "
        "OpenHands inspects the repository and produces the dependency-aware batch graph, then the durable Control Plane automatically runs implementation, review/fix, integration, and optional delivery."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "project_key": {"type": "string"},
            "objective": {"type": "string"},
            "repository_path": {"type": "string"},
            "base_revision": {"type": "string"},
            "active_plan_path": {
                "type": "string",
                "description": "Optional repository-relative active-plan path the OpenHands supervisor should inspect.",
            },
            "delivery": {
                "type": "object",
                "properties": {
                    "remote": {"type": "string"},
                    "branch": {"type": "string"},
                    "target_branch": {"type": "string"},
                    "auto_merge": {"type": "boolean", "const": True},
                    "merge_method": {"type": "string", "enum": ["merge", "squash", "rebase"]},
                },
                "required": ["branch", "auto_merge"],
            },
        },
        "required": ["objective", "repository_path"],
    },
}

_CREATE_PLAN_SCHEMA = {
    "name": "ai_office_create_plan",
    "description": (
        "Submit the analyzed ORCHESTRATE proposal as one durable development plan. The control plane validates and persists the graph before it automatically runs each work item through "
        "IMPLEMENT, independent VERIFY_REVIEW, IMPLEMENT_FIX when needed, deterministic batch integration, premium aggregate BATCH_VERIFY for multi-item batches, integration repair when aggregate review fails, dependent batches, "
        "and, when explicitly authorized, remote checks and merge."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "project_key": {"type": "string"},
            "objective": {"type": "string"},
            "analysis_summary": {
                "type": "string",
                "description": "Concise repository-backed analysis that justifies this batch graph and is persisted with PLAN_CREATED.",
            },
            "repository_path": {"type": "string"},
            "base_revision": {"type": "string"},
            "delivery": {
                "type": "object",
                "description": "Optional explicit authorization to push, open/reuse a PR, wait for checks, merge, verify post-merge checks, and create bounded reviewed follow-up repair PRs when those checks fail.",
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
        "required": ["objective", "analysis_summary", "repository_path", "batches"],
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

_CANCEL_PLAN_SCHEMA = {
    "name": "ai_office_cancel_plan",
    "description": "Cancel a durable plan and all of its non-terminal worker executions.",
    "parameters": {
        "type": "object",
        "properties": {"plan_id": {"type": "string"}},
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

