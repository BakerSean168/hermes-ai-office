"""Hermes-side execution policy for enforced Pixel Agent project profiles.

This module owns only intent/tool safety classification. It has no control-plane transport,
plan state, or tool registration responsibilities.
"""

from __future__ import annotations

from collections.abc import Mapping
import os
from pathlib import Path
import re
import shlex
from typing import Any

_AI_OFFICE_RE = re.compile(r"\bai[\s_-]*office\b", re.IGNORECASE)
_PROVIDER_RE = re.compile(r"provider|supplier|channel|model|供应商|提供商|渠道|模型", re.IGNORECASE)
_PROVIDER_STATUS_RE = re.compile(r"status|health|available|list|current|状态|健康|可用|列表|当前|哪些", re.IGNORECASE)
_DEVELOPMENT_RE = re.compile(
    r"pixel[- ]?agent|ai[ _-]?office|ai_office_delegate|"
    r"implement|review|plan|debug|test|fix|refactor|code|coding|"
    r"实施|实现|审查|评审|规划|计划|调试|测试|修复|重构|编码|代码",
    re.IGNORECASE,
)
_ENFORCED_PROFILES = {
    item.strip().lower()
    for item in os.environ.get(
        "HERMES_AI_OFFICE_ENFORCED_PROFILES",
        "memoflow,bodysense,digital-biome",
    ).split(",")
    if item.strip()
}
_DIRECT_AGENT_NAMES = {
    "agy",
    "antigravity",
    "claude",
    "codex",
    "dsh",
    "openhands",
    "opencode",
    "zcode",
}
_READ_ONLY_TOOL_FRAGMENTS = (
    "read_file",
    "read_text_file",
    "read_media_file",
    "search_files",
    "list_directory",
    "directory_tree",
    "get_file_info",
)
_PACKAGE_VERIFY_SCRIPT_RE = re.compile(
    r"^(?:test|typecheck|lint|build|check|verify|ci|e2e|db:test|prisma:(?:validate|generate))(?:[:_-].*)?$",
    re.IGNORECASE,
)
_BLOCK_MESSAGE = (
    "Direct implementation is disabled for this project profile. "
    "Use ai_office_delegate (or an explicitly operator-authored ai_office_create_plan) so Pixel Agent / AI Office owns writers, review, integration, CI repair, and delivery. "
    "Hermes may inspect state and run bounded read-only verification, but must not edit source, launch coding agents directly, or mutate Git/PR state."
)


def enforces_profile(profile_name: str) -> bool:
    return str(profile_name or "").strip().lower() in _ENFORCED_PROFILES


def provider_topic(text: str) -> bool:
    value = str(text or "")
    return bool(_AI_OFFICE_RE.search(value) or (_PROVIDER_RE.search(value) and _PROVIDER_STATUS_RE.search(value)))


def development_topic(text: str) -> bool:
    return bool(_DEVELOPMENT_RE.search(str(text or "")))


def is_safe_terminal_command(command: str) -> bool:
    """Allow inspection/verification, but never direct implementation or delivery."""
    value = str(command or "").strip()
    if not value:
        return False
    if re.search(r"(?:&&|\|\||[;|><`]|\$\(|\n|\r)", value):
        return False
    try:
        tokens = shlex.split(value)
    except ValueError:
        return False
    if not tokens:
        return False

    command_name = Path(tokens[0]).name.lower()
    if command_name in _DIRECT_AGENT_NAMES:
        return False
    if command_name not in {
        "pwd", "hostname", "whoami", "date", "ls", "find", "rg", "grep", "cat", "head", "tail",
        "wc", "stat", "du", "df", "ps", "pgrep", "git", "gh", "docker", "docker-compose",
        "systemctl", "journalctl", "pytest", "vitest", "nx", "go", "cargo", "pnpm", "npm", "yarn",
        "bun", "npx",
    }:
        return False

    if command_name == "git":
        if len(tokens) < 2:
            return False
        subcommand = tokens[1].lower()
        if subcommand not in {
            "status", "diff", "log", "show", "rev-parse", "remote", "branch", "fetch", "ls-files",
            "grep", "describe",
        }:
            return False
        if subcommand == "branch" and any(
            token in {"-d", "-D", "-m", "-M", "--delete", "--move"} for token in tokens[2:]
        ):
            return False
        return True

    if command_name == "gh":
        if len(tokens) < 3:
            return False
        return (tokens[1].lower(), tokens[2].lower()) in {
            ("pr", "checks"), ("pr", "view"), ("pr", "status"), ("pr", "list"),
            ("run", "view"), ("run", "list"), ("run", "watch"),
        }

    if command_name == "docker":
        if len(tokens) < 2:
            return False
        if tokens[1].lower() == "compose":
            return len(tokens) >= 3 and tokens[2].lower() in {"ps", "logs", "config"}
        return tokens[1].lower() in {"ps", "logs", "inspect", "stats"}

    if command_name == "docker-compose":
        return len(tokens) >= 2 and tokens[1].lower() in {"ps", "logs", "config"}
    if command_name == "systemctl":
        return len(tokens) >= 2 and tokens[1].lower() in {"status", "show", "is-active", "is-failed"}
    if command_name == "journalctl":
        return True
    if command_name in {
        "pwd", "hostname", "whoami", "date", "ls", "find", "rg", "grep", "cat", "head", "tail",
        "wc", "stat", "du", "df", "ps", "pgrep",
    }:
        return True
    if command_name in {"pytest", "vitest"}:
        return True
    if command_name == "nx":
        return len(tokens) >= 2 and tokens[1].lower() in {"test", "lint", "build", "typecheck", "affected"}
    if command_name == "go":
        return len(tokens) >= 2 and tokens[1].lower() in {"test", "vet"}
    if command_name == "cargo":
        return len(tokens) >= 2 and tokens[1].lower() in {"test", "check", "clippy"}

    if command_name in {"pnpm", "npm", "yarn", "bun"}:
        if len(tokens) < 2:
            return False
        if tokens[1].lower() == "exec":
            if len(tokens) < 3:
                return False
            executable = Path(tokens[2]).name.lower()
            if executable in {"vitest", "playwright", "tsc", "eslint", "nx"}:
                return True
            if executable == "prisma":
                return len(tokens) >= 4 and tokens[3].lower() in {"validate", "generate"}
            return False
        script_index = 2 if tokens[1].lower() == "run" else 1
        return len(tokens) > script_index and bool(_PACKAGE_VERIFY_SCRIPT_RE.fullmatch(tokens[script_index]))

    if command_name == "npx":
        if len(tokens) < 2:
            return False
        executable = Path(tokens[1]).name.lower()
        if executable in {"vitest", "playwright", "tsc", "eslint", "nx"}:
            return True
        if executable == "prisma":
            return len(tokens) >= 3 and tokens[2].lower() in {"validate", "generate"}
        return False
    return False


def pre_tool_call(profile_name: str, tool_name: Any = "", args: Any = None) -> dict[str, str] | None:
    if not enforces_profile(profile_name):
        return None
    name = str(tool_name or "").strip().lower()
    if not name or name.startswith("ai_office_"):
        return None
    if any(fragment in name for fragment in _READ_ONLY_TOOL_FRAGMENTS):
        return None

    if "terminal" in name or name in {"shell", "bash", "exec", "code_execution"}:
        arguments = args if isinstance(args, Mapping) else {}
        command = str(arguments.get("command") or arguments.get("cmd") or "")
        return None if is_safe_terminal_command(command) else {"action": "block", "message": _BLOCK_MESSAGE}
    if any(token in name for token in ("write", "edit", "move", "delete", "remove", "patch", "apply_patch")):
        return {"action": "block", "message": _BLOCK_MESSAGE}
    if any(token in name for token in ("delegate", "subagent", "spawn", "codex", "opencode", "claude", "dsh", "zcode", "openhands")):
        return {"action": "block", "message": _BLOCK_MESSAGE}
    if "github" in name and any(token in name for token in ("create", "update", "merge", "push", "delete")):
        return {"action": "block", "message": _BLOCK_MESSAGE}
    if name in {"file", "filesystem"}:
        return {"action": "block", "message": _BLOCK_MESSAGE}
    return None
