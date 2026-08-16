# Hermes Organization Layer — pixel-agents 改造 (实施规格)

> **Historical implementation spec:** This document records the first Hermes Organization Layer implementation. For new business semantics and future migrations, [`docs/DOMAIN-MODEL-V2.md`](docs/DOMAIN-MODEL-V2.md) is authoritative. In particular, Profile/ExecutionNode/Worker terminology here must not override the V2 WorkScope/Position/DutySession/Employee model.

## 背景

- 母体: pixel-agents(standalone 模式, 已在 127.0.0.1:3100 跑通)
- Bridge: hermes-office-bridge = 现有 http://127.0.0.1:8787(server.py)
  - `GET /api/board` → 7 个 profile 的聚合(teams[].workers[]: profile/model/runtime/task/action/status/tokens/cost)
  - `GET /api/events` → SSE, 每 2s 推一次 board 快照(`event: board`)
- 本任务: 在 pixel-agents 内实现 Organization Layer + HermesProvider + Graph View

## 架构

```
Hermes dashboard (9119)
   └─ hermes-office-bridge (8787, 已有)  /api/board + /api/events SSE
        └─ pixel-agents HermesProvider (新增, 订阅 SSE)
             └─ AgentEvent → AgentRuntime → officeState (现成渲染管线)
```

不重写 pixel-agents 的 canvas/character/animation/pathfinding。
Provider 集成遵循 pixel-agents 的 CLAUDE.md 分层规则: core/ 零依赖, server/ 依赖 core, webview-ui/ 依赖 core。

## 1. HermesProvider (server/src/providers/hermes/)

实现 `HookProvider` 接口的**非 hook 变体**: 不安装 shell hooks, 而是 SSE 订阅 bridge。

新增文件:

- `server/src/providers/hermes/hermesProvider.ts` — 主 provider
- `server/src/providers/hermes/bridgeClient.ts` — SSE 客户端(订阅 8787 /api/events, 断线重连 + 轮询 fallback)
- `server/src/providers/hermes/orgModel.ts` — Organization 领域模型(见下)

### bridgeClient.ts

```ts
// 订阅 http://127.0.0.1:8787/api/events (SSE)
// - 收到 event: board → parse JSON → 回调 onBoard(board)
// - 断线 → 每 5s 轮询 /api/board, 恢复后重新订阅 SSE
// - 可配置 baseUrl (env HERMES_BRIDGE_URL, 默认 http://127.0.0.1:8787)
// - 用全局 fetch + ReadableStream 解析 SSE (Node 20+, 无需第三方依赖)
```

### board → AgentEvent 映射

bridge 的 board 结构:

```json
{
  "gateway": { "version": "0.20.0", "busy": true, "active_agents": 2, "active_sessions": 2 },
  "teams": [
    {
      "name": "memoflow",
      "display": "MemoFlow",
      "worker_total": 3,
      "worker_active": 2,
      "mission": "Sync Engine v2",
      "elapsed_sec": 1104,
      "cost_usd": 1.38,
      "workers": [
        {
          "id": "20260812_064027_c0e07db4",
          "num": 1,
          "runtime": "opencode",
          "model": "deepseek-v4-flash",
          "task": "DeepSeek V4 Pro 版本状态核查",
          "action": "receiving stream response",
          "status": "llm_running", // idle|llm_running|planning|coding|browsing|testing|reviewing|waiting_io|blocked|working
          "elapsed_sec": 1800,
          "tokens": {
            "input": 161102,
            "output": 57679,
            "cache_read": 10449280,
            "reasoning": 32379
          },
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

映射规则 (bridge diff → AgentEvent, 在 server 端维护上一帧做 diff):

| bridge 变化             | AgentEvent                                                                      |
| ----------------------- | ------------------------------------------------------------------------------- |
| 新 team 出现            | 该 team 每个 worker 发 `sessionStart` (sessionId=`hermes:<profile>:<workerId>`) |
| 新 worker 出现 (active) | `sessionStart` + `toolStart`(toolName=按 status 映射)                           |
| worker status 变化      | `toolEnd`(旧) + `toolStart`(新, toolName=映射)                                  |
| worker action 含工具名  | `toolStart` toolName=提取的工具名                                               |
| worker 消失 / 变 idle   | `toolEnd` + `turnEnd`                                                           |
| team 全部 idle          | `sessionEnd` 仅当 worker 从列表移除                                             |

status → toolName 映射 (驱动动画):

- planning → `plan` (reading 动画)
- llm_running → `think` (special: 大脑动画)
- coding → `write` (typing 动画)
- browsing → `web_search` (browsing 动画)
- testing → `test` (testing 动画)
- reviewing → `read` (reading 动画)
- waiting_io → `wait` (特殊: 等待动画)
- blocked → `permission` (red ! 动画)
- idle → 无 tool (休息)
- working → `write` 兜底

sessionId 约定: `hermes:<profile>:<workerId>` — 保证 OpenCode/Codex/Hermes 各自独立 character。
每个 worker 是独立 character (即使 runtime 相同: 两个 OpenCode = 两个 character)。

### contextWindowForModel / 其他 HookProvider 方法

- `contextWindowForModel(model)`: 查表 (deepseek-v4-flash: 1048576, deepseek-v4-pro: 1048576, gpt-5.6-sol: 400000, 默认 128000)
- `formatToolStatus(toolName, input)`: 返回可读文本 (如 "writing file" / "running tests")
- `permissionExemptTools`: 空集
- `subagentToolNames`: 空 (Hermes subagent 由 bridge 的 worker 层级表达)
- `readingTools`: {plan, read, web_search, review}
- `installHooks/uninstallHooks/areHooksInstalled`: 返回 no-op / false (非 hook provider)

### Provider 注册

在 `server/src/providers/index.ts` 注册: `hermes: HermesProvider`。
启动时由 cli.ts/server.ts 组装: 若 env `HERMES_BRIDGE_URL` 或 `HERMES_BRIDGE_ENABLED=1` 则启动 HermesProvider 并开始订阅。
(默认关闭, 不干扰现有 Claude 模式。)

## 2. Organization 领域模型 (orgModel.ts)

纯 TS 类型 + 纯函数, 不依赖 pixel-agents 内部:

```ts
export type ProfileAvailability = 'ONLINE' | 'DEGRADED' | 'OFFLINE';
export type ProfileWorkload = 'READY' | 'PLANNING' | 'SUPERVISING' | 'EXECUTING' | 'BLOCKED';
export type NodeType = 'HERMES_SUBAGENT' | 'OPENCODE' | 'CODEX' | 'TERMINAL' | 'BROWSER' | 'OTHER';
export type NodeRole =
  'SUPERVISOR' | 'ORCHESTRATOR' | 'EXECUTOR' | 'REVIEWER' | 'RESEARCHER' | 'TESTER' | 'INTEGRATOR';
export type NodeState =
  | 'STARTING'
  | 'THINKING'
  | 'CODING'
  | 'TERMINAL'
  | 'BROWSING'
  | 'TESTING'
  | 'REVIEWING'
  | 'WAITING_IO'
  | 'NEEDS_INPUT'
  | 'BLOCKED'
  | 'DONE'
  | 'FAILED';
export type EdgeRelation = 'SPAWNED' | 'DELEGATED' | 'SUPERVISES' | 'REVIEWS' | 'DEPENDS_ON';

export interface ProfileController {
  profileId: string;
  availability: ProfileAvailability;
  workload: ProfileWorkload;
  sessionId?: string;
  lastSeenAt: number;
  lastResponseAt?: number;
}

export interface Run {
  id: string;
  profileId: string;
  title: string;
  status: 'PLANNING' | 'RUNNING' | 'BLOCKED' | 'FINALIZING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  rootNodeIds: string[];
}

export interface ExecutionNode {
  id: string;
  profileId: string;
  runId: string;
  parentId?: string;
  type: NodeType;
  role: NodeRole;
  runtime?: string;
  model?: string;
  taskId?: string;
  taskTitle?: string;
  state: NodeState;
  sessionId?: string;
  processId?: number;
  cwd?: string;
  workspace?: string;
  worktree?: string;
  branch?: string;
  currentTool?: string;
  currentAction?: string;
  tokensIn?: number;
  tokensOut?: number;
  cachedTokens?: number;
  cost?: number;
  startedAt: number;
  updatedAt: number;
  lastHeartbeatAt?: number;
  metadata?: Record<string, unknown>;
}

export interface ExecutionEdge {
  id: string;
  runId: string;
  fromNodeId: string;
  toNodeId: string;
  relation: EdgeRelation;
}
```

### 纯函数 (orgModel.ts)

- `inferNodeType(runtime: string): NodeType` — 'opencode'→OPENCODE, 'codex'→CODEX, 'hermes'→HERMES_SUBAGENT, 其他→OTHER
- `inferNodeRole(status: string, action: string): NodeRole` — 含 review/审查→REVIEWER, 含 test→TESTER, 含 plan→ORCHESTRATOR, 默认 EXECUTOR
- `inferNodeState(status: string): NodeState` — 见 bridge status 映射表
- `aggregateProfile(workers: WorkerLike[]): {availability, workload}` —
  - availability: 有 active worker → ONLINE; 否则 ONLINE (第一版: 除非明确 offline 标记)
  - workload: 任一 worker blocked → BLOCKED; 任一 worker active → EXECUTING; 全 idle → READY
  - **关键**: WAITING_IO/BLOCKED 仍算 active → workload 不能因此变 READY
- `isActiveState(state: NodeState): boolean` — STARTING..NEEDS_INPUT,BLOCKED 全 true; 仅 DONE/FAILED false

## 3. Organization Store (server/src/orgStore.ts)

内存图存储 (第一版不落库):

```ts
class OrgStore {
  profiles: Map<string, ProfileController>;
  runs: Map<string, Run>;
  nodes: Map<string, ExecutionNode>;
  edges: Map<string, ExecutionEdge>;
  // 由 bridge board 更新: upsertProfile(profile), upsertNode(node), connect(parentId, childId, relation)
  // 生成: getGraph(runId): {nodes, edges}
  // 每个 worker 是 profile 下的 node (parentId = profile 的 root node)
}
```

profile 的 root node: 每个 profile 有一个隐式 root ExecutionNode (type=HERMES_SUBAGENT, role=SUPERVISOR, id=`<profile>:root`), 表示 ProfileController 本身; workers 挂在 root 下 (edge: SPAWNED)。

## 4. Graph View (webview-ui)

在现有 UI 增加 Organization 视图 (不替换 Canvas):

- 顶部工具栏加按钮 `🌐 Org` (toggle, 与 Canvas 并列)
- Org 视图: 显示 OrgStore 的图 (通过现有 WS 消息通道加新消息类型 `orgState`)
- 渲染: 每个 profile 一个区块, 显示:
  - Profile 名 + availability/workload 徽章 (ONLINE·EXECUTING 等)
  - Root node (🧑✈️ + profile 名)
  - 其下 workers (按 node 层级缩进或连线): `#01 OpenCode/DeepSeek-V4 · 状态 · 任务`
  - edge 标签 (SPAWNED/SUPERVISES/REVIEWS)
- 用纯 DOM/CSS 渲染 (不需要 canvas 引擎), 树形结构 + 简单连线
- 颜色: status → chip 颜色 (BLOCKED 红, DONE 灰, 其他按状态)

## 5. 消息通道

- server → webview: 复用现有 WS; 新增 server 消息类型 `orgState` (payload: OrgStore 快照 {profiles, runs, nodes, edges})
- HermesProvider 每次 board diff 后: 更新 OrgStore → 广播 `orgState`
- webview 收到 `orgState` → 更新 Org 视图 DOM

## 6. 配置

- env: `HERMES_BRIDGE_URL` (默认 http://127.0.0.1:8787), `HERMES_BRIDGE_ENABLED` (默认 0)
- 启动: cli.ts 里若 enabled, 构造 HermesProvider + bridgeClient, start()

## 7. 测试

- orgModel 纯函数单测 (vitest): inferNodeType/State/Role, aggregateProfile (WAITING_IO 保持 EXECUTING 用例), isActiveState
- bridge diff → AgentEvent 映射单测 (提供 fixture board 快照)
- 手动验收: 启动 pixel-agents (HERMES_BRIDGE_ENABLED=1), 浏览器 Org 视图显示 7 个 profile + 活跃 workers, 状态随 board 更新

## 8. 验收标准

1. `HERMES_BRIDGE_ENABLED=1 node dist/cli.js --port 3100` 启动无报错
2. server 日志显示 HermesProvider 订阅 SSE 成功, 收到 board 帧
3. 浏览器 :3100 → Org 视图显示 7 个 profile 区块, 每个有 availability/workload 徽章 + root + workers
4. default profile 的 2 个活跃 worker 显示正确状态 (llm_running/coding 映射为 THINKING/CODING)
5. 等 10 秒, Org 视图随 SSE 帧更新 (无需刷新)
6. Canvas 视图原有功能不破坏
7. `npm run test:server` 新增用例通过

## 9. 参考文件

- core/src/provider.ts (HookProvider/AgentEvent 接口)
- server/src/providers/index.ts (provider 注册)
- server/src/agentRuntime.ts (事件处理)
- server/src/httpServer.ts (WS 广播)
- webview-ui/src/transport/types.ts + hooks/useExtensionMessages.ts (消息协议)
