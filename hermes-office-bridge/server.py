#!/usr/bin/env python3
"""Hermes 工作台看板 - 本地静态服务 + /api/* 反向代理 + /api/board 聚合端点。

纯 Python 标准库实现:
  - 静态文件服务 (index.html 等)
  - /api/* 反向代理到 http://127.0.0.1:9119/api/*, 附加 Bearer token
  - /api/board 聚合端点: 拉取上游 status + sessions, 按 profile 聚合为 Team Pod,
    并对每个 session 做状态机推断 (infer_status)
  - token 从环境变量 HERMES_DASHBOARD_SESSION_TOKEN 读取, 绝不写入前端
"""

import http.server
import json
import os
import re
import sqlite3
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

HOST = "127.0.0.1"
PORT = 8787
UPSTREAM = "http://127.0.0.1:9119"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
KANBAN_DB = "/opt/data/kanban.db"
KANBAN_DB_URI = "file:%s?mode=ro" % KANBAN_DB
SPAWNS_FILE = os.path.join(BASE_DIR, "spawns.json")

# 不需要转发给上游的 hop-by-hop 头
HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
}

# 状态机推断规则: 按顺序匹配 last_activity_description
# (顺序敏感, 前面的优先)
_STATUS_RULES = [
    ("llm_running", ["receiving stream response", "api call", "starting api call"]),
    ("planning", ["plan", "thinking", "reasoning", "reading"]),
    ("coding", ["terminal", "edit", "write_file", "patch", "command"]),
    ("browsing", ["browser", "web", "fetch", "search"]),
    ("reviewing", ["review", "inspect", "read_file"]),
    ("waiting_io", ["wait", "sleep", "poll"]),
    ("blocked", ["error", "failed", "blocked", "approval"]),
]


def _token():
    return os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN", "")


def _read_token_file(path):
    """可选: 如果指定的是文件路径, 读取文件内容作为 token。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def _fetch_upstream(path):
    """GET 上游 JSON 并解析返回。token 缺失或上游不可达时抛异常。"""
    token = _token()
    if not token:
        raise RuntimeError("HERMES_DASHBOARD_SESSION_TOKEN missing")
    req = urllib.request.Request(UPSTREAM + path)
    req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8", "replace")
        return json.loads(raw)


def infer_status(session):
    """按 is_active + last_activity_description 文本映射出工作状态。"""
    if not session.get("is_active"):
        return "idle"
    desc = (session.get("last_activity_description") or "").lower()
    if desc:
        for status, keys in _STATUS_RULES:
            for key in keys:
                if key in desc:
                    return status
    return "working"


def _display_name(name):
    """profile 名 → 友好显示名 (分隔符/驼峰切分后首字母大写)。"""
    words = []
    for part in re.split(r"[-_ ]+", name or ""):
        for w in re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", part).split():
            words.append(w)
    if not words:
        return name or ""
    return " ".join(w[:1].upper() + w[1:] for w in words)


def _session_profile(session):
    """Resolve the effective multiplex profile for a Hermes session.

    The sessions API exposes both the physical gateway profile (`profile`) and
    the routed runtime profile (`profile_name`). Under multiplex routing the
    physical gateway is often `default` even when the session actually belongs
    to MemoFlow/BodySense/etc, so profile_name MUST win. origin_json is the
    second source of truth for routed messaging sessions.
    """
    explicit = session.get("profile_name")
    if explicit:
        return explicit
    try:
        origin = json.loads(session.get("origin_json") or "{}")
        routed = origin.get("profile")
        if routed:
            return routed
    except Exception:  # noqa: BLE001
        pass
    return session.get("profile") or "default"


def _runtime(session):
    """Return the runtime that owns the session.

    `/api/profiles/sessions` contains HERMES sessions. `billing_provider` only
    describes where the model call was billed (e.g. opencode-go), not whether
    an external OpenCode/Codex process exists. Treating billing_provider as the
    runtime created fake OpenCode workers. External runtimes are discovered from
    process/spawn telemetry instead.
    """
    explicit = (session.get("runtime") or session.get("agent_runtime") or "").strip().lower()
    if explicit in {"opencode", "codex", "hermes", "terminal", "browser"}:
        return explicit
    return "hermes"


def _is_profile_controller(session):
    """Messaging root sessions are the Profile Controller, not office workers."""
    if session.get("parent_session_id"):
        return False
    return (session.get("source") or "").lower() in {
        "telegram", "discord", "slack", "whatsapp", "signal", "matrix",
        "teams", "email", "imessage",
    }


def _cost_usd(session):
    c = session.get("estimated_cost_usd")
    if c is None:
        c = session.get("actual_cost_usd")
    try:
        return float(c or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _worker_tokens(session):
    return {
        "input": int(session.get("input_tokens") or 0),
        "output": int(session.get("output_tokens") or 0),
        "cache_read": int(session.get("cache_read_tokens") or 0),
        "reasoning": int(session.get("reasoning_tokens") or 0),
    }


def _elapsed_sec(session, now):
    started = session.get("started_at")
    if not started:
        return 0
    if session.get("is_active"):
        end = now
    else:
        end = session.get("ended_at") or session.get("last_activity_at") or started
    try:
        return max(0, int(end - started))
    except TypeError:
        return 0


def _runtime_from_command(command):
    low = (command or "").lower()
    if re.search(r"(^|[\s/])opencode(?:[\s]|$)", low):
        return "opencode"
    if re.search(r"(^|[\s/])codex(?:[\s]|$)", low):
        return "codex"
    return None


def _model_from_command(command):
    text = command or ""
    m = re.search(r"(?:^|\s)(?:-m|--model)(?:=|\s+)([^\s]+)", text)
    return m.group(1) if m else None


def _profile_hint_from_cwd(cwd):
    m = re.match(r"^/workspace/repos/([^/]+)(?:/|$)", cwd or "")
    return m.group(1) if m else None


def scan_processes():
    """Scan live external executor processes (OpenCode/Codex) with correlation hints."""
    procs = []
    try:
        out = subprocess.run(
            ["ps", "aux"],
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout
        for line in out.splitlines()[1:]:
            parts = line.split(None, 10)
            if len(parts) < 11:
                continue
            command = parts[10]
            runtime = _runtime_from_command(command)
            if not runtime:
                continue
            pid_text = parts[1]
            cwd = ""
            try:
                cwd = os.readlink(f"/proc/{pid_text}/cwd")
            except Exception:  # noqa: BLE001
                pass
            try:
                pid = int(pid_text)
            except ValueError:
                continue
            procs.append(
                {
                    "user": parts[0],
                    "pid": pid,
                    "cwd": cwd,
                    "command": command[:400],
                    "runtime": runtime,
                    "model": _model_from_command(command),
                    "profile_hint": _profile_hint_from_cwd(cwd),
                }
            )
    except Exception:  # noqa: BLE001
        pass
    return procs


def _match_process(cwd, runtime, procs):
    """按 cwd + runtime 关键字匹配进程, 返回 pid 或 None。"""
    if not cwd or not procs:
        return None
    for p in procs:
        pc = p.get("cwd") or ""
        if pc and pc == cwd and (p.get("command") or "").lower().find(runtime) >= 0:
            return p.get("pid")
    return None


def read_kanban():
    """只读读取 /opt/data/kanban.db, 返回 tasks/links/runs/events。

    任何异常(不存在/被锁/损坏)都返回空结构, 不报错。
    """
    empty = {"tasks": [], "links": [], "runs": [], "events": []}
    try:
        con = sqlite3.connect(KANBAN_DB_URI, uri=True, timeout=1)
        con.row_factory = sqlite3.Row
        cur = con.cursor()
        tasks = [
            dict(r)
            for r in cur.execute(
                "SELECT id, title, assignee, status, priority, workspace_path, "
                "created_at, started_at, completed_at FROM tasks WHERE status != 'archived'"
            ).fetchall()
        ]
        links = [
            dict(r)
            for r in cur.execute(
                "SELECT parent_id, child_id FROM task_links"
            ).fetchall()
        ]
        runs = [
            dict(r)
            for r in cur.execute(
                "SELECT id, task_id, profile, status, worker_pid, "
                "last_heartbeat_at, started_at FROM task_runs"
            ).fetchall()
        ]
        events = [
            dict(r)
            for r in cur.execute(
                "SELECT id, task_id, kind, payload, created_at "
                "FROM task_events ORDER BY id DESC LIMIT 100"
            ).fetchall()
        ]
        con.close()
        events.reverse()  # 最近 100 条按时间正序返回
        return {"tasks": tasks, "links": links, "runs": runs, "events": events}
    except Exception:  # noqa: BLE001
        try:
            con.close()
        except Exception:  # noqa: BLE001
            pass
        return empty


def _kanban_summary(tasks):
    summary = {
        "total": len(tasks),
        "todo": 0,
        "ready": 0,
        "running": 0,
        "blocked": 0,
        "done": 0,
    }
    for t in tasks:
        s = t.get("status")
        if s in summary:
            summary[s] += 1
    return summary


def _kanban_by_team(tasks):
    """assignee -> {status: count}"""
    counts = {}
    for t in tasks:
        a = t.get("assignee")
        if not a:
            continue
        s = t.get("status") or "unknown"
        counts.setdefault(a, {}).setdefault(s, 0)
        counts[a][s] += 1
    return counts


def build_board():
    status = _fetch_upstream("/api/status")
    sessions_res = _fetch_upstream("/api/profiles/sessions")
    profiles_res = {}
    procs = scan_processes()
    try:
        profiles_res = _fetch_upstream("/api/profiles")
    except Exception:  # noqa: BLE001
        profiles_res = {}

    sessions = sessions_res.get("sessions") or []
    now = time.time()

    kanban = read_kanban()
    kanban_tasks = kanban.get("tasks") or []
    kanban_by_team = _kanban_by_team(kanban_tasks)

    # 只保留"活跃"或"近期活跃"的 session (避免历史 DONE 节点污染 Live Graph):
    # - is_active 的会话永远保留
    # - 非活跃会话仅保留最近 SESSION_WINDOW_SEC 内有活动的 (默认 6 小时)
    SESSION_WINDOW_SEC = 6 * 3600
    sessions = [
        s
        for s in sessions
        if s.get("is_active")
        or (s.get("last_activity_at") or 0) >= now - SESSION_WINDOW_SEC
    ]

    # 按 profile 分组
    teams_map = {}
    for s in sessions:
        teams_map.setdefault(_session_profile(s), []).append(s)

    # 补上无 session 的空 profile (空团队)
    for p in profiles_res.get("profiles") or []:
        name = p.get("name")
        if name:
            teams_map.setdefault(name, [])

    teams = []
    for name, sess_list in teams_map.items():
        # 团队内按 last_activity_at 降序 (编号 1 起)
        sess_list.sort(key=lambda x: x.get("last_activity_at") or 0, reverse=True)

        workers = []
        controller_sessions = [s for s in sess_list if _is_profile_controller(s)]
        # Live organization graph only contains active execution sessions. Completed
        # work is represented by Kanban Run history, not immortal DONE characters.
        worker_sessions = [
            s for s in sess_list
            if not _is_profile_controller(s) and s.get("is_active")
        ]
        controller = controller_sessions[0] if controller_sessions else None
        active = 0
        blocked = 0
        cost = 0.0
        tokens = {"input": 0, "output": 0, "cache_read": 0}
        for i, s in enumerate(worker_sessions):
            st = infer_status(s)
            if s.get("is_active"):
                active += 1
            if st == "blocked":
                blocked += 1
            cost += _cost_usd(s)
            t = _worker_tokens(s)
            tokens["input"] += t["input"]
            tokens["output"] += t["output"]
            tokens["cache_read"] += t["cache_read"]
            workers.append(
                {
                    "id": s.get("id"),
                    "num": i + 1,
                    "runtime": _runtime(s),
                    "model": s.get("model"),
                    "task": s.get("title") or "",
                    "action": s.get("last_activity_description") or "",
                    "status": st,
                    "elapsed_sec": _elapsed_sec(s, now),
                    "tokens": t,
                    "cost_usd": _cost_usd(s),
                    "source": s.get("source"),
                    "chat_id": s.get("chat_id"),
                    "thread_id": s.get("thread_id"),
                    "last_activity_at": s.get("last_activity_at"),
                    "parent_id": s.get("parent_session_id") or None,
                    "process_id": _match_process(s.get("cwd"), _runtime(s), procs),
                    "workspace": s.get("cwd") or None,
                }
            )

        # mission / elapsed prefer worker activity; controller remains a service endpoint.
        most_recent = worker_sessions[0] if worker_sessions else None
        mission = ""
        elapsed = 0
        if most_recent:
            mission = most_recent.get("title") or ""
            elapsed = _elapsed_sec(most_recent, now)

        teams.append(
            {
                "name": name,
                "display": _display_name(name),
                "worker_total": len(workers),
                "worker_active": active,
                "controller": {
                    "session_id": controller.get("id"),
                    "status": infer_status(controller),
                    "model": controller.get("model"),
                    "action": controller.get("last_activity_description") or "",
                    "is_active": bool(controller.get("is_active")),
                    "last_activity_at": controller.get("last_activity_at"),
                } if controller else None,
                "queued": 0,
                "blocked": blocked,
                "mission": mission,
                "elapsed_sec": elapsed,
                "cost_usd": round(cost, 4),
                "tokens": tokens,
                "workers": workers,
                "kanban_tasks": kanban_by_team.get(name, {}),
            }
        )

    # 活跃团队在前, 其余按名称
    teams.sort(key=lambda t: (-t["worker_active"], t["name"]))

    board = {
        "generated_at": int(now),
        "gateway": {
            "version": status.get("version"),
            "busy": bool(status.get("gateway_busy")),
            "active_agents": status.get("active_agents") or 0,
            "active_sessions": status.get("active_sessions") or 0,
        },
        "teams": teams,
        "processes": procs,
        "kanban_summary": _kanban_summary(kanban_tasks),
    }
    return board


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    server_version = "HermesDashboard/3.0"
    protocol_version = "HTTP/1.1"

    # ---------- 静态文件 (bridge-only 模式: 首页返回服务说明) ----------
    def _serve_static(self):
        path = urllib.parse.urlparse(self.path).path
        if path in ("", "/"):
            # 旧看板 UI 已废弃, 8787 现在只作为 hermes-office-bridge API 服务
            self._send_json(
                {
                    "service": "hermes-office-bridge",
                    "endpoints": ["/api/board", "/api/events", "/api/kanban", "/api/spawns"],
                    "consumed_by": "pixel-agents office (port 3100)",
                }
            )
            return
        rel = path.lstrip("/")
        abs_path = os.path.normpath(os.path.join(BASE_DIR, rel))
        if not abs_path.startswith(BASE_DIR) or not os.path.isfile(abs_path):
            self._send_json({"error": "not found"}, 404)
            return
        content_type = "text/html; charset=utf-8"
        if rel.endswith(".css"):
            content_type = "text/css; charset=utf-8"
        elif rel.endswith(".js"):
            content_type = "application/javascript; charset=utf-8"
        elif rel.endswith(".svg"):
            content_type = "image/svg+xml"
        elif rel.endswith(".json"):
            content_type = "application/json; charset=utf-8"
        try:
            with open(abs_path, "rb") as f:
                body = f.read()
        except OSError:
            self._send_json({"error": "not found"}, 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---------- /api/board 聚合端点 ----------
    def _serve_board(self):
        try:
            board = build_board()
            self._send_json(board)
        except Exception as e:  # noqa: BLE001
            self._send_json({"error": "board aggregation failed: %s" % e}, 502)

    # ---------- /api/kanban (只读 kanban.db) ----------
    def _serve_kanban(self):
        self._send_json(read_kanban())

    # ---------- /api/events (SSE 实时流) ----------
    def _serve_events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.wfile.flush()

        last_heartbeat = time.time()
        try:
            while True:
                now = time.time()
                if now - last_heartbeat >= 15:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_heartbeat = now

                try:
                    board = build_board()
                except Exception as e:  # noqa: BLE001
                    board = {"error": "board aggregation failed: %s" % e}

                data = json.dumps(board, ensure_ascii=False)
                frame = "event: board\ndata: %s\n\n" % data
                self.wfile.write(frame.encode("utf-8"))
                self.wfile.flush()
                time.sleep(2)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass

    # ---------- 反向代理 ----------
    def _serve_proxy(self):
        token = _token()
        if not token:
            self._send_json(
                {"error": "server not configured: HERMES_DASHBOARD_SESSION_TOKEN missing"},
                500,
            )
            return

        # 读取请求体(可能为空)
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else None

        target = UPSTREAM + self.path

        req = urllib.request.Request(target, data=body, method=self.command)
        for key, value in self.headers.items():
            if key.lower() in HOP_BY_HOP:
                continue
            req.add_header(key, value)
        req.add_header("Authorization", "Bearer " + token)

        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                status = resp.getcode()
                resp_body = resp.read()
                resp_headers = resp.headers
        except urllib.error.HTTPError as e:
            status = e.code
            resp_body = e.read()
            resp_headers = e.headers
        except urllib.error.URLError as e:
            self._send_json({"error": "upstream unreachable: %s" % e.reason}, 502)
            return
        except Exception as e:  # noqa: BLE001
            self._send_json({"error": "proxy error: %s" % e}, 502)
            return

        self.send_response(status)
        for key, value in resp_headers.items():
            if key.lower() in HOP_BY_HOP:
                continue
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(resp_body)))
        self.end_headers()
        self.wfile.write(resp_body)

    # ---------- 公共 ----------
    def _send_json(self, obj, status=200):
        body = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---------- /api/spawns (RUNTIME_SPAWN_REQUESTED 记录) ----------
    def _serve_spawns(self):
        try:
            with open(SPAWNS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:  # noqa: BLE001
            data = []
        self._send_json({"spawns": data})

    def _post_spawns(self):
        """记录一次 runtime spawn 请求 (Hermes 组长侧或被动检测写入)。"""
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except Exception:  # noqa: BLE001
            self._send_json({"error": "bad json"}, 400)
            return
        record = {
            "profileId": body.get("profileId") or "",
            "runId": body.get("runId") or "",
            "parentNodeId": body.get("parentNodeId") or "",
            "sessionId": body.get("sessionId") or "",
            "runtime": body.get("runtime") or "unknown",
            "cwd": body.get("cwd") or "",
            "command": body.get("command") or "",
            "createdAt": int(time.time()),
        }
        try:
            with open(SPAWNS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:  # noqa: BLE001
            data = []
        data.append(record)
        # 只保留最近 200 条
        data = data[-200:]
        try:
            with open(SPAWNS_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
        except OSError:
            self._send_json({"error": "cannot persist"}, 500)
            return
        self._send_json({"ok": True, "spawn": record})

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/board":
            self._serve_board()
        elif path == "/api/kanban":
            self._serve_kanban()
        elif path == "/api/events":
            self._serve_events()
        elif path == "/api/spawns":
            self._serve_spawns()
        elif self.path.startswith("/api/"):
            self._serve_proxy()
        else:
            self._serve_static()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/spawns":
            self._post_spawns()
        else:
            self._send_json({"error": "not found"}, 404)

    do_PUT = do_GET
    do_DELETE = do_GET
    do_PATCH = do_GET

    def log_message(self, fmt, *args):
        print("[hermes-dashboard] " + (fmt % args), flush=True)


def main():
    handler = ProxyHandler
    server = http.server.ThreadingHTTPServer((HOST, PORT), handler)
    print(
        "[hermes-dashboard] serving on http://%s:%d  ->  %s  (token: %s)"
        % (HOST, PORT, UPSTREAM, "set" if _token() else "MISSING"),
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
