from __future__ import annotations

import importlib.util
import io
import json
import os
import tempfile
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

    def test_gateway_selected_opencode_model_installs_profile_local_provider_config(self) -> None:
        decision = self.selected(model="hermes-office/employment:empl_custom")
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(
            os.environ, {"HERMES_HOME": root}
        ), mock.patch.object(plugin, "_resolve_runtime_policy", return_value=decision), mock.patch.object(
            plugin, "_enqueue"
        ):
            plugin._CTX = FakeContext(profile="coder")
            directive = plugin._on_pre_tool_call(
                tool_name="terminal",
                args={"command": "opencode run 'ship it'"},
                tool_call_id="tool-gateway-opencode",
            )
            self.assertEqual(directive["action"], "modify")
            self.assertIn(
                "opencode run --model hermes-office/employment:empl_custom",
                directive["args"]["command"],
            )
            for home in [Path(root) / "home", Path(root) / "profiles" / "coder" / "home"]:
                config = json.loads((home / ".config" / "opencode" / "opencode.json").read_text())
                provider = config["provider"]["hermes-office"]
                self.assertEqual(provider["options"]["baseURL"], "http://127.0.0.1:4000/v1")
                self.assertEqual(
                    provider["options"]["apiKey"],
                    "{file:/opt/data/secrets/litellm-runtime.key}",
                )
                self.assertIn("employment:empl_custom", provider["models"])

    def test_gateway_selected_codex_profile_injects_runtime_key_by_file_reference(self) -> None:
        decision = self.selected(runtime="CODEX", model="employment:empl_custom")
        decision["selectedProfile"] = "hermes-office"
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(
            os.environ, {"HERMES_HOME": root}
        ), mock.patch.object(plugin, "_resolve_runtime_policy", return_value=decision), mock.patch.object(
            plugin, "_enqueue"
        ):
            plugin._CTX = FakeContext(profile="reviewer")
            directive = plugin._on_pre_tool_call(
                tool_name="terminal",
                args={"command": "codex exec 'review'"},
                tool_call_id="tool-gateway-codex",
            )
            command = directive["args"]["command"]
            self.assertIn("--model employment:empl_custom --profile hermes-office", command)
            self.assertIn(
                'HERMES_LITELLM_RUNTIME_KEY="$(cat /opt/data/secrets/litellm-runtime.key)"',
                command,
            )
            self.assertNotIn("test-master", command)
            for home in [Path(root) / "home", Path(root) / "profiles" / "reviewer" / "home"]:
                text = (home / ".codex" / "config.toml").read_text()
                self.assertIn("[model_providers.hermes-office]", text)
                self.assertIn('env_key = "HERMES_LITELLM_RUNTIME_KEY"', text)
                self.assertIn("[profiles.hermes-office]", text)

    def test_native_opencode_access_materializes_provider_config_without_plaintext_key(self) -> None:
        decision = self.selected(model="hao-custom-team/alpha")
        decision["selectedAccess"] = {
            "id": "raccess_1",
            "adapterKind": "NATIVE_CONFIG",
            "providerRef": "hao-custom-team",
            "baseUrl": "https://proxy.example.com/v1",
            "credentialRef": "HERMES_AI_OFFICE_TEAM_API_KEY",
            "protocol": "openai-chat-completions",
            "config": {"managedProvider": True, "package": "@ai-sdk/openai-compatible"},
        }
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(
            os.environ, {"HERMES_HOME": root}
        ), mock.patch.object(plugin, "_credential_value", return_value="native-secret-value"), mock.patch.object(
            plugin, "_resolve_runtime_policy", return_value=decision
        ), mock.patch.object(plugin, "_enqueue"):
            plugin._CTX = FakeContext(profile="coder")
            directive = plugin._on_pre_tool_call(
                tool_name="terminal",
                args={"command": "opencode run 'ship it'"},
                tool_call_id="tool-native-opencode",
            )
            self.assertEqual(directive["action"], "modify")
            self.assertIn("opencode run --model hao-custom-team/alpha", directive["args"]["command"])
            self.assertNotIn("native-secret-value", directive["args"]["command"])
            for home in [Path(root) / "home", Path(root) / "profiles" / "coder" / "home"]:
                config = json.loads((home / ".config" / "opencode" / "opencode.json").read_text())
                provider = config["provider"]["hao-custom-team"]
                self.assertEqual(provider["options"]["baseURL"], "https://proxy.example.com/v1")
                self.assertTrue(provider["options"]["apiKey"].startswith("{file:"))
                self.assertNotIn("native-secret-value", json.dumps(config))
                self.assertIn("alpha", provider["models"])
            secret_files = list((Path(root) / "secrets" / "hermes-ai-office").glob("*.key"))
            self.assertEqual(len(secret_files), 1)
            self.assertEqual(secret_files[0].read_text(), "native-secret-value")
            self.assertEqual(secret_files[0].stat().st_mode & 0o777, 0o600)

    def test_native_codex_access_uses_named_profile_and_env_key_file(self) -> None:
        decision = self.selected(runtime="CODEX", model="gpt-5.6-sol")
        decision["selectedProfile"] = "hao-anyrouter-a1b2c3"
        decision["selectedAccess"] = {
            "id": "raccess_2",
            "adapterKind": "NATIVE_CONFIG",
            "providerRef": "hao-anyrouter-1234",
            "baseUrl": "https://anyrouter.top/v1",
            "credentialRef": "ANYROUTER_API_KEY",
            "protocol": "openai-responses",
            "config": {"wireApi": "responses"},
        }
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(
            os.environ, {"HERMES_HOME": root}
        ), mock.patch.object(plugin, "_credential_value", return_value="codex-native-secret"), mock.patch.object(
            plugin, "_resolve_runtime_policy", return_value=decision
        ), mock.patch.object(plugin, "_enqueue"):
            plugin._CTX = FakeContext(profile="reviewer")
            directive = plugin._on_pre_tool_call(
                tool_name="terminal",
                args={"command": "codex exec 'review'"},
                tool_call_id="tool-native-codex",
            )
            command = directive["args"]["command"]
            self.assertIn("codex --profile hao-anyrouter-a1b2c3 exec", command)
            self.assertNotIn("--model", command)
            self.assertIn('ANYROUTER_API_KEY="$(cat ', command)
            self.assertNotIn("codex-native-secret", command)
            for home in [Path(root) / "home", Path(root) / "profiles" / "reviewer" / "home"]:
                text = (home / ".codex" / "config.toml").read_text()
                self.assertIn('[model_providers."hao-anyrouter-1234"]', text)
                self.assertIn('env_key = "ANYROUTER_API_KEY"', text)
                self.assertIn('[profiles."hao-anyrouter-a1b2c3"]', text)
                self.assertIn('model = "gpt-5.6-sol"', text)
                self.assertNotIn("codex-native-secret", text)

    def test_imported_codex_access_materializes_profile_from_existing_provider(self) -> None:
        decision = self.selected(runtime="CODEX", model="gpt-5.6-sol")
        decision["selectedProfile"] = "anyrouter"
        decision["selectedAccess"] = {
            "id": "raccess_imported",
            "adapterKind": "NATIVE_CONFIG",
            "providerRef": "anyrouter",
            "baseUrl": None,
            "credentialRef": None,
            "protocol": None,
            "config": {"importedFrom": "MODEL_OFFERING_RUNTIME_SELECTOR"},
        }
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(
            os.environ, {"HERMES_HOME": root}
        ), mock.patch.object(plugin, "_credential_value", return_value="existing-provider-secret"), mock.patch.object(
            plugin, "_resolve_runtime_policy", return_value=decision
        ), mock.patch.object(plugin, "_enqueue"):
            global_config = Path(root) / "home" / ".codex" / "config.toml"
            global_config.parent.mkdir(parents=True, exist_ok=True)
            global_config.write_text(
                '[model_providers.anyrouter]\n'
                'name = "AnyRouter"\n'
                'base_url = "https://anyrouter.example/v1"\n'
                'env_key = "ANYROUTER_API_KEY"\n'
                'wire_api = "responses"\n',
                encoding="utf-8",
            )
            plugin._CTX = FakeContext(profile="reviewer")
            directive = plugin._on_pre_tool_call(
                tool_name="terminal",
                args={"command": "codex exec 'review'"},
                tool_call_id="tool-imported-codex",
            )
            command = directive["args"]["command"]
            self.assertIn("codex --profile anyrouter exec", command)
            self.assertIn('ANYROUTER_API_KEY="$(cat ', command)
            self.assertNotIn("existing-provider-secret", command)
            for home in [Path(root) / "home", Path(root) / "profiles" / "reviewer" / "home"]:
                text = (home / ".codex" / "config.toml").read_text()
                self.assertIn('[profiles."anyrouter"]', text)
                self.assertIn('model = "gpt-5.6-sol"', text)
                self.assertIn('base_url = "https://anyrouter.example/v1"', text)
                self.assertIn('env_key = "ANYROUTER_API_KEY"', text)
                self.assertNotIn("existing-provider-secret", text)

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
