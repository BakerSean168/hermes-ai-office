from __future__ import annotations

import importlib.util
import io
import json
import unittest
from pathlib import Path
from unittest import mock


PLUGIN_PATH = Path(__file__).with_name("__init__.py")
spec = importlib.util.spec_from_file_location("hermes_ai_office_plugin", PLUGIN_PATH)
assert spec and spec.loader
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


class FakeContext:
    def __init__(self, settings: dict[str, object] | None = None, profile: str = "coder"):
        self.settings = settings or {}
        self.profile_name = profile
        self.hooks: dict[str, object] = {}

    def get_config(self, key: str, default: object = None) -> object:
        return self.settings.get(key, default)

    def register_hook(self, name: str, callback: object) -> None:
        self.hooks[name] = callback


class FakeResponse:
    def __init__(self, value: dict[str, object]):
        self._raw = json.dumps(value).encode("utf-8")

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, *_args: object) -> bytes:
        return self._raw

    def __iter__(self):
        return iter(io.BytesIO(self._raw))


class HermesAiOfficePluginTest(unittest.TestCase):
    def setUp(self) -> None:
        plugin._CTX = FakeContext()
        plugin._PENDING.clear()

    def selected(self, *, runtime: str = "OPENCODE", model: str = "opencode-go/deepseek-v4-flash") -> dict[str, object]:
        return {
            "id": "rlaunch_1",
            "runtimeKind": runtime,
            "policyMode": "PREFER",
            "status": "SELECTED",
            "position": {"id": "pos_1", "name": "Coding Executor", "slug": "coding-executor"},
            "employee": {"id": "emp_1", "name": "DeepSeek V4 Flash @ OpenCode"},
            "employment": {"id": "empl_1", "agreementName": "OpenCode Go"},
            "selectedModel": model,
            "selectedProfile": "anyrouter" if runtime == "CODEX" else None,
            "reasons": ["APPOINTMENT_AND_RUNTIME_SELECTOR_SELECTED"],
        }

    def test_runtime_detection_is_command_aware(self) -> None:
        self.assertEqual(plugin._detect_runtime("opencode run 'fix it'"), "opencode")
        self.assertEqual(plugin._detect_runtime("cd /workspace && codex exec 'review'"), "codex")
        self.assertEqual(plugin._detect_runtime("HOME=/tmp opencode run test"), "opencode")
        self.assertIsNone(plugin._detect_runtime("echo opencode"))
        self.assertIsNone(plugin._detect_runtime("printf 'codex run'"))

    def test_pre_tool_modifies_opencode_with_selected_employee(self) -> None:
        events: list[dict[str, object]] = []
        decision = self.selected()
        with mock.patch.object(plugin, "_resolve_runtime_policy", return_value=decision), mock.patch.object(
            plugin, "_enqueue", side_effect=events.append
        ):
            directive = plugin._on_pre_tool_call(
                tool_name="terminal",
                args={"command": "cd /workspace && opencode run 'fix bug'", "workdir": "/workspace"},
                session_id="session-1",
                task_id="task-1",
                tool_call_id="tool-1",
            )

        self.assertIsInstance(directive, dict)
        self.assertEqual(directive["action"], "modify")
        command = directive["args"]["command"]
        self.assertIn("&& HERMES_OFFICE_DECISION_ID=rlaunch_1", command)
        self.assertIn("opencode run --model opencode-go/deepseek-v4-flash", command)
        self.assertIn("'fix bug'", command)
        self.assertFalse(command.startswith("HERMES_OFFICE_DECISION_ID="))
        self.assertEqual(events[0]["employeeId"], "emp_1")
        self.assertEqual(events[0]["employmentId"], "empl_1")
        self.assertEqual(events[0]["model"], "opencode-go/deepseek-v4-flash")

    def test_existing_model_is_replaced_only_when_policy_selected(self) -> None:
        decision = self.selected(model="opencode-go/deepseek-v4-pro")
        with mock.patch.object(plugin, "_resolve_runtime_policy", return_value=decision), mock.patch.object(
            plugin, "_enqueue"
        ):
            directive = plugin._on_pre_tool_call(
                tool_name="terminal",
                args={"command": "opencode run -m cpa/deepseek-v4-flash task"},
                tool_call_id="tool-2",
            )
        command = directive["args"]["command"]
        self.assertIn("-m opencode-go/deepseek-v4-pro", command)
        self.assertNotIn("cpa/deepseek-v4-flash", command)

    def test_pre_tool_modifies_codex_with_model_and_profile(self) -> None:
        decision = self.selected(runtime="CODEX", model="gpt-5.6-sol")
        with mock.patch.object(plugin, "_resolve_runtime_policy", return_value=decision), mock.patch.object(
            plugin, "_enqueue"
        ):
            directive = plugin._on_pre_tool_call(
                tool_name="terminal",
                args={"command": "codex exec 'review this diff'"},
                tool_call_id="tool-3",
            )
        command = directive["args"]["command"]
        self.assertIn("codex --model gpt-5.6-sol --profile anyrouter exec", command)
        self.assertIn("'review this diff'", command)

    def test_explicit_override_is_respected_in_prefer_mode(self) -> None:
        decision = {
            "id": "rlaunch_override",
            "status": "EXPLICIT_OVERRIDE",
            "selectedModel": "opencode/other-model",
            "position": None,
            "employee": None,
            "employment": None,
            "reasons": ["EXPLICIT_MODEL_HAS_NO_APPOINTED_EMPLOYEE_MATCH"],
        }
        with mock.patch.object(plugin, "_resolve_runtime_policy", return_value=decision), mock.patch.object(
            plugin, "_enqueue"
        ):
            directive = plugin._on_pre_tool_call(
                tool_name="terminal",
                args={"command": "opencode run --model opencode/other-model task"},
                tool_call_id="tool-4",
            )
        self.assertIsNone(directive)

    def test_enforce_blocks_unresolved_or_unavailable_policy(self) -> None:
        plugin._CTX = FakeContext({"runtime_policy.mode": "enforce"})
        blocked = {"id": "rlaunch_block", "status": "BLOCKED", "reasons": ["NO_ELIGIBLE_RUNTIME_EMPLOYEE"]}
        with mock.patch.object(plugin, "_resolve_runtime_policy", return_value=blocked), mock.patch.object(
            plugin, "_enqueue"
        ):
            directive = plugin._on_pre_tool_call(
                tool_name="terminal",
                args={"command": "opencode run task"},
                tool_call_id="tool-5",
            )
        self.assertEqual(directive["action"], "block")
        self.assertIn("no eligible employee", directive["message"].lower())

        with mock.patch.object(plugin, "_resolve_runtime_policy", return_value=None), mock.patch.object(
            plugin, "_enqueue"
        ):
            unavailable = plugin._on_pre_tool_call(
                tool_name="terminal",
                args={"command": "codex exec task"},
                tool_call_id="tool-6",
            )
        self.assertEqual(unavailable["action"], "block")
        self.assertIn("could not reach", unavailable["message"].lower())

    def test_prefer_fails_open_when_policy_service_is_unavailable(self) -> None:
        plugin._CTX = FakeContext({"runtime_policy.mode": "prefer"})
        with mock.patch.object(plugin, "_resolve_runtime_policy", return_value=None), mock.patch.object(
            plugin, "_enqueue"
        ):
            directive = plugin._on_pre_tool_call(
                tool_name="terminal",
                args={"command": "opencode run task"},
                tool_call_id="tool-7",
            )
        self.assertIsNone(directive)

    def test_policy_request_is_bounded_and_omits_prompt(self) -> None:
        captured: dict[str, object] = {}
        decision = self.selected()

        def fake_urlopen(request, timeout: float):
            captured["url"] = request.full_url
            captured["headers"] = dict(request.header_items())
            captured["payload"] = json.loads(request.data.decode("utf-8"))
            captured["timeout"] = timeout
            return FakeResponse(decision)

        with mock.patch.object(plugin.urllib.request, "urlopen", side_effect=fake_urlopen):
            result = plugin._resolve_runtime_policy(
                "opencode",
                "opencode run 'private prompt that must not leave Hermes'",
                {"workdir": "/workspace/project"},
                {"session_id": "session-8", "task_id": "task-8", "tool_call_id": "tool-8"},
            )
        self.assertEqual(result["id"], "rlaunch_1")
        payload = captured["payload"]
        self.assertEqual(payload["runtimeKind"], "OPENCODE")
        self.assertEqual(payload["positionSlug"], "coding-executor")
        self.assertNotIn("private prompt", json.dumps(payload))
        self.assertEqual(payload["commandName"], "opencode run")
        self.assertEqual(payload["metadata"]["profileName"], "coder")
        self.assertEqual(captured["timeout"], 0.8)

    def test_register_exposes_native_hooks(self) -> None:
        ctx = FakeContext()
        with mock.patch.object(plugin, "_ensure_worker"):
            plugin.register(ctx)
        self.assertEqual(
            set(ctx.hooks),
            {"subagent_start", "subagent_stop", "pre_tool_call", "post_tool_call"},
        )


if __name__ == "__main__":
    unittest.main()
