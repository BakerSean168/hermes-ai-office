from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest import mock

try:
    import fastapi  # noqa: F401
except ModuleNotFoundError:
    fastapi_stub = types.ModuleType("fastapi")

    class HTTPException(Exception):
        def __init__(self, status_code: int, detail: str):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

    class APIRouter:
        def __init__(self):
            self.routes = []

        def get(self, path: str):
            def decorator(fn):
                self.routes.append(types.SimpleNamespace(path=path, endpoint=fn))
                return fn
            return decorator

    fastapi_stub.APIRouter = APIRouter
    fastapi_stub.HTTPException = HTTPException
    sys.modules["fastapi"] = fastapi_stub

ROOT = Path(__file__).resolve().parent
API_PATH = ROOT / "dashboard" / "plugin_api.py"
CONTRACT_PATH = ROOT / "contracts" / "dashboard.schema.json"
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
spec = importlib.util.spec_from_file_location("hermes_ai_office_dashboard", API_PATH)
assert spec and spec.loader
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class DashboardTest(unittest.TestCase):
    def test_dashboard_exposes_only_read_only_v3_routes(self) -> None:
        paths = {route.path for route in api.router.routes}
        self.assertEqual(paths, {"/health", "/dashboard", "/model-registry"})
        source = API_PATH.read_text(encoding="utf-8")
        for forbidden in ("/api/v2/", "workforce", "employee", "provider-connections", "runtime-policy"):
            self.assertNotIn(forbidden, source.lower())

    def test_execution_enriches_physical_routes_from_litellm_registry(self) -> None:
        catalog = {
            "dep-paid": {
                "providerKey": "teamorouter",
                "model": "openai/deepseek-v4-flash",
                "group": "deepseek-v4-flash",
                "commercialType": "METERED",
                "supplyOrigin": "COMMERCIAL_RELAY",
            }
        }
        row = api._execution(
            {
                "executionId": "exec-1",
                "projectKey": "project-a",
                "objectiveSummary": "Implement feature",
                "phase": "IMPLEMENT",
                "status": "SUCCEEDED",
                "selection": {
                    "modelClass": "implementation-efficient",
                    "backend": "opencode-acp",
                    "workspaceMode": "fresh_implementation_workspace",
                },
                "timing": {"startedAt": "2026-08-22T10:00:00Z", "endedAt": "2026-08-22T10:01:00Z", "durationMs": 60000},
                "usage": {"input": 100, "output": 20, "costUsd": 0.01, "calls": 2},
                "refs": {
                    "upstream": {
                        "routeUsage": [
                            {
                                "deploymentId": "dep-paid",
                                "provider": "openai",
                                "providerKey": "teamorouter",
                                "model": "openai/deepseek-v4-flash",
                                "input": 100,
                                "output": 20,
                                "costUsd": 0.01,
                                "calls": 2,
                            }
                        ]
                    }
                },
            },
            catalog,
        )
        self.assertEqual(row["totalTokens"], 120)
        self.assertEqual(row["route"]["providerKey"], "teamorouter")
        self.assertEqual(row["routeUsage"][0]["commercialType"], "METERED")
        self.assertEqual(row["durationMs"], 60000)

    def test_analytics_uses_route_level_cost_for_provider_totals(self) -> None:
        executions = [
            {
                "executionId": "e1",
                "projectKey": "project-a",
                "phase": "IMPLEMENT",
                "status": "SUCCEEDED",
                "logicalModel": "implementation-efficient",
                "durationMs": 1000,
                "usage": {"input": 300, "output": 30, "costUsd": 0.3, "calls": 3},
                "routeUsage": [
                    {"providerKey": "free", "physicalModel": "model-a", "input": 100, "output": 10, "costUsd": 0.0, "calls": 1},
                    {"providerKey": "paid", "physicalModel": "model-a", "input": 200, "output": 20, "costUsd": 0.3, "calls": 2},
                ],
            }
        ]
        result = api._analytics(executions)
        providers = {row["key"]: row for row in result["providers"]}
        self.assertEqual(providers["free"]["totalTokens"], 110)
        self.assertEqual(providers["paid"]["totalTokens"], 220)
        self.assertEqual(providers["paid"]["costUsd"], 0.3)
        self.assertIsNone(providers["free"]["successRate"])
        self.assertIsNone(providers["paid"]["successRate"])
        self.assertEqual(result["logicalModels"][0]["totalTokens"], 330)

    def test_fetch_all_executions_pages_until_history_is_exhausted(self) -> None:
        original_page_size = api._HISTORY_PAGE_SIZE
        original_hydrated = api._HISTORY_HYDRATED
        api._HISTORY_PAGE_SIZE = 2
        api._HISTORY_HYDRATED = False
        paths: list[str] = []

        def fetch(path: str, **_kwargs: object):
            paths.append(path)
            if "offset=0" in path:
                return {"items": [{"executionId": "e3"}, {"executionId": "e2"}]}
            if "offset=2" in path:
                return {"items": [{"executionId": "e1"}]}
            return {"items": []}

        try:
            with mock.patch.object(api, "_fetch_json", side_effect=fetch):
                limited_first = api._fetch_all_executions(2)
                self.assertEqual([item["executionId"] for item in limited_first], ["e3", "e2"])
                self.assertTrue(all("hydrate=1" in path for path in paths))
                self.assertFalse(api._HISTORY_HYDRATED)

                paths.clear()
                items = api._fetch_all_executions(0)
                self.assertEqual([item["executionId"] for item in items], ["e3", "e2", "e1"])
                self.assertTrue(all("hydrate=1" in path for path in paths))
                self.assertTrue(api._HISTORY_HYDRATED)

                paths.clear()
                limited_after_full_hydration = api._fetch_all_executions(2)
                self.assertEqual(
                    [item["executionId"] for item in limited_after_full_hydration], ["e3", "e2"]
                )
                self.assertTrue(all("hydrate=0" in path for path in paths))
        finally:
            api._HISTORY_PAGE_SIZE = original_page_size
            api._HISTORY_HYDRATED = original_hydrated

    def test_summary_counts_execution_usage_once(self) -> None:
        result = api._summary(
            [
                {"terminal": False, "status": "RUNNING", "usage": {"input": 10, "output": 5, "calls": 1, "costUsd": 0.01}},
                {"terminal": True, "status": "SUCCEEDED", "durationMs": 5000, "usage": {"input": 20, "output": 10, "calls": 2, "costUsd": 0.02}},
            ]
        )
        self.assertEqual(result["totalExecutions"], 2)
        self.assertEqual(result["activeExecutions"], 1)
        self.assertEqual(result["totalTokens"], 45)
        self.assertEqual(result["calls"], 3)
        self.assertAlmostEqual(result["costUsd"], 0.03)

    def test_contract_is_the_single_dashboard_shape_source(self) -> None:
        version = CONTRACT["properties"]["schemaVersion"]["const"]
        self.assertEqual(api._DASHBOARD_SCHEMA_VERSION, version)
        source = (ROOT / "dashboard" / "dist" / "index.js").read_text(encoding="utf-8")
        self.assertIn(f"const DASHBOARD_SCHEMA_VERSION = {version};", source)
        self.assertIn(".then(assertDashboardContract)", source)

        catalog = {
            "dep-paid": {
                "providerKey": "teamorouter",
                "group": "deepseek-v4-flash",
                "commercialType": "METERED",
                "supplyOrigin": "COMMERCIAL_RELAY",
            }
        }
        execution = api._execution(
            {
                "executionId": "exec-contract",
                "projectKey": "project-contract",
                "objectiveSummary": "Verify dashboard contract",
                "phase": "IMPLEMENT",
                "status": "SUCCEEDED",
                "selection": {
                    "modelClass": "implementation-efficient",
                    "backend": "opencode-acp",
                    "workspaceMode": "fresh_implementation_workspace",
                },
                "timing": {
                    "startedAt": "2026-08-23T01:00:00Z",
                    "endedAt": "2026-08-23T01:00:01Z",
                    "durationMs": 1000,
                },
                "usage": {"input": 10, "output": 2, "calls": 1, "costUsd": 0},
                "refs": {
                    "upstream": {
                        "route": {
                            "deploymentId": "dep-paid",
                            "provider": "openai",
                            "providerKey": "teamorouter",
                            "model": "openai/deepseek-v4-flash",
                        },
                        "routeUsage": [
                            {
                                "deploymentId": "dep-paid",
                                "provider": "openai",
                                "providerKey": "teamorouter",
                                "model": "openai/deepseek-v4-flash",
                                "input": 10,
                                "output": 2,
                                "calls": 1,
                                "costUsd": 0,
                            }
                        ],
                    }
                },
            },
            catalog,
        )
        self.assertEqual(set(execution), set(CONTRACT["$defs"]["Execution"]["properties"]))
        self.assertEqual(set(execution["usage"]), set(CONTRACT["$defs"]["Usage"]["properties"]))
        self.assertEqual(set(execution["route"]), set(CONTRACT["$defs"]["Route"]["properties"]))
        self.assertEqual(set(execution["routeUsage"][0]), set(CONTRACT["$defs"]["RouteUsage"]["properties"]))
        self.assertEqual(set(api._summary([execution])), set(CONTRACT["$defs"]["Summary"]["properties"]))
        analytics = api._analytics([execution])
        self.assertEqual(set(analytics), set(CONTRACT["$defs"]["Analytics"]["properties"]))
        for rows in analytics.values():
            for row in rows:
                self.assertEqual(set(row), set(CONTRACT["$defs"]["AnalyticsRow"]["properties"]))

    def test_control_plane_projection_is_strict_not_alias_based(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "projectKey"):
            api._execution(
                {
                    "executionId": "exec-bad",
                    "project_key": "legacy-alias-is-not-supported",
                    "objectiveSummary": "Bad payload",
                    "phase": "IMPLEMENT",
                    "status": "RUNNING",
                    "selection": {
                        "modelClass": "implementation-efficient",
                        "backend": "opencode-acp",
                        "workspaceMode": "fresh_implementation_workspace",
                    },
                },
                {},
            )

    def test_frontend_is_two_view_execution_console(self) -> None:
        source = (ROOT / "dashboard" / "dist" / "index.js").read_text(encoding="utf-8")
        self.assertIn('setView("overview")', source)
        self.assertIn('setView("analytics")', source)
        self.assertIn('className: "hao-toolbar"', source)
        self.assertNotIn("HERMES · EXECUTION CONTROL PLANE", source)
        self.assertNotIn('h("h1"', source)
        self.assertNotIn('h("td", h(', source)
        for legacy in ("organization", "workforce", "incidents", "runtime policy", "employee dossier"):
            self.assertNotIn(legacy, source.lower())
        manifest = json.loads((ROOT / "dashboard" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["version"], "1.1.0")
        self.assertIn("Execution console", manifest["description"])

    def test_frontend_uses_hermes_auth_and_tracks_host_light_dark_mode(self) -> None:
        source = (ROOT / "dashboard" / "dist" / "index.js").read_text(encoding="utf-8")
        styles = (ROOT / "dashboard" / "dist" / "style.css").read_text(encoding="utf-8")
        self.assertIn("const fetchJSON = SDK.fetchJSON", source)
        self.assertIn("return fetchJSON(API_ROOT + path)", source)
        self.assertNotIn('fetch(API_ROOT + path, { credentials: "same-origin" })', source)
        self.assertIn('root.getPropertyValue("--background-base")', source)
        self.assertIn('"data-theme-mode": themeMode', source)
        self.assertIn('.hao-shell[data-theme-mode="light"]', styles)
        self.assertIn("--hao-bg: #0f1115", styles)
        self.assertIn("--hao-bg: #f6f7f9", styles)

    def test_contract_changes_are_dashboard_backend_only(self) -> None:
        deploy = (ROOT / "scripts" / "deploy-oracle2-safe.sh").read_text(encoding="utf-8")
        self.assertIn('path.startswith("contracts/")', deploy)
        self.assertIn('p.startswith("contracts/")', deploy)
        self.assertIn('kind = "dashboard_backend"', deploy)


if __name__ == "__main__":
    unittest.main()
