"use strict";
(() => {
  // dashboard/src/i18n.js
  var COPY = {
    en: {
      overview: "Overview",
      analytics: "Analytics",
      active: "Active now",
      spend: "Total spend",
      tokens: "Total tokens",
      duration: "Execution time",
      success: "Success rate",
      calls: "Model calls",
      running: "Running now",
      history: "Execution history",
      noRunning: "No active executions",
      project: "Project",
      task: "Task",
      phase: "Phase",
      status: "Status",
      model: "Logical model",
      route: "Provider / physical model",
      started: "Started",
      elapsed: "Elapsed",
      cost: "Cost",
      search: "Search history…",
      refresh: "Refresh",
      updated: "Updated",
      lastObserved: "Last activity",
      governance: "Governance",
      runtime: "Runtime",
      readiness: "Readiness",
      plans: "Development plans",
      providers: "LiteLLM registry",
      admin: "Open LiteLLM Admin",
      groupProject: "Projects",
      groupLogical: "Logical models",
      groupProvider: "Providers / channels",
      groupPhysical: "Physical models",
      groupPhase: "Phases",
      executions: "Executions",
      cache: "Cache read",
      reasoning: "Reasoning",
      input: "Input",
      output: "Output",
      activeDeployments: "active deployments",
      pausedDeployments: "paused",
      activityImplementation: "Implementing",
      activityTicketReview: "Ticket review",
      activityTicketFix: "Ticket fix",
      activityIntegrationRepair: "Integration repair",
      activityBatchVerify: "Batch aggregate review",
      activityPostMergeRepair: "Post-merge repair",
      activityDeliveryRepair: "Delivery repair",
      activityIntegrationCandidate: "Integration candidate",
      activityIntegrating: "Integrating batch",
      activityDelivery: "Delivery",
      activityBlocked: "Blocked",
      activityComplete: "Complete",
      activityIdle: "Idle",
      activityWorkItem: "Work item",
      attempt: "Attempt",
      automation: "automation",
      items: "items",
      batches: "batches",
      planDetail: "Plan timeline",
      close: "Close",
      systemWork: "System workflow",
      businessWork: "Business work",
      mechanicalEvent: "Control-plane event",
      deliveryTimeline: "Delivery timeline",
      noTimeline: "No execution timeline yet",
      auditTitle: "Engineering audit",
      attentionTitle: "Needs attention",
      strongModelTitle: "Strong-model decisions",
      auditExecutions: "Executions",
      failures: "Failures",
      repairs: "Repairs",
      strongModelUses: "Strong-model uses",
      whyStrongModel: "Why strong model",
      failureToRepair: "Failure → repair",
      controlPlaneFailure: "Control-plane failure",
      decisionBatchAggregateReview: "Batch aggregate semantic review",
      decisionIntegrationRepair: "Integration conflict / semantic repair",
      decisionPostMergeRecovery: "Post-merge CI recovery",
      decisionDeliveryRepair: "Delivery recovery",
      decisionIndependentReview: "Independent premium review",
      decisionFailedVerificationRepair: "Premium repair after failed verification",
      decisionStrongModelPolicy: "Strong-model policy decision",
      auditFilterAll: "All",
      auditFilterFailures: "Failures",
      auditFilterRepairs: "Repairs",
      auditFilterStrong: "Strong model",
      auditFilterBatch: "Batch",
      auditFilterAllBatches: "All batches",
      jumpFailure: "Open failure",
      jumpRepair: "Open repair",
      jumpExecution: "Open execution",
      jumpBatch: "Open batch",
      health: "Health",
      openIssues: "open issues",
      healthHealthy: "Healthy",
      healthWatch: "Watch",
      healthDegraded: "Degraded",
      healthCritical: "Critical",
      filteredTimelineEmpty: "No timeline entries match this filter",
      details: "View details",
      continueHandoff: "Resume from handoff",
      handoffTitle: "Resume from agent handoff",
      handoffHelp: "Paste an AI_OFFICE_HANDOFF_V1 packet from ChatGPT, Codex, Claude, or another coding agent. Pixel Agent verifies Git ancestry and plan identities mechanically; this path does not launch a model audit.",
      handoffPlaceholder: "AI_OFFICE_HANDOFF_V1 { ... }",
      handoffSubmit: "Verify & continue",
      handoffCancel: "Cancel",
      handoffInvalid: "Could not parse an AI_OFFICE_HANDOFF_V1 JSON object.",
      handoffSubmitting: "Verifying handoff…",
      continueExternal: "Scan external progress",
      syncingExternal: "Scanning external progress…",
      continueExternalConfirm: "No handoff packet? This fallback scans committed external progress and launches a model-backed repository audit, which can take time and consume model quota. Continue?",
      projectStats: "Projects",
      implementingProjects: "implementing",
      completedProjects: "completed",
      blockedProjects: "blocked",
      criticalProjects: "critical"
    },
    zh: {
      overview: "总览",
      analytics: "统计",
      active: "正在执行",
      spend: "历史总花费",
      tokens: "历史总 Token",
      duration: "累计执行时间",
      success: "成功率",
      calls: "模型调用",
      running: "当前任务",
      history: "全部执行历史",
      noRunning: "当前没有正在执行的任务",
      project: "项目",
      task: "任务",
      phase: "阶段",
      status: "状态",
      model: "逻辑模型",
      route: "渠道 / 物理模型",
      started: "开始时间",
      elapsed: "耗时",
      cost: "花费",
      search: "搜索历史任务…",
      refresh: "刷新",
      updated: "更新于",
      lastObserved: "最近活动",
      governance: "治理",
      runtime: "运行时",
      readiness: "晋级证据",
      plans: "项目计划",
      providers: "LiteLLM 供应池",
      admin: "打开 LiteLLM Admin",
      groupProject: "按项目",
      groupLogical: "按逻辑模型",
      groupProvider: "按渠道 / Provider",
      groupPhysical: "按物理模型",
      groupPhase: "按阶段",
      executions: "执行次数",
      cache: "缓存读取",
      reasoning: "Reasoning",
      input: "输入",
      output: "输出",
      activeDeployments: "条活跃部署",
      pausedDeployments: "条暂停",
      activityImplementation: "正在实施",
      activityTicketReview: "任务审查",
      activityTicketFix: "任务修复",
      activityIntegrationRepair: "集成冲突修复",
      activityBatchVerify: "批次整体审查",
      activityPostMergeRepair: "合并后修复",
      activityDeliveryRepair: "交付修复",
      activityIntegrationCandidate: "待整体审查",
      activityIntegrating: "正在集成",
      activityDelivery: "正在交付",
      activityBlocked: "已阻塞",
      activityComplete: "已完成",
      activityIdle: "空闲",
      activityWorkItem: "工作项",
      attempt: "第几轮",
      automation: "自动流程",
      items: "任务",
      batches: "批次",
      planDetail: "计划时间线",
      close: "关闭",
      systemWork: "系统自动流程",
      businessWork: "业务任务",
      mechanicalEvent: "控制面事件",
      deliveryTimeline: "交付时间线",
      noTimeline: "暂无执行时间线",
      auditTitle: "工程审计",
      attentionTitle: "需要关注",
      strongModelTitle: "强模型决策",
      auditExecutions: "执行次数",
      failures: "失败",
      repairs: "修复",
      strongModelUses: "强模型调用",
      whyStrongModel: "为何使用强模型",
      failureToRepair: "失败 → 修复",
      controlPlaneFailure: "控制面失败",
      decisionBatchAggregateReview: "批次整体语义审查",
      decisionIntegrationRepair: "集成冲突 / 语义修复",
      decisionPostMergeRecovery: "合并后 CI 恢复",
      decisionDeliveryRepair: "交付恢复",
      decisionIndependentReview: "独立高质量审查",
      decisionFailedVerificationRepair: "审查失败后的高质量修复",
      decisionStrongModelPolicy: "强模型策略决策",
      auditFilterAll: "全部",
      auditFilterFailures: "失败",
      auditFilterRepairs: "修复",
      auditFilterStrong: "强模型",
      auditFilterBatch: "批次",
      auditFilterAllBatches: "全部批次",
      jumpFailure: "定位失败",
      jumpRepair: "定位修复",
      jumpExecution: "定位执行",
      jumpBatch: "定位批次",
      health: "健康度",
      openIssues: "个未解决问题",
      healthHealthy: "健康",
      healthWatch: "观察",
      healthDegraded: "降级",
      healthCritical: "严重",
      filteredTimelineEmpty: "当前过滤条件下没有时间线记录",
      details: "查看详情",
      continueHandoff: "从交接继续",
      handoffTitle: "从 Agent 交接继续",
      handoffHelp: "粘贴 ChatGPT、Codex、Claude 或其他编码 Agent 给出的 AI_OFFICE_HANDOFF_V1。Pixel Agent 只做 Git 祖先关系与计划身份的机械校验，不会启动模型审计。",
      handoffPlaceholder: "AI_OFFICE_HANDOFF_V1 { ... }",
      handoffSubmit: "校验并继续",
      handoffCancel: "取消",
      handoffInvalid: "无法解析 AI_OFFICE_HANDOFF_V1 JSON。",
      handoffSubmitting: "正在校验交接…",
      continueExternal: "自动扫描外部进度",
      syncingExternal: "正在扫描外部进度…",
      continueExternalConfirm: "没有交接包时再使用此兜底方式。它会扫描已提交的外部进度，并启动模型对仓库做审计，可能耗时并消耗模型额度。继续吗？",
      projectStats: "项目",
      implementingProjects: "实施中",
      completedProjects: "已完成",
      blockedProjects: "阻塞",
      criticalProjects: "严重"
    }
  };

  // dashboard/src/runtime.js
  var SDK = window.__HERMES_PLUGIN_SDK__;
  var registry = window.__HERMES_PLUGINS__;
  var runtimeReady = Boolean(SDK && registry && typeof registry.register === "function" && typeof SDK.fetchJSON === "function");
  var React = runtimeReady ? SDK.React : null;
  var h = React ? React.createElement : null;
  var fetchJSON = runtimeReady ? SDK.fetchJSON : null;
  var API_ROOT = "/api/plugins/hermes-ai-office";
  var DASHBOARD_SCHEMA_VERSION = 8;
  function useLocale() {
    const hook = SDK && SDK.useI18n;
    if (hook) {
      const value = hook();
      return String(value && value.locale ? value.locale : "en").toLowerCase().startsWith("zh") ? "zh" : "en";
    }
    return "en";
  }
  function api(path, init) {
    return fetchJSON(API_ROOT + path, init);
  }
  function assertDashboardContract(value) {
    if (!value || value.schemaVersion !== DASHBOARD_SCHEMA_VERSION) {
      const actual = value && value.schemaVersion != null ? value.schemaVersion : "missing";
      throw new Error("AI Office dashboard contract mismatch: expected v" + DASHBOARD_SCHEMA_VERSION + ", received v" + actual);
    }
    return value;
  }
  function assertPlanDetailContract(value) {
    if (!value || value.schemaVersion !== DASHBOARD_SCHEMA_VERSION || !value.plan || !Array.isArray(value.batches)) {
      throw new Error("AI Office plan detail contract mismatch");
    }
    return value;
  }
  function parseRgb(value) {
    const text = String(value || "").trim();
    let match = text.match(/^#([0-9a-f]{6})$/i);
    if (match) {
      const hex = match[1];
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    }
    match = text.match(/^#([0-9a-f]{3})$/i);
    if (match) {
      return match[1].split("").map(function(digit) {
        return parseInt(digit + digit, 16);
      });
    }
    match = text.match(/^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  }
  function detectThemeMode() {
    const root = window.getComputedStyle(document.documentElement);
    const rgb = parseRgb(root.getPropertyValue("--background-base") || root.getPropertyValue("--background"));
    if (rgb) {
      const luminance = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
      return luminance > 0.55 ? "light" : "dark";
    }
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  function useThemeMode() {
    const [mode, setMode] = React.useState(detectThemeMode);
    React.useEffect(function() {
      let frame = 0;
      function update() {
        window.cancelAnimationFrame(frame);
        frame = window.requestAnimationFrame(function() {
          setMode(detectThemeMode());
        });
      }
      const observer = new MutationObserver(update);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
      if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
      if (document.head) observer.observe(document.head, { childList: true, subtree: true, attributes: true });
      const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
      if (media && media.addEventListener) media.addEventListener("change", update);
      update();
      return function() {
        observer.disconnect();
        if (media && media.removeEventListener) media.removeEventListener("change", update);
        window.cancelAnimationFrame(frame);
      };
    }, []);
    return mode;
  }

  // dashboard/src/format.js
  function num(value) {
    return Number(value || 0);
  }
  function compact(value, locale) {
    return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
      notation: "compact",
      maximumFractionDigits: 1
    }).format(num(value));
  }
  function integer(value, locale) {
    return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US").format(num(value));
  }
  function money(value) {
    const n = num(value);
    return "$" + (n < 0.01 && n > 0 ? n.toFixed(5) : n.toFixed(2));
  }
  function duration(ms) {
    const value = Math.max(0, num(ms));
    if (value < 1e3) return Math.round(value) + "ms";
    const seconds = Math.floor(value / 1e3);
    if (seconds < 60) return seconds + "s";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "m " + seconds % 60 + "s";
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "h " + minutes % 60 + "m";
    return Math.floor(hours / 24) + "d " + hours % 24 + "h";
  }
  function dateTime(value, locale) {
    if (!value) return "—";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "—";
    return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(date);
  }
  function runningElapsed(item, now) {
    if (item.durationMs != null) return item.durationMs;
    const start = Date.parse(item.startedAt || "");
    return Number.isFinite(start) ? Math.max(0, now - start) : 0;
  }
  function percentage(value) {
    return value == null ? "—" : Math.round(num(value) * 100) + "%";
  }
  function routeLabel(item) {
    const route = item && item.route;
    if (!route) return "—";
    return route.providerKey + " · " + route.physicalModel;
  }
  function activityLabel(kind, t) {
    const labels = {
      IMPLEMENTATION: t.activityImplementation,
      TICKET_REVIEW: t.activityTicketReview,
      TICKET_FIX: t.activityTicketFix,
      INTEGRATION_REPAIR: t.activityIntegrationRepair,
      BATCH_VERIFY: t.activityBatchVerify,
      POST_MERGE_REPAIR: t.activityPostMergeRepair,
      DELIVERY_REPAIR: t.activityDeliveryRepair,
      INTEGRATION_CANDIDATE: t.activityIntegrationCandidate,
      INTEGRATING: t.activityIntegrating,
      DELIVERY: t.activityDelivery,
      BLOCKED: t.activityBlocked,
      COMPLETE: t.activityComplete,
      IDLE: t.activityIdle,
      WORK_ITEM: t.activityWorkItem
    };
    return labels[String(kind || "").toUpperCase()] || String(kind || t.activityIdle).replace(/_/g, " ");
  }
  function shortRevision(value) {
    const text = String(value || "");
    return text ? text.slice(0, 10) : null;
  }

  // dashboard/src/components.js
  function measuredTokens(item, locale, suffix) {
    const usage = item && item.usage;
    if (!usage || Number(usage.calls || 0) <= 0) return "—";
    return compact(item.totalTokens || 0, locale) + (suffix || "");
  }
  function Badge(props) {
    const value = String(props.value || "UNKNOWN").toUpperCase();
    return h(
      "span",
      { className: "hao-badge hao-badge-" + value.toLowerCase().replace(/_/g, "-") },
      value
    );
  }
  function Metric(props) {
    return h(
      "article",
      { className: "hao-metric" + (props.primary ? " hao-metric-primary" : "") },
      h("span", { className: "hao-metric-label" }, props.label),
      h("strong", { className: "hao-metric-value" }, props.value),
      props.hint ? h("span", { className: "hao-metric-hint" }, props.hint) : null
    );
  }
  function Panel(props) {
    return h(
      "section",
      { className: "hao-panel " + (props.className || "") },
      props.title ? h(
        "header",
        { className: "hao-panel-head" },
        h(
          "div",
          null,
          h("h2", null, props.title),
          props.subtitle ? h("p", null, props.subtitle) : null
        ),
        props.action || null
      ) : null,
      props.children
    );
  }
  function ExecutionTable(props) {
    const rows = props.rows || [];
    const t = props.t;
    const locale = props.locale;
    const now = props.now;
    return h(
      "div",
      { className: "hao-table-wrap" },
      h(
        "table",
        { className: "hao-table" },
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            h("th", null, t.project),
            h("th", null, t.task),
            h("th", null, t.phase),
            h("th", null, t.status),
            h("th", null, t.model),
            h("th", null, t.route),
            h("th", null, t.started),
            h("th", null, t.elapsed),
            h("th", { className: "hao-right" }, "Token"),
            h("th", { className: "hao-right" }, t.cost)
          )
        ),
        h(
          "tbody",
          null,
          rows.map(function(item) {
            return h(
              "tr",
              { key: item.executionId, title: item.executionId },
              h("td", null, h("span", { className: "hao-project" }, item.projectKey)),
              h("td", null, h("div", { className: "hao-objective" }, item.objective)),
              h("td", null, h("span", { className: "hao-phase" }, item.phase)),
              h("td", null, h(Badge, { value: item.status })),
              h("td", null, h("span", { className: "hao-mono" }, item.logicalModel)),
              h("td", null, h("span", { className: "hao-route" }, routeLabel(item))),
              h("td", { className: "hao-muted" }, dateTime(item.startedAt, locale)),
              h("td", { className: "hao-mono" }, duration(runningElapsed(item, now))),
              h("td", { className: "hao-right hao-mono" }, measuredTokens(item, locale, "")),
              h("td", { className: "hao-right hao-mono" }, money(item.usage && item.usage.costUsd))
            );
          })
        )
      )
    );
  }
  function RunningCards(props) {
    const rows = props.rows || [];
    if (!rows.length) return h("div", { className: "hao-empty" }, props.t.noRunning);
    return h(
      "div",
      { className: "hao-running-grid" },
      rows.map(function(item) {
        return h(
          "article",
          { className: "hao-running-card", key: item.executionId },
          h(
            "div",
            { className: "hao-running-top" },
            h(Badge, { value: item.status }),
            h("span", { className: "hao-phase" }, item.phase)
          ),
          h("h3", null, item.objective || item.projectKey),
          h("div", { className: "hao-running-project" }, item.projectKey),
          h(
            "div",
            { className: "hao-running-route" },
            item.logicalModel,
            h("span", null, "→"),
            routeLabel(item)
          ),
          h(
            "div",
            { className: "hao-running-foot" },
            h("span", null, props.t.started + " " + dateTime(item.startedAt, props.locale)),
            h("strong", null, duration(runningElapsed(item, props.now)))
          ),
          h(
            "div",
            { className: "hao-running-usage" },
            h("span", null, measuredTokens(item, props.locale, " tok")),
            h("span", null, money(item.usage && item.usage.costUsd))
          )
        );
      })
    );
  }

  // dashboard/src/analytics.js
  function AnalyticsTable(props) {
    return h(
      "div",
      { className: "hao-table-wrap" },
      h(
        "table",
        { className: "hao-table hao-analytics-table" },
        h("thead", null, h(
          "tr",
          null,
          h("th", null, props.title),
          h("th", { className: "hao-right" }, props.t.executions),
          h("th", { className: "hao-right" }, props.t.success),
          h("th", { className: "hao-right" }, "Token"),
          h("th", { className: "hao-right" }, props.t.calls),
          h("th", { className: "hao-right" }, props.t.duration),
          h("th", { className: "hao-right" }, props.t.cost)
        )),
        h("tbody", null, (props.rows || []).map(function(row) {
          return h(
            "tr",
            { key: row.key },
            h("td", null, h("strong", { className: "hao-analytics-key" }, row.key)),
            h("td", { className: "hao-right hao-mono" }, integer(row.executions, props.locale)),
            h("td", { className: "hao-right hao-mono" }, percentage(row.successRate)),
            h("td", { className: "hao-right hao-mono" }, compact(row.totalTokens, props.locale)),
            h("td", { className: "hao-right hao-mono" }, compact(row.calls, props.locale)),
            h("td", { className: "hao-right hao-mono" }, row.durationMs ? duration(row.durationMs) : "—"),
            h("td", { className: "hao-right hao-mono" }, money(row.costUsd))
          );
        }))
      )
    );
  }
  function Analytics(props) {
    const t = props.t;
    const analytics = props.data.analytics || {};
    const groups = [
      ["providers", t.groupProvider],
      ["logicalModels", t.groupLogical],
      ["physicalModels", t.groupPhysical],
      ["projects", t.groupProject],
      ["phases", t.groupPhase]
    ];
    const [group, setGroup] = React.useState("providers");
    const selected = groups.find(function(item) {
      return item[0] === group;
    }) || groups[0];
    return h(
      React.Fragment,
      null,
      h("div", { className: "hao-segmented" }, groups.map(function(item) {
        return h("button", { type: "button", className: item[0] === group ? "is-active" : "", key: item[0], onClick: function() {
          setGroup(item[0]);
        } }, item[1]);
      })),
      h(Panel, { title: selected[1] }, h(AnalyticsTable, { rows: analytics[selected[0]] || [], title: selected[1], t, locale: props.locale })),
      h(
        "section",
        { className: "hao-analytics-notes" },
        h("article", null, h("span", null, t.input), h("strong", null, compact((props.data.summary || {}).input, props.locale))),
        h("article", null, h("span", null, t.output), h("strong", null, compact((props.data.summary || {}).output, props.locale))),
        h("article", null, h("span", null, t.cache), h("strong", null, compact((props.data.summary || {}).cachedInput, props.locale))),
        h("article", null, h("span", null, t.reasoning), h("strong", null, compact((props.data.summary || {}).reasoningOutput, props.locale)))
      )
    );
  }

  // dashboard/src/plan-detail.js
  function decisionReasonLabel(reason, t) {
    const labels = {
      BATCH_AGGREGATE_REVIEW: t.decisionBatchAggregateReview,
      INTEGRATION_REPAIR: t.decisionIntegrationRepair,
      POST_MERGE_RECOVERY: t.decisionPostMergeRecovery,
      DELIVERY_REPAIR: t.decisionDeliveryRepair,
      INDEPENDENT_REVIEW: t.decisionIndependentReview,
      FAILED_VERIFICATION_REPAIR: t.decisionFailedVerificationRepair,
      STRONG_MODEL_POLICY: t.decisionStrongModelPolicy
    };
    return labels[reason] || String(reason || "").replace(/_/g, " ");
  }
  function healthStateLabel(state, t) {
    const labels = { HEALTHY: t.healthHealthy, WATCH: t.healthWatch, DEGRADED: t.healthDegraded, CRITICAL: t.healthCritical };
    return labels[String(state || "").toUpperCase()] || String(state || "").replace(/_/g, " ");
  }
  function HealthSummary(props) {
    const health = props.health || {};
    const state = String(health.state || "HEALTHY").toLowerCase();
    return h(
      "div",
      { className: "hao-health hao-health-" + state },
      h("strong", null, String(health.score == null ? 100 : health.score) + "/100"),
      h("span", null, healthStateLabel(health.state || "HEALTHY", props.t)),
      health.topPriority ? h("span", { className: "hao-health-priority hao-health-priority-" + String(health.topPriority).toLowerCase() }, health.topPriority) : null
    );
  }
  function isFailureExecution(item) {
    const status = String(item && item.status || "").toUpperCase();
    return status === "FAILED" || status === "STUCK" || status === "CANCELLED" || String(item && item.verdict || "").toUpperCase() === "FAIL" || Boolean(item && item.errorCode);
  }
  function isRepairExecution(item, repairIds) {
    if (!item) return false;
    if (repairIds && repairIds.has(item.executionId)) return true;
    if (String(item.phase || "").toUpperCase() === "IMPLEMENT_FIX") return true;
    return ["FAILED_VERIFICATION_REPAIR", "INTEGRATION_REPAIR", "POST_MERGE_RECOVERY", "DELIVERY_REPAIR"].includes(String(item.decisionReason || "").toUpperCase());
  }
  function executionMatchesAuditFilter(item, filter, repairIds) {
    if (filter === "failures") return isFailureExecution(item);
    if (filter === "repairs") return isRepairExecution(item, repairIds);
    if (filter === "strong") return Boolean(item && item.strongModel);
    return true;
  }
  function jumpToTimelineTarget(executionId, batchKey, controls) {
    if (!controls) return;
    controls.setAuditFilter("all");
    if (batchKey) controls.setBatchFilter(batchKey);
    controls.setTargetExecutionId(executionId || null);
    window.setTimeout(function() {
      const target = executionId ? document.getElementById("hao-exec-" + executionId) : batchKey ? document.getElementById("hao-batch-" + batchKey) : null;
      if (!target) return;
      const batch = target.closest ? target.closest("details") : null;
      if (batch) batch.open = true;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      if (executionId) {
        window.setTimeout(function() {
          controls.setTargetExecutionId(null);
        }, 1800);
      }
    }, 80);
  }
  function AuditFilters(props) {
    const filters = [
      ["all", props.t.auditFilterAll],
      ["failures", props.t.auditFilterFailures],
      ["repairs", props.t.auditFilterRepairs],
      ["strong", props.t.auditFilterStrong]
    ];
    return h(
      "section",
      { className: "hao-audit-filters" },
      h("div", { className: "hao-audit-filter-group" }, filters.map(function(item) {
        return h("button", {
          type: "button",
          className: "hao-audit-filter" + (props.auditFilter === item[0] ? " is-active" : ""),
          key: item[0],
          onClick: function() {
            if (item[0] === "failures") props.setAuditFilter("failures");
            else if (item[0] === "repairs") props.setAuditFilter("repairs");
            else if (item[0] === "strong") props.setAuditFilter("strong");
            else props.setAuditFilter("all");
            props.setTargetExecutionId(null);
          }
        }, item[1]);
      })),
      h(
        "label",
        { className: "hao-audit-batch-filter" },
        h("span", null, props.t.auditFilterBatch),
        h(
          "select",
          { value: props.batchFilter, onChange: function(event) {
            props.setBatchFilter(event.target.value);
            props.setTargetExecutionId(null);
          } },
          h("option", { value: "all" }, props.t.auditFilterAllBatches),
          (props.batches || []).map(function(batch) {
            return h("option", { value: batch.key, key: batch.key }, batch.key + " · " + batch.title);
          })
        )
      )
    );
  }
  function AuditOverview(props) {
    const summary = props.audit && props.audit.summary || {};
    const health = props.audit && props.audit.health || {};
    const metrics = [
      [props.t.auditExecutions, integer(summary.executions || 0, props.locale)],
      [props.t.failures, integer(summary.failures || 0, props.locale)],
      [props.t.repairs, integer(summary.repairs || 0, props.locale)],
      [props.t.strongModelUses, integer(summary.strongModelExecutions || 0, props.locale)],
      [props.t.duration, duration(summary.durationMs || 0)],
      ["Token", compact(summary.totalTokens || 0, props.locale)],
      [props.t.cost, money(summary.costUsd || 0)]
    ];
    return h(
      "section",
      { className: "hao-audit" },
      h("div", { className: "hao-audit-head" }, h("h3", null, props.t.auditTitle), h(HealthSummary, { health, t: props.t })),
      h("div", { className: "hao-audit-metrics" }, metrics.map(function(item) {
        return h("div", { className: "hao-audit-metric", key: item[0] }, h("span", null, item[0]), h("strong", null, item[1]));
      }))
    );
  }
  function AuditAttention(props) {
    const audit = props.audit || {};
    const attention = audit.attention || [];
    const decisions = audit.strongModelDecisions || [];
    if (!attention.length && !decisions.length) return null;
    return h(
      "section",
      { className: "hao-audit-grid" },
      attention.length ? h(
        "div",
        { className: "hao-audit-panel" },
        h("h3", null, props.t.attentionTitle),
        h("div", { className: "hao-audit-attention" }, attention.map(function(item, index) {
          const label = item.kind === "CONTROL_PLANE_FAILURE" ? props.t.controlPlaneFailure : props.t.failureToRepair;
          return h(
            "article",
            { className: "hao-audit-finding" + (item.resolved ? " is-resolved" : " is-open"), key: item.kind + index },
            h(
              "div",
              { className: "hao-audit-finding-head" },
              h("strong", null, label),
              h("div", { className: "hao-audit-finding-status" }, h("span", { className: "hao-health-priority hao-health-priority-" + String(item.priority || "P3").toLowerCase() }, item.priority || "P3"), h(Badge, { value: item.resolved ? "SUCCEEDED" : "BLOCKED" }))
            ),
            h("div", { className: "hao-audit-path" }, [item.batchKey, item.workItemKey, item.sourcePhase].filter(Boolean).join(" · ")),
            item.reason ? h("div", { className: "hao-plan-reason" }, item.reason) : null,
            h(
              "div",
              { className: "hao-audit-jumps" },
              item.sourceExecutionId ? h("button", { type: "button", className: "hao-audit-finding-button", onClick: function() {
                props.onJump(item.sourceExecutionId, item.batchKey);
              } }, props.t.jumpFailure) : null,
              item.repairExecutionId ? h("button", { type: "button", className: "hao-audit-finding-button", onClick: function() {
                props.onJump(item.repairExecutionId, item.batchKey);
              } }, props.t.jumpRepair) : null,
              !item.sourceExecutionId && item.batchKey ? h("button", { type: "button", className: "hao-audit-finding-button", onClick: function() {
                props.onJump(null, item.batchKey);
              } }, props.t.jumpBatch) : null
            ),
            item.repairExecutionId ? h("div", { className: "hao-audit-link" }, shortRevision(item.sourceExecutionId) + " → " + shortRevision(item.repairExecutionId)) : null
          );
        }))
      ) : null,
      decisions.length ? h(
        "div",
        { className: "hao-audit-panel" },
        h("h3", null, props.t.strongModelTitle),
        h("div", { className: "hao-audit-decisions" }, decisions.map(function(item) {
          return h(
            "article",
            { className: "hao-audit-decision", key: item.executionId },
            h("div", { className: "hao-audit-finding-head" }, h("strong", null, decisionReasonLabel(item.reason, props.t)), h("span", { className: "hao-plan-chip" }, item.model || "—")),
            h("div", { className: "hao-audit-path" }, [item.batchKey, item.workItemKey, item.phase, item.backend].filter(Boolean).join(" · ")),
            (item.policyReasons || []).length ? h("div", { className: "hao-plan-meta" }, item.policyReasons.map(function(reason) {
              return h("span", { className: "hao-plan-chip", key: reason }, reason);
            })) : null,
            h("div", { className: "hao-audit-jumps" }, h("button", { type: "button", className: "hao-audit-finding-button", onClick: function() {
              props.onJump(item.executionId, item.batchKey);
            } }, props.t.jumpExecution))
          );
        }))
      ) : null
    );
  }
  function TimelineExecution(props) {
    const item = props.execution || {};
    const chips = [];
    if (item.attempt) chips.push(props.t.attempt + " " + item.attempt);
    if (item.backend) chips.push(item.backend);
    if (item.model) chips.push(item.model);
    chips.push(duration(runningElapsed(item, props.now)));
    chips.push(compact(item.totalTokens || 0, props.locale) + " tok");
    chips.push(money(item.costUsd));
    return h(
      "div",
      {
        id: "hao-exec-" + item.executionId,
        className: "hao-timeline-step" + (props.targetExecutionId === item.executionId ? " is-target" : ""),
        "data-execution-id": item.executionId,
        "data-batch-key": props.batchKey || ""
      },
      h(
        "div",
        { className: "hao-timeline-step-head" },
        h("span", { className: "hao-phase" }, item.phase || "EXECUTION"),
        h(Badge, { value: item.status }),
        item.verdict ? h("span", { className: "hao-timeline-verdict" }, item.verdict) : null,
        h(
          "span",
          { className: "hao-timeline-time" },
          dateTime(item.startedAt, props.locale) + (item.lastObservedAt ? " · " + props.t.lastObserved + " " + dateTime(item.lastObservedAt, props.locale) : "")
        )
      ),
      h("div", { className: "hao-plan-meta" }, chips.map(function(value, index) {
        return h("span", { className: "hao-plan-chip", key: value + index }, value);
      })),
      item.strongModel && item.decisionReason ? h(
        "div",
        { className: "hao-audit-why" },
        h("strong", null, props.t.whyStrongModel + ": "),
        h("span", null, decisionReasonLabel(item.decisionReason, props.t)),
        (item.policyReasons || []).length ? h("div", { className: "hao-plan-meta" }, item.policyReasons.map(function(reason) {
          return h("span", { className: "hao-plan-chip", key: reason }, reason);
        })) : null
      ) : null,
      item.errorCode || item.errorDetail ? h("div", { className: "hao-plan-reason" }, [item.errorCode, item.errorDetail].filter(Boolean).join(" · ")) : null
    );
  }
  function TimelineEvent(props) {
    const item = props.event || {};
    return h(
      "div",
      { className: "hao-timeline-step hao-timeline-event" },
      h(
        "div",
        { className: "hao-timeline-step-head" },
        h("span", { className: "hao-phase" }, props.t.mechanicalEvent),
        h("strong", null, String(item.type || "EVENT").replace(/_/g, " ")),
        h("span", { className: "hao-timeline-time" }, dateTime(item.createdAt, props.locale))
      ),
      item.reason || item.message ? h("div", { className: "hao-plan-reason" }, [item.reason, item.message].filter(Boolean).join(" · ")) : null
    );
  }
  function PlanDetail(props) {
    const detail = props.detail;
    const t = props.t;
    const [auditFilter, setAuditFilter] = React.useState("all");
    const [batchFilter, setBatchFilter] = React.useState("all");
    const [targetExecutionId, setTargetExecutionId] = React.useState(null);
    if (props.loading) {
      return h(
        "div",
        { className: "hao-plan-detail-backdrop", onClick: props.onClose },
        h(
          "section",
          { className: "hao-plan-detail", onClick: function(event) {
            event.stopPropagation();
          } },
          h("div", { className: "hao-loading" }, "Loading…")
        )
      );
    }
    const plan = detail && detail.plan;
    const audit = detail && detail.audit || {};
    const repairIds = new Set((audit.attention || []).map(function(item) {
      return item.repairExecutionId;
    }).filter(Boolean));
    const controls = { setAuditFilter, setBatchFilter, setTargetExecutionId };
    function onJump(executionId, batchKey) {
      jumpToTimelineTarget(executionId, batchKey, controls);
    }
    const visibleBatches = !detail ? [] : (detail.batches || []).map(function(batch) {
      if (batchFilter !== "all" && batch.key !== batchFilter) return null;
      const controlFailure = (audit.attention || []).some(function(item) {
        return item.kind === "CONTROL_PLANE_FAILURE" && item.batchKey === batch.key && !item.resolved;
      });
      const workItems = (batch.workItems || []).map(function(work) {
        const executions = (work.executions || []).filter(function(execution) {
          return executionMatchesAuditFilter(execution, auditFilter, repairIds);
        });
        if (auditFilter !== "all" && !executions.length) return null;
        return Object.assign({}, work, { executions });
      }).filter(Boolean);
      if (auditFilter !== "all" && !workItems.length && !(auditFilter === "failures" && controlFailure)) return null;
      return Object.assign({}, batch, { workItems, showEvents: auditFilter === "all" || auditFilter === "failures" && controlFailure });
    }).filter(Boolean);
    return h(
      "div",
      { className: "hao-plan-detail-backdrop", onClick: props.onClose },
      h(
        "section",
        { className: "hao-plan-detail", role: "dialog", "aria-modal": "true", onClick: function(event) {
          event.stopPropagation();
        } },
        h(
          "header",
          { className: "hao-plan-detail-head" },
          h(
            "div",
            null,
            h("div", { className: "hao-running-top" }, plan ? h(Badge, { value: plan.status }) : null, h("span", { className: "hao-phase" }, t.planDetail)),
            h("h2", null, plan ? plan.objective : t.planDetail),
            plan ? h("div", { className: "hao-running-project" }, plan.projectKey + " · " + shortRevision(plan.currentRevision)) : null,
            plan && plan.governance ? h(
              "div",
              { className: "hao-plan-meta" },
              h("span", { className: "hao-plan-chip" }, props.t.governance + " · PR #" + (plan.governance.pullRequestNumber || "—")),
              plan.governance.producer ? h("span", { className: "hao-plan-chip" }, plan.governance.producer) : null,
              plan.governance.governedRevision ? h("span", { className: "hao-plan-chip" }, shortRevision(plan.governance.governedRevision)) : null,
              plan.governance.publishedPlanStatus ? h(Badge, { value: plan.governance.publishedPlanStatus }) : null
            ) : null
          ),
          h("button", { type: "button", className: "hao-button hao-button-secondary", onClick: props.onClose }, t.close)
        ),
        props.error ? h("div", { className: "hao-error" }, props.error) : null,
        detail ? h(
          "div",
          { className: "hao-plan-detail-body" },
          h(AuditOverview, { audit, t, locale: props.locale }),
          h(AuditAttention, { audit, t, locale: props.locale, onJump }),
          h(AuditFilters, { auditFilter, setAuditFilter, batchFilter, setBatchFilter, setTargetExecutionId, batches: detail.batches || [], t }),
          visibleBatches.length ? h("div", { className: "hao-timeline" }, visibleBatches.map(function(batch) {
            const isOpen = batch.status === "RUNNING" || batch.status === "BLOCKED" || batchFilter !== "all" || Boolean(targetExecutionId);
            const batchAudit = (audit.batches || []).find(function(item) {
              return item.key === batch.key;
            }) || {};
            const auditChips = [duration(batchAudit.durationMs || 0), compact(batchAudit.totalTokens || 0, props.locale) + " tok", money(batchAudit.costUsd || 0)];
            if (batchAudit.failures) auditChips.push(batchAudit.failures + " " + t.failures);
            if (batchAudit.repairs) auditChips.push(batchAudit.repairs + " " + t.repairs);
            if (batchAudit.strongModelExecutions) auditChips.push(batchAudit.strongModelExecutions + " " + t.strongModelUses);
            return h(
              "details",
              { id: "hao-batch-" + batch.key, className: "hao-timeline-batch", key: batch.key, open: isOpen, "data-batch-key": batch.key },
              h(
                "summary",
                null,
                h(
                  "div",
                  { className: "hao-timeline-batch-summary" },
                  h(Badge, { value: batch.status }),
                  h("strong", null, batch.key),
                  h("span", null, batch.title),
                  batch.system ? h("span", { className: "hao-plan-chip" }, t.systemWork) : null,
                  batch.integratedRevision ? h("span", { className: "hao-plan-chip" }, shortRevision(batch.integratedRevision)) : null
                ),
                h("div", { className: "hao-timeline-batch-audit" }, auditChips.map(function(value, index) {
                  return h("span", { className: "hao-plan-chip", key: value + index }, value);
                }))
              ),
              h(
                "div",
                { className: "hao-timeline-batch-body" },
                (batch.workItems || []).map(function(work) {
                  return h(
                    "section",
                    { className: "hao-timeline-work" + (work.system ? " is-system" : ""), key: work.key },
                    h(
                      "header",
                      { className: "hao-timeline-work-head" },
                      h(
                        "div",
                        null,
                        h("span", { className: "hao-timeline-work-kind" }, work.system ? t.systemWork : t.businessWork),
                        h("strong", null, work.key + " · " + work.title)
                      ),
                      h(Badge, { value: work.status })
                    ),
                    (work.executions || []).length ? h("div", { className: "hao-timeline-executions" }, (work.executions || []).map(function(execution) {
                      return h(TimelineExecution, { key: execution.executionId, execution, t, locale: props.locale, now: props.now, targetExecutionId, batchKey: batch.key });
                    })) : h("div", { className: "hao-muted hao-timeline-none" }, t.noTimeline),
                    work.blockedReason ? h("div", { className: "hao-plan-reason" }, work.blockedReason) : null
                  );
                }),
                batch.showEvents && (batch.events || []).length ? h("div", { className: "hao-timeline-events" }, (batch.events || []).map(function(event, index) {
                  return h(TimelineEvent, { key: event.type + index, event, t, locale: props.locale });
                })) : null,
                batch.blockedReason ? h("div", { className: "hao-plan-reason" }, batch.blockedReason) : null
              )
            );
          })) : h("div", { className: "hao-empty" }, t.filteredTimelineEmpty),
          auditFilter === "all" && batchFilter === "all" && (detail.deliveryEvents || []).length ? h(
            "section",
            { className: "hao-timeline-delivery" },
            h("h3", null, t.deliveryTimeline),
            (detail.deliveryEvents || []).map(function(event, index) {
              return h(TimelineEvent, { key: event.type + index, event, t, locale: props.locale });
            })
          ) : null
        ) : null
      )
    );
  }

  // dashboard/src/overview.js
  function portfolioHealthRank(plan) {
    const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 };
    const statusRank = { BLOCKED: 0, RUNNING: 1, PENDING: 2, ORCHESTRATING: 3, SUCCEEDED: 4, CANCELLED: 5 };
    const priority = String((plan.health || {}).topPriority || "").toUpperCase();
    const status = String(plan.status || "").toUpperCase();
    return [priorityRank[priority] == null ? 4 : priorityRank[priority], statusRank[status] == null ? 6 : statusRank[status], -Number((plan.health || {}).issueCount || 0), -Number(plan.updatedAt || 0)];
  }
  function comparePortfolioHealth(left, right) {
    const a = portfolioHealthRank(left);
    const b = portfolioHealthRank(right);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return String(left.projectKey || "").localeCompare(String(right.projectKey || ""));
  }
  function PlanCards(props) {
    const rows = (props.rows || []).slice().sort(comparePortfolioHealth);
    const t = props.t;
    if (!rows.length) return h("div", { className: "hao-empty" }, props.locale === "zh" ? "暂无项目计划" : "No development plans");
    return h("div", { className: "hao-running-grid" }, rows.map(function(plan) {
      const batch = plan.currentBatch || {};
      const activity = plan.currentActivity || {};
      const health = plan.health || {};
      const topIssue = health.topIssue || {};
      const syncing = Boolean(props.syncingPlanIds && props.syncingPlanIds[plan.planId]);
      const activityTitle = activity.workItemTitle || activity.batchTitle || batch.title || "All batches complete";
      const phase = activity.phase || plan.deliveryStage;
      const meta = [];
      if (activity.attempt) meta.push(t.attempt + " " + activity.attempt);
      if (activity.backend) meta.push(activity.backend);
      if (activity.model) meta.push(activity.model);
      const revision = shortRevision(activity.revision);
      if (revision) meta.push(revision);
      if (activity.lastObservedAt) meta.push(t.lastObserved + " " + dateTime(activity.lastObservedAt, props.locale));
      if (plan.governance && plan.governance.pullRequestNumber) meta.push("PR #" + plan.governance.pullRequestNumber);
      if (plan.governance && plan.governance.publishedPlanStatus) meta.push(t.governance + " " + plan.governance.publishedPlanStatus);
      const progress = [
        plan.workItems.succeeded + "/" + plan.workItems.total + " " + t.items,
        plan.batches.succeeded + "/" + plan.batches.total + " " + t.batches
      ];
      if (plan.systemWorkItems && plan.systemWorkItems.total) {
        progress.push(plan.systemWorkItems.succeeded + "/" + plan.systemWorkItems.total + " " + t.automation);
      }
      function openPlan() {
        props.onOpen(plan);
      }
      return h(
        "article",
        {
          className: "hao-running-card hao-plan-card hao-plan-card-clickable",
          key: plan.planId,
          role: "button",
          tabIndex: 0,
          onClick: openPlan,
          onKeyDown: function(event) {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openPlan();
            }
          }
        },
        h(
          "div",
          { className: "hao-running-top" },
          h("div", { className: "hao-running-top-left" }, h(Badge, { value: plan.status }), h("span", { className: "hao-phase" }, phase || batch.key || "complete")),
          h(HealthSummary, { health, t })
        ),
        h("h3", null, plan.objective),
        h("div", { className: "hao-running-project" }, plan.projectKey),
        h(
          "div",
          { className: "hao-plan-activity" },
          h("strong", null, activityLabel(activity.kind, t)),
          h("span", null, activityTitle)
        ),
        meta.length ? h("div", { className: "hao-plan-meta" }, meta.map(function(value, index) {
          return h("span", { className: "hao-plan-chip", key: value + index }, value);
        })) : null,
        h("div", { className: "hao-plan-progress" }, progress.join(" · ")),
        topIssue.reason || activity.reason || plan.blockedReason ? h(
          "div",
          { className: "hao-plan-reason hao-plan-health-issue" },
          topIssue.priority ? h("span", { className: "hao-health-priority hao-health-priority-" + String(topIssue.priority).toLowerCase() }, topIssue.priority) : null,
          h("span", null, topIssue.reason || activity.reason || plan.blockedReason)
        ) : null,
        h(
          "div",
          { className: "hao-plan-card-actions" },
          plan.status === "BLOCKED" && batch.status === "BLOCKED" ? h("button", {
            type: "button",
            className: "hao-button hao-plan-continue-button",
            disabled: syncing,
            onClick: function(event) {
              event.stopPropagation();
              props.onHandoff(plan);
            }
          }, t.continueHandoff) : null,
          plan.status === "BLOCKED" && batch.status === "BLOCKED" ? h("button", {
            type: "button",
            className: "hao-button hao-button-secondary hao-plan-scan-button",
            disabled: syncing,
            onClick: function(event) {
              event.stopPropagation();
              props.onScan(plan);
            }
          }, syncing ? t.syncingExternal : t.continueExternal) : null,
          plan.pullRequestUrl ? h("a", {
            className: "hao-button hao-button-secondary",
            href: plan.pullRequestUrl,
            target: "_blank",
            rel: "noreferrer",
            onClick: function(event) {
              event.stopPropagation();
            }
          }, "PR") : null,
          h("button", {
            type: "button",
            className: "hao-button hao-button-secondary hao-plan-details-button",
            onClick: function(event) {
              event.stopPropagation();
              openPlan();
            }
          }, t.details)
        )
      );
    }));
  }
  function Overview(props) {
    const data = props.data;
    const t = props.t;
    const s = data.summary || {};
    const registryData = data.registry || {};
    const deployments = registryData.deployments || {};
    const projectStats = data.planSummary || {};
    const criticalProjects = (data.plans || []).filter(function(plan) {
      return String((plan.health || {}).state || "").toUpperCase() === "CRITICAL";
    }).length;
    const [search, setSearch] = React.useState("");
    const query = search.trim().toLowerCase();
    const history = (data.history || []).filter(function(item) {
      if (!query) return true;
      return [item.projectKey, item.objective, item.phase, item.status, item.logicalModel, routeLabel(item)].join(" ").toLowerCase().includes(query);
    });
    return h(
      React.Fragment,
      null,
      h(
        "section",
        { className: "hao-metrics" },
        h(Metric, { primary: true, label: t.active, value: integer(s.activeExecutions, props.locale), hint: integer(s.totalExecutions, props.locale) + " total" }),
        h(Metric, { label: t.spend, value: money(s.costUsd), hint: integer(s.calls, props.locale) + " " + t.calls.toLowerCase() }),
        h(Metric, { label: t.tokens, value: compact(s.totalTokens, props.locale), hint: t.cache + " " + compact(s.cachedInput, props.locale) }),
        h(Metric, { label: t.duration, value: duration(s.totalDurationMs), hint: integer(s.terminalExecutions, props.locale) + " terminal" }),
        h(Metric, { label: t.success, value: percentage(s.successRate), hint: integer(s.succeeded, props.locale) + " / " + integer(s.failed, props.locale) }),
        h(Metric, { label: t.calls, value: compact(s.calls, props.locale), hint: t.reasoning + " " + compact(s.reasoningOutput, props.locale) })
      ),
      h(Panel, { title: t.running, className: "hao-running-panel" }, h(RunningCards, { rows: data.active, t, locale: props.locale, now: props.now })),
      h(Panel, { title: t.plans, className: "hao-running-panel" }, h(PlanCards, { rows: data.plans, t, locale: props.locale, onOpen: props.onOpenPlan, onHandoff: props.onHandoffPlan, onScan: props.onScanPlan, syncingPlanIds: props.syncingPlanIds })),
      h(
        "div",
        { className: "hao-runtime-strip" },
        h("div", null, h("span", null, t.runtime), h(Badge, { value: ((data.runtime || {}).sourceHealth || {}).openhands || "UNKNOWN" }), h("span", null, "LiteLLM"), h(Badge, { value: ((data.runtime || {}).sourceHealth || {}).litellm || registryData.health || "UNKNOWN" })),
        h(
          "div",
          null,
          h("span", null, t.projectStats),
          h("strong", null, integer(projectStats.active || 0, props.locale)),
          h("span", null, t.implementingProjects),
          h("strong", null, integer(projectStats.succeeded || 0, props.locale)),
          h("span", null, t.completedProjects),
          h("strong", null, integer(projectStats.blocked || 0, props.locale)),
          h("span", null, t.blockedProjects),
          criticalProjects ? h("span", { className: "hao-health-priority hao-health-priority-p0" }, criticalProjects + " " + t.criticalProjects) : null
        ),
        h("div", null, h("span", null, t.providers), h("strong", null, integer(deployments.active || 0, props.locale)), h("span", null, t.activeDeployments), h("span", { className: "hao-muted" }, integer(deployments.paused || 0, props.locale) + " " + t.pausedDeployments))
      ),
      h(Panel, {
        title: t.history,
        action: h("input", { className: "hao-search", value: search, placeholder: t.search, onChange: function(event) {
          setSearch(event.target.value);
        } })
      }, h(ExecutionTable, { rows: history, t, locale: props.locale, now: props.now }))
    );
  }

  // dashboard/src/app.js
  function App() {
    const locale = useLocale();
    const themeMode = useThemeMode();
    const t = COPY[locale];
    const [view, setView] = React.useState("overview");
    const [data, setData] = React.useState(null);
    const [error, setError] = React.useState("");
    const [loading, setLoading] = React.useState(true);
    const [now, setNow] = React.useState(Date.now());
    const [detailPlanId, setDetailPlanId] = React.useState(null);
    const [planDetail, setPlanDetail] = React.useState(null);
    const [detailLoading, setDetailLoading] = React.useState(false);
    const [detailError, setDetailError] = React.useState("");
    const [syncingPlanIds, setSyncingPlanIds] = React.useState({});
    const [handoffPlan, setHandoffPlan] = React.useState(null);
    const [handoffText, setHandoffText] = React.useState("");
    const [handoffError, setHandoffError] = React.useState("");
    const [handoffSubmitting, setHandoffSubmitting] = React.useState(false);
    const load = React.useCallback(function() {
      setLoading(true);
      return api("/dashboard").then(assertDashboardContract).then(function(value) {
        setData(value);
        setError("");
      }).catch(function(cause) {
        setError(String(cause));
      }).finally(function() {
        setLoading(false);
      });
    }, []);
    function openPlan(plan) {
      setDetailPlanId(plan.planId);
      setPlanDetail(null);
      setDetailError("");
      setDetailLoading(true);
      return api("/plans/" + encodeURIComponent(plan.planId)).then(assertPlanDetailContract).then(function(value) {
        setPlanDetail(value);
      }).catch(function(cause) {
        setDetailError(String(cause));
      }).finally(function() {
        setDetailLoading(false);
      });
    }
    function extractHandoff(text) {
      let source = String(text || "").trim();
      const marker = source.indexOf("AI_OFFICE_HANDOFF_V1");
      if (marker >= 0) source = source.slice(marker + "AI_OFFICE_HANDOFF_V1".length);
      const first = source.indexOf("{");
      const last = source.lastIndexOf("}");
      if (first < 0 || last <= first) throw new Error(t.handoffInvalid);
      return JSON.parse(source.slice(first, last + 1));
    }
    function openHandoff(plan) {
      setHandoffPlan(plan);
      setHandoffText("");
      setHandoffError("");
    }
    function closeHandoff() {
      if (handoffSubmitting) return;
      setHandoffPlan(null);
      setHandoffText("");
      setHandoffError("");
    }
    function resumeFromHandoff() {
      if (!handoffPlan) return Promise.resolve();
      let handoff;
      try {
        handoff = extractHandoff(handoffText);
      } catch (cause) {
        setHandoffError(cause instanceof Error ? cause.message : t.handoffInvalid);
        return Promise.resolve();
      }
      setHandoffSubmitting(true);
      setHandoffError("");
      return api("/plans/" + encodeURIComponent(handoffPlan.planId) + "/resume-from-handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(handoff)
      }).then(function() {
        setError("");
        setHandoffPlan(null);
        setHandoffText("");
        window.setTimeout(load, 500);
        window.setTimeout(load, 2500);
      }).catch(function(cause) {
        setHandoffError(String(cause));
      }).finally(function() {
        setHandoffSubmitting(false);
      });
    }
    function syncExternalProgress(plan) {
      if (window.confirm && !window.confirm(t.continueExternalConfirm)) return Promise.resolve();
      const planId = plan.planId;
      setSyncingPlanIds(function(current) {
        return Object.assign({}, current, { [planId]: true });
      });
      return api("/plans/" + encodeURIComponent(plan.planId) + "/sync-and-continue", { method: "POST" }).then(function() {
        setError("");
        window.setTimeout(load, 1e3);
        window.setTimeout(load, 5e3);
        window.setTimeout(load, 15e3);
        window.setTimeout(load, 3e4);
        window.setTimeout(function() {
          setSyncingPlanIds(function(current) {
            const next = Object.assign({}, current);
            delete next[planId];
            return next;
          });
        }, 12 * 60 * 1e3);
      }).catch(function(cause) {
        setError(String(cause));
        setSyncingPlanIds(function(current) {
          const next = Object.assign({}, current);
          delete next[planId];
          return next;
        });
      });
    }
    function closePlan() {
      setDetailPlanId(null);
      setPlanDetail(null);
      setDetailError("");
      setDetailLoading(false);
    }
    React.useEffect(function() {
      if (!data) return;
      setSyncingPlanIds(function(current) {
        const next = Object.assign({}, current);
        let changed = false;
        (data.plans || []).forEach(function(plan) {
          if (next[plan.planId] && plan.status !== "BLOCKED") {
            delete next[plan.planId];
            changed = true;
          }
        });
        return changed ? next : current;
      });
    }, [data]);
    React.useEffect(function() {
      load();
      const refresh = window.setInterval(load, 15e3);
      const clock = window.setInterval(function() {
        setNow(Date.now());
      }, 1e3);
      return function() {
        window.clearInterval(refresh);
        window.clearInterval(clock);
      };
    }, [load]);
    React.useEffect(function() {
      if (!detailPlanId) return void 0;
      function onKeyDown(event) {
        if (event.key === "Escape") closePlan();
      }
      window.addEventListener("keydown", onKeyDown);
      return function() {
        window.removeEventListener("keydown", onKeyDown);
      };
    }, [detailPlanId]);
    React.useEffect(function() {
      if (!handoffPlan) return void 0;
      function onKeyDown(event) {
        if (event.key === "Escape") closeHandoff();
      }
      window.addEventListener("keydown", onKeyDown);
      return function() {
        window.removeEventListener("keydown", onKeyDown);
      };
    }, [handoffPlan, handoffSubmitting]);
    const adminUrl = data && data.registry && data.registry.adminUrl;
    return h(
      "main",
      { className: "hao-shell", "data-theme-mode": themeMode },
      h(
        "header",
        { className: "hao-toolbar" },
        h(
          "nav",
          { className: "hao-toolbar-nav" },
          h("button", { type: "button", className: view === "overview" ? "is-active" : "", onClick: function() {
            setView("overview");
          } }, t.overview),
          h("button", { type: "button", className: view === "analytics" ? "is-active" : "", onClick: function() {
            setView("analytics");
          } }, t.analytics)
        ),
        h(
          "div",
          { className: "hao-toolbar-actions" },
          data ? h("span", { className: "hao-updated" }, t.updated + " " + dateTime(data.generatedAt, locale)) : null,
          adminUrl ? h("a", { className: "hao-button hao-button-secondary", href: adminUrl, target: "_blank", rel: "noreferrer" }, t.admin) : null,
          h("button", { className: "hao-button", type: "button", onClick: load, disabled: loading }, loading ? "…" : t.refresh)
        )
      ),
      error ? h("div", { className: "hao-error" }, error) : null,
      !data ? h("div", { className: "hao-loading" }, loading ? "Loading…" : "No data") : view === "analytics" ? h(Analytics, { data, t, locale }) : h(Overview, { data, t, locale, now, onOpenPlan: openPlan, onHandoffPlan: openHandoff, onScanPlan: syncExternalProgress, syncingPlanIds }),
      detailPlanId ? h(PlanDetail, { detail: planDetail, loading: detailLoading, error: detailError, onClose: closePlan, t, locale, now }) : null,
      handoffPlan ? h(
        "div",
        { className: "hao-handoff-backdrop", role: "presentation", onMouseDown: function(event) {
          if (event.target === event.currentTarget) closeHandoff();
        } },
        h(
          "section",
          { className: "hao-handoff-dialog", role: "dialog", "aria-modal": "true", "aria-label": t.handoffTitle },
          h(
            "div",
            { className: "hao-handoff-head" },
            h("div", null, h("h2", null, t.handoffTitle), h("span", null, handoffPlan.projectKey)),
            h("button", { type: "button", className: "hao-button hao-button-secondary", onClick: closeHandoff, disabled: handoffSubmitting }, "×")
          ),
          h("p", { className: "hao-handoff-help" }, t.handoffHelp),
          h("textarea", {
            className: "hao-handoff-textarea",
            value: handoffText,
            placeholder: t.handoffPlaceholder,
            spellCheck: false,
            autoFocus: true,
            onChange: function(event) {
              setHandoffText(event.target.value);
              setHandoffError("");
            }
          }),
          handoffError ? h("div", { className: "hao-error hao-handoff-error" }, handoffError) : null,
          h(
            "div",
            { className: "hao-handoff-actions" },
            h("button", { type: "button", className: "hao-button hao-button-secondary", onClick: closeHandoff, disabled: handoffSubmitting }, t.handoffCancel),
            h("button", { type: "button", className: "hao-button", onClick: resumeFromHandoff, disabled: handoffSubmitting || !handoffText.trim() }, handoffSubmitting ? t.handoffSubmitting : t.handoffSubmit)
          )
        )
      ) : null
    );
  }

  // dashboard/src/index.js
  if (runtimeReady) registry.register("hermes-ai-office", App);
})();
