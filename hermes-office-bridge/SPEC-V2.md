# Hermes 工作台 V2 — 数据模型重构 + Team Pod (实施规格)

> 在现有看板基础上重构,不推倒重来。保留 server.py 代理逻辑与 token 安全模型,
> 重写数据聚合层与前端 UI。

## 架构原则 (必须遵守)

```
Profile = 团队/小组 (Team Pod, 第一视觉层级)
Run     = 一次项目行动 (本版用 session 承载)
Task    = 工作包 (session.title)
Worker  = 员工 (本版 = 一个 session; 稳定身份 = 团队内编号)
Agent Runtime = 员工使用的工具 (Codex / OpenCode / Hermes / Claude…)
LLM Model     = 员工当前大脑 (可切换, 不是身份)
```

## 数据层 (server.py 重构)

### 上游 (保持不变)
- `GET /api/status` → 网关总览
- `GET /api/profiles/sessions` → sessions 数组

### 聚合逻辑 (server.py 新增 /api/board 端点)

后端聚合为一个统一结构,前端只消费这一个端点:

```json
{
  "generated_at": 1755000000,
  "gateway": {"version": "0.20.0", "busy": true, "active_agents": 2, "active_sessions": 2},
  "teams": [
    {
      "name": "memoflow",
      "display": "MemoFlow",
      "worker_total": 3,
      "worker_active": 2,
      "queued": 0,
      "blocked": 0,
      "mission": "Sync Engine v2",          // 最近活跃 session 的 title
      "elapsed_sec": 1104,                  // 最近活跃 session 运行时长
      "cost_usd": 1.38,                     // 各 session cost 求和
      "tokens": {"input": 0, "output": 0, "cache_read": 0},
      "workers": [
        {
          "id": "20260812_064027_c0e07db4",
          "num": 1,                          // 团队内编号 (按 last_activity 排序, 1 起)
          "runtime": "hermes",               // 推断: billing_provider=opencode-go → "opencode"; 否则 "hermes"
          "model": "deepseek-v4-flash",
          "task": "DeepSeek V4 Pro 版本状态核查",  // session.title
          "action": "receiving stream response",   // last_activity_description
          "status": "llm_running",           // 状态机推断 (见下)
          "elapsed_sec": 1800,
          "tokens": {"input": 161102, "output": 57679, "cache_read": 10449280, "reasoning": 32379},
          "cost_usd": 0.0,
          "source": "telegram",
          "chat_id": "-1004334123414",
          "thread_id": "3",
          "last_activity_at": 1786767299.1
        }
      ]
    }
  ]
}
```

### 状态机推断 (server.py, 函数 infer_status(session))

按 `is_active` + `last_activity_description` 文本映射:

| 推断状态 | 规则 |
|---|---|
| `idle` | `is_active=false` |
| `llm_running` | 描述含 "receiving stream response" / "api call" / "starting api call" |
| `planning` | 含 "plan" / "thinking" / "reasoning" / "reading" |
| `coding` | 含 "terminal" / "edit" / "write_file" / "patch" / "command" |
| `browsing` | 含 "browser" / "web" / "fetch" / "search" |
| `reviewing` | 含 "review" / "inspect" / "read_file" |
| `waiting_io` | 含 "wait" / "sleep" / "poll" |
| `blocked` | 含 "error" / "failed" / "blocked" / "approval" |
| 兜底 | `working` |

### 进程扫描增强 (可选, 尽力而为)

server.py 尝试 `ps aux` 找 codex/opencode/agy/claude 进程,作为 "runtime 进程" 补充信息。
找不到就跳过,不影响主流程。

## 前端 UI (index.html 重写)

### 布局: Team Pod 为第一视觉层级

```
顶部状态栏 (保留, 加宽): 🤖 Hermes 工作台 | 网关状态 | 活跃 Agent | 活跃会话 | 刷新指示

┌─────────────────────────────────────────────┐
│ 🧑✈️ MemoFlow                  2 / 3 Active  │   ← Pod 头部
│ 正在执行: Sync Engine v2                    │
│ ████████████░░░░  72%          18m 24s      │   ← 进度条 (active 占比, 非真实进度也可)
│                                             │
│  👨💻 #01            👨💻 #02       👨💻 #03 │   ← Worker 卡片并排
│  Codex              OpenCode     Hermes     │
│  GPT-5.6            DS-V4-Flash  DS-V4      │
│  Code Review        API Adapter  Tests      │
│  🔍 reviewing       🔨 coding    🧪 testing │
│                                             │
│  Queue 0  Blocked 0  Cost $1.38  Tokens 10M│   ← Pod 底部指标
└─────────────────────────────────────────────┘
```

- 每个 **profile = 一个 Team Pod**(大卡片, 圆角大、糖果色边框)
- Pod 头部: 🧑✈️ + 团队名 + `Active X/Y` 徽章(活跃数/总数)
- Pod 中部: "正在执行: <mission>" + 进度条(active workers 占比做进度) + 已运行时长
- Pod 内 Worker 行: 每 worker 一张小卡, 依次为:
  - 编号徽章 `#01` + 卡通头像 (SVG)
  - 第二行: runtime 图标 + 名称 (Codex/OpenCode/Hermes)
  - 第三行: model 标签 (彩色小 chip)
  - 第四行: task (会话标题, 截断 30 字)
  - 动作气泡: status 对应的 emoji + 文本
- Pod 底部: `Queue N · Blocked N · Cost $X · Tokens Y`(tokens 格式化: 104.5M cache / 161K in)
- 空闲 worker: 头像静止 + 咖啡杯 ☕ + "待命"
- 空团队(无 workers): Pod 显示 "暂无员工" 灰态

### 状态机动画 (只有 active worker 动)

| status | 卡通表现 |
|---|---|
| idle | 静止 + 咖啡杯 |
| planning | 头上 💭 思考气泡动画 |
| llm_running | 头部 CPU/脑波动画 (旋转光环) |
| coding | 敲键盘动画 (手部小幅度上下) |
| browsing | 拿放大镜 🔍 摆动 |
| testing | 🧪 试管冒泡 |
| reviewing | 看文档 📄 翻页 |
| waiting_io | ⏳ 沙漏 |
| blocked | 🚨 红色闪烁边框 |
| working (兜底) | ⚙️ 齿轮旋转 |

### 全局行为

- 保留 5s 自动刷新 (V3 再升级 WebSocket, 本版不动)
- 刷新时 Pod/Worker 卡片不整体闪烁 (只更新数据, 用 CSS transition)
- 响应式: 窄屏时 Pod 单列, 宽屏多 Pod 网格
- 禁止外部 CDN, 全部内联
- token 仍在 server.py 环境变量, 页面无 token

## 文件

- `server.py` — 重写: 保留静态服务 + /api/* 代理 (原样), 新增 /api/board 聚合端点
- `index.html` — 重写: Team Pod 布局 + 状态机动画
- `start.sh` / `README.md` — 不变 (README 补充 /api/board 说明)

## 验收标准

1. `bash start.sh` 后 `curl http://127.0.0.1:8787/api/board` 返回上述结构 (teams 数组非空)
2. 浏览器 http://127.0.0.1:8787/ 显示 Team Pod 布局: 每个 profile 一个 Pod, Pod 内有 Worker 卡片
3. 活跃 session 的 worker 有对应状态动画, 空闲 worker 静止
4. Pod 头部显示 Active X/Y、mission、elapsed、cost
5. Tailscale 地址 https://oracle.taile92a8e.ts.net:8787/ 同样可访问
