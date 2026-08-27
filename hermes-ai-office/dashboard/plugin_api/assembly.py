from __future__ import annotations

import concurrent.futures
import threading
import time
import urllib.parse
from typing import Any, Callable, Dict, Mapping

from . import config
from .executions import _analytics, _execution, _route_catalog, _summary
from .plans import _plans

FetchJson = Callable[..., Dict[str, Any]]

_CACHE_LOCK = threading.Lock()
_CACHE_BUILD_LOCK = threading.Lock()
_CACHE: tuple[float, int, Dict[str, Any]] | None = None
_CACHE_TTL_SECONDS = 5.0


def fetch_all_executions(max_items: int, fetch_json: FetchJson) -> list[Mapping[str, Any]]:
    offset = 0
    items: list[Mapping[str, Any]] = []
    while max_items == 0 or len(items) < max_items:
        page_limit = config.HISTORY_PAGE_SIZE
        if max_items:
            page_limit = min(page_limit, max_items - len(items))
        query = {"limit": page_limit, "offset": offset, "hydrate": "0"}
        payload = fetch_json(
            "/api/v3/development/executions?" + urllib.parse.urlencode(query),
            timeout=12.0,
        )
        page = [item for item in payload.get("items", []) if isinstance(item, Mapping)]
        items.extend(page)
        if len(page) < page_limit:
            break
        offset += len(page)
    return items


def build_dashboard(limit: int, fetch_json: FetchJson) -> Dict[str, Any]:
    global _CACHE

    def cached() -> Dict[str, Any] | None:
        with _CACHE_LOCK:
            if (
                _CACHE
                and _CACHE[1] == limit
                and time.monotonic() - _CACHE[0] < _CACHE_TTL_SECONDS
            ):
                return _CACHE[2]
        return None

    hit = cached()
    if hit is not None:
        return hit

    with _CACHE_BUILD_LOCK:
        hit = cached()
        if hit is not None:
            return hit
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            runtime_future = pool.submit(fetch_json, "/api/v3/development/runtime-summary")
            readiness_future = pool.submit(fetch_json, "/api/v3/development/readiness")
            registry_future = pool.submit(fetch_json, "/api/v3/development/model-registry")
            plans_future = pool.submit(
                fetch_json, "/api/v3/development/plans?limit=100&view=summary"
            )
            executions_future = pool.submit(fetch_all_executions, limit, fetch_json)
            runtime = runtime_future.result()
            readiness = readiness_future.result()
            registry = registry_future.result()
            plan_payload = plans_future.result()
            raw_executions = executions_future.result()

        catalog = _route_catalog(registry)
        executions = [_execution(item, catalog) for item in raw_executions]
        active = [item for item in executions if not item["terminal"]]
        history = [item for item in executions if item["terminal"]]
        plans, plan_summary = _plans(plan_payload.get("items"))
        result: Dict[str, Any] = {
            "schemaVersion": config.DASHBOARD_SCHEMA_VERSION,
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "summary": _summary(executions),
            "active": active,
            "history": history,
            "analytics": _analytics(executions),
            "plans": plans,
            "planSummary": plan_summary,
            "runtime": runtime,
            "readiness": readiness,
            "registry": registry,
        }
        with _CACHE_LOCK:
            _CACHE = (time.monotonic(), limit, result)
        return result
