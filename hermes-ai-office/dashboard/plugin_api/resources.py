from __future__ import annotations

import re
from typing import Any, Dict, Mapping


_RESOURCE_TIERS = {"PROMOTIONAL", "FREE", "SUBSCRIPTION", "METERED", "OTHER"}
_RESOURCE_STATES = {"ACTIVE", "SUSPENDED", "DISABLED"}
_RESOURCE_TRANSPORTS = {"LITELLM_MANAGED", "PROVIDER_NATIVE"}
_CAPABILITIES = {"IMPLEMENTATION", "REASONING"}


def _required_string(value: Mapping[str, Any], key: str, source: str) -> str:
    raw = value.get(key)
    if not isinstance(raw, str) or not raw.strip():
        raise RuntimeError(f"control-plane contract violation: {source}.{key} must be a non-empty string")
    return raw.strip()


def _optional_string(value: Mapping[str, Any], key: str) -> str | None:
    raw = value.get(key)
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise RuntimeError(f"control-plane contract violation: resource.{key} must be a string or null")
    return raw.strip() or None


def _enum(value: Mapping[str, Any], key: str, allowed: set[str], source: str, *, fallback: str | None = None) -> str:
    raw = value.get(key, fallback)
    if not isinstance(raw, str) or raw.upper() not in allowed:
        choices = ", ".join(sorted(allowed))
        raise RuntimeError(f"control-plane contract violation: {source}.{key} must be one of {choices}")
    return raw.upper()


def _integer_or_none(value: Any, key: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise RuntimeError(f"control-plane contract violation: resource.{key} must be a non-negative integer or null")
    return value


def _sanitize_reason(value: str | None) -> str | None:
    if not value:
        return None
    # The Control Plane supplies sanitized failures. Keep this final projection
    # defensive in case an older producer accidentally includes credential-like
    # material in a reason string.
    redacted = re.sub(
        r"(?i)(api[_ -]?key|access[_ -]?token|authorization|password|secret|base[_ -]?url)\s*[:=]\s*[^\s,;]+",
        r"\1=[REDACTED]",
        value,
    )
    redacted = re.sub(r"\bsk-[A-Za-z0-9_-]{8,}\b", "[REDACTED]", redacted)
    return redacted


def _failure(value: Any) -> Dict[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, str):
        message = _sanitize_reason(value.strip())
        return {
            "reasonClass": "UNKNOWN_PROVIDER_FAILURE",
            "sanitizedReason": message,
            "changedAt": None,
            "source": None,
        } if message else None
    if not isinstance(value, Mapping):
        raise RuntimeError("control-plane contract violation: resource.lastNormalizedFailure must be an object, string, or null")
    reason_class = str(value.get("reasonClass") or value.get("class") or "UNKNOWN_PROVIDER_FAILURE").strip()
    sanitized_reason = _sanitize_reason(
        _optional_string(value, "sanitizedReason")
        or _optional_string(value, "message")
        or _optional_string(value, "reason")
    )
    return {
        "reasonClass": reason_class or "UNKNOWN_PROVIDER_FAILURE",
        "sanitizedReason": sanitized_reason,
        "changedAt": _optional_string(value, "changedAt") or _optional_string(value, "occurredAt"),
        "source": _optional_string(value, "source"),
    }


def _binding(raw: Any, resource_id: str) -> Dict[str, Any]:
    if not isinstance(raw, Mapping):
        raise RuntimeError(f"control-plane contract violation: resource {resource_id} model binding must be an object")
    model_family = _optional_string(raw, "modelFamily") or _optional_string(raw, "model")
    if not model_family:
        raise RuntimeError(f"control-plane contract violation: resource {resource_id} model binding.modelFamily must be a non-empty string")
    capability = _optional_string(raw, "capability") or _optional_string(raw, "role")
    if capability is not None:
        capability = capability.upper()
        if capability not in _CAPABILITIES:
            raise RuntimeError(f"control-plane contract violation: resource {resource_id} model binding.capability is invalid")
    agent_backend = _optional_string(raw, "agentBackend") or _optional_string(raw, "backend")
    enabled = raw.get("enabled", True)
    if not isinstance(enabled, bool):
        raise RuntimeError(f"control-plane contract violation: resource {resource_id} model binding.enabled must be a boolean")
    return {
        "modelFamily": model_family,
        "capability": capability,
        "agentBackend": agent_backend,
        "modelRank": _integer_or_none(raw.get("modelRank"), "modelRank"),
        "enabled": enabled,
        "deploymentId": _optional_string(raw, "deploymentId"),
        "protocol": _optional_string(raw, "protocol"),
    }


def _resource(raw: Mapping[str, Any]) -> Dict[str, Any]:
    if not isinstance(raw, Mapping):
        raise RuntimeError("control-plane contract violation: resource row must be an object")
    resource_id = _required_string(raw, "resourceId", "resource")
    provider_key = _optional_string(raw, "providerKey")
    display_name = (
        _optional_string(raw, "displayName")
        or _optional_string(raw, "name")
        or provider_key
        or resource_id
    )
    sequence = raw.get("resourceSequence")
    if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 0:
        raise RuntimeError("control-plane contract violation: resource.resourceSequence must be a non-negative integer")
    binding_rows = raw.get("modelBindings")
    if binding_rows is None:
        binding_rows = raw.get("bindings", [])
    if not isinstance(binding_rows, list):
        raise RuntimeError("control-plane contract violation: resource.modelBindings must be an array")
    version = _integer_or_none(raw.get("version"), "version")
    return {
        "resourceId": resource_id,
        "displayName": display_name,
        "providerKey": provider_key,
        "resourceTier": _enum(raw, "resourceTier", _RESOURCE_TIERS, "resource", fallback=raw.get("tier")),
        "resourceSequence": sequence,
        "state": _enum(raw, "state", _RESOURCE_STATES, "resource", fallback=raw.get("resourceState")),
        "transport": _enum(raw, "transport", _RESOURCE_TRANSPORTS, "resource"),
        "modelBindings": [_binding(item, resource_id) for item in binding_rows],
        "lastNormalizedFailure": _failure(raw.get("lastNormalizedFailure", raw.get("lastFailure"))),
        "suspendedUntil": _optional_string(raw, "suspendedUntil"),
        "version": version,
    }


def resources(payload: Mapping[str, Any]) -> list[Dict[str, Any]]:
    rows = payload.get("items")
    if not isinstance(rows, list):
        raise RuntimeError("control-plane contract violation: /api/v4/resources.items must be an array")
    return [_resource(item) for item in rows if isinstance(item, Mapping)]
