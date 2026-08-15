# Pixel Agents — Parent-Runtime Correlation + 多级树 (SPEC-CORR)

## 背景

HermesProvider + Org 视图已工作(平铺: profile root → workers)。
Bridge 现已为 worker 增加 `parent_id`(session 父链, 当前多为 null)、`process_id`(进程匹配)、`workspace`(cwd),
顶层 `processes` 带 pid/cwd/command。
本任务: 把 correlation 数据接入 ExecutionNode, 支持**多级树渲染**, 并接入 kanban 任务节点。

## 1. HermesProvider node 构建增强 (server/src/providers/hermes/hermesProvider.ts)

worker → ExecutionNode 映射新增字段:
- `parentId`: 优先用 `worker.parent_id`(session 父链); 否则 rootId (现有行为)
- `processId`: `worker.process_id` (Number 或 undefined)
- `workspace`: `worker.workspace` (cwd)
- `taskId`: 若 worker 关联 kanban 任务则填 kanban task id

### 进程匹配 (HermesProvider 内, 在 bridgeClient 之上)

bridge board 顶层 `processes` 数组 (pid/cwd/command):
- 若 worker.process_id 为空, 尝试用 worker.workspace + runtime 匹配 processes (与 bridge 的 _match_process 同逻辑)
- 匹配成功 → node.processId
- 匹配不到 → undefined (不报错)

## 2. 多级树支持 (OrgStore + OrgView)

### OrgStore (server/src/orgStore.ts)

- `connect(parentId, childId, relation)` 已支持任意 parentId (不限于 root)
- 新增 `getTree(profileId)`: 返回以 root 为根的嵌套树 {node, children[]}
- root 的 children 中, parentId === rootId 的直接挂 root; parentId 指向其他 node 的挂到对应 node 下

### OrgView (webview-ui/src/components/OrgView.tsx)

- 从平铺渲染改为**递归渲染**: 每个 node 渲染后递归渲染其 children (缩进/连线)
- 树节点显示: `#num runtime/model · state · task` + edge 标签 (SPAWNED/SUPERVISES/REVIEWS/DEPENDS_ON)
- 无 children 的 node 正常显示; 多级时层级缩进清晰
- 保留现有 profile 区块 + availability/workload 徽章

## 3. kanban 任务节点接入

bridge `/api/kanban` (tasks/links/runs) — HermesProvider 需订阅它 (可在 board SSE 之外, 每 30s 轮询一次):

- 每个 kanban task → 一个 ExecutionNode:
  - type: `OTHER`, role: `EXECUTOR`, state: 按 status 映射 (todo→STARTING, ready→WAITING_IO, running→CODING, blocked→BLOCKED, done→DONE)
  - parentId: 对应 profile 的 rootId (按 task.assignee 匹配 profile)
  - taskId: kanban task id, taskTitle: task.title
  - metadata: {kanban: true, priority, workspace_path}
- task_links (parent_id/child_id) → ExecutionEdge: relation `DEPENDS_ON`
- kanban runs (task_id/profile/worker_pid) → 若 worker_pid 匹配到进程, 填充 node.processId
- 变更后广播 orgState (与 board 帧同通道)

### bridgeClient 增强

- `GET /api/kanban` 轮询 (30s), 解析为 HermesKanban 类型 {tasks, links, runs}
- 与 board 帧分开处理, 但共享 OrgStore 更新路径

## 4. 数据流

```
bridge /api/events (2s)  ──► HermesProvider ──► OrgStore (nodes+edges)
bridge /api/kanban (30s) ──► HermesProvider ──► OrgStore (kanban nodes)
                              │
                              ▼
                     orgState 广播 (每帧/每次 kanban 更新)
                              ▼
                        OrgView 递归渲染
```

## 5. 验收标准

1. Org 视图: 每个 profile 区块显示 root + workers; 若 worker.parent_id 非空, 渲染为嵌套 (多级树)
2. kanban 任务出现在 Org 视图: 挂对应 profile, 显示 📋 + 标题 + 状态; task_links 显示 DEPENDS_ON 边
3. 有匹配进程的 worker 显示 PID (node 详情/标签)
4. 无 kanban 数据/无进程时不报错, 视图正常
5. `npm run test:server` 通过; 新增: getTree 嵌套测试、kanban node 映射测试、进程匹配测试
6. 构建通过, 3100 端口正常运行, Canvas 不破坏

## 6. 参考

- server/src/providers/hermes/hermesProvider.ts (HermesProvider)
- server/src/providers/hermes/bridgeClient.ts (bridge 客户端)
- server/src/orgStore.ts (OrgStore)
- webview-ui/src/components/OrgView.tsx (Org 视图)
