from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
import re
import unittest
from unittest import mock

PLUGIN_PATH = Path(__file__).with_name("__init__.py")
PLUGIN_DIR = PLUGIN_PATH.parent
MODULE_NAME = "hermes_ai_office_plugin"
spec = importlib.util.spec_from_file_location(
    MODULE_NAME,
    PLUGIN_PATH,
    submodule_search_locations=[str(PLUGIN_DIR)],
)
assert spec and spec.loader
plugin = importlib.util.module_from_spec(spec)
plugin.__package__ = MODULE_NAME
plugin.__path__ = [str(PLUGIN_DIR)]
sys.modules[MODULE_NAME] = plugin
spec.loader.exec_module(plugin)


class FakeContext:
    def __init__(self, profile: str = "default"):
        self.profile_name = profile
        self.tools: dict[str, dict[str, object]] = {}
        self.hooks: dict[str, object] = {}

    def register_tool(self, **kwargs: object) -> None:
        self.tools[str(kwargs["name"])] = dict(kwargs)

    def register_hook(self, name: str, callback: object) -> None:
        self.hooks[name] = callback


class PluginTest(unittest.TestCase):
    def setUp(self) -> None:
        plugin._CTX = FakeContext("test-profile")

    def test_plugin_facade_delegates_protocol_and_execution_policy_to_owned_modules(self) -> None:
        source = PLUGIN_PATH.read_text(encoding="utf-8")
        self.assertIn("from .protocol import", source)
        self.assertIn("from .policy import", source)
        self.assertNotIn("_PACKAGE_VERIFY_SCRIPT_RE =", source)
        self.assertNotIn('"name": "ai_office_run_phase"', source)

    def test_register_exposes_only_v3_tools_and_guidance_hook(self) -> None:
        ctx = FakeContext()
        plugin.register(ctx)
        self.assertEqual(set(ctx.hooks), {"pre_llm_call", "pre_tool_call"})
        self.assertEqual(
            set(ctx.tools),
            {
                "ai_office_list_providers",
                "ai_office_run_phase",
                "ai_office_get_execution",
                "ai_office_cancel_execution",
                "ai_office_list_active",
                "ai_office_delegate",
                "ai_office_create_plan",
                "ai_office_get_plan",
                "ai_office_cancel_plan",
                "ai_office_list_plans",
            },
        )
        self.assertNotIn("ai_office_resolve_execution", ctx.tools)

    def test_manifest_indexes_every_registered_tool(self) -> None:
        ctx = FakeContext()
        plugin.register(ctx)
        manifest = PLUGIN_PATH.with_name("plugin.yaml").read_text(encoding="utf-8")
        manifest_tools = set(re.findall(r"^  - (ai_office_[a-z_]+)$", manifest, re.MULTILINE))
        self.assertEqual(manifest_tools, set(ctx.tools))

    def test_run_phase_requires_repository_for_initial_writer(self) -> None:
        result = json.loads(
            plugin._run_development_phase_tool(
                {"phase": "IMPLEMENT", "objective": "Implement it."},
                tool_call_id="missing-repo",
            )
        )
        self.assertFalse(result["ok"])
        self.assertIn("repository_path is required", result["message"])

    def test_run_phase_uses_causal_parent_result_and_no_caller_previous_result_field(self) -> None:
        previous = {
            "executionId": "exec-plan",
            "projectKey": "memo-flow",
            "result": {"finalText": "Plan from durable execution."},
        }
        created = {"executionId": "exec-impl", "projectKey": "memo-flow", "status": "RUNNING"}
        calls: list[tuple[str, dict[str, object]]] = []

        def request(path: str, **kwargs: object):
            calls.append((path, kwargs))
            if path.endswith("/exec-plan"):
                return previous
            return created

        with mock.patch.object(plugin, "_control_plane_request", side_effect=request):
            result = json.loads(
                plugin._run_development_phase_tool(
                    {
                        "phase": "IMPLEMENT",
                        "objective": "Implement approved plan.",
                        "repository_path": "/repo/memo-flow",
                        "previous_execution_id": "exec-plan",
                        "await": False,
                    },
                    session_id="s1",
                    tool_call_id="call-1",
                )
            )
        self.assertTrue(result["ok"])
        payload = calls[-1][1]["payload"]
        self.assertEqual(payload["context"]["previousExecutionId"], "exec-plan")
        self.assertEqual(payload["context"]["previousResult"], "Plan from durable execution.")
        self.assertEqual(payload["projectKey"], "memo-flow")
        self.assertNotIn("transportMode", payload.get("override", {}))
        self.assertNotIn("previous_result", plugin._RUN_PHASE_SCHEMA["parameters"]["properties"])

    def test_run_phase_preserves_policy_hints_and_bounded_overrides(self) -> None:
        with mock.patch.object(
            plugin,
            "_control_plane_request",
            return_value={"executionId": "exec-1", "status": "RUNNING"},
        ) as request:
            result = json.loads(
                plugin._run_development_phase_tool(
                    {
                        "phase": "IMPLEMENT",
                        "objective": "Implement.",
                        "repository_path": "/repo/project",
                        "complexity_hint": "HIGH",
                        "risk_hint": "MEDIUM",
                        "quality_hint": "PREMIUM",
                        "budget_hint": "LOW",
                        "parallelism": 3,
                        "preferred_backend": "openhands-builtin",
                        "preferred_model_class": "implementation-efficient",
                        "await": False,
                    },
                    tool_call_id="call-hints",
                )
            )
        self.assertTrue(result["ok"])
        payload = request.call_args.kwargs["payload"]
        self.assertEqual(payload["hints"]["parallelism"], 3)
        self.assertEqual(payload["override"]["backend"], "openhands-builtin")
        self.assertEqual(payload["override"]["modelClass"], "implementation-efficient")

    def test_list_active_filters_terminal_executions(self) -> None:
        with mock.patch.object(
            plugin,
            "_control_plane_request",
            return_value={
                "items": [
                    {"executionId": "a", "status": "RUNNING"},
                    {"executionId": "b", "status": "PAUSED"},
                    {"executionId": "c", "status": "SUCCEEDED"},
                ]
            },
        ):
            result = json.loads(plugin._list_active_development_executions_tool({}))
        self.assertEqual(result["count"], 2)
        self.assertEqual([item["executionId"] for item in result["items"]], ["a", "b"])

    def test_provider_tool_reads_litellm_registry_only(self) -> None:
        registry = {
            "authority": "LITELLM",
            "health": "OK",
            "adminUrl": "https://oracle.example/ui/",
            "credentials": {"count": 2},
            "deployments": {
                "count": 3,
                "active": 2,
                "paused": 1,
                "groups": {"deepseek-v4-flash": 2},
                "items": [
                    {
                        "id": "d1",
                        "group": "deepseek-v4-flash",
                        "providerKey": "teamorouter",
                        "commercialType": "FREE",
                        "blocked": False,
                    },
                    {
                        "id": "d2",
                        "group": "deepseek-v4-flash",
                        "providerKey": "opencode-go",
                        "commercialType": "SUBSCRIPTION",
                        "blocked": False,
                    },
                ],
            },
            "aliases": {"implementation-efficient": "deepseek-v4-flash"},
        }
        with mock.patch.object(plugin, "_control_plane_request", return_value=registry) as request:
            result = json.loads(plugin._list_shared_providers_tool({}))
        self.assertTrue(result["ok"])
        self.assertEqual(result["authority"], "LITELLM")
        self.assertEqual(result["providers"][0]["providerKey"], "opencode-go")
        request.assert_called_once_with("/api/v3/development/model-registry", timeout=5.0)

    def test_delegate_plan_is_thin_idempotent_and_returns_orchestrating_plan(self) -> None:
        args = {
            "project_key": "bodysense",
            "objective": "Implement the current active plan.",
            "repository_path": "/home/dev/projects/bodysense",
            "active_plan_path": "docs/plan/active/current.md",
        }
        with mock.patch.object(
            plugin,
            "_control_plane_request",
            return_value={
                "planId": "plan-delegated",
                "status": "ORCHESTRATING",
                "orchestration": {
                    "executionId": "exec-orchestrate",
                    "phase": "ORCHESTRATE",
                    "status": "RUNNING",
                    "selection": {"backend": "openhands-builtin", "modelClass": "planning-premium"},
                },
                "batches": [],
            },
        ) as request:
            first = json.loads(plugin._delegate_development_plan_tool(args, tool_call_id="call-a"))
            first_key = request.call_args.kwargs["idempotency_key"]
            second = json.loads(plugin._delegate_development_plan_tool(args, tool_call_id="call-b"))
            second_key = request.call_args.kwargs["idempotency_key"]
        self.assertTrue(first["ok"])
        self.assertEqual(first["status"], "ORCHESTRATING")
        self.assertEqual(first["orchestration"]["backend"], "openhands-builtin")
        self.assertEqual(first_key, second_key)
        self.assertEqual(request.call_args.args[0], "/api/v3/development/delegations")
        payload = request.call_args.kwargs["payload"]
        self.assertNotIn("batches", payload)
        self.assertNotIn("analysisSummary", payload)
        self.assertIn("Active plan to inspect first", payload["objective"])

    def test_create_plan_uses_content_identity_and_durable_plan_api(self) -> None:
        args = {
            "project_key": "pixel-agents",
            "objective": "Add a small endpoint.",
            "analysis_summary": "The endpoint is isolated and can be implemented in one batch.",
            "repository_path": "/repo/pixel-agents",
            "delivery": {
                "branch": "feat/durable-delivery",
                "target_branch": "main",
                "auto_merge": True,
                "merge_method": "merge",
            },
            "batches": [
                {
                    "key": "batch-1",
                    "title": "Endpoint",
                    "work_items": [
                        {
                            "key": "item-1",
                            "title": "Implement endpoint",
                            "objective": "Implement and test it.",
                            "acceptance_criteria": ["Focused test passes."],
                        }
                    ],
                }
            ],
        }
        with mock.patch.object(
            plugin,
            "_control_plane_request",
            return_value={"planId": "plan-1", "status": "RUNNING"},
        ) as request:
            first = json.loads(plugin._create_development_plan_tool(args, tool_call_id="call-a"))
            first_key = request.call_args.kwargs["idempotency_key"]
            second = json.loads(plugin._create_development_plan_tool(args, tool_call_id="call-b"))
            second_key = request.call_args.kwargs["idempotency_key"]
        self.assertTrue(first["ok"])
        self.assertTrue(second["ok"])
        self.assertEqual(first_key, second_key)
        self.assertEqual(request.call_args.args[0], "/api/v3/development/plans")
        payload = request.call_args.kwargs["payload"]
        self.assertEqual(
            payload["analysisSummary"],
            "The endpoint is isolated and can be implemented in one batch.",
        )
        self.assertEqual(payload["delivery"]["branch"], "feat/durable-delivery")
        self.assertTrue(payload["delivery"]["autoMerge"])

    def test_legacy_phase_tool_cannot_bypass_durable_orchestration(self) -> None:
        result = json.loads(
            plugin._run_development_phase_tool(
                {"phase": "ORCHESTRATE", "objective": "Create a plan."}
            )
        )
        self.assertFalse(result["ok"])
        self.assertIn("invalid development phase", result["message"])

    def test_create_plan_requires_explicit_auto_merge_authorization(self) -> None:
        result = json.loads(
            plugin._create_development_plan_tool(
                {
                    "objective": "Ship it.",
                    "analysis_summary": "One bounded delivery batch is sufficient.",
                    "repository_path": "/repo/project",
                    "delivery": {"branch": "feat/ship", "auto_merge": False},
                    "batches": [
                        {
                            "key": "batch",
                            "title": "Batch",
                            "work_items": [
                                {"key": "item", "title": "Item", "objective": "Implement."}
                            ],
                        }
                    ],
                }
            )
        )
        self.assertFalse(result["ok"])
        self.assertIn("explicitly true", result["message"])

    def test_get_plan_compacts_execution_results_for_hermes_context(self) -> None:
        plan = {
            "planId": "plan-1",
            "status": "SUCCEEDED",
            "currentRevision": "abc123",
            "batches": [
                {
                    "key": "batch-1",
                    "status": "SUCCEEDED",
                    "workItems": [
                        {
                            "key": "item-1",
                            "status": "SUCCEEDED",
                            "executions": [
                                {
                                    "executionId": "exec-1",
                                    "phase": "VERIFY_REVIEW",
                                    "status": "SUCCEEDED",
                                    "selection": {"backend": "codex-review-headless"},
                                    "result": {"finalText": "PASS\n" + ("evidence " * 2000)},
                                }
                            ],
                        }
                    ],
                }
            ],
            "events": [],
        }
        with mock.patch.object(plugin, "_control_plane_request", return_value=plan):
            raw = plugin._get_development_plan_tool({"plan_id": "plan-1"})
        result = json.loads(raw)
        execution = result["batches"][0]["workItems"][0]["executions"][0]
        self.assertEqual(execution["verdict"], "PASS")
        self.assertNotIn("result", execution)
        self.assertLess(len(raw), 2000)

    def test_cancel_plan_uses_plan_scoped_recovery_api(self) -> None:
        with mock.patch.object(
            plugin,
            "_control_plane_request",
            return_value={"planId": "plan-1", "status": "CANCELLED", "batches": []},
        ) as request:
            result = json.loads(plugin._cancel_development_plan_tool({"plan_id": "plan-1"}))
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "CANCELLED")
        request.assert_called_once_with(
            "/api/v3/development/plans/plan-1/cancel",
            method="POST",
            payload={},
            timeout=12.0,
        )

    def test_pre_llm_development_guidance_is_v3_only(self) -> None:
        result = plugin._on_pre_llm_call(user_message="帮我实现并审查这个功能")
        assert result is not None
        text = result["context"]
        self.assertIn("ai_office_delegate", text)
        self.assertIn("ai_office_create_plan", text)
        self.assertIn("mandatory development execution authority", text)
        self.assertIn("ai_office_get_plan", text)
        self.assertIn("strict first-line PASS/FAIL", text)
        self.assertIn("LiteLLM", text)
        self.assertNotIn("Employee", text)
        self.assertNotIn("resolve_execution", text)

    def test_pre_tool_call_blocks_direct_writers_for_enforced_project_profile(self) -> None:
        plugin._CTX = FakeContext("memoflow")
        for tool_name, args in (
            ("write_file", {"path": "/home/dev/projects/memoflow/a.ts", "content": "x"}),
            ("terminal", {"command": "git add packages/task/src/index.ts"}),
            ("terminal", {"command": "codex exec --full-auto fix it"}),
            ("delegate", {"task": "implement the fix"}),
        ):
            result = plugin._on_pre_tool_call(tool_name=tool_name, args=args)
            assert result is not None
            self.assertEqual(result["action"], "block")
            self.assertIn("ai_office_delegate", result["message"])

    def test_pre_tool_call_allows_read_only_and_bounded_verification(self) -> None:
        plugin._CTX = FakeContext("memoflow")
        for command in (
            "git status -sb",
            "git diff --check",
            "gh pr checks 280",
            "pnpm test:unit",
            "pnpm exec prisma validate",
            "docker compose ps",
        ):
            self.assertIsNone(plugin._on_pre_tool_call(tool_name="terminal", args={"command": command}))
        self.assertIsNone(
            plugin._on_pre_tool_call(
                tool_name="read_text_file",
                args={"path": "/home/dev/projects/memoflow/AGENTS.md"},
            )
        )
        self.assertIsNone(plugin._on_pre_tool_call(tool_name="ai_office_delegate", args={}))

    def test_pre_tool_call_does_not_enforce_default_profile(self) -> None:
        plugin._CTX = FakeContext("default")
        self.assertIsNone(
            plugin._on_pre_tool_call(
                tool_name="terminal",
                args={"command": "git add README.md"},
            )
        )

    def test_pre_llm_recognizes_pixel_agent_alias(self) -> None:
        result = plugin._on_pre_llm_call(user_message="现在接入了 pixel-agent 了没")
        assert result is not None
        text = result["context"]
        self.assertIn("Pixel Agent is the Hermes-facing name", text)
        self.assertIn("ai_office_delegate", text)

    def test_pre_llm_provider_guidance_uses_litellm_snapshot(self) -> None:
        with mock.patch.object(
            plugin,
            "_control_plane_request",
            return_value={
                "credentials": {"count": 3},
                "deployments": {"count": 9, "active": 6, "paused": 3},
            },
        ):
            result = plugin._on_pre_llm_call(user_message="AI Office 当前有哪些可用供应商")
        assert result is not None
        self.assertIn("credentials=3", result["context"])
        self.assertIn("active=6", result["context"])

    def test_plugin_source_contains_no_legacy_execution_or_workforce_surface(self) -> None:
        source = PLUGIN_PATH.read_text(encoding="utf-8")
        for forbidden in (
            "ai_office_resolve_execution",
            "/api/v2/",
            "providerHubConnectionId",
            "runtime_spawn_requested",
            "employmentId",
        ):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
