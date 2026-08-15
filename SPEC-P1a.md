# Pixel Agents — P1a: CharacterMapper + 标签增强 + cleanup (SPEC-P1a)

## 背景

P0 已修复(数据正确)。P1 目标: 把 Execution Graph 与 Office 视觉真正接起来。
本批 (P1a): 人物标签信息增强 + 状态动画补全 + 三个 cleanup 小尾巴。
下一批 (P1b): Office 按 Profile 分区 + fit-to-content。

## 1. CharacterMapper — 人物标签 (HermesProvider + webview)

### server 侧 (hermesProvider.ts)

创建 agent 时 (sessionStart) 设置:
- `agentName`: `#{num}` (如 `#01`)  — 与 Org 视图编号一致
- `teamName`: profile display 名 (已有, 保持)
- `model`: 已有
- 新增 `meta` (若 Character 支持): runtime (opencode/codex/hermes)

### webview 侧 (ToolOverlay / 人物头顶)

ToolOverlay 显示结构 (按优先级):
```
Default #01            ← teamName + agentName
OpenCode · DeepSeek V4 ← runtime · model
Writing                ← 状态文本 (formatToolStatus)
```
- runtime 显示名映射: opencode→OpenCode, codex→Codex, hermes→Hermes, 其他→原样
- 若无 model 则不显示该行; 保持 ToolOverlay 紧凑 (最多 3 行)

## 2. 状态动画补全 (characters.ts / renderer)

HermesProvider 的 toolName: Plan/Think/Write/WebSearch/Test/Read/Wait/Permission。
pixel-agents 动画系统对未知工具名的 fallback 已有; 补全以下 (不画新帧, 复用现有):
- `Think` → typing 帧 + ToolOverlay 显示 "Thinking"
- `Test` → typing 帧 + "Testing"
- `Wait` → idle 帧 + "Waiting"
- `Plan` → reading 帧 + "Planning"
- `Permission` → 已有 blocked 视觉 (红色 !)

确保 statusText 正确 (formatToolStatus 已由 provider 提供)。

## 3. Cleanup

### 3a. Org 视图字体 → system-ui (OrgView.tsx + 相关 CSS)

- Org 视图容器/节点: `font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif !important`
- Canvas 办公室保留 pixel font (游戏化区域)
- 顶部统计栏同样 system-ui

### 3b. kanban archived → DONE (hermesProvider.ts)

- `kanbanStateToNodeState('archived')` → `'DONE'` (已有 bridge 过滤, 双保险)

### 3c. kanban 节点 runId (hermesProvider.ts buildKanbanNodes)

- 节点 runId: `${profileId}:run` (现在为空 → 归入默认 'Active' run; 改为挂 profile run)
- 同时确保 orgStore 有对应 run (upsertRun, title=profile display)

## 4. 验收标准

1. 人物头顶标签: `Default #01` + `OpenCode · DeepSeek V4` + 状态文本 (3 行结构)
2. Think/Test/Wait 状态有动画且标签正确 (Thinking/Testing/Waiting)
3. Org 视图字体为 system-ui (Canvas 仍 pixel)
4. kanban 任务挂 profile run (orgState: kanban node runId = memoflow:run)
5. `npm run test:server` 通过; 构建通过; 3100 正常运行无报错
6. Canvas/Org 既有功能不破坏

## 5. 参考

- server/src/providers/hermes/hermesProvider.ts (agent 创建/toolName/kanban)
- webview-ui/src/office/components/ToolOverlay.tsx (头顶标签)
- webview-ui/src/office/engine/characters.ts (动画)
- webview-ui/src/office/toolUtils.ts (STATUS_TO_TOOL)
- webview-ui/src/components/OrgView.tsx (字体)
