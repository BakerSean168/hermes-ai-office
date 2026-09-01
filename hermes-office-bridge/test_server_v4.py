import io
import json
import unittest
from unittest import mock

import server


class V4ProjectionTest(unittest.TestCase):
    def test_projects_v4_plan_graph_and_active_execution(self):
        payload = {
            "items": [
                {
                    "plan": {
                        "planId": "plan-1",
                        "projectKey": "memoflow",
                        "objective": "Cross-platform migration",
                        "repositoryPath": "/repo",
                        "status": "RUNNING",
                        "createdAt": "2026-09-01T00:00:00.000Z",
                        "updatedAt": "2026-09-01T00:01:00.000Z",
                    },
                    "graph": {
                        "graphVersionId": "graph-1",
                        "createdAt": "2026-09-01T00:00:00.000Z",
                    },
                    "workItems": [
                        {
                            "workItemId": "work-1",
                            "itemKey": "ports",
                            "title": "Move platform ports",
                            "status": "RUNNING",
                            "createdAt": "2026-09-01T00:00:00.000Z",
                            "updatedAt": "2026-09-01T00:01:00.000Z",
                        }
                    ],
                    "executions": [
                        {
                            "identity": {
                                "executionId": "execution-1",
                                "planId": "plan-1",
                                "workItemId": "work-1",
                            },
                            "status": "RUNNING",
                            "createdAt": "2026-09-01T00:00:30.000Z",
                        }
                    ],
                }
            ]
        }
        response = io.BytesIO(json.dumps(payload).encode("utf-8"))
        with mock.patch("urllib.request.urlopen", return_value=response) as request:
            result = server._merge_ai_office_plans(
                {"tasks": [], "links": [], "runs": [], "events": []}
            )

        self.assertIn("/api/v4/plans?limit=100", request.call_args.args[0].full_url)
        self.assertEqual([task["id"] for task in result["tasks"]], [
            "ai-office:plan-1",
            "ai-office:graph-1",
            "ai-office:work-1",
        ])
        self.assertEqual(result["runs"][0]["id"], "execution-1")
        self.assertEqual(result["runs"][0]["task_id"], "ai-office:work-1")
        self.assertEqual(result["plans"][0]["planId"], "plan-1")


if __name__ == "__main__":
    unittest.main()
