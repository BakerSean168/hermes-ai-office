# Hermes 工作台看板

卡通动画风格的 Hermes 多 profile 实时状态看板(纯 Python 标准库后端 + 纯前端页面)。

## 启动

```bash
bash start.sh
```

然后浏览器打开 http://127.0.0.1:8787。页面提供三视图切换:**🏢 Office**(Team Pod)、
**🕸️ Graph**(SVG 任务依赖 DAG)、**📊 Ops**(高密度表格)。默认通过 SSE 实时流
(`/api/events`) 自动刷新,断线时自动回退到 5 秒轮询 `/api/board`。

## API

- `GET /api/board` — 聚合端点: 拉取上游 status + sessions, 按 profile 聚合成 `teams`(Team Pod),
  每个 worker 带状态机推断出的 `status`(`idle` / `planning` / `llm_running` / `coding` /
  `browsing` / `reviewing` / `waiting_io` / `blocked` / `working`), 并附带 runtime / model /
  task / action / tokens / cost 等字段。每个 team 附带 `kanban_tasks`(按状态分组计数),
  顶层附带 `kanban_summary`(`{total, todo, ready, running, blocked, done}`)。
- `GET /api/kanban` — 只读读取 `/opt/data/kanban.db`(SQLite `mode=ro`), 返回
  `{tasks, links, runs, events}`,其中 `events` 只取最近 100 条。kanban.db 缺失/被锁时
  返回空结构而不报错。
- `GET /api/events` — Server-Sent Events 实时流: `Content-Type: text/event-stream`,
  每 2 秒推送一次 `event: board` 帧(数据 = `/api/board` JSON + kanban 摘要),
  每 15 秒发一条 `: ping` 心跳注释。用 `ThreadingHTTPServer` 承载,不阻塞普通请求。
- `/api/*` — 其余路径反向代理到 http://127.0.0.1:9119 (附加 Bearer token)。

## Tailscale 访问

看板已通过 Tailscale Serve 暴露(tailnet only):

- https://oracle.taile92a8e.ts.net:8787/ (页面)
- 代理链路:ts.net:8787 → 127.0.0.1:8787 → dashboard API (9119)

注意:看板进程 (server.py) 需保持运行;机器重启后需重新 `bash start.sh`。
Serve 规则本身由 tailscaled 持久保存。
