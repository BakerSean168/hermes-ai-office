from __future__ import annotations

import importlib.util
import json
import os
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
        runtime = partial["plugins"]["entries"]["hermes-ai-office"]["settings"]["runtime_policy"]
        self.value["plugins"]["entries"]["hermes-ai-office"]["settings"]["runtime_policy"] = runtime


class DashboardApiTest(unittest.IsolatedAsyncioTestCase):
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

    def test_active_tab_keeps_an_explicit_readable_label(self) -> None:
        css = (DASHBOARD / "dist" / "style.css").read_text()
        self.assertIn('.hao-tab[aria-selected="true"]', css)
        self.assertRegex(css, r'\.hao-tab\[aria-selected="true"\][^{]*\{[^}]*color:')

    def test_dashboard_owns_high_contrast_content_tokens(self) -> None:
        css = (DASHBOARD / "dist" / "style.css").read_text()
        self.assertIn("--hao-text: #f2f8fb", css)
        self.assertIn("--hao-text-secondary: #c9d8e1", css)
        self.assertNotIn("--hao-text: var(--text-primary", css)
        self.assertRegex(css, r"\.hao-hero h1\s*\{[^}]*color: var\(--hao-text\) !important")
        self.assertRegex(css, r"\.hao-data-table th[^}]*color: #dce8ef !important")
        self.assertRegex(css, r"\.hao-data-table th,\s*\.hao-data-table td[^}]*color: var\(--hao-text-secondary\) !important")
        self.assertIn("color: #ffffff !important", css)
        self.assertNotIn("--hao-text: var(--foreground", css)


if __name__ == "__main__":
    unittest.main()
