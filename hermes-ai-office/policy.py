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
    r"implement|develop|debug|fix|refactor|code|coding|code review|"
    r"实现|开发|调试|修复|重构|编码|代码|代码审查",
    re.IGNORECASE,
)
_CODING_ACTION_RE = re.compile(
    r"implement|develop|debug|fix|refactor|review|edit|write|change|add|remove|"
    r"实现|开发|调试|修复|重构|审查|评审|编辑|修改|编写|添加|删除|实施",
    re.IGNORECASE,
)
_CODING_OBJECT_RE = re.compile(
    r"source(?: code)?|code|feature|bug|repository|repo|branch|worktree|pull request|"
    r"function|class|module|component|endpoint|schema|migration|unit test|test case|CI|"
    r"源码|代码|功能|bug|仓库|分支|工作树|函数|类|模块|组件|端点|契约|迁移|"
    r"单元测试|测试用例|CI",
    re.IGNORECASE,
)
_STRONG_CODING_RE = re.compile(
    r"write\s+code|code\s+review|code\s+change|fix\s+(?:a\s+)?bug|"
    r"implement\s+(?:a\s+)?feature|refactor|git\s+(?:commit|push|merge)|"
    r"写代码|改代码|代码审查|代码改动|重构|修复.{0,12}bug|实现.{0,12}功能|"
    r"提交.{0,12}代码|推送.{0,12}分支|合并.{0,12}分支",
    re.IGNORECASE,
)
_CODING_CONTINUATION_RE = re.compile(
    r"(?:继续|接着|开始|推进|完成|收尾|剩余|下一步).{0,20}(?:实施|实现|修复|开发|重构|审查|评审)|"
    r"(?:continue|resume|finish|proceed).{0,30}(?:implement|develop|fix|refactor|review)",
    re.IGNORECASE,
)
_NON_CODING_OPS_RE = re.compile(
    r"ssh|private key|secret|credential|server|vps|service|systemd|firewall|dns|domain|"
    r"tls|certificate|deploy|deployment|production|staging|backup|log|process|port|"
    r"私钥|密钥|凭证|服务器|运维|部署|服务|防火墙|域名|证书|备份|日志|进程|端口",
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
    "Direct software-development implementation is disabled for this coding turn. "
    "Use ai_office_delegate (or an explicitly operator-authored ai_office_create_plan) so Pixel Agent / AI Office owns source writers, review, integration, CI repair, and code delivery. "
    "This restriction applies to coding work only; ordinary SSH, secrets, deployment, service administration, and non-code file operations are not forced through Pixel Agent."
)


def enforces_profile(profile_name: str) -> bool:
    return str(profile_name or "").strip().lower() in _ENFORCED_PROFILES


def provider_topic(text: str) -> bool:
    value = str(text or "")
    return bool(_AI_OFFICE_RE.search(value) or (_PROVIDER_RE.search(value) and _PROVIDER_STATUS_RE.search(value)))


def development_topic(text: str) -> bool:
    return bool(_DEVELOPMENT_RE.search(str(text or "")))


def coding_task_topic(text: str, context_text: str = "") -> bool:
    """Classify software-development intent without treating generic operations as coding.

    The current turn wins. Short continuation prompts such as ``继续实施`` inherit coding
    intent only when the recent conversation already contains a concrete coding object.
    SSH setup, secret storage, deployment operations, service administration, and generic
    file management therefore stay outside the Pixel Agent mandatory boundary.
    """
    value = str(text or "").strip()
    if not value:
        return False
    if _STRONG_CODING_RE.search(value):
        return True
    if _CODING_ACTION_RE.search(value) and _CODING_OBJECT_RE.search(value):
        return True
    if _NON_CODING_OPS_RE.search(value):
        return False
    context = str(context_text or "")
    if _CODING_CONTINUATION_RE.search(value) and _CODING_OBJECT_RE.search(context):
        return True
    if len(value) <= 80 and _CODING_ACTION_RE.search(value) and _CODING_OBJECT_RE.search(context):
        return True
    return False


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


def pre_tool_call(
    profile_name: str,
    tool_name: Any = "",
    args: Any = None,
    *,
    coding_turn: bool = False,
) -> dict[str, str] | None:
    if not enforces_profile(profile_name) or not coding_turn:
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
