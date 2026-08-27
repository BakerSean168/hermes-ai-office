from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import threading
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
        self.assertEqual(paths, {"/health", "/dashboard", "/model-registry", "/plans/{plan_id}"})
        source = API_PATH.read_text(encoding="utf-8")
        for forbidden in ("/api/v2/", "workforce", "employee", "provider-connections", "runtime-policy"):
            self.assertNotIn(forbidden, source.lower())

    def test_execution_skips_incomplete_legacy_route_metadata_without_breaking_dashboard(self) -> None:
        row = api._execution(
            {
                "executionId": "exec-legacy-route",
                "projectKey": "project-a",
                "objectiveSummary": "Review legacy execution",
                "phase": "VERIFY_REVIEW",
                "status": "SUCCEEDED",
                "selection": {
                    "modelClass": "gpt-5.6-sol",
                    "backend": "codex-review-headless",
                    "workspaceMode": "review_snapshot",
                },
                "timing": {"durationMs": 1000},
                "usage": {},
                "refs": {
                    "upstream": {
                        "route": {"model": "gpt-5.6-sol", "calls": 1, "costUsd": 0},
                        "routeUsage": [{"model": "gpt-5.6-sol", "calls": 1, "costUsd": 0}],
                    }
                },
            },
            {},
        )
        self.assertIsNone(row["route"])
        self.assertEqual(row["routeUsage"], [])
        self.assertEqual(row["logicalModel"], "gpt-5.6-sol")

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

    def test_fetch_all_executions_pages_without_hydrating_execution_hosts(self) -> None:
        original_page_size = api._HISTORY_PAGE_SIZE
        api._HISTORY_PAGE_SIZE = 2
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
                limited = api._fetch_all_executions(2)
                self.assertEqual([item["executionId"] for item in limited], ["e3", "e2"])
                self.assertTrue(all("hydrate=0" in path for path in paths))

                paths.clear()
                items = api._fetch_all_executions(0)
                self.assertEqual([item["executionId"] for item in items], ["e3", "e2", "e1"])
                self.assertTrue(all("hydrate=0" in path for path in paths))
                self.assertFalse(any("hydrate=1" in path for path in paths))
        finally:
            api._HISTORY_PAGE_SIZE = original_page_size

    def test_dashboard_cold_refresh_reads_independent_sources_concurrently(self) -> None:
        barrier = threading.Barrier(5, timeout=2)
        paths: list[str] = []
        lock = threading.Lock()

        def fetch(path: str, **_kwargs: object):
            with lock:
                paths.append(path)
            barrier.wait()
            if path.endswith("runtime-summary"):
                return {"sourceHealth": {"openhands": "OK", "litellm": "OK"}}
            if path.endswith("readiness"):
                return {"ready": True, "gates": {"representativeWorkflows": {"current": 1, "required": 1}}}
            if path.endswith("model-registry"):
                return {"deployments": {"items": []}}
            if "/plans?" in path:
                return {"items": []}
            if "/executions?" in path:
                return {"items": []}
            raise AssertionError(path)

        old_cache = api._CACHE
        api._CACHE = None
        try:
            with mock.patch.object(api, "_fetch_json", side_effect=fetch):
                value = api._build_dashboard(1)
            self.assertEqual(value["schemaVersion"], CONTRACT["properties"]["schemaVersion"]["const"])
            self.assertEqual(len(paths), 5)
            self.assertEqual(barrier.n_waiting, 0)
        finally:
            api._CACHE = old_cache

    def test_dashboard_requests_compact_plan_summary_projection(self) -> None:
        paths: list[str] = []

        def fetch(path: str, **_kwargs: object):
            paths.append(path)
            if path.endswith("runtime-summary"):
                return {"sourceHealth": {"openhands": "OK", "litellm": "OK"}}
            if path.endswith("readiness"):
                return {"ready": True, "gates": {"representativeWorkflows": {"current": 1, "required": 1}}}
            if path.endswith("model-registry"):
                return {"deployments": {"items": []}}
            if "/plans?" in path:
                return {"items": []}
            if "/executions?" in path:
                return {"items": []}
            raise AssertionError(path)

        old_cache = api._CACHE
        api._CACHE = None
        try:
            with mock.patch.object(api, "_fetch_json", side_effect=fetch):
                api._build_dashboard(1)
            self.assertIn("/api/v3/development/plans?limit=100&view=summary", paths)
        finally:
            api._CACHE = old_cache

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

    def test_plan_progress_is_projected_separately_from_platform_readiness(self) -> None:
        plans, summary = api._plans(
            [
                {
                    "planId": "plan-1",
                    "projectKey": "pixel-agents",
                    "objective": "Complete the workflow",
                    "status": "RUNNING",
                    "currentRevision": "abc123",
                    "batches": [
                        {
                            "key": "batch-1",
                            "title": "Core",
                            "status": "RUNNING",
                            "workItems": [
                                {"status": "SUCCEEDED"},
                                {"status": "RUNNING"},
                            ],
                        }
                    ],
                }
            ]
        )
        self.assertEqual(summary, {"total": 1, "active": 1, "blocked": 0, "succeeded": 0})
        self.assertEqual(plans[0]["workItems"], {"total": 2, "succeeded": 1})
        self.assertEqual(plans[0]["currentBatch"]["key"], "batch-1")
        self.assertNotIn("readiness", plans[0])

    def test_plan_projection_exposes_system_work_without_polluting_business_progress(self) -> None:
        plans, _summary = api._plans(
            [
                {
                    "planId": "plan-aggregate",
                    "projectKey": "memoflow",
                    "objective": "Integrate parallel changes",
                    "status": "RUNNING",
                    "currentRevision": "base-1",
                    "batches": [
                        {
                            "batchId": "batch-1",
                            "key": "batch-1",
                            "title": "Parallel domain work",
                            "status": "RUNNING",
                            "integratedRevision": "candidate-2",
                            "workItems": [
                                {"workItemId": "work-a", "key": "TASK-1", "title": "Task", "status": "SUCCEEDED", "executions": []},
                                {"workItemId": "work-b", "key": "GOAL-1", "title": "Goal", "status": "SUCCEEDED", "executions": []},
                                {
                                    "workItemId": "work-verify",
                                    "key": "batch-verify-b1-2",
                                    "title": "Verify integrated batch",
                                    "status": "RUNNING",
                                    "executions": [
                                        {
                                            "executionId": "exec-verify",
                                            "phase": "BATCH_VERIFY",
                                            "status": "RUNNING",
                                            "selection": {"backend": "codex-review-headless", "modelClass": "gpt-5.6-sol"},
                                            "timing": {"startedAt": "2026-08-27T01:00:00Z"},
                                        }
                                    ],
                                },
                            ],
                        }
                    ],
                    "events": [
                        {
                            "type": "BATCH_AGGREGATE_REVIEW_CREATED",
                            "batchId": "batch-1",
                            "workItemId": "work-verify",
                            "detail": {"attempt": 2, "candidateRevision": "candidate-2"},
                        }
                    ],
                }
            ]
        )
        plan = plans[0]
        self.assertEqual(plan["workItems"], {"total": 2, "succeeded": 2})
        self.assertEqual(plan["systemWorkItems"], {"total": 1, "succeeded": 0})
        self.assertEqual(plan["batches"], {"total": 1, "succeeded": 0})
        self.assertEqual(plan["currentActivity"]["kind"], "BATCH_VERIFY")
        self.assertEqual(plan["currentActivity"]["attempt"], 2)
        self.assertEqual(plan["currentActivity"]["backend"], "codex-review-headless")
        self.assertEqual(plan["currentActivity"]["model"], "gpt-5.6-sol")
        self.assertEqual(plan["currentActivity"]["revision"], "candidate-2")
        self.assertEqual(set(plan), set(CONTRACT["$defs"]["Plan"]["properties"]))
        self.assertEqual(set(plan["currentActivity"]), set(CONTRACT["$defs"]["PlanActivity"]["properties"]))

    def test_plan_projection_identifies_post_merge_repair_and_failed_merge_revision(self) -> None:
        plans, _summary = api._plans(
            [
                {
                    "planId": "plan-post-merge",
                    "projectKey": "pixel-agents",
                    "objective": "Ship safely",
                    "status": "RUNNING",
                    "currentRevision": "repair-base",
                    "deliveryStage": "PENDING",
                    "mergeRevision": "merge-bad-123",
                    "batches": [
                        {"batchId": "batch-main", "key": "batch-main", "title": "Main", "status": "SUCCEEDED", "workItems": [{"workItemId": "work-main", "key": "MAIN-1", "title": "Main", "status": "SUCCEEDED", "executions": []}]},
                        {
                            "batchId": "batch-fix",
                            "key": "delivery-fix-1",
                            "title": "Repair post-merge checks",
                            "status": "RUNNING",
                            "workItems": [
                                {
                                    "workItemId": "work-fix",
                                    "key": "post-merge-fix-1",
                                    "title": "Repair failed post-merge checks",
                                    "status": "RUNNING",
                                    "executions": [
                                        {
                                            "executionId": "exec-fix",
                                            "phase": "IMPLEMENT",
                                            "status": "RUNNING",
                                            "selection": {"backend": "openhands-builtin", "modelClass": "gpt-5.6-sol"},
                                            "timing": {"startedAt": "2026-08-27T02:00:00Z"},
                                        }
                                    ],
                                }
                            ],
                        },
                    ],
                    "events": [
                        {
                            "type": "PLAN_DELIVERY_REPAIR_SCHEDULED",
                            "batchId": "batch-fix",
                            "detail": {"reason": "DELIVERY_POST_MERGE_CHECKS_FAILED", "stage": "POST_MERGE_CHECKS"},
                        },
                        {
                            "type": "EXECUTION_STARTED",
                            "batchId": "batch-fix",
                            "workItemId": "work-fix",
                            "executionId": "exec-fix",
                            "detail": {"phase": "IMPLEMENT", "attempt": 1},
                        },
                    ],
                }
            ]
        )
        plan = plans[0]
        self.assertEqual(plan["batches"], {"total": 1, "succeeded": 1})
        self.assertEqual(plan["systemWorkItems"], {"total": 1, "succeeded": 0})
        self.assertEqual(plan["currentActivity"]["kind"], "POST_MERGE_REPAIR")
        self.assertEqual(plan["currentActivity"]["attempt"], 1)
        self.assertEqual(plan["currentActivity"]["reason"], "DELIVERY_POST_MERGE_CHECKS_FAILED")
        self.assertEqual(plan["currentActivity"]["revision"], "merge-bad-123")

    def test_blocked_plan_projects_blocked_batch_even_without_synthetic_repair_item(self) -> None:
        plans, _summary = api._plans(
            [
                {
                    "planId": "plan-blocked",
                    "projectKey": "memoflow",
                    "objective": "Integrate batch",
                    "status": "BLOCKED",
                    "currentRevision": "base",
                    "blockedReason": "BATCH_INTEGRATION_FAILED",
                    "batches": [
                        {
                            "batchId": "batch-3",
                            "key": "batch-3",
                            "title": "Shared composition",
                            "status": "BLOCKED",
                            "blockedReason": "BATCH_INTEGRATION_FAILED",
                            "workItems": [
                                {"workItemId": "work-1", "key": "TASK-1", "title": "Task", "status": "SUCCEEDED", "executions": []}
                            ],
                        }
                    ],
                    "events": [],
                }
            ]
        )
        plan = plans[0]
        self.assertEqual(plan["currentBatch"]["key"], "batch-3")
        self.assertEqual(plan["currentActivity"]["kind"], "BLOCKED")
        self.assertEqual(plan["currentActivity"]["reason"], "BATCH_INTEGRATION_FAILED")

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

    def test_plan_detail_projects_execution_timeline_with_model_usage_and_failure_reason(self) -> None:
        raw = {
            "planId": "plan-detail",
            "projectKey": "memoflow",
            "objective": "Ship durable reminders",
            "status": "RUNNING",
            "currentRevision": "rev-current",
            "blockedReason": None,
            "deliveryStage": None,
            "pullRequestUrl": None,
            "mergeRevision": None,
            "createdAt": 1,
            "updatedAt": 2,
            "batches": [
                {
                    "batchId": "batch-1-id",
                    "key": "batch-1",
                    "title": "Reminder handlers",
                    "status": "RUNNING",
                    "baseRevision": "base",
                    "integratedRevision": "candidate",
                    "blockedReason": None,
                    "workItems": [
                        {
                            "workItemId": "work-1-id",
                            "key": "TASK-1",
                            "title": "Implement task reminder",
                            "objective": "Implement it.",
                            "acceptanceCriteria": ["Focused test passes."],
                            "status": "SUCCEEDED",
                            "blockedReason": None,
                            "executions": [
                                {
                                    "executionId": "exec-1",
                                    "projectKey": "memoflow",
                                    "objectiveSummary": "Implement it.",
                                    "phase": "IMPLEMENT",
                                    "status": "FAILED",
                                    "selection": {
                                        "backend": "opencode-acp",
                                        "modelClass": "implementation-efficient",
                                        "workspaceMode": "isolated_write",
                                    },
                                    "timing": {
                                        "startedAt": "2026-08-27T01:00:00Z",
                                        "endedAt": "2026-08-27T01:02:00Z",
                                        "durationMs": 120000,
                                    },
                                    "usage": {"input": 100, "output": 20, "calls": 2, "costUsd": 0.03},
                                    "error": {"code": "WRITER_COMPLETION_NO_COMMIT", "detail": "No commit", "retryable": False},
                                },
                                {
                                    "executionId": "exec-2",
                                    "projectKey": "memoflow",
                                    "objectiveSummary": "Review it.",
                                    "status": "SUCCEEDED",
                                    "selection": {
                                        "backend": "openhands-builtin",
                                        "modelClass": "gpt-5.6-sol",
                                        "workspaceMode": "isolated_write",
                                        "reasons": ["phase:IMPLEMENT_FIX", "model:premium-repair"],
                                    },
                                    "phase": "IMPLEMENT_FIX",
                                    "timing": {"startedAt": "2026-08-27T01:03:00Z", "endedAt": "2026-08-27T01:03:45Z", "durationMs": 45000},
                                    "usage": {"input": 40, "output": 10, "calls": 1, "costUsd": 0.02},
                                },
                                {
                                    "executionId": "exec-3",
                                    "projectKey": "memoflow",
                                    "objectiveSummary": "Review repair.",
                                    "phase": "VERIFY_REVIEW",
                                    "status": "SUCCEEDED",
                                    "selection": {
                                        "backend": "codex-review-headless",
                                        "modelClass": "gpt-5.6-sol",
                                        "workspaceMode": "review_snapshot",
                                        "reasons": ["phase:VERIFY_REVIEW", "backend:phase-policy"],
                                    },
                                    "timing": {"startedAt": "2026-08-27T01:04:00Z", "endedAt": "2026-08-27T01:05:00Z", "durationMs": 60000},
                                    "usage": {"input": 50, "output": 5, "calls": 1, "costUsd": 0.01},
                                    "result": {"finalText": "PASS\nVerified."},
                                },
                            ],
                        },
                        {
                            "workItemId": "work-v-id",
                            "key": "batch-verify-b1-1",
                            "title": "Aggregate review",
                            "objective": "Review combined batch.",
                            "acceptanceCriteria": [],
                            "status": "RUNNING",
                            "blockedReason": None,
                            "executions": [
                                {
                                    "executionId": "exec-v",
                                    "projectKey": "memoflow",
                                    "objectiveSummary": "Review combined batch.",
                                    "phase": "BATCH_VERIFY",
                                    "status": "RUNNING",
                                    "selection": {
                                        "backend": "codex-review-headless",
                                        "modelClass": "gpt-5.6-sol",
                                        "workspaceMode": "review_snapshot",
                                        "reasons": ["phase:BATCH_VERIFY", "model:aggregate-review-premium"],
                                    },
                                    "timing": {"startedAt": "2026-08-27T01:05:00Z"},
                                    "usage": {},
                                }
                            ],
                        },
                    ],
                }
            ],
            "events": [
                {"type": "EXECUTION_STARTED", "batchId": "batch-1-id", "workItemId": "work-1-id", "executionId": "exec-1", "detail": {"phase": "IMPLEMENT", "attempt": 2}, "createdAt": "2026-08-27T01:00:00Z"},
                {"type": "BATCH_INTEGRATED", "batchId": "batch-1-id", "workItemId": None, "executionId": None, "detail": {"revision": "candidate"}, "createdAt": "2026-08-27T01:04:30Z"},
            ],
        }
        detail = api._plan_detail(raw)
        self.assertEqual(set(detail), set(CONTRACT["$defs"]["PlanDetailResponse"]["properties"]))
        self.assertEqual(detail["schemaVersion"], CONTRACT["properties"]["schemaVersion"]["const"])
        self.assertEqual(detail["plan"]["planId"], "plan-detail")
        self.assertEqual(len(detail["batches"]), 1)
        batch = detail["batches"][0]
        self.assertEqual(set(batch), set(CONTRACT["$defs"]["PlanTimelineBatch"]["properties"]))
        self.assertFalse(batch["system"])
        self.assertEqual(len(batch["workItems"]), 2)
        failed = batch["workItems"][0]["executions"][0]
        self.assertEqual(set(failed), set(CONTRACT["$defs"]["PlanTimelineExecution"]["properties"]))
        self.assertEqual(failed["attempt"], 2)
        self.assertEqual(failed["backend"], "opencode-acp")
        self.assertEqual(failed["model"], "implementation-efficient")
        self.assertEqual(failed["durationMs"], 120000)
        self.assertEqual(failed["totalTokens"], 120)
        self.assertAlmostEqual(failed["costUsd"], 0.03)
        self.assertEqual(failed["errorCode"], "WRITER_COMPLETION_NO_COMMIT")
        self.assertEqual(failed["errorDetail"], "No commit")
        repaired = batch["workItems"][0]["executions"][1]
        self.assertEqual(repaired["phase"], "IMPLEMENT_FIX")
        self.assertTrue(repaired["strongModel"])
        self.assertEqual(repaired["decisionReason"], "FAILED_VERIFICATION_REPAIR")
        self.assertEqual(repaired["policyReasons"], ["phase:IMPLEMENT_FIX", "model:premium-repair"])
        approved = batch["workItems"][0]["executions"][2]
        self.assertEqual(approved["verdict"], "PASS")
        self.assertEqual(approved["decisionReason"], "INDEPENDENT_REVIEW")
        aggregate = batch["workItems"][1]
        self.assertTrue(aggregate["system"])
        self.assertEqual(aggregate["executions"][0]["phase"], "BATCH_VERIFY")
        self.assertEqual(batch["events"][0]["type"], "BATCH_INTEGRATED")
        audit = detail["audit"]
        self.assertEqual(set(audit), set(CONTRACT["$defs"]["PlanAudit"]["properties"]))
        self.assertEqual(audit["summary"]["failures"], 1)
        self.assertEqual(audit["summary"]["repairs"], 1)
        self.assertEqual(audit["summary"]["strongModelExecutions"], 3)
        self.assertEqual(audit["summary"]["totalTokens"], 225)
        self.assertAlmostEqual(audit["summary"]["costUsd"], 0.06)
        self.assertEqual(audit["batches"][0]["key"], "batch-1")
        self.assertEqual(audit["batches"][0]["failures"], 1)
        self.assertEqual(audit["attention"][0]["sourceExecutionId"], "exec-1")
        self.assertEqual(audit["attention"][0]["repairExecutionId"], "exec-2")
        self.assertTrue(audit["attention"][0]["resolved"])
        reasons = {item["executionId"]: item["reason"] for item in audit["strongModelDecisions"]}
        self.assertEqual(reasons["exec-2"], "FAILED_VERIFICATION_REPAIR")
        self.assertEqual(reasons["exec-v"], "BATCH_AGGREGATE_REVIEW")

    def test_plan_audit_links_failed_implement_to_successful_retry(self) -> None:
        audit = api._plan_audit([
            {
                "key": "batch-retry",
                "status": "SUCCEEDED",
                "events": [],
                "workItems": [
                    {
                        "key": "TASK-RETRY",
                        "executions": [
                            {"executionId": "failed", "phase": "IMPLEMENT", "status": "FAILED", "verdict": None, "strongModel": False, "durationMs": 10, "totalTokens": 5, "costUsd": 0},
                            {"executionId": "retry", "phase": "IMPLEMENT", "status": "SUCCEEDED", "verdict": None, "strongModel": False, "durationMs": 20, "totalTokens": 7, "costUsd": 0},
                        ],
                    }
                ],
            }
        ])
        self.assertEqual(audit["summary"]["repairs"], 1)
        self.assertEqual(audit["attention"][0]["repairExecutionId"], "retry")
        self.assertTrue(audit["attention"][0]["resolved"])

    def test_plan_detail_endpoint_is_read_only_and_fetches_one_plan_on_demand(self) -> None:
        paths = {route.path for route in api.router.routes}
        self.assertIn("/plans/{plan_id}", paths)
        raw = {
            "planId": "plan-1", "projectKey": "example", "objective": "Ship", "status": "SUCCEEDED",
            "currentRevision": "abc", "blockedReason": None, "deliveryStage": "SUCCEEDED",
            "pullRequestUrl": "https://github.test/pull/1", "mergeRevision": "merged",
            "createdAt": 1, "updatedAt": 2, "batches": [], "events": []
        }
        with mock.patch.object(api, "_fetch_json", return_value=raw) as fetch:
            detail = asyncio.run(api.plan_detail("plan-1"))
        self.assertEqual(detail["plan"]["planId"], "plan-1")
        fetch.assert_called_once_with("/api/v3/development/plans/plan-1")

    def test_frontend_plan_cards_open_on_demand_timeline_detail(self) -> None:
        source = (ROOT / "dashboard" / "dist" / "index.js").read_text(encoding="utf-8")
        styles = (ROOT / "dashboard" / "dist" / "style.css").read_text(encoding="utf-8")
        self.assertIn('api("/plans/" + encodeURIComponent(plan.planId))', source)
        self.assertIn("function PlanDetail", source)
        self.assertIn("function TimelineExecution", source)
        self.assertIn('className: "hao-plan-detail"', source)
        self.assertIn('className: "hao-timeline"', source)
        self.assertIn(".hao-plan-detail", styles)
        self.assertIn(".hao-timeline-step", styles)
        self.assertIn("function AuditOverview", source)
        self.assertIn("function AuditAttention", source)
        self.assertIn("strongModelDecisions", source)
        self.assertIn("decisionReasonLabel", source)
        self.assertIn(".hao-audit-metrics", styles)
        self.assertIn(".hao-audit-attention", styles)

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
        self.assertEqual(manifest["version"], "1.4.0")
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
