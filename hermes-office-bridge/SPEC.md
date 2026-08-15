# Hermes Agent 可视化状态看板 — 实施规格 (SPEC)

## 目标

做一个本地 Web 看板,用**卡通动画**展示 Hermes 多 profile(组长)+ 各会话/Agent(员工)的实时工作状态。
类似腾讯 AI 产品的"AI 员工"动画界面:每个 profile 是组长卡片,每个活跃会话/子任务是员工卡片,
卡片上标注 Agent 名 + 模型名 + 编号 + 当前工作内容,干活时播放动画。

## 架构(必须遵守)

```
浏览器 (index.html, 纯前端 JS)
   └─ 同源 fetch /api/*  ──►  server.py (Python 标准库, 无第三方依赖)
                                  ├─ 静态文件服务 (index.html / css / js)
                                  └─ 反向代理: /api/* → http://127.0.0.1:9119/api/* (加 Bearer token)
```

- 后端用 **Python 标准库** (http.server + urllib),不要 Node、不要 pip 依赖。
- Token 绝不能写进前端页面。server.py 从**环境变量** `HERMES_DASHBOARD_SESSION_TOKEN` 读取,
  启动时由 `start.sh` 注入(见下)。
- 端口 **8787**,监听 127.0.0.1。

## 数据源 (Hermes Dashboard API)

- 上游: `http://127.0.0.1:9119` (Hermes dashboard, 网关容器 host-network 已可达)
- 认证: `Authorization: Bearer <token>` (token 由 server.py 从环境变量取, 转发时附加)
- CORS: 上游已放行, 但本项目走同源代理, 不需要 CORS。

### 核心端点

**GET /api/status** → 网关总览:
```json
{
  "version": "0.20.0",
  "gateway_running": true,
  "gateway_state": "running",
  "active_agents": 2,
  "active_sessions": 2,
  "gateway_busy": true,
  "gateway_platforms": {"telegram": {"state": "connected"}}
}
```

**GET /api/profiles/sessions** → 每个会话(员工)的实时信息, 数组:
```json
{"sessions": [
  {
    "id": "20260812_064027_c0e07db4",
    "profile": "default",
    "is_active": true,
    "model": "deepseek-v4-flash",
    "billing_provider": "opencode-go",
    "billing_base_url": "https://opencode.ai/zen/go/v1",
    "title": "DeepSeek V4 Pro 版本状态核查",
    "preview": "[Alex] 帮我看一下...",
    "last_activity_at": 1786767299.1,
    "last_activity_description": "starting API call #1",
    "message_count": 214,
    "tool_call_count": 105,
    "input_tokens": 161102,
    "output_tokens": 57679,
    "cache_read_tokens": 10449280,
    "reasoning_tokens": 32379,
    "source": "telegram",
    "chat_id": "-1004334123414",
    "thread_id": "3",
    "display_name": "Hermes Workspace"
  }
]}
```
- `profile` 字段 = 组长名(如 default / memoflow / coder / bodysense / infra-readonly / infra-change / digital-biome)。
- `is_active: true` = 正在干活。
- `last_activity_description` = 当前在做什么(如 "starting API call #1"、工具名)。
- `model` = 员工用的大脑模型;`billing_provider` = 计费通道(如 opencode-go / deepseek)。

**GET /api/profiles** → 组长列表(数组, 每项含 name 等)。

### 员工"工作内容"的显示规则

- 优先用 `title` 作为员工当前任务名(会话标题)。
- 用 `last_activity_description` 作为"正在做什么"的实时动作文本。
- `is_active: true` → 忙碌动画;否则 → 空闲动画(如喝咖啡/待机)。
- 编号:按 sessions 数组顺序分配 1、2、3…(同 profile 下按 last_activity_at 排序)。

## UI 要求 (卡通动画风格)

1. **顶部状态栏**: 大标题 "Hermes 工作台", 网关状态徽章(运行中/忙碌/活跃 Agent 数/活跃会话数), 版本号, 每 5 秒自动刷新。
2. **组长卡片区**: 每个 profile 一张组长卡(从 /api/profiles + sessions 聚合)。
   卡片显示: 组长名 + 手下员工数 + 组长整体状态(有活跃会话=忙碌, 无=空闲)。
3. **员工卡片区**: 每个活跃/最近会话一张员工卡, 卡片包含:
   - 卡通人物(SVG 或 CSS 绘制, 圆头小人与工位), 头上**标识牌**: `Agent 编号 + 模型名`(如 "员工 3 · deepseek-v4-flash")
   - 名字/角色: profile 名 + 会话标题(截断 40 字)
   - 状态行: 计费通道 (billing_provider) + 消息数 + 工具调用数 + token 用量(格式化: 104.5M cache read 等)
   - "正在做"气泡: last_activity_description, 忙碌时气泡打字动画, 空闲时显示"待命中"
   - 忙碌动画: 人物敲键盘/CPU 旋转/呼吸光晕; 空闲动画: 人物瘫坐/咖啡杯冒热气
4. **配色**: 深色背景 + 霓虹/柔和糖果色卡片, 卡通感(圆角大、阴影软、emoji 点缀如 🤖☕⚡)。
5. **纯静态前端**: 一个 index.html + 内联 CSS/JS 即可(或拆 css/js 文件), 禁止外部 CDN(离线可用)。
6. 页面标题: "Hermes 工作台"。

## 交付物 (在项目目录 /opt/data/hermes-agent-dashboard/)

```
/opt/data/hermes-agent-dashboard/
├── server.py          # 标准库静态服务 + /api/* 代理 (读 HERMES_DASHBOARD_SESSION_TOKEN)
├── index.html         # 看板页面 (内联 CSS+JS 或拆文件均可)
├── start.sh           # 启动脚本: 自动从 docker 容器取 token, 注入并启动 server.py
└── README.md          # 一句话说明 + 启动方法
```

## start.sh 逻辑

```bash
#!/usr/bin/env bash
# 1. 优先从 hermes-personal 容器环境读 token
TOKEN=$(docker exec hermes-personal printenv HERMES_DASHBOARD_SESSION_TOKEN 2>/dev/null)
# 2. 兜底: 从本机 hermes dashboard 进程环境读
if [ -z "$TOKEN" ]; then
  PID=$(pgrep -f "hermes dashboard" | head -1)
  TOKEN=$(tr '\0' '\n' < /proc/$PID/environ 2>/dev/null | grep "^HERMES_DASHBOARD_SESSION_TOKEN=" | cut -d= -f2)
fi
if [ -z "$TOKEN" ]; then echo "无法获取 token"; exit 1; fi
export HERMES_DASHBOARD_SESSION_TOKEN="$TOKEN"
exec python3 server.py   # 端口 8787, 监听 127.0.0.1
```

## 验收标准

1. `bash start.sh` 后 `curl -s http://127.0.0.1:8787/` 返回看板 HTML。
2. `curl -s http://127.0.0.1:8787/api/status` 返回带数据(代理成功)。
3. 浏览器打开显示卡通卡片, 每 5 秒刷新, 有活跃会话的 profile 显示忙碌动画。
4. server.py 只读环境变量, 页面代码里不出现 token。
