from __future__ import annotations

import importlib.util
import json
import threading
import unittest
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "providerctl.py"
spec = importlib.util.spec_from_file_location("providerctl", MODULE_PATH)
providerctl = importlib.util.module_from_spec(spec)
assert spec and spec.loader
sys.modules[spec.name] = providerctl
spec.loader.exec_module(providerctl)


class CatalogHandler(BaseHTTPRequestHandler):
    requests = []

    def do_GET(self):
        type(self).requests.append((self.path, self.headers.get("Authorization")))
        if self.path == "/models":
            body = b"<html>landing page</html>"
            self.send_response(200)
            self.send_header("content-type", "text/html")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/v1/models":
            body = json.dumps(
                {
                    "data": [
                        {"id": "gpt-5.6-sol"},
                        {"id": "gpt-image-1"},
                        {"id": "gpt-4o-transcribe"},
                        {"id": "deepseek-v4-flash"},
                    ]
                }
            ).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *_args):
        pass


class ProviderCtlTests(unittest.TestCase):
    def setUp(self):
        CatalogHandler.requests = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), CatalogHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_probe_normalizes_root_to_v1_without_leaking_key(self):
        base = f"http://127.0.0.1:{self.server.server_port}"
        result = providerctl.probe_openai_models(base, "secret-value")
        self.assertEqual(result.base_url, base + "/v1")
        self.assertTrue(result.used_fallback)
        self.assertIn("gpt-5.6-sol", result.models)
        self.assertEqual(
            CatalogHandler.requests,
            [("/models", "Bearer secret-value"), ("/v1/models", "Bearer secret-value")],
        )

    def test_gpt_filter_excludes_non_chat_surfaces(self):
        selected = providerctl.select_models(
            ["gpt-5.6-sol", "gpt-image-1", "gpt-4o-transcribe", "gpt-realtime", "deepseek-v4"],
            "gpt",
            [],
        )
        self.assertEqual(selected, ["gpt-5.6-sol"])

    def test_deployment_contains_provider_and_economic_metadata(self):
        payload = providerctl.deployment_payload(
            provider_name="pqh",
            display_name="PQH",
            model="gpt-5.6-sol",
            commercial_type="METERED",
            supply_origin="COMMERCIAL_RELAY",
        )
        self.assertEqual(payload["model_name"], "gpt-5.6-sol")
        self.assertEqual(payload["litellm_params"]["model"], "openai/gpt-5.6-sol")
        self.assertEqual(payload["litellm_params"]["litellm_credential_name"], "pqh")
        self.assertEqual(payload["litellm_params"]["order"], 40)
        metadata = payload["model_info"]["metadata"]
        self.assertEqual(metadata["legacy_provider_key"], "pqh")
        self.assertEqual(metadata["commercial_type"], "METERED")
        self.assertEqual(metadata["supply_origin"], "COMMERCIAL_RELAY")

    def test_exact_model_requires_catalog_advertisement(self):
        with self.assertRaises(providerctl.ProviderCtlError):
            providerctl.select_models(["gpt-5.6-sol"], "gpt", ["gpt-does-not-exist"])


if __name__ == "__main__":
    unittest.main()
