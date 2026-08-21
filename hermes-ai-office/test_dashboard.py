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
            runtime = partial["plugins"]["entries"]["hermes-ai-office"]["settings"]["runtime_policy"]
            self.value["plugins"]["entries"]["hermes-ai-office"]["settings"]["runtime_policy"] = runtime


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
        ):
            result = await api.overview()
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

    async def test_provider_hub_control_forwards_enabled_and_reason(self) -> None:
        with mock.patch.object(api, "_post_json", return_value={"ok": True}) as post:
            result = await api.provider_hub_control(
                "pconn_1", api.ProviderControlRequest(enabled=False, reason="maintenance")
            )
        self.assertEqual(result, {"ok": True})
        post.assert_called_once_with(
            "/api/v2/commands/provider-connections/pconn_1/control",
            {"enabled": False, "reason": "maintenance"},
        )

    async def test_provider_hub_control_rejects_invalid_connection_id(self) -> None:
        with self.assertRaises(api.HTTPException) as raised:
            await api.provider_hub_control(
                "bad/id", api.ProviderControlRequest(enabled=True)
            )
        self.assertEqual(raised.exception.status_code, 400)

    async def test_provider_management_proxies_profile_and_retire_commands(self) -> None:
        with mock.patch.object(api, "_post_json", return_value={"ok": True}) as post:
            updated = await api.provider_hub_profile(
                "pconn_1",
                api.ProviderProfileRequest(
                    display_name="Relay",
                    base_url="https://relay.example/v1",
                    website_url="https://relay.example",
                    protocol="openai-responses",
                ),
            )
            retired = await api.provider_hub_retire(
                "pconn_1", api.ProviderRetireRequest(reason="cleanup")
            )
        self.assertEqual(updated, {"ok": True})
        self.assertEqual(retired, {"ok": True})
        self.assertEqual(post.call_args_list[0].args[0], "/api/v2/commands/provider-connections/pconn_1/profile")
        self.assertEqual(post.call_args_list[1].args[0], "/api/v2/commands/provider-connections/pconn_1/retire")

    async def test_supplier_management_proxies_profile_and_force_retire(self) -> None:
        with mock.patch.object(api, "_post_json", return_value={"ok": True}) as post:
            updated = await api.supplier_profile(
                "sup_1", api.SupplierProfileRequest(name="Relay", website_url="https://relay.example")
            )
            retired = await api.supplier_retire(
                "sup_1", api.SupplierRetireRequest(reason="cleanup", force=True)
            )
        self.assertEqual(updated, {"ok": True})
        self.assertEqual(retired, {"ok": True})
        self.assertEqual(post.call_args_list[0].args[0], "/api/v2/commands/suppliers/sup_1/profile")
        self.assertEqual(post.call_args_list[1].args[0], "/api/v2/commands/suppliers/sup_1/retire")
        self.assertTrue(post.call_args_list[1].args[1]["force"])

    async def test_provider_presets_hide_expensive_deepseek_official_api(self) -> None:
        result = await api.provider_presets()
        ids = [item["id"] for item in result["items"]]
        self.assertNotIn("deepseek", ids)
        self.assertIn("opencode-go", ids)

    async def test_custom_onboarding_rejects_deepseek_official_as_brain_only(self) -> None:
        descriptor = {
            "id": "custom-deepseek",
            "name": "DeepSeek official",
            "supplierSlug": "custom-deepseek",
            "supplierName": "DeepSeek official",
            "baseUrl": "https://api.deepseek.com/v1",
            "keyEnv": "DEEPSEEK_API_KEY",
            "transport": "openai_chat",
        }
        body = api.ProviderRegisterRequest(
            preset_id="custom",
            api_key="do-not-store",
            selected_models=["deepseek-chat"],
            default_model="deepseek-chat",
        )
        with mock.patch.object(
            api, "_discover_provider_models", return_value=(descriptor, ["deepseek-chat"], False)
        ), mock.patch.object(api, "_save_provider_secret") as save, mock.patch.object(
            api, "_hub_upsert_connection"
        ) as upsert:
            with self.assertRaises(api.HTTPException) as raised:
                await api.register_provider(body)
        self.assertEqual(raised.exception.status_code, 422)
        self.assertIn("Hermes 大脑", str(raised.exception.detail))
        save.assert_not_called()
        upsert.assert_not_called()

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
            self.assertEqual(before["mode"], "prefer")
            result = await api.set_runtime_policy(
                api.RuntimePolicySettings(
                    mode="enforce",
                    opencode_position="review-executor",
                    codex_position="codex-reviewer",
                )
            )
            self.assertTrue(result["ok"])
            self.assertEqual(result["runtimePolicy"]["mode"], "enforce")
            self.assertEqual(result["runtimePolicy"]["opencodePosition"], "review-executor")
            self.assertEqual(result["runtimePolicy"]["codexPosition"], "codex-reviewer")

    async def test_provider_registration_only_materializes_selected_models_and_never_sends_key_to_domain(self) -> None:
        descriptor = {
            "id": "deepseek",
            "name": "DeepSeek API",
            "supplierSlug": "deepseek",
            "supplierName": "DeepSeek",
            "baseUrl": "https://relay.example/v1",
            "keyEnv": "DEEPSEEK_API_KEY",
            "transport": "openai_chat",
            "plan": {"slug": "api", "name": "DeepSeek API", "commercialType": "METERED"},
            "opencodePrefix": "deepseek",
        }
        calls = []

        def post(path, payload, **kwargs):
            calls.append((path, payload, kwargs))
            if path.endswith("provider-connections/upsert"):
                return {
                    "id": "pconn_deepseek",
                    "provider_key": payload["providerKey"],
                    "display_name": payload["displayName"],
                    "supplier_id": payload.get("supplierId"),
                    "base_url": payload.get("baseUrl"),
                    "protocol": payload.get("protocol"),
                    "auth_kind": payload.get("authKind"),
                    "credential_ref": payload.get("credentialRef"),
                    "credential_scope": payload.get("credentialScope"),
                    "source_profile_id": payload.get("sourceProfileId"),
                    "source_kind": payload.get("sourceKind"),
                    "share_scope": payload.get("shareScope"),
                    "health": payload.get("health"),
                    "models": payload.get("models") or [],
                    "metadata": payload.get("metadata") or {},
                }
            if path.endswith("workforce-sources/upsert"):
                return {"id": "sup_deepseek", "slug": payload["slug"], "name": payload["name"], "source_kind": payload["sourceKind"]}
            if path.endswith("/staffing-preferences"):
                return {"metadata": {"staffingPreferences": payload}}
            if path.endswith("/runtime-access"):
                return {"id": "raccess_" + str(payload["runtimeKind"]).lower(), **payload}
            model = payload["supplierModel"]["key"]
            suffix = model.replace("/", "-")
            return {
                "supplier": {"id": "sup_deepseek"},
                "employee": {"id": f"emp_{suffix}", "displayName": model},
                "employment": {"id": f"empl_{suffix}"},
            }

        body = api.ProviderRegisterRequest(
            preset_id="deepseek",
            api_key="secret-key-value",
            selected_models=["deepseek-chat", "deepseek-reasoner"],
            default_model="deepseek-reasoner",
        )
        with mock.patch.object(
            api,
            "_discover_provider_models",
            return_value=(descriptor, ["deepseek-chat", "deepseek-reasoner", "unused"], False),
        ), mock.patch.object(api, "_post_json", side_effect=post), mock.patch.object(
            api, "_save_provider_secret"
        ) as save_secret:
            result = await api.register_provider(body)

        self.assertTrue(result["ok"])
        self.assertEqual([item["model"] for item in result["employees"]], ["deepseek-chat", "deepseek-reasoner"])
        self.assertEqual(result["defaultEmployeeId"], "emp_deepseek-reasoner")
        save_secret.assert_called_once_with(descriptor, "secret-key-value")
        catalog_calls = [payload for path, payload, _ in calls if path.endswith("supply-catalog/register")]
        self.assertEqual(len(catalog_calls), 2)
        self.assertFalse(any("secret-key-value" in json.dumps(payload) for payload in catalog_calls))
        source_calls = [payload for path, payload, _ in calls if path.endswith("workforce-sources/upsert")]
        self.assertGreaterEqual(len(source_calls), 1)
        self.assertTrue(all(payload["sourceKind"] == "EXTERNAL" for payload in source_calls))
        self.assertFalse(any("secret-key-value" in json.dumps(payload) for payload in source_calls))
        hub_calls = [payload for path, payload, _ in calls if path.endswith("provider-connections/upsert")]
        self.assertGreaterEqual(len(hub_calls), 1)
        self.assertFalse(any("secret-key-value" in json.dumps(payload) for payload in hub_calls))
        preference = [payload for path, payload, _ in calls if path.endswith("staffing-preferences")][0]
        self.assertEqual(preference["enabledEmployeeIds"], ["emp_deepseek-chat", "emp_deepseek-reasoner"])
        self.assertEqual(preference["defaultEmployeeId"], "emp_deepseek-reasoner")

    async def test_custom_provider_creates_native_runtime_access_without_business_secret_leak(self) -> None:
        descriptor = {
            "id": "custom",
            "providerId": "custom:abc123",
            "name": "Team Router",
            "supplierSlug": "custom-abc123",
            "supplierName": "Team Router",
            "keyEnv": "HERMES_AI_OFFICE_ABC123_API_KEY",
            "baseUrl": "https://proxy.example.com/v1",
            "transport": "openai_chat",
        }
        calls = []

        def post(path, payload, idempotency_key=None):
            calls.append((path, payload, idempotency_key))
            if path.endswith("provider-connections/upsert"):
                return {
                    "id": "pconn_custom",
                    "provider_key": payload["providerKey"],
                    "display_name": payload["displayName"],
                    "supplier_id": payload.get("supplierId"),
                    "base_url": payload.get("baseUrl"),
                    "protocol": payload.get("protocol"),
                    "auth_kind": payload.get("authKind"),
                    "credential_ref": payload.get("credentialRef"),
                    "credential_scope": payload.get("credentialScope"),
                    "source_profile_id": payload.get("sourceProfileId"),
                    "source_kind": payload.get("sourceKind"),
                    "share_scope": payload.get("shareScope"),
                    "health": payload.get("health"),
                    "models": payload.get("models") or [],
                    "metadata": payload.get("metadata") or {},
                }
            if path.endswith("workforce-sources/upsert"):
                return {"id": "sup_custom", "slug": payload["slug"], "name": payload["name"], "source_kind": payload["sourceKind"]}
            if path.endswith("supply-catalog/register"):
                model = payload["supplierModel"]["key"]
                return {
                    "supplier": {"id": "sup_custom"},
                    "employee": {"id": f"emp_{model}", "displayName": model},
                    "employment": {"id": f"empl_{model}"},
                }
            if path.endswith("runtime-access"):
                return {"id": "raccess_" + str(payload["runtimeKind"]).lower(), **payload}
            if path.endswith("staffing-preferences"):
                return {"metadata": {"staffingPreferences": payload}}
            raise AssertionError(path)

        body = api.ProviderRegisterRequest(
            preset_id="custom",
            api_key="secret-key-value",
            base_url="https://proxy.example.com/v1",
            supplier_name="Team Router",
            selected_models=["alpha", "beta"],
            default_model="beta",
        )
        with mock.patch.object(
            api,
            "_discover_provider_models",
            return_value=(descriptor, ["alpha", "beta", "unused"], False),
        ), mock.patch.object(api, "_post_json", side_effect=post), mock.patch.object(
            api, "_save_provider_secret"
        ), mock.patch.object(api, "_save_custom_provider"):
            result = await api.register_provider(body)

        self.assertTrue(result["ok"])
        catalog_payloads = [payload for path, payload, _ in calls if path.endswith("supply-catalog/register")]
        self.assertEqual(len(catalog_payloads), 2)
        self.assertFalse(any("secret-key-value" in json.dumps(payload) for payload in catalog_payloads))
        source_payloads = [payload for path, payload, _ in calls if path.endswith("workforce-sources/upsert")]
        self.assertGreaterEqual(len(source_payloads), 1)
        self.assertFalse(any("secret-key-value" in json.dumps(payload) for payload in source_payloads))
        hub_payloads = [payload for path, payload, _ in calls if path.endswith("provider-connections/upsert")]
        self.assertGreaterEqual(len(hub_payloads), 1)
        self.assertFalse(any("secret-key-value" in json.dumps(payload) for payload in hub_payloads))
        access_calls = [(path, payload) for path, payload, _ in calls if path.endswith("runtime-access")]
        self.assertEqual(len(access_calls), 4)
        self.assertTrue(all(payload["adapterKind"] == "NATIVE_CONFIG" for _, payload in access_calls))
        self.assertFalse(any("secret-key-value" in json.dumps(payload) for _, payload in access_calls))
        opencode = next(payload for _, payload in access_calls if payload["runtimeKind"] == "OPENCODE")
        self.assertEqual(opencode["providerRef"], "hao-custom-abc123")
        self.assertEqual(opencode["baseUrl"], "https://proxy.example.com/v1")
        self.assertEqual(opencode["credentialRef"], "HERMES_AI_OFFICE_ABC123_API_KEY")
        self.assertEqual(opencode["config"]["providerHubConnectionId"], "pconn_custom")
        codex = next(payload for _, payload in access_calls if payload["runtimeKind"] == "CODEX")
        self.assertEqual(codex["config"]["providerHubConnectionId"], "pconn_custom")
        self.assertEqual(result["employees"][0]["runtimeAccess"][0]["adapterKind"], "NATIVE_CONFIG")
        self.assertEqual(result["defaultEmployeeId"], "emp_beta")

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

    def test_provider_hub_remains_backend_registry_but_not_business_navigation(self) -> None:
        source = API_PATH.read_text(encoding="utf-8")
        self.assertIn('@router.get("/providers/hub/{connection_id}")', source)
        self.assertIn('_sync_profile_native_provider_hub', source)
        bundle = (DASHBOARD / "dist" / "index.js").read_text(encoding="utf-8")
        self.assertNotIn('tab === "providers"', bundle)
        self.assertNotIn('"overview", "organization", "workforce", "suppliers", "providers"', bundle)

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

    def test_supplier_detail_owns_website_and_provider_connection_metadata(self) -> None:
        bundle = (DASHBOARD / "dist" / "index.js").read_text(encoding="utf-8")
        self.assertIn('supplier.websiteUrl', bundle)
        self.assertIn('suppliers.website', bundle)
        self.assertIn('api("/suppliers/" + encodeURIComponent(String(supplier.id)) + "/connections")', bundle)
        self.assertIn('connection.base_url', bundle)
        self.assertIn('connection.credential_ref', bundle)
        self.assertIn('hao-external-link', bundle)
        self.assertNotIn('function ProviderHub(props)', bundle)

    def test_provider_connection_controls_distinguish_admin_and_effective_state(self) -> None:
        bundle = (DASHBOARD / "dist" / "index.js").read_text(encoding="utf-8")
        self.assertIn('api("/providers/hub/" + encodeURIComponent(String(connection.id)) + "/control"', bundle)
        self.assertIn('const adminState = String(connection.adminState || "DISABLED").toUpperCase()', bundle)
        self.assertIn('const effectiveState = String(connection.effectiveState || connection.health || "UNKNOWN").toUpperCase()', bundle)
        self.assertIn('const retryStates = ["UNAVAILABLE", "TEMP_UNAVAILABLE"]', bundle)
        self.assertIn('props.t("suppliers.enable")', bundle)
        self.assertIn('props.t("suppliers.retry")', bundle)
        self.assertIn('props.t("suppliers.disable")', bundle)
        self.assertIn('JSON.stringify({ enabled: Boolean(enabled)', bundle)
        self.assertIn('asArray(connection.recentAttempts).slice().sort', bundle)
        self.assertIn('Number.isFinite(leftNumeric) ? leftNumeric : Date.parse', bundle)
        self.assertIn('Number.isFinite(rightNumeric) ? rightNumeric : Date.parse', bundle)
        self.assertIn(').slice(0, 5)', bundle)
        for field in ("outcome", "errorKind", "httpStatus", "observedAt", "errorMessage"):
            self.assertIn('item.' + field, bundle)
        self.assertIn('connectionTime(item.observedAt)', bundle)
        self.assertNotIn('tab === "providers"', bundle)

    def test_supplier_ui_is_compact_and_exposes_onboarding_flow(self) -> None:
        source = (DASHBOARD / "dist" / "index.js").read_text()
        css = (DASHBOARD / "dist" / "style.css").read_text()
        self.assertIn('"suppliers.add": "添加供应商"', source)
        self.assertIn('"suppliers.details": "查看详情"', source)
        self.assertIn('"suppliers.manage": "管理"', source)
        self.assertIn('api("/suppliers/" + encodeURIComponent(String(manageSupplier.id)) + "/profile"', source)
        self.assertIn('api("/suppliers/" + encodeURIComponent(String(manageSupplier.id)) + "/retire"', source)
        self.assertIn('api("/providers/hub/" + encodeURIComponent(id) + "/profile"', source)
        self.assertIn('api("/providers/hub/" + encodeURIComponent(id) + "/retire"', source)
        self.assertIn('className: "hao-provider-manage"', source)
        self.assertIn('className: "hao-supplier-row-actions"', source)
        self.assertIn('api("/providers/presets")', source)
        self.assertIn('api("/providers/discover"', source)
        self.assertIn('api("/providers/register"', source)
        self.assertIn('selected_models: selectedModels', source)
        self.assertIn('default_model: defaultModel || selectedModels[0]', source)
        self.assertIn('className: "hao-supplier-list"', source)
        self.assertIn('className: "hao-supplier-row hao-supplier-row-head"', source)
        self.assertIn('props.t("suppliers.internal")', source)
        self.assertNotIn("const suppliers = asArray(supply.suppliers).filter", source)
        self.assertIn('className: "hao-workforce-row"', source)
        self.assertIn('props.t("workforce.contributionTokens")', source)
        self.assertIn('contributionTokens(right) - contributionTokens(left)', source)
        self.assertIn('supplySummary.workforceSources || supplySummary.suppliers', source)
        self.assertIn('api("/employees/" + encodeURIComponent(String(employee.id)) + "/dossier")', source)
        self.assertIn('className: "hao-modal ', source)
        self.assertIn('className: "hao-preset-grid"', source)
        self.assertNotIn('const personalChannels = asArray(personalChannelProjection.channels)', source)
        self.assertIn("const suppliers = asArray(supply.suppliers);", source)
        self.assertIn('"workforce.filterInternal": "内部员工"', source)
        self.assertNotIn('personalGateways.length', source)
        self.assertNotIn('props.t("suppliers.cpaDeepseek")', source)
        self.assertNotIn('props.t("suppliers.unclassified")', source)
        self.assertIn('.hao-supplier-row {', css)
        self.assertIn('.hao-button-danger {', css)
        self.assertIn('.hao-provider-manage-grid {', css)
        self.assertRegex(css, r"\.hao-supplier-row-actions\s*\{[^}]*flex-wrap:\s*nowrap")
        self.assertRegex(css, r"\.hao-supplier-row-actions\s+\.hao-button\s*\{[^}]*white-space:\s*nowrap")
        self.assertIn('190px max-content;', css)
        self.assertIn('.hao-modal-backdrop {', css)
        self.assertIn('.hao-model-picker {', css)

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
