# Pixel Agents — Spawn Correlation + PID 标签 (SPEC-SPAWN)

## 背景

bridge (8787) 新增 `/api/spawns` (GET 列表 / POST 记录 RUNTIME_SPAWN_REQUESTED)。
Hermes 组长侧或外部工具可 POST spawn 记录: {profileId, runId, parentNodeId, sessionId, runtime, cwd, command, createdAt}。
本任务: HermesProvider 消费 spawns → 建立真实父子链 (Root → Supervisor → Executor); 并把 PID 显示到 Org 视图节点标签与 Canvas 人物标签。

## 1. bridgeClient 增强 (server/src/providers/hermes/bridgeClient.ts)

- 新增 `fetchSpawns()`: GET `{baseUrl}/api/spawns` → HermesSpawn[]
- spawn 轮询并入现有 kanban 轮询周期 (30s), 每次取后回调 `onSpawns(spawns)`
- 类型:
```ts
export interface HermesSpawn {
  profileId: string;
  runId?: string;
  parentNodeId?: string;
  sessionId?: string;
  runtime: string;
  cwd?: string;
  command?: string;
  createdAt: number;
}
```

## 2. Spawn correlation (server/src/providers/hermes/hermesProvider.ts)

### 2a. worker → spawn 匹配 (父链)

对每个 worker (session), 在其 profile 内找最近的 spawn 记录:
- 匹配条件 (短窗口, 宽松):
  1. spawn.profileId === worker.profileId
  2. spawn.runtime 与 worker.runtime 一致 (opencode/codex/hermes)
  3. spawn.createdAt 在 worker 的 last_activity_at 前后 5 分钟内 (先到先得, 一个 spawn 只匹配一个 worker)
- 匹配成功: 该 worker 的 ExecutionNode:
  - `parentId` = spawn.parentNodeId 非空 ? spawn.parentNodeId : (worker.parent_id 或 rootId)
  - `metadata.spawnId` = spawn 记录 (含 command/cwd)
- spawn.parentNodeId 语义: Hermes 组长派发时可指定父节点 (如 `memoflow:root` 或某个 supervisor 节点 id); 未指定时默认挂 root

### 2b. supervisor 判定

若某 worker 的 action/任务文本含 "派发"/"dispatch"/"delegate"/"supervis" 或 spawn.parentNodeId 指向它,
其 node.role 设为 SUPERVISOR, 且它 spawn 出的 executors 的 parentId 指向它 (多级树)。

### 2c. Edge 关系

- spawn 匹配的 worker: root/parent → worker edge relation = `SPAWNED`
- 若 spawn 记录带 parentNodeId: 显示 `SUPERVISES` 边 (parent 是 supervisor 时) 或 `DELEGATED`
- OrgStore.connect 已支持任意 parentId, 复用即可

## 3. PID 显示 (OrgView + Canvas tooltip)

### 3a. OrgView (webview-ui/src/components/OrgView.tsx)

- 节点行尾追加: 若 node.processId 非空 → `[PID {processId}]` 灰色小字
- 若 node.metadata.spawnId → 追加 `⚡ {command 前 20 字}` 提示

### 3b. Canvas 人物标签 (ToolOverlay / agentName)

- HermesProvider 创建 agent 时, 若 worker.process_id 匹配 → 在 agentName 或 tooltip 里带 `(PID {id})`
- 优先放 tooltip/overlay (头顶标签保持 `Default #01` 简洁, 避免过长)

## 4. 验收标准

1. `curl -X POST :8787/api/spawns -d '{"profileId":"memoflow","runtime":"opencode","cwd":"/workspace/repos/memoflow","command":"opencode run"}'` 后, Org 视图对应 opencode worker 显示 spawn 关联 (⚡ 标记)
2. 匹配到进程的 worker 显示 `[PID xxxx]`
3. 父子链: spawn.parentNodeId 指定时, 节点挂在对应 parent 下 (多级树渲染)
4. 无 spawn 数据时一切照旧 (不报错, 平铺)
5. `npm run test:server` 通过 (新增 spawn 匹配测试)
6. 构建通过, 3100 正常运行, Canvas/Org 不破坏

## 5. 参考

- server/src/providers/hermes/bridgeClient.ts
- server/src/providers/hermes/hermesProvider.ts
- server/src/orgStore.ts
- webview-ui/src/components/OrgView.tsx
