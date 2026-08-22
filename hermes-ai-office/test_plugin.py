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
        self.tools: dict[str, dict[str, object]] = {}

    def get_config(self, key: str, default: object = None) -> object:
        return self.settings.get(key, default)

    def register_hook(self, name: str, callback: object) -> None:
        self.hooks[name] = callback

    def register_tool(self, **kwargs: object) -> None:
        self.tools[str(kwargs["name"])] = dict(kwargs)


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
        plugin._PROVIDER_CONNECTION_CACHE.clear()
        plugin._API_SUCCESS_LAST_RECORDED.clear()
        plugin._PLACEMENT_RECONCILE_LAST = 0.0

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
        self.assertEqual(
            plugin._detect_runtime(
                "HOME=/tmp /home/ubuntu/projects/agent-harness/bin/harnessctl exec --project /repo dsh -- --patch p.yml task"
            ),
            "dsh",
        )
        self.assertEqual(
            plugin._detect_runtime("/home/ubuntu/projects/agent-harness/bin/harnessctl exec --project /repo claude -- task"),
            "claude",
        )
        self.assertIsNone(plugin._detect_runtime("echo opencode"))
        self.assertIsNone(plugin._detect_runtime("printf 'codex run'"))

    def test_managed_harness_launch_keeps_telemetry_without_legacy_restaffing(self) -> None:
        events: list[dict[str, object]] = []
        command = (
            "HOME=/opt/data/profiles/memoflow/home "
            "/home/ubuntu/projects/agent-harness/bin/harnessctl exec "
            "--project /home/ubuntu/projects/memoflow codex -- --profile team exec task"
        )
        with mock.patch.object(plugin, "_resolve_runtime_policy") as policy, mock.patch.object(
            plugin, "_enqueue", side_effect=events.append
        ):
            directive = plugin._on_pre_tool_call(
                tool_name="terminal",
                args={"command": command, "workdir": "/home/ubuntu/projects/memoflow"},
                tool_call_id="managed-1",
            )
        self.assertIsNone(directive)
        policy.assert_not_called()
        self.assertEqual(plugin._PENDING["managed-1"]["runtime"], "codex")
        self.assertEqual(
            plugin._PENDING["managed-1"]["policyStatus"],
            "PRE_RESOLVED_CAPABILITY_PLANE",
        )
        self.assertEqual(events[0]["event"], "runtime_spawn_requested")

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
            home = Path(root) / "profiles" / "coder" / "home"
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
            home = Path(root) / "profiles" / "reviewer" / "home"
            text = (home / ".codex" / "config.toml").read_text()
            self.assertIn("[model_providers.hermes-office]", text)
            self.assertIn('env_key = "HERMES_LITELLM_RUNTIME_KEY"', text)
            profile_text = (home / ".codex" / "hermes-office.config.toml").read_text()
            self.assertIn('model_provider = "hermes-office"', profile_text)

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
            home = Path(root) / "profiles" / "coder" / "home"
            config = json.loads((home / ".config" / "opencode" / "opencode.json").read_text())
            provider = config["provider"]["hao-custom-team"]
            self.assertEqual(provider["options"]["baseURL"], "https://proxy.example.com/v1")
            self.assertTrue(provider["options"]["apiKey"].startswith("{file:"))
            self.assertNotIn("native-secret-value", json.dumps(config))
            self.assertIn("alpha", provider["models"])
            secret_files = list(
                (Path(root) / "profiles" / "coder" / "secrets" / "hermes-ai-office").glob("*.key")
            )
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
            home = Path(root) / "profiles" / "reviewer" / "home"
            text = (home / ".codex" / "config.toml").read_text()
            self.assertIn('[model_providers."hao-anyrouter-1234"]', text)
            self.assertIn('env_key = "ANYROUTER_API_KEY"', text)
            self.assertNotIn("codex-native-secret", text)
            profile_text = (home / ".codex" / "hao-anyrouter-a1b2c3.config.toml").read_text()
            self.assertIn('model_provider = "hao-anyrouter-1234"', profile_text)
            self.assertIn('model = "gpt-5.6-sol"', profile_text)

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
            profile_config = Path(root) / "profiles" / "reviewer" / "home" / ".codex" / "config.toml"
            profile_config.parent.mkdir(parents=True, exist_ok=True)
            profile_config.write_text(
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
            home = Path(root) / "profiles" / "reviewer" / "home"
            text = (home / ".codex" / "config.toml").read_text()
            self.assertIn('base_url = "https://anyrouter.example/v1"', text)
            self.assertIn('env_key = "ANYROUTER_API_KEY"', text)
            self.assertNotIn("existing-provider-secret", text)
            profile_text = (home / ".codex" / "anyrouter.config.toml").read_text()
            self.assertIn('model_provider = "anyrouter"', profile_text)
            self.assertIn('model = "gpt-5.6-sol"', profile_text)

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

    def test_prefer_blocks_when_selected_first_class_access_is_not_ready(self) -> None:
        decision = self.selected(runtime="CODEX", model="gpt-5.6-sol")
        decision["selectedProfile"] = "missing-profile"
        decision["selectedAccess"] = {
            "id": "raccess_missing",
            "adapterKind": "NATIVE_CONFIG",
            "providerRef": "missing-provider",
            "baseUrl": None,
            "credentialRef": None,
            "config": {},
        }
        with mock.patch.object(plugin, "_resolve_runtime_policy", return_value=decision), mock.patch.object(
            plugin, "_enqueue"
        ):
            directive = plugin._on_pre_tool_call(
                tool_name="terminal",
                args={"command": "codex exec task"},
                tool_call_id="tool-access-not-ready",
            )
        self.assertEqual(directive["action"], "block")
        self.assertIn("runtime access is not ready", directive["message"].lower())

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

    def test_add_provider_schema_exposes_supply_economics_tags(self) -> None:
        properties = plugin._ADD_PROVIDER_SCHEMA["parameters"]["properties"]
        self.assertEqual(properties["supply_origin"]["enum"], [
            "OFFICIAL", "COMMERCIAL_RELAY", "COMMUNITY_RELAY", "EVENT_GRANT",
            "PERSONAL_HOSTED", "INTERNAL_POOL", "UNKNOWN",
        ])
        self.assertIn("SUBSCRIPTION", properties["commercial_type"]["enum"])
        self.assertIn("MANUAL_ONLY", properties["routing_policy"]["enum"])

    def test_add_shared_provider_stores_secret_only_in_hermes_and_sends_safe_hub_payload(self) -> None:
        captured: dict[str, object] = {}

        def control(path: str, **kwargs: object) -> dict[str, object]:
            captured["path"] = path
            captured["payload"] = kwargs.get("payload")
            return {"id": "pconn_worldclaw", "health": "READY"}

        with mock.patch.object(plugin, "_discover_shared_models", return_value=("https://worldclawpro.ai/v1", ["gpt-test"])), mock.patch.object(
            plugin, "_save_shared_credential"
        ) as save_credential, mock.patch.object(
            plugin, "_save_shared_custom_provider"
        ), mock.patch.object(
            plugin, "_register_shared_policy_workforce", return_value=[]
        ), mock.patch.object(plugin, "_control_plane_request", side_effect=control):
            result = json.loads(
                plugin._add_shared_provider_tool(
                    {
                        "url": "https://worldclawpro.ai",
                        "api_key": "super-secret-key",
                        "name": "worldclaw",
                        "website_url": "https://worldclawpro.ai/",
                        "supply_origin": "COMMUNITY_RELAY",
                        "commercial_type": "SPONSORED",
                        "routing_policy": "AUTO",
                    }
                )
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["providerKey"], "worldclaw")
        self.assertEqual(result["websiteUrl"], "https://worldclawpro.ai")
        self.assertEqual(result["economics"]["supplyOrigin"], "COMMUNITY_RELAY")
        self.assertEqual(result["economics"]["commercialType"], "SPONSORED")
        save_credential.assert_called_once_with("WORLDCLAW_API_KEY", "super-secret-key")
        payload = captured["payload"]
        self.assertIsInstance(payload, dict)
        self.assertEqual(payload["credentialRef"], "WORLDCLAW_API_KEY")
        self.assertEqual(payload["websiteUrl"], "https://worldclawpro.ai")
        self.assertNotIn("super-secret-key", json.dumps(payload))
        self.assertNotIn("super-secret-key", json.dumps(result))

    def test_deepseek_official_api_is_brain_only_and_excluded_from_ai_office(self) -> None:
        with mock.patch.object(plugin, "_discover_shared_models") as discover, mock.patch.object(
            plugin, "_save_shared_credential"
        ) as save:
            rejected = json.loads(
                plugin._add_shared_provider_tool(
                    {
                        "url": "https://api.deepseek.com/v1",
                        "api_key": "never-store-this-value",
                        "name": "deepseek",
                    }
                )
            )
        self.assertFalse(rejected["ok"])
        self.assertIn("brain", rejected["message"].lower())
        discover.assert_not_called()
        save.assert_not_called()

        hub = {
            "items": [
                {
                    "id": "deepseek-official",
                    "provider_key": "deepseek",
                    "base_url": "https://api.deepseek.com/v1",
                    "admin_state": "ENABLED",
                    "routable": True,
                },
                {
                    "id": "charity",
                    "provider_key": "charity-relay",
                    "base_url": "https://relay.example/v1",
                    "admin_state": "ENABLED",
                    "routable": True,
                },
            ]
        }
        with mock.patch.object(plugin, "_control_plane_request", return_value=hub), mock.patch.object(
            plugin, "_provider_connection_credential_ready", return_value=True
        ):
            self.assertEqual(plugin._available_execution_provider_ids("coder"), ["charity"])

    def test_list_shared_providers_reads_litellm_registry_state(self) -> None:
        with mock.patch.object(
            plugin,
            "_control_plane_request",
            return_value={
                "authority": "LITELLM",
                "health": "OK",
                "adminUrl": "https://oracle.example:10446/ui/",
                "credentials": {"count": 1},
                "deployments": {
                    "count": 1,
                    "active": 1,
                    "paused": 0,
                    "groups": {"gpt-test": 1},
                    "items": [
                        {
                            "id": "dep-worldclaw",
                            "group": "gpt-test",
                            "model": "openai/gpt-test",
                            "credential": "ai-office-worldclaw",
                            "blocked": False,
                            "providerKey": "worldclaw",
                            "commercialType": "METERED",
                            "protocol": "openai-chat-completions",
                        }
                    ],
                },
                "aliases": {},
            },
        ):
            result = json.loads(plugin._list_shared_providers_tool({}))
        self.assertTrue(result["ok"])
        self.assertEqual(result["authority"], "LITELLM")
        self.assertEqual(result["providers"][0]["providerKey"], "worldclaw")
        self.assertEqual(result["providers"][0]["commercialTypes"], ["METERED"])

    def test_register_exposes_native_hooks(self) -> None:
        ctx = FakeContext()
        with mock.patch.object(plugin, "_ensure_worker"):
            plugin.register(ctx)
        self.assertEqual(
            set(ctx.hooks),
            {
                "subagent_start",
                "subagent_stop",
                "pre_llm_call",
                "post_api_request",
                "api_request_error",
                "pre_tool_call",
                "post_tool_call",
            },
        )
        self.assertEqual(
            set(ctx.tools),
            {
                "ai_office_list_providers",
                "ai_office_run_phase",
                "ai_office_get_execution",
                "ai_office_continue_execution",
                "ai_office_cancel_execution",
                "ai_office_list_active",
                "ai_office_resolve_execution",
            },
        )

    def test_set_provider_state_resolves_unambiguous_key_without_secret(self) -> None:
        with mock.patch.object(plugin, "_control_plane_request", side_effect=[
            {"items": [{"id": "conn-1", "provider_key": "worldclaw"}]},
            {"ok": True},
        ]) as request:
            result = json.loads(plugin._set_provider_state_tool({"provider_key": "worldclaw", "enabled": False, "reason": "maintenance"}))
        self.assertTrue(result["ok"])
        self.assertEqual(request.call_args.args[0], "/api/v2/commands/provider-connections/conn-1/control")
        self.assertEqual(request.call_args.kwargs["payload"], {"enabled": False, "reason": "maintenance"})

    def test_pending_carries_provider_hub_connection_id(self) -> None:
        decision = self.selected()
        decision["selectedAccess"] = {"config": {"providerHubConnectionId": "conn-9"}}
        with mock.patch.object(plugin, "_resolve_runtime_policy", return_value=decision), mock.patch.object(plugin, "_enqueue"):
            plugin._on_pre_tool_call(tool_name="terminal", args={"command": "opencode run test"}, tool_call_id="carry-1")
        self.assertEqual(plugin._PENDING["carry-1"]["providerHubConnectionId"], "conn-9")

    def test_list_provider_reads_litellm_registry_and_preserves_economics_metadata(self) -> None:
        registry = {
            "authority": "LITELLM",
            "health": "OK",
            "adminUrl": "https://oracle.example:10446/ui/",
            "credentials": {"count": 2, "items": []},
            "deployments": {
                "count": 3,
                "active": 2,
                "paused": 1,
                "groups": {"gpt-5.6-sol": 2, "deepseek-v4-flash": 1},
                "items": [
                    {
                        "id": "dep-free",
                        "group": "deepseek-v4-flash",
                        "model": "openai/deepseek-v4-flash-free",
                        "credential": "ai-office-teamorouter",
                        "order": 1,
                        "blocked": False,
                        "providerKey": "teamorouter-gpt-5-6",
                        "commercialType": "OTHER",
                        "protocol": "openai-chat-completions",
                    },
                    {
                        "id": "dep-sub",
                        "group": "deepseek-v4-flash",
                        "model": "openai/deepseek-v4-flash",
                        "credential": "ai-office-opencode-go",
                        "order": 2,
                        "blocked": False,
                        "providerKey": "opencode-go",
                        "commercialType": "SUBSCRIPTION",
                        "protocol": "openai-chat-completions",
                    },
                    {
                        "id": "dep-paused",
                        "group": "gpt-5.6-sol",
                        "model": "openai/gpt-5.6-sol",
                        "credential": "ai-office-anyrouter",
                        "order": 20,
                        "blocked": True,
                        "providerKey": "anyrouter",
                        "commercialType": "METERED",
                        "protocol": "openai-responses",
                    },
                ],
            },
            "aliases": {"implementation-efficient": "deepseek-v4-flash"},
        }
        with mock.patch.object(plugin, "_control_plane_request", return_value=registry) as request:
            result = json.loads(plugin._list_shared_providers_tool({}))
        self.assertTrue(result["ok"])
        self.assertEqual(result["authority"], "LITELLM")
        self.assertEqual(result["adminUrl"], "https://oracle.example:10446/ui/")
        self.assertEqual(result["summary"]["deployments"], 3)
        self.assertEqual(result["summary"]["active"], 2)
        self.assertEqual(result["summary"]["paused"], 1)
        providers = {item["providerKey"]: item for item in result["providers"]}
        self.assertEqual(providers["opencode-go"]["commercialTypes"], ["SUBSCRIPTION"])
        self.assertEqual(providers["anyrouter"]["paused"], 1)
        self.assertIn("deepseek-v4-flash", result["modelGroups"])
        request.assert_called_once_with("/api/v3/development/model-registry", timeout=5.0)
        self.assertIn("LiteLLM", plugin._LIST_PROVIDERS_SCHEMA["description"])

    def test_provider_mutation_tools_are_not_registered_in_v3_plugin_surface(self) -> None:
        ctx = FakeContext()
        with mock.patch.object(plugin, "_ensure_worker"):
            plugin.register(ctx)
        self.assertNotIn("ai_office_add_provider", ctx.tools)
        self.assertNotIn("ai_office_set_provider_state", ctx.tools)
        self.assertIn("ai_office_list_providers", ctx.tools)

    def test_provider_attempt_sync_success_exact_payload(self) -> None:
        plugin._PENDING["success"] = {"providerHubConnectionId": "conn-1", "runtime": "opencode", "background": False, "pty": False}
        with mock.patch.object(plugin, "_control_plane_request") as request, mock.patch.object(plugin, "_enqueue"):
            plugin._on_post_tool_call(tool_name="terminal", result={"status": "ok"}, tool_call_id="success")
        self.assertEqual(request.call_args.args[0], "/api/v2/commands/provider-connections/conn-1/attempts")
        self.assertEqual(request.call_args.kwargs["payload"], {"outcome": "SUCCESS"})

    def test_provider_attempt_429_exact_payload(self) -> None:
        plugin._PENDING["throttle"] = {"providerHubConnectionId": "conn-1", "runtime": "opencode", "background": False, "pty": False}
        with mock.patch.object(plugin, "_control_plane_request") as request, mock.patch.object(plugin, "_enqueue"):
            plugin._on_post_tool_call(tool_name="terminal", result={"error": "429 rate limit"}, tool_call_id="throttle")
        self.assertEqual(request.call_args.kwargs["payload"], {"outcome": "THROTTLED", "errorKind": "RATE_LIMIT", "httpStatus": 429, "message": "429 rate limit"})

    def test_terminal_quota_records_capacity_exhaustion_with_reset(self) -> None:
        plugin._PENDING["quota-terminal"] = {
            "providerHubConnectionId": "conn-go",
            "runtime": "dsh",
            "model": "deepseek-v4-flash",
            "background": False,
            "pty": False,
        }
        with mock.patch.object(plugin, "_control_plane_request") as request, mock.patch.object(
            plugin, "_record_capacity_exhaustion_for_connection"
        ) as capacity, mock.patch.object(plugin, "_enqueue"):
            plugin._on_post_tool_call(
                tool_name="terminal",
                result={
                    "error": "QUOTA: Weekly usage limit reached. Resets in 2 days.",
                    "exitCode": 1,
                },
                tool_call_id="quota-terminal",
            )
        payload = request.call_args.kwargs["payload"]
        self.assertEqual(payload["errorKind"], "QUOTA")
        self.assertEqual(payload["resetAfterSeconds"], 172800)
        capacity.assert_called_once()
        self.assertEqual(capacity.call_args.args[0], "conn-go")
        self.assertEqual(capacity.call_args.args[1]["errorKind"], "QUOTA")
        self.assertEqual(capacity.call_args.args[2]["model"], "deepseek-v4-flash")

    def test_provider_attempt_auth_redacts_and_posts(self) -> None:
        plugin._PENDING["auth"] = {"providerHubConnectionId": "conn-1", "runtime": "opencode", "background": False, "pty": False}
        with mock.patch.object(plugin, "_control_plane_request") as request, mock.patch.object(plugin, "_enqueue"):
            plugin._on_post_tool_call(tool_name="terminal", result={"error": "401 Bearer abc sk-secret token=xyz password=hunter2"}, tool_call_id="auth")
        payload = request.call_args.kwargs["payload"]
        self.assertEqual(payload["outcome"], "FAILURE")
        self.assertEqual(payload["errorKind"], "AUTH")
        self.assertNotIn("abc", payload["message"])
        self.assertNotIn("sk-secret", payload["message"])

    def test_background_success_does_not_post(self) -> None:
        plugin._PENDING["bg"] = {"providerHubConnectionId": "conn-1", "runtime": "opencode", "background": True, "pty": False}
        with mock.patch.object(plugin, "_control_plane_request") as request, mock.patch.object(plugin, "_enqueue"):
            plugin._on_post_tool_call(tool_name="terminal", result={"status": "ok"}, tool_call_id="bg")
        request.assert_not_called()

    def test_background_429_posts_failure(self) -> None:
        plugin._PENDING["bg429"] = {"providerHubConnectionId": "conn-1", "runtime": "opencode", "background": True, "pty": False}
        with mock.patch.object(plugin, "_control_plane_request") as request, mock.patch.object(plugin, "_enqueue"):
            plugin._on_post_tool_call(tool_name="terminal", result={"error": "429 rate limit"}, tool_call_id="bg429")
        self.assertEqual(request.call_args.kwargs["payload"]["outcome"], "THROTTLED")

    def test_provider_connection_resolver_prefers_exact_provider_key(self) -> None:
        hub = {
            "items": [
                {
                    "id": "conn-opencode",
                    "providerKey": "opencode-go",
                    "baseUrl": "https://opencode.ai/zen/go/v1",
                },
                {
                    "id": "conn-other",
                    "providerKey": "other",
                    "baseUrl": "https://other.example/v1",
                },
            ]
        }
        with mock.patch.object(plugin, "_control_plane_request", return_value=hub) as request:
            connection_id = plugin._resolve_provider_connection_id(
                "OpenCode Go", "https://opencode.ai/zen/go/v1/"
            )
        self.assertEqual(connection_id, "conn-opencode")
        request.assert_called_once_with("/api/v2/projections/provider-hub-summary", timeout=1.5)

    def test_provider_connection_resolver_uses_unique_base_url_fallback(self) -> None:
        hub = {
            "items": [
                {
                    "id": "conn-proxy",
                    "providerKey": "cpa",
                    "baseUrl": "http://127.0.0.1:8317/v1",
                }
            ]
        }
        with mock.patch.object(plugin, "_control_plane_request", return_value=hub):
            connection_id = plugin._resolve_provider_connection_id(
                "deepseek", "http://127.0.0.1:8317/v1"
            )
        self.assertEqual(connection_id, "conn-proxy")

    def test_v3_provider_telemetry_does_not_shadow_write_retired_provider_hub(self) -> None:
        plugin._CTX = FakeContext({"execution_mode": "v3"})
        with mock.patch.object(plugin, "_record_api_provider_attempt") as record:
            plugin._on_post_api_request(
                api_request_id="api-v3",
                provider="opencode-go",
                model="deepseek-v4-flash",
            )
            plugin._on_api_request_error(
                api_request_id="api-v3-error",
                provider="opencode-go",
                model="deepseek-v4-flash",
                status_code=429,
                reason="rate_limit",
            )
        record.assert_not_called()

    def test_post_api_request_records_success_for_main_agent_provider(self) -> None:
        with mock.patch.object(
            plugin, "_resolve_provider_connection_id", return_value="conn-opencode"
        ), mock.patch.object(plugin, "_control_plane_request") as request:
            plugin._on_post_api_request(
                api_request_id="api-1",
                session_id="session-1",
                task_id="task-1",
                turn_id="turn-1",
                provider="opencode-go",
                base_url="https://opencode.ai/zen/go/v1",
                model="deepseek-v4-flash",
                api_mode="chat_completions",
                api_call_count=1,
            )
        self.assertEqual(
            request.call_args.args[0],
            "/api/v2/commands/provider-connections/conn-opencode/attempts",
        )
        payload = request.call_args.kwargs["payload"]
        self.assertEqual(payload["outcome"], "SUCCESS")
        self.assertEqual(payload["source"], "HERMES_LLM_API")
        self.assertEqual(payload["metadata"]["provider"], "opencode-go")
        self.assertEqual(payload["metadata"]["model"], "deepseek-v4-flash")
        self.assertEqual(payload["metadata"]["profile"], "coder")
        self.assertTrue(
            request.call_args.kwargs["idempotency_key"].startswith(
                "provider-api-success-conn-opencode-"
            )
        )

    def test_post_api_request_samples_repeated_successes(self) -> None:
        with mock.patch.object(
            plugin, "_resolve_provider_connection_id", return_value="conn-opencode"
        ), mock.patch.object(plugin, "_control_plane_request") as request, mock.patch.object(
            plugin.time, "monotonic", side_effect=[100.0, 110.0]
        ):
            plugin._on_post_api_request(
                api_request_id="api-1", provider="opencode-go", model="deepseek-v4-flash"
            )
            plugin._on_post_api_request(
                api_request_id="api-2", provider="opencode-go", model="deepseek-v4-flash"
            )
        self.assertEqual(request.call_count, 1)

    def test_api_request_error_records_rate_limit_without_error_body(self) -> None:
        with mock.patch.object(
            plugin, "_resolve_provider_connection_id", return_value="conn-opencode"
        ), mock.patch.object(plugin, "_control_plane_request") as request:
            plugin._on_api_request_error(
                api_request_id="api-429",
                provider="opencode-go",
                base_url="https://opencode.ai/zen/go/v1",
                model="deepseek-v4-flash",
                api_mode="chat_completions",
                status_code=429,
                error_message="429 rate limit Bearer abc sk-secret token=xyz",
                error_body="PRIVATE PROMPT super-secret-body",
            )
        payload = request.call_args.kwargs["payload"]
        self.assertEqual(payload["outcome"], "THROTTLED")
        self.assertEqual(payload["errorKind"], "RATE_LIMIT")
        self.assertEqual(payload["httpStatus"], 429)
        self.assertNotIn("abc", payload["message"])
        self.assertNotIn("sk-secret", payload["message"])
        self.assertNotIn("super-secret-body", json.dumps(payload))
        self.assertEqual(payload["source"], "HERMES_LLM_API")

    def test_quota_evidence_updates_capacity_pool_with_observed_reset(self) -> None:
        calls = []

        def control(path: str, **kwargs: object) -> dict[str, object]:
            calls.append((path, kwargs))
            if path == "/api/v2/projections/provider-hub":
                return {
                    "items": [
                        {
                            "id": "conn-go",
                            "provider_key": "opencode-go",
                            "supplier": {"id": "sup-go", "name": "OpenCode"},
                        }
                    ]
                }
            if path == "/api/v2/projections/supply":
                return {
                    "suppliers": [
                        {
                            "id": "sup-go",
                            "agreements": [
                                {"id": "agr-go", "lifecycle": "ACTIVE", "commercialType": "SUBSCRIPTION"}
                            ],
                        }
                    ]
                }
            if path == "/api/v2/commands/capacity-pools/upsert":
                return {"id": "pool-go"}
            raise AssertionError(path)

        with mock.patch.object(plugin, "_control_plane_request", side_effect=control), mock.patch.object(
            plugin.time, "time", return_value=1_000.0
        ):
            plugin._record_capacity_exhaustion_for_connection(
                "conn-go",
                {"outcome": "FAILURE", "errorKind": "QUOTA", "resetAfterSeconds": 172800},
                {"provider": "opencode-go", "model": "deepseek-v4-flash"},
            )
        capacity = next(item for item in calls if item[0] == "/api/v2/commands/capacity-pools/upsert")
        payload = capacity[1]["payload"]
        self.assertEqual(payload["supplyAgreementId"], "agr-go")
        self.assertEqual(payload["remaining"], 0)
        self.assertEqual(payload["dimension"], "CUSTOM")
        self.assertEqual(payload["resetAt"], (1_000 + 172800) * 1000)
        self.assertEqual(payload["resetPolicy"]["seconds"], 172800)
        self.assertNotIn("apiKey", json.dumps(payload))

    def test_api_error_classifier_covers_auth_quota_timeout_and_server(self) -> None:
        self.assertEqual(plugin._api_error_outcome(status_code=401)["errorKind"], "AUTH")
        self.assertEqual(
            plugin._api_error_outcome(error_message="insufficient balance")["errorKind"],
            "QUOTA",
        )
        quota = plugin._api_error_outcome(
            error_message="QUOTA: Weekly usage limit reached. Resets in 2 days."
        )
        self.assertEqual(quota["errorKind"], "QUOTA")
        self.assertEqual(quota["resetAfterSeconds"], 2 * 24 * 60 * 60)
        terminal = plugin._terminal_outcome(
            "error",
            {"stderr": "QUOTA: Weekly usage limit reached. Resets in 2 days."},
        )
        self.assertEqual(terminal["errorKind"], "QUOTA")
        self.assertEqual(terminal["resetAfterSeconds"], 2 * 24 * 60 * 60)
        self.assertEqual(
            plugin._api_error_outcome(error_message="request timed out")["errorKind"],
            "TIMEOUT",
        )
        self.assertEqual(plugin._api_error_outcome(status_code=503)["errorKind"], "SERVER")
        self.assertEqual(
            plugin._api_error_outcome(
                reason="rate_limit",
                status_code=429,
                error={"type": "RateLimitError", "message": "too many requests"},
            )["errorKind"],
            "RATE_LIMIT",
        )

    def test_api_request_error_ignores_request_and_policy_failures(self) -> None:
        with mock.patch.object(plugin, "_record_api_provider_attempt") as record:
            plugin._on_api_request_error(
                reason="content_policy_blocked",
                provider="opencode-go",
                error={"type": "ContentPolicyBlocked", "message": "prompt rejected"},
            )
            plugin._on_api_request_error(
                reason="format_error",
                provider="opencode-go",
                status_code=400,
                error={"type": "BadRequest", "message": "bad payload"},
            )
            plugin._on_api_request_error(
                reason="model_not_found",
                provider="opencode-go",
                status_code=404,
                error={"type": "NotFound", "message": "missing model"},
            )
        record.assert_not_called()

    def test_api_error_idempotency_distinguishes_retries(self) -> None:
        base = {
            "api_request_id": "turn-1:api:1",
            "provider": "opencode-go",
            "model": "deepseek-v4-flash",
        }
        first = plugin._api_attempt_idempotency_key(
            "error", "conn-opencode", {**base, "retry_count": 0}
        )
        second = plugin._api_attempt_idempotency_key(
            "error", "conn-opencode", {**base, "retry_count": 1}
        )
        success = plugin._api_attempt_idempotency_key(
            "success", "conn-opencode", {**base, "retry_count": 1}
        )
        self.assertNotEqual(first, second)
        self.assertNotEqual(second, success)

    def test_api_request_telemetry_skips_unresolved_provider(self) -> None:
        with mock.patch.object(
            plugin, "_resolve_provider_connection_id", return_value=""
        ), mock.patch.object(plugin, "_control_plane_request") as request:
            plugin._on_post_api_request(
                api_request_id="api-missing",
                provider="unmapped-provider",
                base_url="https://unknown.example/v1",
                model="model-x",
            )
        request.assert_not_called()

    def test_v3_run_phase_creates_async_implementation_with_hermes_correlation(self) -> None:
        plugin._CTX = FakeContext({"execution_mode": "v3"})
        started = {
            "executionId": "exec-v3-1",
            "projectKey": "memoflow",
            "phase": "IMPLEMENT",
            "status": "RUNNING",
            "selection": {"backend": "opencode-acp", "modelClass": "implementation-efficient"},
        }
        with mock.patch.object(plugin, "_control_plane_request", return_value=started) as request:
            result = json.loads(
                plugin._run_development_phase_tool(
                    {
                        "phase": "IMPLEMENT",
                        "objective": "Implement the approved refactor.",
                        "repository_path": "/home/ubuntu/projects/memoflow",
                    },
                    session_id="session-1",
                    turn_id="turn-1",
                    tool_call_id="call-1",
                )
            )
        self.assertTrue(result["ok"])
        self.assertFalse(result["awaitRequested"])
        self.assertFalse(result["awaitTimedOut"])
        self.assertEqual(result["executionId"], "exec-v3-1")
        request.assert_called_once()
        call = request.call_args
        self.assertEqual(call.args[0], "/api/v3/development/executions")
        self.assertEqual(call.kwargs["method"], "POST")
        self.assertTrue(call.kwargs["idempotency_key"].startswith("hermes-v3-implement-"))
        payload = call.kwargs["payload"]
        self.assertEqual(payload["projectKey"], "memoflow")
        self.assertEqual(payload["repository"]["path"], "/home/ubuntu/projects/memoflow")
        self.assertFalse(payload["await"])
        self.assertEqual(payload["hermes"], {"profile": "coder", "sessionId": "session-1", "turnId": "turn-1"})

    def test_v3_run_phase_inherits_project_and_result_from_previous_execution(self) -> None:
        plugin._CTX = FakeContext({"execution_mode": "v3"})
        previous = {
            "executionId": "exec-impl",
            "projectKey": "memoflow",
            "phase": "IMPLEMENT",
            "status": "SUCCEEDED",
            "result": {"finalText": "Implemented and verified."},
        }
        review = {
            "executionId": "exec-review",
            "projectKey": "memoflow",
            "phase": "VERIFY_REVIEW",
            "status": "SUCCEEDED",
            "result": {"finalText": "APPROVED"},
        }
        with mock.patch.object(plugin, "_control_plane_request", side_effect=[previous, review]) as request:
            result = json.loads(
                plugin._run_development_phase_tool(
                    {
                        "phase": "VERIFY_REVIEW",
                        "objective": "Review independently.",
                        "previous_execution_id": "exec-impl",
                    },
                    session_id="s-review",
                    turn_id="t-review",
                    tool_call_id="call-review",
                )
            )
        self.assertTrue(result["ok"])
        self.assertTrue(result["awaitRequested"])
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertEqual(request.call_count, 2)
        self.assertEqual(request.call_args_list[0].args[0], "/api/v3/development/executions/exec-impl")
        payload = request.call_args_list[1].kwargs["payload"]
        self.assertEqual(payload["projectKey"], "memoflow")
        self.assertEqual(payload["repository"]["path"], "")
        self.assertEqual(payload["context"]["previousExecutionId"], "exec-impl")
        self.assertEqual(payload["context"]["previousResult"], "Implemented and verified.")

    def test_v3_implement_fix_uses_failed_review_as_causal_parent(self) -> None:
        plugin._CTX = FakeContext({"execution_mode": "v3"})
        failed_review = {
            "executionId": "exec-review-failed",
            "projectKey": "memoflow",
            "phase": "VERIFY_REVIEW",
            "status": "SUCCEEDED",
            "result": {"finalText": "BLOCKED: odd numbers are incorrectly reported as even."},
        }
        started_fix = {
            "executionId": "exec-fix",
            "projectKey": "memoflow",
            "phase": "IMPLEMENT_FIX",
            "status": "RUNNING",
        }
        with mock.patch.object(plugin, "_control_plane_request", side_effect=[failed_review, started_fix]) as request:
            result = json.loads(
                plugin._run_development_phase_tool(
                    {
                        "phase": "IMPLEMENT_FIX",
                        "objective": "Address only the review finding.",
                        "previous_execution_id": "exec-review-failed",
                    },
                    session_id="s-fix",
                    turn_id="t-fix",
                    tool_call_id="call-fix",
                )
            )
        self.assertTrue(result["ok"])
        self.assertEqual(result["executionId"], "exec-fix")
        self.assertEqual(request.call_args_list[0].args[0], "/api/v3/development/executions/exec-review-failed")
        payload = request.call_args_list[1].kwargs["payload"]
        self.assertEqual(payload["projectKey"], "memoflow")
        self.assertEqual(payload["context"]["previousExecutionId"], "exec-review-failed")
        self.assertEqual(
            payload["context"]["previousResult"],
            "BLOCKED: odd numbers are incorrectly reported as even.",
        )
        self.assertEqual(payload["repository"]["path"], "")

    def test_v3_run_phase_waits_by_short_get_polling_not_long_post(self) -> None:
        plugin._CTX = FakeContext({"execution_mode": "v3"})
        started = {"executionId": "exec-plan", "projectKey": "p", "phase": "INVESTIGATE_PLAN", "status": "RUNNING"}
        finished = {"executionId": "exec-plan", "projectKey": "p", "phase": "INVESTIGATE_PLAN", "status": "SUCCEEDED", "result": {"finalText": "plan"}}
        with mock.patch.object(plugin, "_control_plane_request", side_effect=[started, finished]) as request, mock.patch.object(
            plugin.time, "sleep", return_value=None
        ):
            result = json.loads(
                plugin._run_development_phase_tool(
                    {
                        "phase": "INVESTIGATE_PLAN",
                        "objective": "Investigate and plan.",
                        "project_key": "p",
                        "repository_path": "/repo",
                        "await": True,
                        "wait_timeout_seconds": 10,
                    },
                    tool_call_id="call-plan",
                )
            )
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertFalse(result["awaitTimedOut"])
        self.assertEqual(request.call_count, 2)
        self.assertEqual(request.call_args_list[0].kwargs["payload"]["await"], False)
        self.assertEqual(request.call_args_list[0].kwargs["timeout"], 8.0)
        self.assertEqual(request.call_args_list[1].args[0], "/api/v3/development/executions/exec-plan")
        self.assertEqual(request.call_args_list[1].kwargs["timeout"], 4.0)

    def test_v3_run_phase_serializes_hints_and_policy_overrides(self) -> None:
        plugin._CTX = FakeContext({"execution_mode": "v3"})
        started = {"executionId": "exec-hints", "projectKey": "p", "phase": "IMPLEMENT", "status": "RUNNING"}
        with mock.patch.object(plugin, "_control_plane_request", return_value=started) as request:
            result = json.loads(
                plugin._run_development_phase_tool(
                    {
                        "phase": "IMPLEMENT",
                        "objective": "Implement.",
                        "project_key": "p",
                        "repository_path": "/repo",
                        "complexity_hint": "high",
                        "risk_hint": "medium",
                        "quality_hint": "premium",
                        "budget_hint": "low",
                        "parallelism": 3,
                        "preferred_backend": "opencode-acp",
                        "preferred_model_class": "implementation-efficient",
                        "transport_mode": "litellm_managed",
                    },
                    tool_call_id="call-hints",
                )
            )
        self.assertTrue(result["ok"])
        payload = request.call_args.kwargs["payload"]
        self.assertEqual(payload["hints"], {"complexity": "HIGH", "risk": "MEDIUM", "quality": "PREMIUM", "budget": "LOW", "parallelism": 3})
        self.assertEqual(payload["override"], {"backend": "opencode-acp", "modelClass": "implementation-efficient", "transportMode": "LITELLM_MANAGED"})

    def test_v3_execution_get_cancel_and_active_tools_are_thin_facades(self) -> None:
        with mock.patch.object(
            plugin,
            "_control_plane_request",
            side_effect=[
                {"executionId": "exec-1", "status": "RUNNING"},
                {"executionId": "exec-1", "status": "CANCELLED"},
                {
                    "items": [
                        {"executionId": "exec-1", "status": "CANCELLED"},
                        {"executionId": "exec-2", "status": "RUNNING"},
                        {"executionId": "exec-3", "status": "WAITING_FOR_CONFIRMATION"},
                    ]
                },
            ],
        ) as request:
            got = json.loads(plugin._get_development_execution_tool({"execution_id": "exec-1"}))
            cancelled = json.loads(plugin._cancel_development_execution_tool({"execution_id": "exec-1"}))
            active = json.loads(plugin._list_active_development_executions_tool({"project_key": "memo flow", "limit": 20}))
        self.assertTrue(got["ok"])
        self.assertEqual(cancelled["status"], "CANCELLED")
        self.assertEqual(active["count"], 2)
        self.assertEqual([item["executionId"] for item in active["items"]], ["exec-2", "exec-3"])
        self.assertEqual(request.call_args_list[0].args[0], "/api/v3/development/executions/exec-1")
        self.assertEqual(request.call_args_list[1].args[0], "/api/v3/development/executions/exec-1/cancel")
        self.assertEqual(request.call_args_list[1].kwargs["method"], "POST")
        self.assertIn("projectKey=memo+flow", request.call_args_list[2].args[0])

    def test_v3_continue_execution_resumes_paused_run_with_bounded_wait(self) -> None:
        resumed = {"executionId": "exec-resume", "status": "RUNNING"}
        finished = {"executionId": "exec-resume", "status": "SUCCEEDED", "result": {"finalText": "done"}}
        long_message = "x" * 25000
        with mock.patch.object(
            plugin,
            "_control_plane_request",
            side_effect=[resumed, finished],
        ) as request, mock.patch.object(plugin.time, "sleep", return_value=None):
            result = json.loads(
                plugin._continue_development_execution_tool(
                    {
                        "execution_id": "exec-resume",
                        "message": long_message,
                        "await": True,
                        "wait_timeout_seconds": 5,
                    }
                )
            )
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertTrue(result["awaitRequested"])
        self.assertFalse(result["awaitTimedOut"])
        self.assertEqual(request.call_count, 2)
        first = request.call_args_list[0]
        self.assertEqual(first.args[0], "/api/v3/development/executions/exec-resume/messages")
        self.assertEqual(first.kwargs["method"], "POST")
        self.assertEqual(len(first.kwargs["payload"]["message"]), 20000)
        self.assertEqual(first.kwargs["timeout"], 8.0)
        self.assertEqual(request.call_args_list[1].args[0], "/api/v3/development/executions/exec-resume")

    def test_v3_continue_execution_rejects_empty_message_before_network(self) -> None:
        with mock.patch.object(plugin, "_control_plane_request") as request:
            result = json.loads(
                plugin._continue_development_execution_tool(
                    {"execution_id": "exec-resume", "message": "   "}
                )
            )
        self.assertFalse(result["ok"])
        self.assertIn("message is required", result["message"])
        request.assert_not_called()

    def test_v3_initial_phase_requires_repository_but_continuation_does_not(self) -> None:
        plugin._CTX = FakeContext({"execution_mode": "v3"})
        missing = json.loads(plugin._run_development_phase_tool({"phase": "IMPLEMENT", "objective": "Implement."}, tool_call_id="missing-repo"))
        self.assertFalse(missing["ok"])
        self.assertIn("repository_path is required", missing["message"])

    def test_pre_llm_authority_context_recognizes_ai_office_and_current_litellm_registry(self) -> None:
        registry = {
            "authority": "LITELLM",
            "health": "OK",
            "credentials": {"count": 2},
            "deployments": {
                "count": 3,
                "active": 2,
                "paused": 1,
                "items": [
                    {"providerKey": "worldclaw", "blocked": False},
                    {"providerKey": "worldclaw", "blocked": False},
                    {"providerKey": "anyrouter", "blocked": True},
                ],
            },
        }
        with mock.patch.object(plugin, "_control_plane_request", return_value=registry) as request:
            result = plugin._on_pre_llm_call(user_message="继续看当前可用供应商，能识别到 AI Office 吗")
        self.assertIsNotNone(result)
        context = result["context"]
        self.assertIn("internal control-plane", context)
        self.assertIn("ai_office_list_providers", context)
        self.assertIn("LiteLLM model/provider registry", context)
        self.assertIn("worldclaw: active=2; paused=0", context)
        self.assertIn("anyrouter: active=0; paused=1", context)
        request.assert_called_once_with("/api/v3/development/model-registry", timeout=3.0)

    def test_pre_llm_execution_context_requires_ai_office_placement_before_coding_harness(self) -> None:
        plugin._CTX = FakeContext({"execution_mode": "v3"})
        with mock.patch.object(plugin, "_control_plane_request") as request:
            result = plugin._on_pre_llm_call(user_message="帮我修一下这个 CSS 布局")
        self.assertIsNotNone(result)
        self.assertIn("ai_office_run_phase", result["context"])
        self.assertIn("INVESTIGATE_PLAN", result["context"])
        self.assertIn("IMPLEMENT_FIX", result["context"])
        self.assertIn("VERIFY_REVIEW", result["context"])
        self.assertIn("FINALIZE", result["context"])
        self.assertIn("previous_execution_id", result["context"])
        self.assertIn("IMPLEMENT_FIX must point to the failed VERIFY_REVIEW", result["context"])
        self.assertIn("VERIFY_REVIEW must point to the implementation/fix", result["context"])
        self.assertIn("FINALIZE must point to the approved VERIFY_REVIEW", result["context"])
        self.assertIn("asynchronous by default", result["context"])
        self.assertIn("ai_office_get_execution", result["context"])
        self.assertIn("IMPLEMENT=OpenCode/DeepSeek", result["context"])
        self.assertIn("REVIEW=Codex/GPT", result["context"])
        self.assertIn("per execution", result["context"])
        self.assertIn("legacy compatibility tool", result["context"])
        request.assert_not_called()

    def test_execution_mode_is_real_routing_authority(self) -> None:
        plugin._CTX = FakeContext({"execution_mode": "v3"})
        with mock.patch.object(plugin, "_resolve_runtime_policy") as legacy_policy:
            directive = plugin._on_pre_tool_call(
                tool_name="terminal",
                args={"command": "opencode run task"},
                tool_call_id="v3-no-double-route",
            )
        self.assertIsNone(directive)
        legacy_policy.assert_not_called()

        plugin._CTX = FakeContext({"execution_mode": "v2"})
        with mock.patch.object(plugin, "_control_plane_request") as request:
            context = plugin._on_pre_llm_call(user_message="帮我实现这个功能")
        self.assertIn("legacy V2 execution placement", context["context"])
        self.assertIn("ai_office_resolve_execution", context["context"])
        self.assertNotIn("primary execution authority", context["context"])
        request.assert_not_called()

        plugin._CTX = FakeContext({"execution_mode": "disabled"})
        with mock.patch.object(plugin, "_control_plane_request") as request:
            disabled = plugin._on_pre_llm_call(user_message="帮我实现这个功能")
            start = json.loads(
                plugin._run_development_phase_tool(
                    {"phase": "IMPLEMENT", "objective": "Implement.", "repository_path": "/repo"},
                    tool_call_id="disabled-start",
                )
            )
        self.assertIn("execution delegation is disabled", disabled["context"])
        self.assertFalse(start["ok"])
        self.assertIn("execution_mode=disabled", start["message"])
        request.assert_not_called()

    def test_v3_start_is_blocked_on_v2_but_existing_execution_controls_remain_available(self) -> None:
        plugin._CTX = FakeContext({"execution_mode": "v2"})
        with mock.patch.object(plugin, "_control_plane_request", return_value={"executionId": "exec-old", "status": "RUNNING"}) as request:
            start = json.loads(
                plugin._run_development_phase_tool(
                    {"phase": "IMPLEMENT", "objective": "Implement.", "repository_path": "/repo"},
                    tool_call_id="v2-start",
                )
            )
            existing = json.loads(plugin._get_development_execution_tool({"execution_id": "exec-old"}))
        self.assertFalse(start["ok"])
        self.assertIn("execution_mode=v2", start["message"])
        self.assertTrue(existing["ok"])
        request.assert_called_once_with("/api/v3/development/executions/exec-old", timeout=4.0)

    def test_pre_llm_authority_context_ignores_unrelated_turns(self) -> None:
        with mock.patch.object(plugin, "_control_plane_request") as request:
            result = plugin._on_pre_llm_call(user_message="给我解释一下番茄炒蛋为什么出水")
        self.assertIsNone(result)
        request.assert_not_called()

    def test_chat_gpt_workforce_registers_explicit_bridged_codex_access(self) -> None:
        accesses: list[dict[str, object]] = []

        def control(path: str, **kwargs: object) -> dict[str, object]:
            payload = kwargs.get("payload")
            if path == "/api/v2/commands/supply-catalog/register":
                return {
                    "employee": {"id": "emp-4sapi"},
                    "employment": {"id": "empl-4sapi"},
                }
            if path.endswith("/runtime-access"):
                self.assertIsInstance(payload, dict)
                accesses.append(dict(payload))
                return {"id": f"access-{len(accesses)}"}
            raise AssertionError(path)

        with mock.patch.object(plugin, "_control_plane_request", side_effect=control):
            registrations = plugin._register_shared_policy_workforce(
                provider_key="forapi-4sapi-org-gpt-5-6",
                display_name="4SAPI",
                website_url="https://4sapi.org",
                base_url="https://4sapi.org/v1",
                protocol="openai-chat-completions",
                credential_ref="FORAPI_4SAPI_API_KEY",
                connection_id="pconn-4sapi",
                models=["gpt-5.6-sol"],
            )
        self.assertEqual(len(registrations), 1)
        self.assertEqual([item["runtimeKind"] for item in accesses], ["OPENCODE", "CODEX"])
        codex = accesses[1]
        self.assertEqual(codex["protocol"], "openai-chat-completions")
        self.assertEqual(codex["config"]["wireApi"], "responses")
        self.assertEqual(codex["config"]["transportMode"], "BRIDGED_CHAT")
        self.assertEqual(codex["config"]["bridgeKind"], "CC_SWITCH_CODEX_CHAT")

    def test_reconcile_upgrades_stale_chat_codex_access_to_bridged_transport(self) -> None:
        hub = {
            "items": [
                {
                    "id": "pconn-4sapi",
                    "provider_key": "forapi-4sapi-org-gpt-5-6",
                    "display_name": "4SAPI",
                    "base_url": "https://4sapi.org/v1",
                    "website_url": "https://4sapi.org",
                    "credential_ref": "FORAPI_4SAPI_API_KEY",
                    "auth_kind": "API_KEY",
                    "admin_state": "ENABLED",
                    "protocol": "openai-chat-completions",
                    "models": ["gpt-5.6-sol"],
                    "supplier": {"id": "sup-4sapi", "slug": "forapi-4sapi-org-gpt-5-6", "name": "4SAPI"},
                }
            ]
        }
        workforce = {
            "employees": [
                {
                    "id": "emp-4sapi",
                    "currentEmploymentCount": 1,
                    "supplier": {"id": "sup-4sapi"},
                    "supplierModel": {"key": "gpt-5.6-sol"},
                }
            ]
        }
        supply = {
            "suppliers": [
                {
                    "agreements": [
                        {
                            "employments": [
                                {
                                    "employeeId": "emp-4sapi",
                                    "runtimeAccess": [
                                        {
                                            "runtimeKind": "CODEX",
                                            "lifecycle": "ACTIVE",
                                            "config": {"wireApi": "chat"},
                                        }
                                    ],
                                }
                            ]
                        }
                    ]
                }
            ]
        }

        def control(path: str, **_kwargs: object) -> dict[str, object]:
            if path.endswith("provider-hub"):
                return hub
            if path.endswith("workforce"):
                return workforce
            if path.endswith("supply"):
                return supply
            raise AssertionError(path)

        with mock.patch.object(plugin, "_control_plane_request", side_effect=control), mock.patch.object(
            plugin, "_provider_connection_credential_ready", return_value=True
        ), mock.patch.object(
            plugin,
            "_register_shared_policy_workforce",
            return_value=[{"model": "gpt-5.6-sol", "employeeId": "emp-4sapi"}],
        ) as register:
            result = plugin._reconcile_policy_workforce_from_hub(force=True)
        self.assertEqual(result, {"connections": 1, "models": 1})
        self.assertEqual(register.call_args.kwargs["models"], ["gpt-5.6-sol"])
        self.assertEqual(register.call_args.kwargs["protocol"], "openai-chat-completions")

    def test_policy_workforce_keeps_all_gpt_execution_models_but_excludes_non_agent_gpt(self) -> None:
        models = [
            "gpt-4.1",
            "gpt-5.4-mini",
            "gpt-5.5",
            "gpt-5.6-luna",
            "gpt-5.6-luna-fast",
            "gpt-5.6-sol",
            "gpt-image-2",
            "gpt-audio-1",
            "deepseek-v4-flash",
            "deepseek-v4-pro",
            "glm-5.2",
            "glm-5.3",
            "claude-opus-5",
            "claude-haiku-4-5",
        ]
        self.assertEqual(
            plugin._policy_workforce_models(models),
            [
                "gpt-4.1",
                "gpt-5.4-mini",
                "gpt-5.5",
                "gpt-5.6-luna",
                "gpt-5.6-luna-fast",
                "gpt-5.6-sol",
                "deepseek-v4-flash",
                "glm-5.2",
                "claude-opus-5",
            ],
        )

    def test_execution_runtime_inventory_uses_persistent_runtime_paths(self) -> None:
        mapping = {
            "claude": "/opt/data/runtime/npm/bin/claude",
            "codex": "/opt/data/runtime/npm/bin/codex",
            "dsh": "/opt/data/runtime/npm/bin/dsh",
            "opencode": "",
        }
        with mock.patch.object(plugin, "_runtime_binary", side_effect=lambda name: mapping.get(name, "")):
            inventory = plugin._execution_runtime_inventory()
        self.assertEqual(
            inventory,
            [
                {"kind": "CLAUDE_CODE", "path": "/opt/data/runtime/npm/bin/claude", "mode": "HEADLESS"},
                {"kind": "CODEX", "path": "/opt/data/runtime/npm/bin/codex", "mode": "HEADLESS"},
                {"kind": "DSH", "path": "/opt/data/runtime/npm/bin/dsh", "mode": "HEADLESS"},
            ],
        )

    def test_v3_rejects_legacy_resolve_execution_before_provider_hub_reconciliation(self) -> None:
        plugin._CTX = FakeContext({"execution_mode": "v3"})
        with mock.patch.object(plugin, "_reconcile_policy_workforce_from_hub") as reconcile, mock.patch.object(
            plugin, "_control_plane_request"
        ) as request:
            result = json.loads(plugin._resolve_execution_tool({"intent": "REVIEW"}))
        self.assertFalse(result["ok"])
        self.assertIn("V2 rollback-only", result["message"])
        reconcile.assert_not_called()
        request.assert_not_called()

    def test_resolve_execution_tool_sends_safe_runtime_inventory_and_returns_guidance(self) -> None:
        captured: dict[str, object] = {}

        def control(path: str, **kwargs: object) -> dict[str, object]:
            captured["path"] = path
            captured["payload"] = kwargs.get("payload")
            return {
                "status": "SELECTED",
                "policyVersion": "simple-placement-v1",
                "selected": {
                    "model": "gpt-5.6-sol",
                    "providerConnection": {"id": "conn-1", "credentialRef": "OPENAI_API_KEY"},
                    "runtime": {"preferredHarness": "CODEX", "profileAction": "REUSE_EXISTING"},
                    "guidance": "Use Codex and resolve credentials through credentialRef.",
                },
            }

        with mock.patch.object(
            plugin,
            "_execution_runtime_inventory",
            return_value=[{"kind": "CODEX", "path": "/opt/data/runtime/npm/bin/codex", "mode": "HEADLESS"}],
        ), mock.patch.object(plugin, "_control_plane_request", side_effect=control), mock.patch.object(
            plugin, "_reconcile_policy_workforce_from_hub", return_value={"connections": 0, "models": 0}
        ), mock.patch.object(
            plugin, "_available_execution_provider_ids", return_value=["conn-1"]
        ), mock.patch.object(
            plugin, "_execution_project_path", return_value="/home/ubuntu/projects/memoflow"
        ), mock.patch.object(
            plugin, "_prepare_execution_result", side_effect=lambda value, **_kwargs: value
        ), mock.patch.object(plugin.time, "time", return_value=1000.0):
            result = json.loads(
                plugin._resolve_execution_tool({"intent": "REVIEW", "requested_model": "gpt-5.6-sol"})
            )
        self.assertTrue(result["ok"])
        self.assertEqual(captured["path"], "/api/v2/commands/execution/resolve")
        payload = captured["payload"]
        self.assertEqual(payload["intent"], "REVIEW")
        self.assertEqual(payload["requestedModel"], "gpt-5.6-sol")
        self.assertEqual(payload["timezone"], "Asia/Shanghai")
        self.assertEqual(payload["availableProviderConnectionIds"], ["conn-1"])
        self.assertEqual(payload["at"], 1_000_000)
        self.assertEqual(payload["metadata"]["profileName"], "coder")
        self.assertEqual(payload["metadata"]["projectRoot"], "/home/ubuntu/projects/memoflow")
        self.assertNotIn("api_key", json.dumps(payload).lower())
        self.assertEqual(result["selected"]["runtime"]["preferredHarness"], "CODEX")

    def test_global_provider_credential_can_be_promoted_from_source_profile_without_echoing_value(self) -> None:
        connection = {
            "credential_ref": "TEAMOROUTER_GPT_5_6_API_KEY",
            "credential_scope": "GLOBAL",
            "auth_kind": "API_KEY",
            "metadata": {"addedFromProfile": "memoflow"},
        }
        global_home = Path("/opt/data")
        profile_home = Path("/opt/data/profiles/memoflow")
        reads = {
            (str(global_home), "TEAMOROUTER_GPT_5_6_API_KEY"): ["", "secret-value"],
            (str(profile_home), "TEAMOROUTER_GPT_5_6_API_KEY"): ["secret-value"],
        }

        def read(home: Path, ref: str) -> str:
            values = reads[(str(home), ref)]
            return values.pop(0) if len(values) > 1 else values[0]

        with mock.patch.object(plugin, "_global_hermes_home", return_value=global_home), mock.patch.object(
            plugin, "_env_value_at_home", side_effect=read
        ), mock.patch.object(plugin, "_save_shared_credential") as save:
            ready = plugin._provider_connection_credential_ready(connection, "coder")
        self.assertTrue(ready)
        save.assert_called_once_with("TEAMOROUTER_GPT_5_6_API_KEY", "secret-value")

    def test_credential_value_falls_back_to_global_home(self) -> None:
        with mock.patch.object(plugin, "_global_hermes_home", return_value=Path("/opt/data")), mock.patch.object(
            plugin, "_env_value_at_home", return_value="global-secret"
        ), mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(plugin._credential_value("SHARED_API_KEY"), "global-secret")

    def test_prepare_codex_rejects_chat_provider_without_explicit_bridge_contract(self) -> None:
        selected = {"model": "gpt-5.6-luna"}
        runtime = {
            "selectedHarness": "CODEX",
            "preferredHarness": "CODEX",
            "providerRef": "chat-relay",
            "profileRef": "chat-relay-luna",
        }
        connection = {
            "id": "pconn-chat-relay",
            "providerKey": "chat-relay",
            "authKind": "API_KEY",
            "baseUrl": "https://chat-relay.example/v1",
            "credentialRef": "CHAT_RELAY_API_KEY",
            "protocol": "openai-chat-completions",
        }
        with mock.patch.object(plugin, "_ensure_codex_native_access") as ensure:
            with self.assertRaisesRegex(RuntimeError, "missing a valid Chat Completions bridge contract"):
                plugin._prepare_codex_execution(selected, runtime, connection)
        ensure.assert_not_called()

    def test_prepare_codex_bridged_chat_writes_secret_free_route_descriptor(self) -> None:
        selected = {"model": "gpt-5.6-sol"}
        runtime = {
            "selectedHarness": "CODEX",
            "preferredHarness": "CODEX",
            "providerRef": "hao-forapi-4sapi",
            "profileRef": "hao-forapi-sol",
            "accessProfileId": "raccess-bridge",
            "transportMode": "BRIDGED_CHAT",
            "bridgeKind": "CC_SWITCH_CODEX_CHAT",
            "executable": "/opt/data/runtime/npm/bin/codex",
        }
        connection = {
            "id": "pconn-4sapi",
            "providerKey": "forapi-4sapi-org-gpt-5-6",
            "authKind": "API_KEY",
            "baseUrl": "https://4sapi.org/v1",
            "credentialRef": "FORAPI_4SAPI_API_KEY",
            "protocol": "openai-chat-completions",
        }
        with tempfile.TemporaryDirectory() as tempdir, mock.patch.dict(
            os.environ, {"HERMES_HOME": tempdir}, clear=False
        ), mock.patch.object(
            plugin, "_runtime_secret_file", return_value=f"{tempdir}/credential.key"
        ), mock.patch.object(plugin, "_ensure_codex_native_access") as ensure:
            plugin._prepare_codex_execution(selected, runtime, connection)
            route_path = Path(runtime["bridgeRouteConfig"])
            self.assertTrue(route_path.exists())
            route = json.loads(route_path.read_text(encoding="utf-8"))
        ensure.assert_not_called()
        self.assertEqual(route["transportMode"], "BRIDGED_CHAT")
        self.assertEqual(route["bridgeKind"], "CC_SWITCH_CODEX_CHAT")
        self.assertEqual(route["upstreamBaseUrl"], "https://4sapi.org/v1")
        self.assertEqual(route["credentialRef"], "FORAPI_4SAPI_API_KEY")
        self.assertNotIn("secret", json.dumps(route).lower())
        self.assertTrue(runtime["profileReady"])

    def test_prepare_codex_oauth_reuses_existing_profile_without_secret_materialization(self) -> None:
        selected = {"model": "gpt-5.6-sol"}
        runtime = {
            "selectedHarness": "CODEX",
            "preferredHarness": "CODEX",
            "executable": "/opt/data/runtime/npm/bin/codex",
            "accessProfileId": "raccess-oauth",
            "profileRef": "team",
            "providerRef": "openai",
        }
        connection = {
            "id": "pconn-openai-team",
            "providerKey": "openai-team",
            "authKind": "OAUTH",
            "credentialScope": "OAUTH_PROFILE",
            "sourceProfileId": "memoflow",
            "credentialRef": "codex-auth:memoflow",
            "protocol": "codex-chatgpt-oauth",
        }
        with mock.patch.object(plugin, "_runtime_secret_file") as secret_file, mock.patch.object(
            plugin, "_ensure_codex_native_access"
        ) as ensure, mock.patch.object(plugin, "_codex_profile_exists", return_value=True):
            plugin._prepare_codex_execution(selected, runtime, connection)
        secret_file.assert_not_called()
        ensure.assert_not_called()
        self.assertEqual(runtime["profileAction"], "REUSE_EXISTING")
        self.assertTrue(runtime["profileReady"])
        self.assertEqual(
            runtime["commandTemplate"],
            "/opt/data/runtime/npm/bin/codex --profile team exec <task>",
        )

    def test_prepare_dsh_execution_materializes_provider_patch_without_plaintext_secret(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            selected = {"model": "deepseek-v4-flash"}
            runtime = {
                "selectedHarness": "DSH",
                "preferredHarness": "DSH",
                "executable": "/opt/data/runtime/npm/bin/dsh",
            }
            connection = {
                "id": "pconn-opencode",
                "providerKey": "opencode-go",
                "baseUrl": "https://opencode.ai/zen/go/v1",
                "credentialRef": "OPENCODE_GO_API_KEY",
            }
            with mock.patch.dict(os.environ, {"HERMES_HOME": tempdir}, clear=False), mock.patch.object(
                plugin, "_runtime_secret_file", return_value=f"{tempdir}/secrets/opencode.key"
            ):
                plugin._prepare_dsh_execution(selected, runtime, connection)
                patch = Path(runtime["managedProfilePath"])
                self.assertTrue(patch.exists())
                content = patch.read_text(encoding="utf-8")
                self.assertIn("provider: deepseek-official", content)
                self.assertIn('model: "deepseek-v4-flash"', content)
                self.assertIn('apiKeyEnv: "OPENCODE_GO_API_KEY"', content)
                self.assertIn('baseURL: "https://opencode.ai/zen/go/v1"', content)
                self.assertNotIn("secret-value", content)
                self.assertEqual(runtime["profileAction"], "CREATE_MANAGED")
                self.assertIn("--profile headless --patch", runtime["commandTemplate"])
                self.assertIn("$(cat", runtime["commandTemplate"])
                plugin._prepare_dsh_execution(selected, runtime, connection)
                self.assertEqual(runtime["profileAction"], "REUSE_EXISTING")

    def test_prepare_execution_result_routes_launch_through_agent_harness(self) -> None:
        result = {
            "status": "SELECTED",
            "selected": {
                "model": "deepseek-v4-flash",
                "providerConnection": {
                    "id": "pconn-deepseek",
                    "providerKey": "deepseek",
                    "baseUrl": "https://api.deepseek.com",
                    "credentialRef": "DEEPSEEK_API_KEY",
                },
                "runtime": {
                    "selectedHarness": "DSH",
                    "preferredHarness": "DSH",
                    "executable": "/opt/data/runtime/npm/bin/dsh",
                },
                "guidance": "Use DSH.",
            },
        }
        with tempfile.TemporaryDirectory() as tempdir, mock.patch.dict(
            os.environ, {"HERMES_HOME": tempdir}, clear=False
        ), mock.patch.object(
            plugin, "_runtime_secret_file", return_value=f"{tempdir}/secret.key"
        ), mock.patch.object(
            plugin,
            "_prepare_agent_harness_environment",
            return_value={
                "controller": "/home/ubuntu/projects/agent-harness/bin/harnessctl",
                "profileHome": f"{tempdir}/profiles/coder/home",
                "projectRoot": "/home/ubuntu/projects/memoflow",
                "capabilityHash": "cap-hash",
                "environmentId": "memoflow-cap-hash",
                "environmentRoot": f"{tempdir}/capability-env",
                "admission": {"host": "dsh", "status": "READY", "runtimeState": "READY", "blockers": []},
            },
        ):
            prepared = plugin._prepare_execution_result(
                result, project_path="/home/ubuntu/projects/memoflow"
            )
        selected = prepared["selected"]
        runtime = selected["runtime"]
        self.assertTrue(runtime["profileReady"])
        self.assertEqual(runtime["capabilityPlaneStatus"], "READY")
        self.assertEqual(runtime["launchContract"], "HARNESSCTL_EXEC")
        self.assertEqual(runtime["capabilityHash"], "cap-hash")
        self.assertIn("harnessctl exec --project /home/ubuntu/projects/memoflow dsh", runtime["commandTemplate"])
        self.assertIn("--patch", runtime["commandTemplate"])
        self.assertIn("$(cat", runtime["commandTemplate"])
        self.assertIn("replace only <task>", selected["guidance"])

    def test_prepare_execution_result_routes_bridged_codex_through_agent_harness_route_descriptor(self) -> None:
        result = {
            "status": "SELECTED",
            "selected": {
                "model": "gpt-5.6-sol",
                "providerConnection": {
                    "id": "pconn-4sapi",
                    "providerKey": "forapi-4sapi-org-gpt-5-6",
                    "authKind": "API_KEY",
                    "baseUrl": "https://4sapi.org/v1",
                    "credentialRef": "FORAPI_4SAPI_API_KEY",
                    "protocol": "openai-chat-completions",
                },
                "runtime": {
                    "selectedHarness": "CODEX",
                    "preferredHarness": "CODEX",
                    "accessProfileId": "raccess-bridge",
                    "profileRef": "hao-forapi-sol",
                    "providerRef": "hao-forapi-4sapi",
                    "transportMode": "BRIDGED_CHAT",
                    "bridgeKind": "CC_SWITCH_CODEX_CHAT",
                },
                "guidance": "Use Codex.",
            },
        }
        with tempfile.TemporaryDirectory() as tempdir, mock.patch.dict(
            os.environ, {"HERMES_HOME": tempdir}, clear=False
        ), mock.patch.object(
            plugin, "_runtime_secret_file", return_value=f"{tempdir}/4sapi.key"
        ), mock.patch.object(
            plugin,
            "_prepare_agent_harness_environment",
            return_value={
                "controller": "/home/ubuntu/projects/agent-harness/bin/harnessctl",
                "profileHome": f"{tempdir}/profiles/coder/home",
                "projectRoot": "/home/ubuntu/projects/memoflow",
                "capabilityHash": "cap-hash",
                "environmentId": "memoflow-cap-hash",
                "environmentRoot": f"{tempdir}/capability-env",
                "admission": {
                    "host": "codex",
                    "status": "READY",
                    "runtimeState": "READY",
                    "transportMode": "BRIDGED_CHAT",
                    "blockers": [],
                },
            },
        ) as prepare:
            prepared = plugin._prepare_execution_result(
                result, project_path="/home/ubuntu/projects/memoflow"
            )
            runtime = prepared["selected"]["runtime"]
            route = runtime["bridgeRouteConfig"]
            descriptor = json.loads(Path(route).read_text(encoding="utf-8"))
            prepare.assert_called_once_with(
                "/home/ubuntu/projects/memoflow",
                "codex",
                route_config=route,
            )
            self.assertEqual(runtime["capabilityPlaneStatus"], "READY")
            self.assertIn(f"--route-config {route} codex --", runtime["commandTemplate"])
            self.assertIn("$(cat", runtime["commandTemplate"])
            self.assertEqual(descriptor["transportMode"], "BRIDGED_CHAT")
            self.assertEqual(descriptor["credentialRef"], "FORAPI_4SAPI_API_KEY")
            self.assertNotIn("credential-secret-value", json.dumps(descriptor))

    def test_prepare_execution_result_blocks_on_capability_admission_failure(self) -> None:
        result = {
            "status": "SELECTED",
            "selected": {
                "model": "gpt-5.6-sol",
                "providerConnection": {
                    "id": "pconn-team",
                    "providerKey": "team",
                    "authKind": "OAUTH",
                    "credentialRef": "codex-auth:team",
                },
                "runtime": {
                    "selectedHarness": "CODEX",
                    "preferredHarness": "CODEX",
                    "accessProfileId": "access-team",
                    "profileRef": "team",
                    "providerRef": "openai",
                },
                "guidance": "Use Codex.",
            },
        }
        with mock.patch.object(plugin, "_codex_profile_exists", return_value=True), mock.patch.object(
            plugin,
            "_prepare_agent_harness_environment",
            return_value={
                "controller": "/home/ubuntu/projects/agent-harness/bin/harnessctl",
                "profileHome": "/opt/data/profiles/memoflow/home",
                "projectRoot": "/home/ubuntu/projects/memoflow",
                "capabilityHash": "cap-hash",
                "environmentId": "memoflow-cap-hash",
                "environmentRoot": "/tmp/capability-env",
                "admission": {
                    "host": "codex",
                    "status": "BLOCKED",
                    "runtimeState": "READY",
                    "blockers": [{"kind": "mcp", "name": "codegraph", "state": "MISSING"}],
                },
            },
        ):
            prepared = plugin._prepare_execution_result(
                result, project_path="/home/ubuntu/projects/memoflow"
            )
        runtime = prepared["selected"]["runtime"]
        self.assertFalse(runtime["profileReady"])
        self.assertEqual(runtime["capabilityPlaneStatus"], "BLOCKED")
        self.assertEqual(runtime["launchContract"], "BLOCKED_CAPABILITY_ADMISSION")
        self.assertEqual(runtime["capabilityBlockers"][0]["name"], "codegraph")
        self.assertNotIn("commandTemplate", runtime)
        self.assertIn("do not bypass", prepared["selected"]["guidance"])

    def test_prepare_execution_result_blocks_degraded_launch_without_project(self) -> None:
        result = {
            "status": "SELECTED",
            "selected": {
                "model": "gpt-5.6-sol",
                "providerConnection": {
                    "id": "pconn-team",
                    "providerKey": "team",
                    "authKind": "OAUTH",
                    "credentialRef": "codex-auth:team",
                },
                "runtime": {
                    "selectedHarness": "CODEX",
                    "preferredHarness": "CODEX",
                    "accessProfileId": "access-team",
                    "profileRef": "team",
                    "providerRef": "openai",
                },
                "guidance": "Use Codex.",
            },
        }
        with mock.patch.object(plugin, "_codex_profile_exists", return_value=True):
            prepared = plugin._prepare_execution_result(result)
        runtime = prepared["selected"]["runtime"]
        self.assertFalse(runtime["profileReady"])
        self.assertEqual(runtime["capabilityPlaneStatus"], "PROJECT_REQUIRED")
        self.assertEqual(runtime["launchContract"], "BLOCKED_UNTIL_PROJECT_RESOLVED")
        self.assertNotIn("commandTemplate", runtime)
        self.assertIn("project_path", prepared["selected"]["guidance"])

    def test_prepare_agent_harness_environment_uses_profile_home(self) -> None:
        completed = mock.Mock(
            returncode=0,
            stdout=json.dumps(
                {
                    "environment": {
                        "projectRoot": "/home/ubuntu/projects/memoflow",
                        "capabilityHash": "abc123",
                        "environmentId": "memoflow-abc123",
                        "root": "/tmp/env-root",
                    },
                    "admission": {
                        "host": "codex",
                        "status": "READY",
                        "runtimeState": "READY",
                        "blockers": [],
                    },
                }
            ),
            stderr="",
        )
        with tempfile.TemporaryDirectory() as tempdir, mock.patch.dict(
            os.environ, {"HERMES_HOME": tempdir}, clear=False
        ), mock.patch.object(
            plugin, "_agent_harnessctl_path", return_value="/bin/harnessctl"
        ), mock.patch.object(plugin.subprocess, "run", return_value=completed) as run:
            value = plugin._prepare_agent_harness_environment("/home/ubuntu/projects/memoflow", "codex")
        self.assertEqual(value["capabilityHash"], "abc123")
        self.assertTrue(value["profileHome"].endswith("/profiles/coder/home"))
        self.assertEqual(
            run.call_args.args[0],
            ["/bin/harnessctl", "prepare", "/home/ubuntu/projects/memoflow", "--host", "codex", "--json"],
        )
        self.assertEqual(run.call_args.kwargs["env"]["HOME"], value["profileHome"])
        self.assertEqual(value["admission"]["status"], "READY")


if __name__ == "__main__":
    unittest.main()
