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


if __name__ == "__main__":
    unittest.main()
