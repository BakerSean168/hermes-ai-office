#!/usr/bin/env bash
# 启动 Hermes 工作台看板: 自动获取 session token 并注入启动 server.py
set -euo pipefail

# 1. 优先从 hermes-personal 容器环境读 token
TOKEN=$(docker exec hermes-personal printenv HERMES_DASHBOARD_SESSION_TOKEN 2>/dev/null || true)

# 2. 兜底: 从本机 hermes dashboard 进程环境读
if [ -z "$TOKEN" ]; then
  PID=$(pgrep -f "hermes dashboard" | head -1)
  if [ -n "$PID" ]; then
    TOKEN=$(tr '\0' '\n' < "/proc/$PID/environ" 2>/dev/null | grep "^HERMES_DASHBOARD_SESSION_TOKEN=" | cut -d= -f2- || true)
  fi
fi

if [ -z "$TOKEN" ]; then
  echo "无法获取 HERMES_DASHBOARD_SESSION_TOKEN (hermes-personal 容器 / hermes dashboard 进程均未找到)" >&2
  exit 1
fi

export HERMES_DASHBOARD_SESSION_TOKEN="$TOKEN"
echo "已获取 token (长度 ${#TOKEN}), 启动看板 → http://127.0.0.1:8787"
exec python3 server.py
