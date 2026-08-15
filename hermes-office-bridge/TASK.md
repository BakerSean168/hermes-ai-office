# 任务:实施 Hermes 工作台看板

阅读本目录中的 SPEC.md,严格按照规格实施整个看板项目:

1. server.py — Python 标准库(http.server + urllib),静态文件服务 + /api/* 反向代理到 http://127.0.0.1:9119,附加 Bearer token(从环境变量 HERMES_DASHBOARD_SESSION_TOKEN 读取)。监听 127.0.0.1:8787。
2. index.html — 卡通动画看板页面(纯前端,内联 CSS/JS,禁止外部 CDN):
   - 顶部状态栏:网关状态、活跃 Agent 数、活跃会话数、版本号,每 5 秒自动刷新
   - 组长卡片区:每个 profile 一张卡(名字 + 手下员工数 + 忙碌/空闲状态)
   - 员工卡片区:每个活跃会话一张卡,含卡通人物(SVG/CSS)、头上标识牌(编号 + 模型名)、会话标题、计费通道、消息数/工具调用数/token 用量、"正在做"气泡(last_activity_description),忙碌动画/空闲动画
   - 深色背景 + 糖果色卡片,卡通风格
3. start.sh — 自动从 docker 容器 hermes-personal 或本机进程环境读取 HERMES_DASHBOARD_SESSION_TOKEN,注入并启动 server.py。
4. README.md — 一句话说明 + 启动方法。

完成后:
- 运行 bash start.sh 启动服务
- curl 验证 http://127.0.0.1:8787/ 返回 HTML
- curl 验证 http://127.0.0.1:8787/api/status 返回有效 JSON

验收标准见 SPEC.md 最后一段。遇到问题自行解决,直到全部验收通过。
如需访问上游 http://127.0.0.1:9119 直接用 curl。
