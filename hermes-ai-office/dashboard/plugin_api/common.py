from __future__ import annotations

from typing import Any, Dict, Mapping

def _number(value: Any) -> float:
    try:
        result = float(value or 0)
        return result if result == result else 0.0
    except (TypeError, ValueError):
        return 0.0


def _required_string(value: Mapping[str, Any], key: str, source: str) -> str:
    raw = value.get(key)
    if not isinstance(raw, str) or not raw.strip():
        raise RuntimeError(f"control-plane contract violation: {source}.{key} must be a non-empty string")
    return raw


def _usage(value: Any) -> Dict[str, Any]:
    raw = value if isinstance(value, Mapping) else {}
    return {
        "input": int(_number(raw.get("input"))),
        "output": int(_number(raw.get("output"))),
        "cachedInput": int(_number(raw.get("cachedInput"))),
        "reasoningOutput": int(_number(raw.get("reasoningOutput"))),
        "calls": int(_number(raw.get("calls"))),
        "costUsd": _number(raw.get("costUsd")),
    }
