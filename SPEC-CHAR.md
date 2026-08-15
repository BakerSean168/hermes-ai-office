# Pixel Agents — Canvas Character 动画增强 (SPEC-CHAR)

## 背景

HermesProvider(server/src/providers/hermes/)已完成:订阅 bridge SSE → AgentEvent → OrgStore → orgState。
Org 视图工作正常。本任务: 让 **Canvas 办公室人物** 的状态动画和头顶标签正确反映 Hermes worker。

现状问题:
- HermesProvider 的 toolName 用 plan/think/write/web_search/test/read/wait/permission
- pixel-agents 动画系统只认识 Claude 工具名(Read/Grep/Glob/WebFetch/WebSearch/Write/Edit/Bash/Task)
- think/test/wait 等没有对应动画; 人物头顶标签(agentName)未设置, 显示为 raw sessionId

## 1. toolName 规范化 (server/src/providers/hermes/hermesProvider.ts)

statusToToolName 输出改为 pixel-agents 认识的工具名 (大小写敏感, 与 STATUS_TO_TOOL 前缀匹配):

| bridge status | toolName (新) | 动画期望 |
|---|---|---|
| planning | `Plan` | reading 动画 (加入 readingTools) |
| llm_running | `Think` | 新增: 静态思考 (复用 idle 帧 + 特殊标签) |
| coding | `Write` | typing 动画 (已有) |
| browsing | `WebSearch` | browsing/reading (加入 readingTools) |
| testing | `Test` | 新增: 复用 Bash 动画 (命令屏幕) |
| reviewing | `Read` | reading 动画 (已有) |
| waiting_io | `Wait` | 新增: 静态等待 + ⏳ 标签 |
| blocked | `Permission` | 红色 ! 气泡 (已有 permissionRequest 路径, 但这里是 toolStart 路径 — 见下) |
| idle | '' (无 tool) | 休息 |

同步更新:
- `HERMES_TOOL_LABELS` 映射: Plan→Planning, Think→Thinking, Write→Writing, WebSearch→Browsing, Test→Testing, Read→Reading, Wait→Waiting, Permission→Blocked
- `readingTools` (HookProvider 声明): 加入 Plan/WebSearch/Read (Think 不需要 reading 动画, 用特殊处理)

## 2. 前端动画识别 (webview-ui/src/office/toolUtils.ts + characters.ts)

- `STATUS_TO_TOOL` 增加: `Think: 'Think'`, `Test: 'Test'`, `Wait: 'Wait'`, `Plan: 'Plan'` (使 extractToolName 返回这些工具名)
- characters.ts / renderer.ts 工具分类:
  - Think/Test/Wait/Plan 默认走 typing 或 idle 帧即可 (第一版不画新帧)
  - 关键: **标签文字** 正确 (ToolOverlay 显示工具状态文本, 来自 formatToolStatus)
- 检查 characters.ts 的工具动画选择逻辑, 确保未知 tool 名不会报错/崩溃 (fallback 到 typing)

## 3. agentName / 标签 (server/src/providers/hermes/hermesProvider.ts)

创建 agent 时设置:
- `agentName`: `<profile> #<num>` (如 `Default #01`, `MemoFlow #01`)
- `teamName`: profile display 名 (如 `MemoFlow`) — 若 pixel-agents 的 team 显示逻辑能利用则设置, 否则留空
- sessionId 保持 `hermes:<profile>:<workerId>` (不变)

ToolOverlay / 人物头顶应显示: `Default #01` + 状态文本 (Thinking/Writing/Blocked...)。

## 4. 验收标准

1. HERMES_BRIDGE_ENABLED=1 启动, Canvas 出现 Hermes 人物 (7 profile 的活跃 workers 至少出现 default 的 2 个)
2. 人物头顶标签: `Default #01` + `Writing`/`Thinking` 等状态文本
3. 活跃 worker 有动画 (write→typing), blocked worker 有红色 ! (若有)
4. 无报错: `npm run test:server` 通过, webview 构建无 error
5. Canvas 原有功能 (Claude 模式) 不破坏

## 5. 参考

- webview-ui/src/office/toolUtils.ts (STATUS_TO_TOOL)
- webview-ui/src/office/engine/characters.ts (动画 FSM)
- webview-ui/src/office/components/ToolOverlay.tsx (头顶标签)
- server/src/providers/hermes/hermesProvider.ts (HermesProvider)
