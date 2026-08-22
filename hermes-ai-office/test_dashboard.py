from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


DASHBOARD = Path(__file__).with_name("dashboard")
API_PATH = DASHBOARD / "plugin_api.py"
spec = importlib.util.spec_from_file_location("hermes_ai_office_dashboard_api", API_PATH)
assert spec and spec.loader
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class FakeConfig:
    def __init__(self) -> None:
        self.value = {
            "plugins": {
                "entries": {
                    "hermes-ai-office": {
                        "settings": {
                            "execution_mode": "v2",
                            "runtime_policy": {
                                "mode": "prefer",
                                "positions": {
                                    "opencode": "coding-executor",
                                    "codex": "codex-executor",
                                },
                            }
                        }
                    }
                }
            }
        }

    def load_config_readonly(self):
        return self.value

    def save_config(self, partial, merge_existing=True):
        assert merge_existing is True
        if "custom_providers" in partial:
            self.value["custom_providers"] = partial["custom_providers"]
        if "plugins" in partial:
            settings = partial["plugins"]["entries"]["hermes-ai-office"]["settings"]
            if "execution_mode" in settings:
                self.value["plugins"]["entries"]["hermes-ai-office"]["settings"]["execution_mode"] = settings["execution_mode"]
            if "runtime_policy" in settings:
                self.value["plugins"]["entries"]["hermes-ai-office"]["settings"]["runtime_policy"] = settings["runtime_policy"]


class DashboardApiTest(unittest.IsolatedAsyncioTestCase):
    async def test_employee_dossier_proxy_is_lazy_and_validated(self) -> None:
        with mock.patch.object(api, "_fetch_json", return_value={"identity": {"id": "emp_1"}}) as fetch:
            result = await api.employee_dossier("emp_1")
        self.assertEqual(result["identity"]["id"], "emp_1")
        fetch.assert_called_once_with("/api/v2/projections/employees/emp_1/dossier")
        with self.assertRaises(Exception):
            await api.employee_dossier("bad/id")

    async def test_overview_combines_partial_local_projections(self) -> None:
        payloads = {
            "/api/v2/projections/workforce": {"summary": {"employees": 2}},
            "/api/v2/projections/supply": {"summary": {"suppliers": 1}},
            "/api/v2/projections/office": {"summary": {"positions": 3}},
            "/api/v2/incidents?limit=200": {"items": []},
            "/api/v2/runtime-launch-decisions?limit=100": {"items": [{"id": "rlaunch_1"}]},
        }
        with mock.patch.object(api, "_fetch_json", side_effect=lambda path: payloads[path]), mock.patch.object(
            api, "_runtime_policy_settings", return_value={"mode": "prefer"}
        ), mock.patch.object(api, "_sync_profile_native_provider_hub") as legacy_sync:
            result = await api.overview()
        legacy_sync.assert_not_called()
        self.assertEqual(result["workforce"]["summary"]["employees"], 2)
        self.assertEqual(result["supply"]["summary"]["suppliers"], 1)
        self.assertNotIn("personalChannels", result)
        self.assertNotIn("providerHub", result)
        self.assertEqual(result["organization"]["summary"]["positions"], 3)
        self.assertEqual(result["runtimeDecisions"]["items"][0]["id"], "rlaunch_1")
        self.assertEqual(result["controlPlaneUrl"], "local")

    async def test_overview_keeps_other_sections_when_one_source_fails(self) -> None:
        def fetch(path: str):
            if path.startswith("/api/v2/incidents"):
                raise RuntimeError("incident projection unavailable")
            return {"ok": True}

        with mock.patch.object(api, "_fetch_json", side_effect=fetch):
            result = await api.overview()
        self.assertTrue(result["workforce"]["ok"])
        self.assertTrue(result["incidents"]["unavailable"])
        self.assertIn("incident projection unavailable", result["incidents"]["error"])

    async def test_development_projection_composes_v3_runtime_history_usage_and_provider_health(self) -> None:
        payloads = {
            "/api/v3/development/runtime-summary": {
                "sourceHealth": {"openhands": "OK", "litellm": "OK", "langfuse": "UNCONFIGURED"},
                "logicalModels": ["implementation-efficient", "review-premium"],
                "enabledBackends": ["opencode-acp", "openhands-builtin"],
                "concurrency": {"max_active_writers": 4, "max_active_writers_per_project": 2},
            },
            "/api/v3/development/policy": {"version": 1, "phases": {"IMPLEMENT": {"model_class": "implementation-efficient"}}},
            "/api/v3/development/readiness": {
                "status": "NOT_READY",
                "ready": False,
                "gates": {
                    "representativeWorkflows": {"pass": False, "current": 1, "required": 10},
                    "providerFallback": {"pass": True},
                    "gatewayReconnect": {"pass": True},
                    "rollback": {"pass": True},
                    "fixLoop": {"pass": False},
                    "observability": {"pass": True, "verified": 3, "required": 3},
                },
            },
            "/api/v3/development/executions?limit=80": {
                "items": [
                    {"executionId": "exec-run", "projectKey": "body", "phase": "IMPLEMENT", "status": "RUNNING"},
                    {"executionId": "exec-done", "projectKey": "body", "phase": "VERIFY_REVIEW", "status": "SUCCEEDED"},
                ]
            },
            "/api/v3/development/model-registry": {
                "authority": "LITELLM",
                "health": "OK",
                "adminUrl": "https://oracle.example:10446/ui/",
                "credentials": {"count": 2, "items": []},
                "deployments": {"count": 3, "active": 2, "paused": 1, "groups": {"gpt-5.6-sol": 2}, "items": []},
                "aliases": {"review-premium": "gpt-5.6-sol"},
            },
            "/api/v3/development/executions/exec-run": {
                "executionId": "exec-run", "projectKey": "body", "phase": "IMPLEMENT", "status": "RUNNING",
                "usage": {"input": 100, "output": 10, "cachedInput": 40, "costUsd": 0.1, "calls": 2},
                "refs": {"openhandsConversationId": "conv-run"},
            },
            "/api/v3/development/executions/exec-done": {
                "executionId": "exec-done", "projectKey": "body", "phase": "VERIFY_REVIEW", "status": "SUCCEEDED",
                "usage": {"input": 200, "output": 20, "costUsd": 0.2, "calls": 3},
                "refs": {"langfuseTraceId": "trace-done"},
            },
        }

        def fetch(path: str, **_kwargs):
            return payloads[path]

        with mock.patch.object(api, "_fetch_json", side_effect=fetch):
            result = await api.development()
        self.assertEqual(result["projectionVersion"], 1)
        self.assertEqual([item["executionId"] for item in result["active"]], ["exec-run"])
        self.assertEqual([item["executionId"] for item in result["history"]], ["exec-done"])
        self.assertEqual(result["summary"]["usage"]["input"], 300)
        self.assertEqual(result["summary"]["usage"]["output"], 30)
        self.assertEqual(result["summary"]["usage"]["calls"], 5)
        self.assertAlmostEqual(result["summary"]["usage"]["costUsd"], 0.3)
        self.assertEqual(result["summary"]["usage"]["traces"], 1)
        self.assertEqual(result["runtime"]["logicalModels"][0], "implementation-efficient")
        self.assertEqual(result["readiness"]["status"], "NOT_READY")
        self.assertFalse(result["readiness"]["gates"]["representativeWorkflows"]["pass"])
        self.assertEqual(result["providers"]["deployments"]["active"], 2)

    async def test_development_projection_degrades_partially_without_hiding_execution_history(self) -> None:
        def fetch(path: str, **_kwargs):
            if path == "/api/v3/development/runtime-summary":
                raise RuntimeError("runtime unavailable")
            if path == "/api/v3/development/executions?limit=80":
                return {"items": [{"executionId": "exec-old", "projectKey": "p", "phase": "FINALIZE", "status": "SUCCEEDED"}]}
            if path == "/api/v3/development/executions/exec-old":
                return {"executionId": "exec-old", "projectKey": "p", "phase": "FINALIZE", "status": "SUCCEEDED"}
            return {"ok": True}

        with mock.patch.object(api, "_fetch_json", side_effect=fetch):
            result = await api.development()
        self.assertTrue(result["runtime"]["unavailable"])
        self.assertEqual(result["history"][0]["executionId"], "exec-old")

    async def test_model_registry_is_a_thin_v3_litellm_proxy(self) -> None:
        expected = {
            "authority": "LITELLM",
            "health": "OK",
            "adminUrl": "https://oracle.example:10446/ui/",
            "credentials": {"count": 15, "items": []},
            "deployments": {"count": 98, "active": 15, "paused": 83, "groups": {}, "items": []},
            "aliases": {"planning-premium": "gpt-5.6-sol"},
        }
        with mock.patch.object(api, "_fetch_json", return_value=expected) as fetch:
            result = await api.model_registry()
        self.assertEqual(result, expected)
        fetch.assert_called_once_with("/api/v3/development/model-registry")

    async def test_legacy_provider_and_supplier_management_endpoints_are_gone(self) -> None:
        calls = [
            lambda: api.provider_hub(False),
            lambda: api.provider_hub_detail("pconn_1"),
            lambda: api.provider_hub_control("pconn_1", api.ProviderControlRequest(enabled=False)),
            lambda: api.provider_hub_profile(
                "pconn_1",
                api.ProviderProfileRequest(
                    display_name="Relay",
                    base_url="https://relay.example/v1",
                    website_url="https://relay.example",
                    protocol="openai-chat-completions",
                ),
            ),
            lambda: api.provider_hub_retire("pconn_1", api.ProviderRetireRequest(reason="retired")),
            lambda: api.supplier_profile("sup_1", api.SupplierProfileRequest(name="Relay", website_url="")),
            lambda: api.supplier_economics(
                "sup_1",
                api.SupplierEconomicsRequest(
                    supply_origin="COMMUNITY_RELAY",
                    commercial_type="SPONSORED",
                    routing_policy="AUTO",
                ),
            ),
            lambda: api.supplier_retire("sup_1", api.SupplierRetireRequest(reason="retired", force=True)),
            lambda: api.supplier_connections("sup_1"),
            lambda: api.provider_presets(),
        ]
        with mock.patch.object(api, "_post_json") as post, mock.patch.object(api, "_fetch_json") as fetch:
            for call in calls:
                with self.assertRaises(api.HTTPException) as raised:
                    await call()
                self.assertEqual(raised.exception.status_code, 410)
                self.assertIn("LiteLLM Admin", str(raised.exception.detail))
        post.assert_not_called()
        fetch.assert_not_called()

    async def test_legacy_provider_registration_is_retired_before_secret_or_domain_write(self) -> None:
        body = api.ProviderRegisterRequest(
            preset_id="custom",
            api_key="do-not-store",
            base_url="https://relay.example/v1",
            selected_models=["alpha"],
            default_model="alpha",
        )
        with mock.patch.object(api, "_discover_provider_models") as discover, mock.patch.object(
            api, "_save_provider_secret"
        ) as save, mock.patch.object(api, "_post_json") as post:
            with self.assertRaises(api.HTTPException) as raised:
                await api.register_provider(body)
        self.assertEqual(raised.exception.status_code, 410)
        discover.assert_not_called()
        save.assert_not_called()
        post.assert_not_called()

    def test_profile_discovery_ignores_ai_office_managed_codex_and_opencode_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            home = root / "profiles" / "memoflow" / "home"
            codex = home / ".codex"
            codex.mkdir(parents=True)
            (codex / "config.toml").write_text(
                '[model_providers."hao-relay-1234"]\n'
                'name = "Hermes AI Office · hao-relay-1234"\n'
                'base_url = "https://relay.example/v1"\n'
                'env_key = "RELAY_API_KEY"\n'
                'wire_api = "responses"\n',
                encoding="utf-8",
            )
            (codex / "hao-relay.config.toml").write_text(
                '# HERMES AI OFFICE MANAGED PROFILE\n'
                'model_provider = "hao-relay-1234"\n'
                'model = "gpt-5.5"\n',
                encoding="utf-8",
            )
            opencode = home / ".config" / "opencode"
            opencode.mkdir(parents=True)
            (opencode / "opencode.json").write_text(
                json.dumps(
                    {
                        "provider": {
                            "relay": {
                                "npm": "@ai-sdk/openai-compatible",
                                "options": {
                                    "baseURL": "https://relay.example/v1",
                                    "apiKey": "{file:/opt/data/profiles/memoflow/secrets/hermes-ai-office/credential-deadbeef.key}",
                                },
                                "models": {"gpt-5.5": {}},
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch.object(api, "get_hermes_home", return_value=str(root)), mock.patch.object(
                api, "_hub_upsert_connection"
            ) as upsert, mock.patch.object(api, "_hub_link") as link, mock.patch.object(
                api, "_register_discovered_employee"
            ) as employee:
                discovered = api._discover_profile_native_connections()
        self.assertEqual(discovered, [])
        upsert.assert_not_called()
        link.assert_not_called()
        employee.assert_not_called()

    def test_profile_default_prevents_false_unfilled_state_without_guessing_employee(self) -> None:
        organization = {
            "summary": {"staffedPositions": 0, "unfilledPositions": 1},
            "positions": [
                {
                    "id": "pos_profile",
                    "runtimeKind": "HERMES_PROFILE",
                    "status": "UNFILLED",
                    "workScope": {"slug": "coder", "name": "Coder"},
                    "currentAppointments": [],
                }
            ],
        }
        workforce = {
            "employees": [
                {
                    "id": "emp_open",
                    "displayName": "DeepSeek V4 Flash @ OpenCode",
                    "supplier": {"slug": "opencode"},
                    "supplierModel": {"key": "deepseek-v4-flash"},
                },
                {
                    "id": "emp_pool",
                    "displayName": "DeepSeek V4 Flash @ Planner Pool",
                    "supplier": {"slug": "planner-pool"},
                    "supplierModel": {"key": "deepseek-v4-flash"},
                },
            ]
        }
        with mock.patch.object(
            api,
            "_hermes_model_defaults",
            return_value={
                "coder": {
                    "provider": "deepseek",
                    "model": "deepseek-v4-flash",
                    "source": "HERMES_PROFILE_CONFIG",
                }
            },
        ):
            enriched = api._enrich_organization(organization, workforce)
        position = enriched["positions"][0]
        self.assertEqual(position["status"], "DEFAULT_MODEL")
        self.assertEqual(position["effectiveStaffing"]["model"], "deepseek-v4-flash")
        self.assertIsNone(position["effectiveStaffing"]["employeeId"])
        self.assertEqual(enriched["summary"]["defaultedPositions"], 1)
        self.assertEqual(enriched["summary"]["configuredPositions"], 1)
        self.assertEqual(enriched["summary"]["staffedPositions"], 0)
        self.assertEqual(enriched["summary"]["unfilledPositions"], 0)

    def test_provider_specific_default_can_resolve_one_employee(self) -> None:
        organization = {
            "summary": {},
            "positions": [
                {
                    "id": "pos_profile",
                    "runtimeKind": "HERMES_PROFILE",
                    "status": "UNFILLED",
                    "workScope": {"slug": "default"},
                    "currentAppointments": [],
                }
            ],
        }
        workforce = {
            "employees": [
                {
                    "id": "emp_open",
                    "displayName": "DeepSeek V4 Flash @ OpenCode",
                    "supplier": {"slug": "opencode"},
                    "supplierModel": {"key": "deepseek-v4-flash"},
                },
                {
                    "id": "emp_pool",
                    "displayName": "DeepSeek V4 Flash @ Planner Pool",
                    "supplier": {"slug": "planner-pool"},
                    "supplierModel": {"key": "deepseek-v4-flash"},
                },
            ]
        }
        with mock.patch.object(
            api,
            "_hermes_model_defaults",
            return_value={
                "*": {
                    "provider": "opencode-go",
                    "model": "deepseek-v4-flash",
                    "source": "HERMES_GLOBAL_CONFIG",
                }
            },
        ):
            enriched = api._enrich_organization(organization, workforce)
        effective = enriched["positions"][0]["effectiveStaffing"]
        self.assertEqual(effective["state"], "DEFAULTED")
        self.assertEqual(effective["employeeId"], "emp_open")
        self.assertEqual(enriched["summary"]["unfilledPositions"], 0)

    async def test_runtime_policy_settings_round_trip_through_hermes_config(self) -> None:
        fake = FakeConfig()
        with mock.patch.object(api, "config_mod", fake):
            before = await api.get_runtime_policy()
            self.assertEqual(before["executionMode"], "v2")
            self.assertEqual(before["mode"], "prefer")
            result = await api.set_runtime_policy(
                api.RuntimePolicySettings(
                    execution_mode="v3",
                    mode="enforce",
                    opencode_position="review-executor",
                    codex_position="codex-reviewer",
                )
            )
            self.assertTrue(result["ok"])
            self.assertEqual(result["runtimePolicy"]["executionMode"], "v3")
            self.assertEqual(result["runtimePolicy"]["mode"], "enforce")
            self.assertEqual(result["runtimePolicy"]["opencodePosition"], "review-executor")
            self.assertEqual(result["runtimePolicy"]["codexPosition"], "codex-reviewer")

    async def test_provider_discovery_endpoint_is_retired_in_favor_of_litellm_admin(self) -> None:
        body = api.ProviderDiscoverRequest(preset_id="custom", api_key="secret", base_url="https://relay.example/v1")
        with mock.patch.object(api, "_discover_provider_models") as discover:
            with self.assertRaises(api.HTTPException) as raised:
                await api.discover_provider(body)
        self.assertEqual(raised.exception.status_code, 410)
        discover.assert_not_called()

    def test_local_provider_endpoint_is_not_presented_as_an_official_website(self) -> None:
        self.assertEqual(api._website_origin("http://127.0.0.1:8317/v1"), "")
        self.assertEqual(api._website_origin("http://localhost:8317/v1"), "")
        self.assertEqual(api._website_origin("https://worldclawpro.ai/v1"), "https://worldclawpro.ai")

    def test_custom_supplier_name_is_optional_and_identity_is_stable_by_endpoint(self) -> None:
        first = api._custom_supplier_identity("https://proxy.example.com/v1")
        second = api._custom_supplier_identity("https://proxy.example.com/v1/", "")
        named = api._custom_supplier_identity("https://proxy.example.com/v1", "Team Router")
        self.assertEqual(first["providerId"], second["providerId"])
        self.assertEqual(first["supplierSlug"], second["supplierSlug"])
        self.assertEqual(first["supplierName"], "Proxy")
        self.assertEqual(named["supplierName"], "Team Router")
        self.assertTrue(first["keyEnv"].startswith("HERMES_AI_OFFICE_"))

    def test_custom_provider_config_stores_only_key_reference(self) -> None:
        fake = FakeConfig()
        fake.value["custom_providers"] = []
        descriptor = {
            "providerId": "custom:abc123",
            "supplierName": "Team Router",
            "baseUrl": "https://proxy.example.com/v1",
            "keyEnv": "HERMES_AI_OFFICE_ABC123_API_KEY",
        }
        with mock.patch.object(api, "config_mod", fake):
            api._save_custom_provider(descriptor)
        row = fake.value["custom_providers"][0]
        self.assertEqual(row["key_env"], "HERMES_AI_OFFICE_ABC123_API_KEY")
        self.assertNotIn("api_key", row)

    def test_litellm_registry_replaces_provider_hub_runtime_authority(self) -> None:
        source = API_PATH.read_text(encoding="utf-8")
        self.assertIn('@router.get("/model-registry")', source)
        self.assertIn('/api/v3/development/model-registry', source)
        self.assertIn('_provider_hub_retired()', source)
        bundle = (DASHBOARD / "dist" / "index.js").read_text(encoding="utf-8")
        self.assertIn('api("/model-registry")', bundle)
        self.assertIn('registry.openAdmin', bundle)
        self.assertNotIn('api("/providers/presets")', bundle)
        self.assertNotIn('api("/providers/register"', bundle)
        self.assertNotIn('api("/providers/hub/" + encodeURIComponent', bundle)

    def test_control_plane_url_is_forced_to_loopback(self) -> None:
        with mock.patch.dict(os.environ, {"HERMES_AI_OFFICE_CONTROL_PLANE_URL": "https://attacker.example"}):
            self.assertEqual(api._base_url(), "http://127.0.0.1:8320")
        with mock.patch.dict(os.environ, {"HERMES_AI_OFFICE_CONTROL_PLANE_URL": "http://localhost:9000"}):
            self.assertEqual(api._base_url(), "http://localhost:9000")


class DashboardBundleContractTest(unittest.TestCase):
    def test_manifest_and_bundle_use_native_dashboard_sdk(self) -> None:
        manifest = json.loads((DASHBOARD / "manifest.json").read_text())
        source = (DASHBOARD / "dist" / "index.js").read_text()
        self.assertEqual(manifest["name"], "hermes-ai-office")
        self.assertEqual(manifest["tab"]["path"], "/office")
        self.assertEqual(manifest["api"], "plugin_api.py")
        self.assertIn('registry.register("hermes-ai-office", OfficePage)', source)
        self.assertIn('"suppliers", "operations"', source)
        self.assertNotIn('tab === "providers"', source)
        self.assertIn("window.__HERMES_PLUGIN_SDK__", source)
        self.assertNotIn('from "react"', source)
        self.assertNotIn("react.production.min", source)
        self.assertIn("SDK.useI18n", source)
        self.assertIn("hermes-locale", source)
        self.assertIn("组织架构", source)
        self.assertIn("网关观测", source)
        self.assertIn("observedUsage", source)
        self.assertIn('role: "tablist"', source)
        self.assertIn('aria-selected', source)
        self.assertIn('className: "hao-data-table"', source)

    def test_model_registry_ui_delegates_provider_crud_to_native_litellm_admin(self) -> None:
        bundle = (DASHBOARD / "dist" / "index.js").read_text(encoding="utf-8")
        self.assertIn('"tabs.suppliers": "模型与供应商"', bundle)
        self.assertIn('function Suppliers(props)', bundle)
        self.assertIn('api("/model-registry")', bundle)
        self.assertIn('window.open(adminUrl, "_blank", "noopener,noreferrer")', bundle)
        self.assertIn('props.t("registry.credentials")', bundle)
        self.assertIn('props.t("registry.deployments")', bundle)
        self.assertIn('props.t("registry.aliases")', bundle)
        self.assertIn('item.providerKey', bundle)
        self.assertIn('item.commercialType', bundle)
        self.assertIn('item.protocol', bundle)
        self.assertIn('item.credential', bundle)
        self.assertIn('item.blocked ? "PAUSED" : "AVAILABLE"', bundle)
        self.assertNotIn('api("/providers/presets")', bundle)
        self.assertNotIn('api("/providers/discover"', bundle)
        self.assertNotIn('api("/providers/register"', bundle)
        self.assertNotIn('api("/providers/hub/" + encodeURIComponent', bundle)
        self.assertNotIn('api("/suppliers/" + encodeURIComponent(String(manageSupplier.id))', bundle)

    def test_development_tab_exposes_v3_execution_policy_health_and_usage(self) -> None:
        source = (DASHBOARD / "dist" / "index.js").read_text(encoding="utf-8")
        css = (DASHBOARD / "dist" / "style.css").read_text(encoding="utf-8")
        self.assertIn('"overview", "development", "organization"', source)
        self.assertIn('function Development(props)', source)
        self.assertIn('api("/development")', source)
        self.assertIn('policy.executionV3', source)
        self.assertIn('execution_mode: executionMode', source)
        self.assertIn('props.t("development.active")', source)
        self.assertIn('props.t("development.history")', source)
        self.assertIn('props.t("development.readiness")', source)
        self.assertIn('readinessGates.providerFallback', source)
        self.assertIn('readinessGates.gatewayReconnect', source)
        self.assertIn('props.t("development.routing")', source)
        self.assertIn('runtime.logicalModels', source)
        self.assertIn('policy.phases', source)
        self.assertIn('item.usage', source)
        self.assertIn('upstream.route', source)
        self.assertIn('development.observedRoute', source)
        self.assertIn('["openhands", "litellm", "observability", "langfuse"]', source)
        self.assertIn('refs.openhandsConversationId', source)
        self.assertIn('refs.langfuseTraceId', source)
        self.assertIn('className: "hao-dev-policy-grid"', source)
        self.assertIn('.hao-dev-two-column {', css)
        self.assertIn('.hao-dev-policy-grid {', css)
        self.assertIn('.hao-dev-health-row {', css)
        self.assertIn('"tabs.development": "开发控制"', source)

    def test_active_tab_keeps_an_explicit_readable_label(self) -> None:
        css = (DASHBOARD / "dist" / "style.css").read_text()
        self.assertIn('.hao-tab[aria-selected="true"]', css)
        self.assertRegex(css, r'\.hao-tab\[aria-selected="true"\][^{]*\{[^}]*color:')

    def test_dashboard_owns_high_contrast_content_tokens(self) -> None:
        css = (DASHBOARD / "dist" / "style.css").read_text()
        self.assertIn('.hao-page[data-hao-theme="light"]', css)
        self.assertIn('.hao-page[data-hao-theme="dark"]', css)
        self.assertIn("--hao-text: #10232f", css)
        self.assertIn("--hao-text: #f7fbfd", css)
        self.assertIn("--hao-text-secondary: #314b59", css)
        self.assertIn("--hao-text-secondary: #d6e4eb", css)
        self.assertRegex(css, r"\.hao-hero h1\s*\{[^}]*color: var\(--hao-text\) !important")
        self.assertRegex(css, r"\.hao-data-table th[^}]*color: var\(--hao-table-head-text\) !important")
        self.assertRegex(css, r"\.hao-data-table th,\s*\.hao-data-table td[^}]*color: var\(--hao-text-secondary\) !important")
        self.assertIn("-webkit-text-fill-color: currentColor", css)
        self.assertNotIn("--hao-text: var(--foreground", css)

    def test_dashboard_follows_hermes_theme_without_a_plugin_specific_setting(self) -> None:
        source = (DASHBOARD / "dist" / "index.js").read_text()
        self.assertIn("function resolveHostTheme()", source)
        self.assertIn("document.documentElement.dataset.theme", source)
        self.assertIn('document.documentElement.classList.contains("dark")', source)
        self.assertIn('window.matchMedia("(prefers-color-scheme: dark)")', source)
        self.assertIn("new MutationObserver(sync)", source)
        self.assertIn('"data-hao-theme": theme', source)

    def test_critical_dark_theme_text_cannot_inherit_transparent_fill(self) -> None:
        css = (DASHBOARD / "dist" / "style.css").read_text()
        self.assertRegex(
            css,
            r"\.hao-tab,\s*\.hao-metric-value,[^{]*\{[^}]*-webkit-text-fill-color: currentColor",
        )
        self.assertRegex(
            css,
            r'\.hao-page\[data-hao-theme="dark"\][^{]*\{[^}]*--hao-tab-active-text: #ffffff',
        )


if __name__ == "__main__":
    unittest.main()
