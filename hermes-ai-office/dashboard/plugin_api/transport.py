from __future__ import annotations

import json
import urllib.request
from typing import Any, Dict, Mapping

from .config import BASE_URL


def fetch_json(path: str, *, timeout: float = 12.0) -> Dict[str, Any]:
    if not path.startswith("/api/v3/") and path != "/api/health":
        raise ValueError("dashboard may access only V3 control-plane APIs")
    request = urllib.request.Request(BASE_URL + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        value = json.load(response)
    if not isinstance(value, dict):
        raise RuntimeError("control plane returned a non-object payload")
    return value


def post_json(path: str, payload: Mapping[str, Any], *, timeout: float = 12.0) -> Dict[str, Any]:
    if not path.startswith("/api/v3/"):
        raise ValueError("dashboard actions may access only V3 control-plane APIs")
    request = urllib.request.Request(
        BASE_URL + path,
        data=json.dumps(dict(payload)).encode("utf-8"),
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        value = json.load(response)
    if not isinstance(value, dict):
        raise RuntimeError("control plane returned a non-object payload")
    return value
