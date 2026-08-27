from __future__ import annotations

import json
import os
from pathlib import Path

BASE_URL = os.environ.get(
    "HERMES_AI_OFFICE_CONTROL_PLANE_URL", "http://127.0.0.1:8320"
).rstrip("/")
CONTRACT_PATH = Path(__file__).resolve().parents[2] / "contracts" / "dashboard.schema.json"
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
DASHBOARD_SCHEMA_VERSION = int(CONTRACT["properties"]["schemaVersion"]["const"])
HISTORY_PAGE_SIZE = 500
