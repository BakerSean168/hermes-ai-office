# Pixel Agents — P0 数据正确性修复 (SPEC-P0)

## 背景

用户评审指出 P0 问题(80% 工作量应在此):
1. **DONE 节点污染 Live Graph** — 历史 idle/DONE worker 永久挂着 (Default 18 节点, 大量 DONE)
2. **Profile aggregation 不准确** — MemoFlow READY 但 kanban 任务 STARTING; DONE 状态被算作 active
3. **假 Supervisor** — 每个 profile 一个人工 `<profile>:root` SUPERVISOR 节点 (Root Controller ≠ Supervisor)
4. **Run 层缺失** — UI 是 Profile → 平铺 nodes, 没有 Run 中间层
5. **[SPAWNED] 标签信息价值低** — 应显示 Task/Runtime/Model/State/Elapsed

Bridge 已修复: /api/board 只返回活跃 + 6 小时内 session (历史 DONE 已过滤)。本任务修 pixel-agents 侧。

## 1. aggregateProfile 修复 (server/src/providers/hermes/orgModel.ts)

```ts
export function aggregateProfile(
  workers: WorkerLike[],
  opts?: { kanbanActive?: number },  // 新增: 该 profile 的活跃 kanban 任务数
): { availability, workload }
```

- **DONE/FAILED/CANCELLED 不算 active**: 仅 STARTING/THINKING/CODING/TERMINAL/BROWSING/TESTING/REVIEWING/WAITING_IO/NEEDS_INPUT/BLOCKED 算 active
- **kanban 任务并入**: opts.kanbanActive > 0 → workload 至少 EXECUTING (blocked 任务 → BLOCKED)
- isActiveState 同步: DONE/FAILED 返回 false (现有 DONE 可能已 true — 修正)
- 更新单测: DONE-only worker → READY; kanbanActive=1 → EXECUTING

## 2. 移除假 Supervisor (hermesProvider.ts + orgStore)

- 不再为每个 profile upsert `<profile>:root` SUPERVISOR **节点**
- Profile 层级由 ProfileController 表示 (已有), UI 端 Profile Header 代表 Root (🏢 MemoFlow ONLINE·EXECUTING)
- **真实 Supervisor 才创建节点**: worker 的 action/task 文本含 派发/dispatch/delegate/supervis/协调 且 spawn 出子节点 → 该 worker 节点 role=SUPERVISOR (已有 isSupervisorWorker, 保留)
- 挂载关系: 无 parentId 的 worker 直接挂 profile (UI 层: Profile → nodes); 有 spawn 关联的挂 spawn.parentNodeId
- 移除 rootId 概念: syncTeam 不再 upsert root node; 节点 parentId 为空时 UI 视为 profile 直属
- kanban 节点: parentId 为空 (profile 直属)

## 3. Run 层 (orgStore + OrgView)

- Run 已在 store (upsertRun)。**UI 分组**: OrgView 按 (profile, run) 分组渲染:
  ```
  🏢 MemoFlow   ONLINE · EXECUTING
  └─ Run #R218  "Context Architecture Refactor"   (title 取节点 task 或 profile mission)
     ├─ S01 Hermes  Supervisor · 派发/协调文本
     ├─ E01 OpenCode · DeepSeek-V4  CODING · 06:14
     └─ E02 OpenCode · DeepSeek-V4  TESTING · 04:21
  ```
- runId 分组逻辑: 无 runId 的节点 → 归入 "Active" 默认 run (title = profile.mission 或 "活动")
- 多 Run 并行: 同 profile 多 runId → 多 Run 块
- Run 头部显示: 节点数 / 活跃数 / 总 elapsed

## 4. 节点行格式升级 (OrgView.tsx)

移除每行尾 `[SPAWNED]`。行内容:
```
#E01  OpenCode · DeepSeek V4        ← 编号 + runtime · model
      Implement cache layer          ← task title (次行, 灰色小字)
      CODING · 04:31                 ← state chip + elapsed
      [PID 1234] ⚡ cmd               ← 有则显示 (保留)
```
- 树缩进已表达父子, edge 标签仅 hover 显示 (title 属性: S01 ─SPAWNED→ E01)
- 样式: state chip 彩色 (BLOCKED 红 / DONE 灰 / active 蓝绿), 系统字体 (见 6)

## 5. 字体 (OrgView + 相关组件)

- Org/Graph/Ops 视图: `font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
- Canvas 办公室保留 pixel font (游戏化区域)
- 顶部统计: "7 Profiles · 2 Active Runs · 4 Active Executors" (动态计算: active runs = 有活跃节点的 run 数; active executors = active 节点数)

## 6. 验收标准

1. Default: 只有 2 个活跃节点 (历史 DONE 不再出现)
2. MemoFlow 无活跃任务 → `ONLINE · READY`, 无假 SUPERVISOR 节点
3. kanban 活跃任务存在时 → profile 显示 EXECUTING (端到端: 创建 assignee=memoflow 任务 → MemoFlow EXECUTING)
4. DONE 节点不再使 profile 变 EXECUTING
5. Org 视图: Profile → Run → 节点 三级结构; 节点行含 Task/Model/State/Elapsed
6. `npm run test:server` 通过 (新增: DONE 不算 active / kanban 并入 aggregation / root 不创建节点)
7. 构建通过, 3100 正常运行

## 7. 参考

- server/src/providers/hermes/orgModel.ts (aggregateProfile/isActiveState)
- server/src/providers/hermes/hermesProvider.ts (syncTeam/rootId)
- server/src/orgStore.ts (runs/nodes/edges)
- webview-ui/src/components/OrgView.tsx (渲染)
