#!/usr/bin/env python3
"""One-time Provider Hub -> LiteLLM DB registry migration.

The script never prints credential values. Provider API credentials are expected in
this process environment (normally sourced from Hermes' protected global .env).
LiteLLM's master key is also expected in the environment.

It intentionally leaves the legacy V2 Provider Hub database untouched as historical
migration evidence. Runtime/UI authority moves to LiteLLM after cutover.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

DEFAULT_DB = "/srv/hermes-personal/data/model-control-plane/control-plane.sqlite"
DEFAULT_URL = "http://127.0.0.1:4000"

# Legacy connection aliases that share one real API credential/access path.
CREDENTIAL_REF_OVERRIDES = {
    "wechat-miniapp-glm": "WECHAT_MINIAPP_FREE_API_KEY",
}

# Public model groups are the stable LiteLLM API surface. Physical model names may
# differ by provider while still offering the same capability.
PUBLIC_MODEL_ALIASES = {
    "deepseek-v4-flash-free": "deepseek-v4-flash",
}

# Preserve the already-qualified V3 routes exactly during migration. All other
# providers receive economics-derived order values and can be enabled/paused in the
# native LiteLLM dashboard.
QUALIFIED_ORDER = {
    ("teamorouter-gpt-5-6", "gpt-5.6-sol"): 1,
    ("forapi-4sapi-org-gpt-5-6", "gpt-5.6-sol"): 2,
    ("teamorouter-gpt-5-6", "deepseek-v4-flash-free"): 1,
    ("opencode-go", "deepseek-v4-flash"): 2,
}

ECONOMIC_ORDER = {
    "FREE": 20,
    "SPONSORED": 20,
    "SUBSCRIPTION": 30,
    "METERED": 40,
    "OTHER": 60,
}

@dataclass(frozen=True)
class LegacyConnection:
    id: str
    provider_key: str
    display_name: str
    base_url: str | None
    protocol: str
    auth_kind: str
    credential_ref: str | None
    models: tuple[str, ...]
    availability: str
    admin_state: str
    supplier_slug: str | None
    supplier_name: str | None
    supply_origin: str | None
    routing_policy: str | None
    commercial_type: str | None

    @property
    def credential_name(self) -> str:
        return f"ai-office-{self.provider_key}"

    @property
    def is_native_access(self) -> bool:
        return self.auth_kind != "API_KEY" or self.protocol == "codex-chatgpt-oauth"

    @property
    def custom_provider(self) -> str:
        if self.protocol == "anthropic-messages":
            return "anthropic"
        return "openai"


def _parse_models(raw: str | None) -> tuple[str, ...]:
    try:
        value = json.loads(raw or "[]")
    except json.JSONDecodeError:
        return ()
    out: list[str] = []
    if isinstance(value, list):
        for item in value:
            if isinstance(item, str):
                model = item
            elif isinstance(item, dict):
                model = item.get("id") or item.get("model") or item.get("name") or item.get("modelId")
            else:
                model = None
            if isinstance(model, str) and model.strip():
                out.append(model.strip())
    return tuple(dict.fromkeys(out))


def load_connections(db_file: str) -> list[LegacyConnection]:
    db = sqlite3.connect(f"file:{db_file}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    rows = db.execute(
        """
        SELECT
          c.id, c.provider_key, c.display_name, c.base_url, c.protocol,
          c.auth_kind, c.credential_ref, c.models_json, c.availability_state,
          c.admin_state,
          s.slug AS supplier_slug, s.name AS supplier_name,
          s.supply_origin, s.routing_policy,
          (
            SELECT p.commercial_type
            FROM v2_supply_agreements a
            LEFT JOIN v2_plans p ON p.id = a.plan_id
            WHERE a.supplier_id = s.id AND a.lifecycle = 'ACTIVE'
            ORDER BY a.created_at DESC
            LIMIT 1
          ) AS commercial_type
        FROM v2_provider_connections c
        LEFT JOIN v2_suppliers s ON s.id = c.supplier_id
        WHERE c.lifecycle = 'ACTIVE'
        ORDER BY c.display_name, c.provider_key
        """
    ).fetchall()
    db.close()
    return [
        LegacyConnection(
            id=row["id"],
            provider_key=row["provider_key"],
            display_name=row["display_name"],
            base_url=row["base_url"],
            protocol=row["protocol"],
            auth_kind=row["auth_kind"],
            credential_ref=row["credential_ref"],
            models=_parse_models(row["models_json"]),
            availability=row["availability_state"],
            admin_state=row["admin_state"],
            supplier_slug=row["supplier_slug"],
            supplier_name=row["supplier_name"],
            supply_origin=row["supply_origin"],
            routing_policy=row["routing_policy"],
            commercial_type=row["commercial_type"],
        )
        for row in rows
    ]


def public_model_name(model: str) -> str:
    return PUBLIC_MODEL_ALIASES.get(model, model)


def physical_model_name(connection: LegacyConnection, model: str) -> str:
    prefix = "anthropic" if connection.protocol == "anthropic-messages" else "openai"
    return f"{prefix}/{model}"


def mode_for_model(model: str) -> str:
    lower = model.lower()
    if "image" in lower:
        return "image_generation"
    return "chat"


def order_for(connection: LegacyConnection, model: str) -> int:
    override = QUALIFIED_ORDER.get((connection.provider_key, model))
    if override is not None:
        return override
    return ECONOMIC_ORDER.get((connection.commercial_type or "").upper(), 70)


def is_qualified(connection: LegacyConnection, model: str) -> bool:
    return (connection.provider_key, model) in QUALIFIED_ORDER


def should_be_active(connection: LegacyConnection, model: str) -> bool:
    if is_qualified(connection, model):
        return True
    if connection.admin_state != "ENABLED":
        return False
    if connection.routing_policy == "MANUAL_ONLY":
        return False
    return connection.availability == "AVAILABLE"


def credential_ref_for(connection: LegacyConnection) -> str | None:
    return CREDENTIAL_REF_OVERRIDES.get(connection.provider_key, connection.credential_ref)


def api_request(base_url: str, master_key: str, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        base_url.rstrip("/") + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {master_key}",
            "Content-Type": "application/json",
            "litellm-changed-by": "provider-hub-migration",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read()
            if not raw:
                return None
            return json.loads(raw)
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", "replace")
        raise RuntimeError(f"LiteLLM {method} {path} failed: HTTP {error.code}: {text[:600]}") from error


def current_state(base_url: str, master_key: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    creds_raw = api_request(base_url, master_key, "GET", "/credentials")
    credentials = creds_raw.get("credentials", []) if isinstance(creds_raw, dict) else (creds_raw or [])
    cred_map = {str(item.get("credential_name")): item for item in credentials if isinstance(item, dict)}
    models_raw = api_request(base_url, master_key, "GET", "/model/info") or {}
    models = models_raw.get("data", []) if isinstance(models_raw, dict) else []
    return cred_map, [item for item in models if isinstance(item, dict)]


def migration_key(connection: LegacyConnection, physical_model: str) -> str:
    return f"provider-hub:{connection.id}:{physical_model}"


def model_payload(connection: LegacyConnection, model: str) -> dict[str, Any]:
    public_model = public_model_name(model)
    physical_model = physical_model_name(connection, model)
    order = order_for(connection, model)
    tags = [
        "ai-office",
        f"provider:{connection.provider_key}",
        f"protocol:{connection.protocol}",
        f"commercial:{(connection.commercial_type or 'UNKNOWN').lower()}",
        f"origin:{(connection.supply_origin or 'UNKNOWN').lower()}",
    ]
    params: dict[str, Any] = {
        "model": physical_model,
        "litellm_credential_name": connection.credential_name,
        "order": order,
        "timeout": 120,
        "max_retries": 1,
        "tags": tags,
    }
    if connection.protocol == "openai-chat-completions":
        params["use_chat_completions_api"] = True
    metadata = {
        "owner": "litellm-provider-registry",
        "migrated_from": "ai-office-provider-hub",
        "migration_key": migration_key(connection, physical_model),
        "legacy_connection_id": connection.id,
        "legacy_provider_key": connection.provider_key,
        "display_name": connection.display_name,
        "supplier_slug": connection.supplier_slug,
        "supplier_name": connection.supplier_name,
        "supply_origin": connection.supply_origin,
        "commercial_type": connection.commercial_type,
        "routing_policy": connection.routing_policy,
        "legacy_availability": connection.availability,
        "legacy_admin_state": connection.admin_state,
        "protocol": connection.protocol,
        "route_role": "qualified" if is_qualified(connection, model) else "migrated",
    }
    return {
        "model_name": public_model,
        "litellm_params": params,
        "model_info": {
            "id": None,
            "mode": mode_for_model(model),
            "metadata": metadata,
        },
    }


def credential_payload(connection: LegacyConnection) -> dict[str, Any]:
    ref = credential_ref_for(connection)
    if not ref:
        raise RuntimeError(f"{connection.provider_key}: no credential_ref")
    secret = os.environ.get(ref)
    if not secret:
        raise RuntimeError(f"{connection.provider_key}: credential env {ref} is not available")
    values: dict[str, Any] = {"api_key": secret}
    if connection.base_url:
        values["api_base"] = connection.base_url
    return {
        "credential_name": connection.credential_name,
        "credential_info": {
            "custom_llm_provider": connection.custom_provider,
            "metadata": {
                "owner": "litellm-provider-registry",
                "migrated_from": "ai-office-provider-hub",
                "legacy_connection_id": connection.id,
                "legacy_provider_key": connection.provider_key,
                "protocol": connection.protocol,
            },
        },
        "credential_values": values,
    }


def print_plan(connections: list[LegacyConnection]) -> None:
    api_connections = [c for c in connections if not c.is_native_access]
    native = [c for c in connections if c.is_native_access]
    deployments = sum(len(c.models) for c in api_connections)
    print(f"API connections -> LiteLLM credentials: {len(api_connections)}")
    print(f"Model deployments -> LiteLLM DB: {deployments}")
    print(f"Native subscription/access records -> excluded from model provider registry: {len(native)}")
    for c in connections:
        if c.is_native_access:
            print(f"NATIVE  {c.provider_key:30} protocol={c.protocol} models={len(c.models)}")
            continue
        ref = credential_ref_for(c)
        present = bool(ref and os.environ.get(ref))
        active = sum(1 for m in c.models if should_be_active(c, m))
        blocked = len(c.models) - active
        print(
            f"API     {c.provider_key:30} protocol={c.protocol:24} models={len(c.models):2d} "
            f"active={active:2d} blocked={blocked:2d} credential={'yes' if present else 'MISSING'}"
        )


def apply_migration(connections: list[LegacyConnection], base_url: str, master_key: str) -> None:
    credentials, models = current_state(base_url, master_key)
    existing_by_key: dict[str, dict[str, Any]] = {}
    for item in models:
        metadata = (item.get("model_info") or {}).get("metadata") or {}
        key = metadata.get("migration_key") if isinstance(metadata, dict) else None
        if isinstance(key, str):
            existing_by_key[key] = item

    created_credentials = updated_credentials = 0
    created_models = updated_models = paused_models = unpaused_models = 0

    for connection in connections:
        if connection.is_native_access:
            continue
        payload = credential_payload(connection)
        name = connection.credential_name
        if name in credentials:
            api_request(base_url, master_key, "PATCH", "/credentials/" + urllib.parse.quote(name, safe=""), payload)
            updated_credentials += 1
        else:
            api_request(base_url, master_key, "POST", "/credentials", payload)
            created_credentials += 1

        for model in connection.models:
            payload = model_payload(connection, model)
            physical = payload["litellm_params"]["model"]
            key = migration_key(connection, physical)
            existing = existing_by_key.get(key)
            if existing:
                model_id = str((existing.get("model_info") or {}).get("id") or "")
                if not model_id:
                    raise RuntimeError(f"{key}: existing DB model has no id")
                payload["model_info"]["id"] = model_id
                api_request(
                    base_url,
                    master_key,
                    "PATCH",
                    f"/model/{urllib.parse.quote(model_id, safe='')}/update",
                    payload,
                )
                updated_models += 1
            else:
                created = api_request(base_url, master_key, "POST", "/model/new", payload) or {}
                model_id = str(
                    created.get("model_id")
                    or (created.get("model_info") or {}).get("id")
                    or created.get("id")
                    or ""
                )
                if not model_id:
                    # Reload because LiteLLM response shapes have changed between releases.
                    _, reloaded = current_state(base_url, master_key)
                    for candidate in reloaded:
                        metadata = (candidate.get("model_info") or {}).get("metadata") or {}
                        if metadata.get("migration_key") == key:
                            model_id = str((candidate.get("model_info") or {}).get("id") or "")
                            break
                if not model_id:
                    raise RuntimeError(f"{key}: LiteLLM created model but returned no model id")
                created_models += 1
                existing_by_key[key] = {"model_info": {"id": model_id, "metadata": payload["model_info"]["metadata"]}}

            desired_active = should_be_active(connection, model)
            api_request(
                base_url,
                master_key,
                "PATCH",
                f"/model/{urllib.parse.quote(model_id, safe='')}/update",
                {"blocked": not desired_active},
            )
            if desired_active:
                unpaused_models += 1
            else:
                paused_models += 1

    print(
        json.dumps(
            {
                "credentials_created": created_credentials,
                "credentials_updated": updated_credentials,
                "models_created": created_models,
                "models_updated": updated_models,
                "models_active": unpaused_models,
                "models_paused": paused_models,
            },
            indent=2,
        )
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--litellm-url", default=DEFAULT_URL)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    connections = load_connections(args.db)
    print_plan(connections)
    missing = []
    for connection in connections:
        if connection.is_native_access:
            continue
        ref = credential_ref_for(connection)
        if not ref or not os.environ.get(ref):
            missing.append((connection.provider_key, ref))
    if missing:
        print("Missing credentials:", file=sys.stderr)
        for provider, ref in missing:
            print(f"  {provider}: {ref or '<none>'}", file=sys.stderr)
        return 2
    if not args.apply:
        print("PLAN_ONLY: rerun with --apply after review")
        return 0

    master_key = os.environ.get("LITELLM_MASTER_KEY")
    if not master_key:
        print("LITELLM_MASTER_KEY is required", file=sys.stderr)
        return 2
    apply_migration(connections, args.litellm_url, master_key)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
