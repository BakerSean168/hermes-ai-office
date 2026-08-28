#!/usr/bin/env python3
"""Securely import OpenAI-compatible provider credentials into LiteLLM.

Design constraints:
- LiteLLM remains the single provider/model authority for AI Office V3.
- Upstream API keys are never accepted as command-line arguments or printed.
- Provider base URLs are probed and canonicalized (including /v1 fallback).
- One encrypted LiteLLM credential is created per supplier; model deployments
  refer to it by ``litellm_credential_name`` instead of duplicating secrets.
- Deployment metadata preserves the economic/provider facts consumed by the
  V3 model-control-plane projection.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import platform
import re
import stat
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

DEFAULT_ADMIN_URL = "http://127.0.0.1:4000"
DEFAULT_CONTAINER = "hermes-litellm"
PROTOCOL_CHAT_COMPLETIONS = "openai-chat-completions"
PROTOCOL_RESPONSES = "openai-responses"
PROTOCOLS = {
    "chat-completions": PROTOCOL_CHAT_COMPLETIONS,
    "responses": PROTOCOL_RESPONSES,
}
OWNER = "litellm-provider-registry"
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,62}$")
CODEX_ORIGINATOR = "codex_exec"
CODEX_VERSION_FALLBACK = "0.149.1"

def detect_codex_version() -> str:
    override = os.environ.get("HERMES_PROVIDERCTL_CODEX_VERSION", "").strip()
    if override:
        return override
    try:
        raw = subprocess.check_output(
            ["codex", "--version"], text=True, stderr=subprocess.DEVNULL, timeout=3
        ).strip()
        match = re.search(r"(\d+\.\d+\.\d+)", raw)
        if match:
            return match.group(1)
    except (OSError, subprocess.SubprocessError):
        pass
    return CODEX_VERSION_FALLBACK

def codex_platform_label() -> str:
    arch = platform.machine() or "unknown"
    try:
        release = platform.freedesktop_os_release()
        name = str(release.get("NAME") or "").strip()
        version_id = str(release.get("VERSION_ID") or "").strip()
        if name and version_id:
            parts = []
            for raw in version_id.split("."):
                try:
                    parts.append(str(int(raw)))
                except ValueError:
                    parts.append(raw)
            while len(parts) < 3:
                parts.append("0")
            return f"{name} {'.'.join(parts[:3])}; {arch}"
    except (AttributeError, OSError):
        pass
    system = platform.system() or "unknown"
    return f"{system}; {arch}"


def codex_user_agent(version: str | None = None) -> str:
    version = version or detect_codex_version()
    return (
        f"codex_exec/{version} ({codex_platform_label()}) "
        f"unknown (codex_exec; {version})"
    )

CODEX_CLIENT_VERSION = detect_codex_version()
DEFAULT_USER_AGENT = os.environ.get(
    "HERMES_PROVIDERCTL_USER_AGENT", codex_user_agent(CODEX_CLIENT_VERSION)
)
EDGE_ERROR_KEY = "__providerctl_edge_error__"
COMMERCIAL_ORDER = {
    "FREE": 20,
    "SPONSORED": 20,
    "SUBSCRIPTION": 30,
    "METERED": 40,
    "OTHER": 60,
}
GPT_NON_CHAT_MARKERS = ("image", "audio", "realtime", "transcribe", "tts")


class ProviderCtlError(RuntimeError):
    pass


@dataclass(frozen=True)
class ProbeResult:
    base_url: str
    models: tuple[str, ...]
    used_fallback: bool


def json_request(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: Any | None = None,
    timeout: float = 20.0,
    user_agent: str | None = None,
) -> tuple[int, Any]:
    payload = None if body is None else json.dumps(body).encode("utf-8")
    # urllib's Python-urllib/* fingerprint is rejected by some API edges before
    # provider authentication. Use the same client identity as Codex CLI by
    # default; callers may still override it explicitly.
    merged = {"Accept": "*/*", "User-Agent": user_agent or DEFAULT_USER_AGENT}
    if headers:
        merged.update(headers)
    if payload is not None:
        merged["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=payload, method=method, headers=merged)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            content_type = (response.headers.get("content-type") or "").lower()
            if not raw:
                return response.status, None
            if "json" not in content_type:
                try:
                    return response.status, json.loads(raw.decode("utf-8"))
                except Exception:
                    return response.status, None
            return response.status, json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # Never propagate or print upstream/admin response bodies. Some proxy
        # errors echo request metadata and credential-bearing admin responses
        # may contain decrypted values.
        raw = exc.read(8192)
        lowered = raw.lower()
        if b"error code: 1010" in lowered or b"error 1010" in lowered:
            return exc.code, {EDGE_ERROR_KEY: "cloudflare_1010"}
        return exc.code, None
    except urllib.error.URLError as exc:
        raise ProviderCtlError(f"network error contacting {safe_origin(url)}: {exc.reason}") from None


def safe_origin(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    return f"{parsed.scheme}://{parsed.netloc}"


def normalize_base(value: str) -> str:
    value = value.strip().rstrip("/")
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ProviderCtlError("base URL must be an absolute http(s) URL")
    if parsed.username or parsed.password:
        raise ProviderCtlError("credentials must not be embedded in the base URL")
    if parsed.query or parsed.fragment:
        raise ProviderCtlError("base URL must not contain a query string or fragment")
    return value


def base_candidates(value: str) -> list[str]:
    normalized = normalize_base(value)
    candidates = [normalized]
    if normalized.endswith("/v1"):
        alternate = normalized[:-3].rstrip("/")
    else:
        alternate = normalized + "/v1"
    if alternate and alternate not in candidates:
        candidates.append(alternate)
    return candidates


def parse_model_catalog(payload: Any) -> tuple[str, ...] | None:
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        return None
    result: list[str] = []
    seen: set[str] = set()
    for item in payload["data"]:
        model_id = item.get("id") if isinstance(item, dict) else None
        if isinstance(model_id, str) and model_id.strip() and model_id not in seen:
            seen.add(model_id)
            result.append(model_id.strip())
    return tuple(result)


def probe_openai_models(
    base_url: str,
    api_key: str,
    *,
    timeout: float = 20.0,
    user_agent: str | None = None,
) -> ProbeResult:
    failures: list[tuple[str, int]] = []
    edge_errors: set[str] = set()
    candidates = base_candidates(base_url)
    for index, candidate in enumerate(candidates):
        separator = "&" if "?" in candidate else "?"
        models_url = candidate + "/models" + separator + urllib.parse.urlencode(
            {"client_version": CODEX_CLIENT_VERSION}
        )
        status, payload = json_request(
            models_url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Originator": CODEX_ORIGINATOR,
            },
            timeout=timeout,
            user_agent=user_agent,
        )
        if isinstance(payload, dict) and isinstance(payload.get(EDGE_ERROR_KEY), str):
            edge_errors.add(payload[EDGE_ERROR_KEY])
        models = parse_model_catalog(payload)
        if 200 <= status < 300 and models:
            return ProbeResult(candidate, models, used_fallback=index > 0)
        failures.append((candidate, status))

    statuses = {status for _, status in failures}
    if "cloudflare_1010" in edge_errors:
        reason = (
            "provider edge rejected the HTTP client before API authentication "
            "(Cloudflare 1010); use --user-agent or provider-specific headers"
        )
    elif 401 in statuses or 403 in statuses:
        reason = "credential rejected (HTTP 401/403)"
    elif 429 in statuses:
        reason = "provider rate-limited the catalog probe (HTTP 429)"
    elif any(status >= 500 for status in statuses):
        reason = "provider returned a server error"
    elif any(200 <= status < 300 for status in statuses):
        reason = "endpoint returned a non-OpenAI model catalog (for example HTML)"
    else:
        rendered = ", ".join(str(s) for s in sorted(statuses)) or "no HTTP response"
        reason = f"no compatible model catalog found (statuses: {rendered})"
    raise ProviderCtlError(reason)


def select_models(models: Iterable[str], family: str, exact: list[str]) -> list[str]:
    available = list(models)
    if exact:
        missing = sorted(set(exact) - set(available))
        if missing:
            raise ProviderCtlError("requested models were not advertised: " + ", ".join(missing))
        return list(dict.fromkeys(exact))
    if family == "gpt":
        selected = [
            model
            for model in available
            if model.lower().startswith("gpt-")
            and not any(marker in model.lower() for marker in GPT_NON_CHAT_MARKERS)
        ]
    elif family == "all-chat":
        selected = [
            model
            for model in available
            if not any(marker in model.lower() for marker in GPT_NON_CHAT_MARKERS)
        ]
    else:
        raise ProviderCtlError(f"unsupported model family: {family}")
    if not selected:
        raise ProviderCtlError(f"no {family} models were found in the provider catalog")
    return selected


def read_secret(key_file: str | None) -> str:
    if key_file:
        path = Path(key_file)
        mode = stat.S_IMODE(path.stat().st_mode)
        if mode & 0o077:
            raise ProviderCtlError(f"key file must be mode 0600 or stricter (found {mode:o})")
        value = path.read_text(encoding="utf-8").strip()
    elif not sys.stdin.isatty():
        value = sys.stdin.read().strip()
    else:
        value = getpass.getpass("Upstream API key: ").strip()
    if not value:
        raise ProviderCtlError("empty upstream API key")
    return value


def read_admin_key(args: argparse.Namespace) -> str:
    if args.admin_key_file:
        path = Path(args.admin_key_file)
        mode = stat.S_IMODE(path.stat().st_mode)
        if mode & 0o077:
            raise ProviderCtlError(f"admin key file must be mode 0600 or stricter (found {mode:o})")
        value = path.read_text(encoding="utf-8").strip()
        if value:
            return value
    if os.environ.get("LITELLM_MASTER_KEY"):
        return os.environ["LITELLM_MASTER_KEY"].strip()
    try:
        raw = subprocess.check_output(["docker", "inspect", args.container], text=True)
        inspected = json.loads(raw)
        env = ((inspected or [{}])[0].get("Config") or {}).get("Env") or []
        for item in env:
            if isinstance(item, str) and item.startswith("LITELLM_MASTER_KEY="):
                value = item.partition("=")[2].strip()
                if value:
                    return value
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError, IndexError):
        pass
    raise ProviderCtlError("LiteLLM admin key not found; set LITELLM_MASTER_KEY or use --admin-key-file")


class LiteLlmAdmin:
    def __init__(self, base_url: str, api_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.headers = {"Authorization": f"Bearer {api_key}"}

    def request(self, method: str, path: str, body: Any | None = None) -> Any:
        status, payload = json_request(
            self.base_url + "/" + path.lstrip("/"),
            method=method,
            headers=self.headers,
            body=body,
        )
        if not 200 <= status < 300:
            raise ProviderCtlError(f"LiteLLM Admin {method} /{path.lstrip('/')} failed with HTTP {status}")
        return payload

    def credentials(self) -> list[dict[str, Any]]:
        payload = self.request("GET", "/credentials")
        if isinstance(payload, list):
            return [row for row in payload if isinstance(row, dict)]
        if isinstance(payload, dict):
            rows = payload.get("credentials", payload.get("data", []))
            if isinstance(rows, list):
                return [row for row in rows if isinstance(row, dict)]
        raise ProviderCtlError("LiteLLM returned an unexpected credentials payload")

    def deployments(self) -> list[dict[str, Any]]:
        payload = self.request("GET", "/model/info")
        rows = payload.get("data", []) if isinstance(payload, dict) else payload
        if not isinstance(rows, list):
            raise ProviderCtlError("LiteLLM returned an unexpected model registry payload")
        return [row for row in rows if isinstance(row, dict)]

    def patch_deployment(self, model_id: str, body: dict[str, Any]) -> Any:
        if not model_id:
            raise ProviderCtlError("cannot reconcile deployment without model_info.id")
        return self.request("PATCH", f"/model/{urllib.parse.quote(model_id, safe='')}/update", body)


def credential_base_matches(row: dict[str, Any], name: str, base_url: str) -> bool:
    if row.get("credential_name") != name:
        return False
    values = row.get("credential_values") if isinstance(row.get("credential_values"), dict) else {}
    existing_base = str(values.get("api_base") or "").rstrip("/")
    return existing_base == base_url.rstrip("/")


def deployment_key(row: dict[str, Any]) -> tuple[str, str, str]:
    params = row.get("litellm_params") if isinstance(row.get("litellm_params"), dict) else {}
    info = row.get("model_info") if isinstance(row.get("model_info"), dict) else {}
    metadata = info.get("metadata") if isinstance(info.get("metadata"), dict) else {}
    return (
        str(row.get("model_name") or ""),
        str(params.get("litellm_credential_name") or ""),
        str(metadata.get("legacy_provider_key") or ""),
    )


def find_existing_deployment(
    rows: Iterable[dict[str, Any]],
    *,
    model: str,
    provider_name: str,
) -> dict[str, Any] | None:
    exact: dict[str, Any] | None = None
    fallback: dict[str, Any] | None = None
    for row in rows:
        group, credential, provider = deployment_key(row)
        if group != model or credential != provider_name:
            continue
        if provider == provider_name:
            exact = row
            break
        if fallback is None:
            fallback = row
    return exact or fallback


def deployment_reconcile_patch(row: dict[str, Any], *, protocol: str) -> dict[str, Any]:
    params = row.get("litellm_params") if isinstance(row.get("litellm_params"), dict) else {}
    desired_headers = {
        "User-Agent": DEFAULT_USER_AGENT,
        "Originator": CODEX_ORIGINATOR,
    }
    updates: dict[str, Any] = {}
    if params.get("extra_headers") != desired_headers:
        updates["extra_headers"] = desired_headers
    if protocol == PROTOCOL_CHAT_COMPLETIONS:
        if params.get("use_chat_completions_api") is not True:
            updates["use_chat_completions_api"] = True
    elif params.get("use_chat_completions_api") is True:
        # False preserves native Responses routing; PATCH cannot remove an
        # arbitrary field with null because LiteLLM excludes nulls from updates.
        updates["use_chat_completions_api"] = False
    return {"litellm_params": updates} if updates else {}


def create_credential(
    admin: LiteLlmAdmin,
    *,
    name: str,
    display_name: str,
    base_url: str,
    api_key: str,
    protocol: str,
    commercial_type: str,
    supply_origin: str,
) -> None:
    admin.request(
        "POST",
        "/credentials",
        {
            "credential_name": name,
            "credential_info": {
                "custom_llm_provider": "openai",
                "metadata": {
                    "owner": OWNER,
                    "protocol": protocol,
                    "source": "hermes-litellm-providerctl",
                    "legacy_provider_key": name,
                    "provider_display_name": display_name,
                    "commercial_type": commercial_type,
                    "supply_origin": supply_origin,
                },
            },
            "credential_values": {"api_base": base_url, "api_key": api_key},
        },
    )


def deployment_payload(
    *,
    provider_name: str,
    display_name: str,
    model: str,
    protocol: str,
    commercial_type: str,
    supply_origin: str,
) -> dict[str, Any]:
    order = COMMERCIAL_ORDER[commercial_type]
    litellm_params: dict[str, Any] = {
        "model": f"openai/{model}",
        "litellm_credential_name": provider_name,
        # Keep runtime requests aligned with Codex as well as the catalog probe.
        "extra_headers": {
            "User-Agent": DEFAULT_USER_AGENT,
            "Originator": CODEX_ORIGINATOR,
        },
        "timeout": 120.0,
        "max_retries": 1,
        "order": order,
        "tags": [
            "ai-office",
            f"provider:{provider_name}",
            f"protocol:{protocol}",
            f"commercial:{commercial_type.lower()}",
            f"origin:{supply_origin.lower()}",
        ],
    }
    # This flag makes LiteLLM emulate /responses through /chat/completions.
    # Omit it for providers with a native Responses endpoint so the native
    # protocol can be preserved end to end.
    if protocol == PROTOCOL_CHAT_COMPLETIONS:
        litellm_params["use_chat_completions_api"] = True

    return {
        "model_name": model,
        "litellm_params": litellm_params,
        "model_info": {
            "id": str(uuid.uuid4()),
            "blocked": False,
            "mode": "chat",
            "metadata": {
                "owner": OWNER,
                "protocol": protocol,
                "display_name": display_name,
                "supplier_name": display_name,
                "supplier_slug": provider_name,
                "legacy_provider_key": provider_name,
                "supply_origin": supply_origin,
                "commercial_type": commercial_type,
                "source": "hermes-litellm-providerctl",
            },
        },
    }


def run_import(args: argparse.Namespace) -> None:
    if not NAME_RE.fullmatch(args.name):
        raise ProviderCtlError("provider name must match [a-z0-9][a-z0-9._-]{0,62}")
    commercial_type = args.commercial_type.upper()
    supply_origin = args.supply_origin.upper()
    if commercial_type not in COMMERCIAL_ORDER:
        raise ProviderCtlError("unsupported commercial type")

    upstream_key = read_secret(args.key_file)
    protocol = PROTOCOLS[args.protocol]
    probe = probe_openai_models(
        args.base_url,
        upstream_key,
        timeout=args.timeout,
        user_agent=args.user_agent,
    )
    models = select_models(probe.models, args.family, args.model)
    display_name = args.display_name or args.name

    print(f"provider={args.name}")
    print(f"canonical_base={probe.base_url}")
    print(f"catalog_models={len(probe.models)} selected_models={len(models)}")
    print(f"commercial_type={commercial_type} order={COMMERCIAL_ORDER[commercial_type]}")
    print(f"protocol={protocol}")
    if probe.used_fallback:
        print("base_url_normalized=true")
    for model in models:
        print(f"model={model}")

    if not args.apply:
        print("dry_run=true; no LiteLLM state changed")
        return

    admin = LiteLlmAdmin(args.admin_url, read_admin_key(args))
    credentials = admin.credentials()
    same_name = [row for row in credentials if row.get("credential_name") == args.name]
    if same_name:
        if not args.reuse_existing_credential:
            raise ProviderCtlError(
                f"credential {args.name} already exists; LiteLLM masks stored keys, so providerctl "
                "will not silently reuse or overwrite it (use --reuse-existing-credential only "
                "when intentionally resuming a partial import)"
            )
        if not any(credential_base_matches(row, args.name, probe.base_url) for row in same_name):
            raise ProviderCtlError(
                f"credential {args.name} exists with a different API base; refuse unsafe reuse"
            )
        print("credential=reused")
    else:
        create_credential(
            admin,
            name=args.name,
            display_name=display_name,
            base_url=probe.base_url,
            api_key=upstream_key,
            protocol=protocol,
            commercial_type=commercial_type,
            supply_origin=supply_origin,
        )
        print("credential=created")

    deployments = admin.deployments()
    created = 0
    reused = 0
    reconciled = 0
    for model in models:
        current = find_existing_deployment(
            deployments, model=model, provider_name=args.name
        )
        if current is not None:
            patch = deployment_reconcile_patch(current, protocol=protocol)
            if patch:
                info = current.get("model_info") if isinstance(current.get("model_info"), dict) else {}
                model_id = str(info.get("id") or "")
                admin.patch_deployment(model_id, patch)
                reconciled += 1
            else:
                reused += 1
            continue
        admin.request(
            "POST",
            "/model/new",
            deployment_payload(
                provider_name=args.name,
                display_name=display_name,
                model=model,
                protocol=protocol,
                commercial_type=commercial_type,
                supply_origin=supply_origin,
            ),
        )
        created += 1
    print(
        f"deployments_created={created} deployments_reused={reused} "
        f"deployments_reconciled={reconciled}"
    )
    print("import=complete")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Securely import an OpenAI-compatible supplier into the Oracle2 LiteLLM authority."
    )
    parser.add_argument("--name", required=True, help="stable provider slug, e.g. pqh")
    parser.add_argument("--display-name", help="human-readable supplier name")
    parser.add_argument("--base-url", required=True, help="provider root or /v1 base URL")
    parser.add_argument("--key-file", help="mode-0600 upstream key file; otherwise stdin/TTY prompt")
    parser.add_argument("--family", choices=("gpt", "all-chat"), default="gpt")
    parser.add_argument("--model", action="append", default=[], help="exact advertised model; repeatable")
    parser.add_argument(
        "--protocol",
        choices=tuple(PROTOCOLS),
        default="chat-completions",
        help="upstream OpenAI wire protocol; responses preserves native /responses when supported",
    )
    parser.add_argument(
        "--user-agent",
        default=DEFAULT_USER_AGENT,
        help="HTTP User-Agent for provider probes (default: current Codex CLI shape)",
    )
    parser.add_argument(
        "--commercial-type",
        choices=tuple(COMMERCIAL_ORDER),
        default="METERED",
        help="economic class consumed by AI Office routing projection",
    )
    parser.add_argument("--supply-origin", default="COMMERCIAL_RELAY")
    parser.add_argument("--admin-url", default=DEFAULT_ADMIN_URL)
    parser.add_argument("--admin-key-file")
    parser.add_argument(
        "--reuse-existing-credential",
        action="store_true",
        help="resume a partial import using an existing same-name credential; never overwrites its secret",
    )
    parser.add_argument("--container", default=DEFAULT_CONTAINER)
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--apply", action="store_true", help="persist credential/deployments after successful probe")
    return parser


def main() -> int:
    try:
        run_import(build_parser().parse_args())
        return 0
    except ProviderCtlError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("error: interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
