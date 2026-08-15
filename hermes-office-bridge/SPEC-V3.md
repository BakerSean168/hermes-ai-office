# Hermes 工作台 V3 — Graph/Ops 视图 + 实时事件流 + kanban 接入 (实施规格)

> 在 V2(Team Pod)基础上增量开发。保留 V2 全部功能,新增三视图切换、SSE 实时、kanban 聚合、关系动画。

## 1. 数据层增强 (server.py)

### 1.1 新增 /api/kanban (只读 kanban.db)

读取 `/opt/data/kanban.db`(SQLite, 只读连接),返回:

```json
{
  "tasks": [
    {"id": 1, "title": "...", "assignee": "memoflow", "status": "todo|ready|running|blocked|done",
     "priority": 0, "workspace_path": "/workspace/repos/memoflow", "created_at": 1755..., "started_at": null, "completed_at": null}
  ],
  "links": [{"parent_id": 1, "child_id": 2}],
  "runs": [
    {"id": 1, "task_id": 1, "profile": "memoflow", "status": "running|done|failed",
     "worker_pid": 12345, "last_heartbeat_at": 1755..., "started_at": 1755...}
  ],
  "events": [
    {"id": 1, "task_id": 1, "kind": "created|claimed|progress|completed|blocked", "payload": "{}", "created_at": 1755...}
  ]
}
```

- 只读连接 (`mode=ro`), 绝不写 kanban.db
- 任务状态按 SQLite 里的 status 字段原样返回
- events 只取最近 100 条

### 1.2 新增 /api/events (SSE 实时流)

用 **Server-Sent Events** 实现实时推送(标准库可做, 浏览器 EventSource 原生支持):

- `GET /api/events` → `Content-Type: text/event-stream`
- 每 **2 秒** 推一次当前 board 快照 (事件名 `board`), 数据 = /api/board 的 JSON + kanban 摘要
- 前端 EventSource 连接; 断线时前端自动 fallback 5s 轮询 /api/board
- 用 ThreadingHTTPServer 支持并发 (SSE 长连接 + 普通请求共存)
- 心跳注释行 `: ping` 每 15s 发一次, 防代理断连

### 1.3 /api/board 保持兼容

V2 的 /api/board 结构不变 (前端 V2 代码仍可用)。新增可选字段:
- 每 team 加 `kanban_tasks`: 该 team 名下 (assignee=team) 的 kanban 任务数 (按状态分组)
- 顶层加 `kanban_summary`: {total, todo, ready, running, blocked, done}

## 2. 前端三视图 (index.html)

顶部加 Tab 切换: **🏢 Office | 🕸️ Graph | 📊 Ops** (默认 Office)

### 2.1 Office (默认) — 现有 Team Pod 不动

- 保留 V2 全部功能
- Pod 底部指标行追加 kanban 徽章: `📋 板: 2 待办 · 1 进行中` (若有)

### 2.2 Graph — 任务依赖 DAG

- 用 SVG 画布渲染有向图
- **节点**:
  - Team 节点 (圆角矩形, 🧑✈️ 图标): 每 profile 一个
  - Worker 节点 (圆形头像): 每个活跃 worker
  - Kanban 任务节点 (小卡片): 每任务一个, 颜色按状态 (todo=灰 ready=蓝 running=绿 blocked=红 done=暗)
- **边**:
  - Team → 其下 Worker (细线)
  - kanban task_links 的 parent→child (带箭头)
  - Worker 之间: 目前无真实数据, 不画; 但预留 (有 parent_session_id 时画)
- 布局: 简单分层 (Team 在左/上, 任务按依赖排序), 用 force 或分层定位; 不做复杂引擎, 手写布局即可
- 节点 hover 显示 tooltip (任务详情/worker 详情)
- 动画: 活跃节点呼吸光晕

### 2.3 Ops — 高密度表格

- 表格列: `# | 团队 | Worker | 任务 | Runtime | Model | 状态 | 动作 | 已运行 | Tokens(in/out/cache) | Cost | Workspace`
- 状态彩色 chip
- 按 团队 → 状态 排序
- 行 hover 高亮; 支持按状态筛选 (顶部小 filter: 全部/活跃/空闲/blocked)
- kanban 任务也作为行 (类型标记 📋), 显示 assignee/status/workspace

## 3. 实时 + 关系动画 (Office 视图增强)

### 3.1 EventSource 接入

```js
const es = new EventSource('/api/events');
es.addEventListener('board', e => {
  const next = JSON.parse(e.data);
  diffAndUpdate(next);   // 见下
});
es.onerror = () => { es.close(); startPolling(); };  // fallback 轮询
```

### 3.2 diff 驱动的状态变化动画

前端维护上一帧 board, diff 出变化:

| 变化 | 动画 (300~500ms) |
|---|---|
| worker 出现 (新 active) | 从 Pod 头部飞入该 worker 卡片 + 短暂高亮 |
| worker 从 active→idle | 卡片淡出到待命区 + "完成 ✓" 标记闪现 |
| status 变化 (如 coding→reviewing) | 卡片边框流光一圈 |
| kanban 新事件 | Pod 底部徽章闪一下 |

- 动画用 CSS transition + 一次性 class, 不引入 JS 动画库
- 空闲 worker 依然静止 (V2 规则不变)

## 4. 文件

- `server.py` — 新增 /api/kanban (只读 sqlite3) + /api/events (SSE); 改用 ThreadingHTTPServer
- `index.html` — 三视图 Tab + Graph SVG + Ops 表格 + EventSource + diff 动画
- `README.md` — 补充 /api/kanban、/api/events 说明
- `start.sh` — 不变

## 5. 验收标准

1. `curl http://127.0.0.1:8787/api/kanban` 返回结构正确 (kanban.db 只读)
2. `curl -N http://127.0.0.1:8787/api/events` 2 秒内收到 `event: board` 帧 (curl -N 流式)
3. 浏览器三视图可切换: Office 原有 Pod 正常, Graph 显示节点+边, Ops 显示表格
4. 活跃 worker 状态变化时出现对应动画 (diff 驱动)
5. 服务仍监听 127.0.0.1:8787, Tailscale 访问正常
6. 页面无 token, 代理逻辑不变

## 6. 注意事项

- sqlite3 只读连接: `sqlite3.connect('file:/opt/data/kanban.db?mode=ro', uri=True)`
- SSE 响应头: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `Access-Control-Allow-Origin: *`
- ThreadingHTTPServer: 继承 http.server.ThreadingHTTPServer, 处理 SSE 长连接不阻塞其他请求
- 前端 EventSource 只连同源 /api/events, 无 CORS 问题
- 若 kanban.db 被锁 (WAL), 用 `timeout=1` 容错, 读不到就返回空结构不报错
