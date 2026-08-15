# Pixel Agents — P1b: Office Profile 分区 + fit-to-content (SPEC-P1b)

## 背景

P1a 完成 (标签/动画/字体)。本批: 把办公室从"公共办公区"变成 **7 个 Profile 团队分区**,
并修复初始缩放 (办公室应占视口 65-80%, 而非 90% 黑屏)。

## 1. Office 按 Profile 分区 (Areas)

pixel-agents 已有 Areas 机制 (AreaDefinition {label, color}, OfficeLayout.areaTiles, areaMappings)。

### 1a. 启动时自动建 7 个 profile Areas (server 侧, hermesProvider.ts 或 cli.ts)

HermesProvider 启动后, 根据 board 的 teams (7 个 profile) 自动生成 area 配置:
- 每个 profile 一个 Area: label = profile display 名 (Default/MemoFlow/BodySense/...)
- 颜色: 从固定调色板按 index 分配 (区分度高的 7 色, 如 #ff6b6b/#4ecdc4/#45b7d1/#f9ca24/#6c5ce7/#00b894/#fd79a8)
- 注入方式: 复用 standalone 配置的 areaMappings (server/src/configPersistence.ts, clientMessageHandler.ts 的 areaMappingsLoaded) — 直接写入 cfg.standalone.areaMappings (profile 名 → [profile 名]) 并广播

### 1b. Layout 分区 (webview)

- 现有默认 layout (21×22) 画 7 个 profile 分区太挤 → 扩展 layout 或重排:
  - 方案: 将 layout 加宽 (如 32×22) 或使用现有空间划分 7 个区域 (每区域 4-5 列)
  - 每个区域: areaTiles 覆盖该区域 tiles, AreaDefinition label=profile 名
  - 区域内: 1-2 张桌子 (desk) + 名牌 (floating label 显示 profile 名)
- 参考现有 areaTiles 数据结构 (webview-ui/src/office/types.ts OfficeLayout.areaTiles, engine/officeState.ts area 逻辑)

### 1c. agent → 分区分配 (webview officeState)

- agent 坐下时按 teamName 选择对应 Area 内的 seat:
  - 现有 seat 分配逻辑 (officeState.ts 的 seat/desk 选择) 增加: 优先选择 agent.teamName 对应 Area 内的空 seat
  - Hermes agent 的 teamName = profile 名 (已有) → 自动落位到 profile 分区
  - 无 teamName 的 agent (Claude 等) 保持现有行为 (任意 seat)
- 名牌/区域标题: Area 上方显示 profile 名 + 状态 (ONLINE·EXECUTING 等, 从 orgState profile 数据)

## 2. fit-to-content 初始缩放

### 现状
- defaultZoom() 用固定 DPR 因子 (toolUtils.ts), 21×22 layout 在 1280×720 下只占 ~20-30% 视口
- 大量黑色留白

### 实现
- 计算 layout 内容边界 (有 tile/furniture 的范围, 即非空 tile 的 min/max col/row)
- 初始 zoom = min(viewportW / contentW, viewportH / contentH) × 0.75 (留 25% 边距), 限制在 [ZOOM_MIN, ZOOM_MAX]
- 初始 pan 居中: offset 使内容中心 = 视口中心
- 只在首次加载/无用户自定义 zoom 时应用; 用户 zoom 后保持
- 参考 webview 的 zoom/pan 实现 (constants.ts ZOOM_*, officeState.ts 或 App.tsx 的 zoom 状态)

## 3. 验收标准

1. 办公室出现 7 个分区, 每个分区有名牌 (profile 名) + 不同颜色地毯/边框
2. Hermes agent 落位到对应 profile 分区 (Default 的 agent 在 Default 区)
3. 初始加载: 办公室占视口 ~65-80%, 无大面积黑屏
4. 用户 zoom/pan 后不被强制复位
5. Claude 模式 (无 teamName agent) 不受影响
6. `npm run test:server` 通过; 构建通过; 3100 正常运行
7. Org 视图/Canvas 既有功能不破坏

## 4. 参考

- webview-ui/src/office/types.ts (AreaDefinition/OfficeLayout/areaTiles)
- webview-ui/src/office/engine/officeState.ts (seat 分配/area 逻辑)
- webview-ui/src/office/toolUtils.ts (defaultZoom)
- webview-ui/src/constants.ts (ZOOM_*)
- webview-ui/src/App.tsx (zoom/pan 状态)
- server/src/configPersistence.ts + clientMessageHandler.ts (areaMappings)
- server/src/providers/hermes/hermesProvider.ts (HermesProvider)
