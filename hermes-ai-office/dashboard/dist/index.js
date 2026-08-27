(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  const registry = window.__HERMES_PLUGINS__;
  if (!SDK || !registry || typeof registry.register !== "function") return;
  const React = SDK.React;
  const h = React.createElement;
  const fetchJSON = SDK.fetchJSON;
  const API_ROOT = "/api/plugins/hermes-ai-office";
  const DASHBOARD_SCHEMA_VERSION = 7;
  if (typeof fetchJSON !== "function") return;

  function useLocale() {
    const hook = SDK.useI18n;
    if (hook) {
      const value = hook();
      return String(value && value.locale ? value.locale : "en").toLowerCase().startsWith("zh") ? "zh" : "en";
    }
    return "en";
  }

  const COPY = {
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
    },
  };

  function api(path) {
    return fetchJSON(API_ROOT + path);
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
      return match[1].split("").map(function (digit) { return parseInt(digit + digit, 16); });
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
    React.useEffect(function () {
      let frame = 0;
      function update() {
        window.cancelAnimationFrame(frame);
        frame = window.requestAnimationFrame(function () { setMode(detectThemeMode()); });
      }
      const observer = new MutationObserver(update);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
      if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
      if (document.head) observer.observe(document.head, { childList: true, subtree: true, attributes: true });
      const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
      if (media && media.addEventListener) media.addEventListener("change", update);
      update();
      return function () {
        observer.disconnect();
        if (media && media.removeEventListener) media.removeEventListener("change", update);
        window.cancelAnimationFrame(frame);
      };
    }, []);
    return mode;
  }

  function num(value) {
    return Number(value || 0);
  }
  function compact(value, locale) {
    return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
      notation: "compact",
      maximumFractionDigits: 1,
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
    if (value < 1000) return Math.round(value) + "ms";
    const seconds = Math.floor(value / 1000);
    if (seconds < 60) return seconds + "s";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "m " + (seconds % 60) + "s";
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "h " + (minutes % 60) + "m";
    return Math.floor(hours / 24) + "d " + (hours % 24) + "h";
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
      second: "2-digit",
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
      WORK_ITEM: t.activityWorkItem,
    };
    return labels[String(kind || "").toUpperCase()] || String(kind || t.activityIdle).replace(/_/g, " ");
  }
  function shortRevision(value) {
    const text = String(value || "");
    return text ? text.slice(0, 10) : null;
  }

  function Badge(props) {
    const value = String(props.value || "UNKNOWN").toUpperCase();
    return h("span", { className: "hao-badge hao-badge-" + value.toLowerCase().replace(/_/g, "-") }, value);
  }
  function Metric(props) {
    return h(
      "article",
      { className: "hao-metric" + (props.primary ? " hao-metric-primary" : "") },
      h("span", { className: "hao-metric-label" }, props.label),
      h("strong", { className: "hao-metric-value" }, props.value),
      props.hint ? h("span", { className: "hao-metric-hint" }, props.hint) : null,
    );
  }
  function Panel(props) {
    return h(
      "section",
      { className: "hao-panel " + (props.className || "") },
      props.title
        ? h("header", { className: "hao-panel-head" }, h("div", null, h("h2", null, props.title), props.subtitle ? h("p", null, props.subtitle) : null), props.action || null)
        : null,
      props.children,
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
          h("tr", null,
            h("th", null, t.project),
            h("th", null, t.task),
            h("th", null, t.phase),
            h("th", null, t.status),
            h("th", null, t.model),
            h("th", null, t.route),
            h("th", null, t.started),
            h("th", null, t.elapsed),
            h("th", { className: "hao-right" }, "Token"),
            h("th", { className: "hao-right" }, t.cost),
          ),
        ),
        h(
          "tbody",
          null,
          rows.map(function (item) {
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
              h("td", { className: "hao-right hao-mono" }, compact(item.totalTokens || 0, locale)),
              h("td", { className: "hao-right hao-mono" }, money(item.usage && item.usage.costUsd)),
            );
          }),
        ),
      ),
    );
  }

  function RunningCards(props) {
    const rows = props.rows || [];
    if (!rows.length) return h("div", { className: "hao-empty" }, props.t.noRunning);
    return h(
      "div",
      { className: "hao-running-grid" },
      rows.map(function (item) {
        return h(
          "article",
          { className: "hao-running-card", key: item.executionId },
          h("div", { className: "hao-running-top" }, h(Badge, { value: item.status }), h("span", { className: "hao-phase" }, item.phase)),
          h("h3", null, item.objective || item.projectKey),
          h("div", { className: "hao-running-project" }, item.projectKey),
          h("div", { className: "hao-running-route" }, item.logicalModel, h("span", null, "→"), routeLabel(item)),
          h("div", { className: "hao-running-foot" },
            h("span", null, props.t.started + " " + dateTime(item.startedAt, props.locale)),
            h("strong", null, duration(runningElapsed(item, props.now))),
          ),
          h("div", { className: "hao-running-usage" },
            h("span", null, compact(item.totalTokens || 0, props.locale) + " tok"),
            h("span", null, money(item.usage && item.usage.costUsd)),
          ),
        );
      }),
    );
  }

  function decisionReasonLabel(reason, t) {
    const labels = {
      BATCH_AGGREGATE_REVIEW: t.decisionBatchAggregateReview,
      INTEGRATION_REPAIR: t.decisionIntegrationRepair,
      POST_MERGE_RECOVERY: t.decisionPostMergeRecovery,
      DELIVERY_REPAIR: t.decisionDeliveryRepair,
      INDEPENDENT_REVIEW: t.decisionIndependentReview,
      FAILED_VERIFICATION_REPAIR: t.decisionFailedVerificationRepair,
      STRONG_MODEL_POLICY: t.decisionStrongModelPolicy,
    };
    return labels[reason] || String(reason || "").replace(/_/g, " ");
  }

  function AuditOverview(props) {
    const summary = (props.audit && props.audit.summary) || {};
    const metrics = [
      [props.t.auditExecutions, integer(summary.executions || 0, props.locale)],
      [props.t.failures, integer(summary.failures || 0, props.locale)],
      [props.t.repairs, integer(summary.repairs || 0, props.locale)],
      [props.t.strongModelUses, integer(summary.strongModelExecutions || 0, props.locale)],
      [props.t.duration, duration(summary.durationMs || 0)],
      ["Token", compact(summary.totalTokens || 0, props.locale)],
      [props.t.cost, money(summary.costUsd || 0)],
    ];
    return h("section", { className: "hao-audit" },
      h("div", { className: "hao-audit-head" }, h("h3", null, props.t.auditTitle)),
      h("div", { className: "hao-audit-metrics" }, metrics.map(function (item) {
        return h("div", { className: "hao-audit-metric", key: item[0] }, h("span", null, item[0]), h("strong", null, item[1]));
      }))
    );
  }

  function AuditAttention(props) {
    const audit = props.audit || {};
    const attention = audit.attention || [];
    const decisions = audit.strongModelDecisions || [];
    if (!attention.length && !decisions.length) return null;
    return h("section", { className: "hao-audit-grid" },
      attention.length ? h("div", { className: "hao-audit-panel" },
        h("h3", null, props.t.attentionTitle),
        h("div", { className: "hao-audit-attention" }, attention.map(function (item, index) {
          const label = item.kind === "CONTROL_PLANE_FAILURE" ? props.t.controlPlaneFailure : props.t.failureToRepair;
          return h("article", { className: "hao-audit-finding" + (item.resolved ? " is-resolved" : " is-open"), key: item.kind + index },
            h("div", { className: "hao-audit-finding-head" }, h("strong", null, label), h(Badge, { value: item.resolved ? "SUCCEEDED" : "BLOCKED" })),
            h("div", { className: "hao-audit-path" }, [item.batchKey, item.workItemKey, item.sourcePhase].filter(Boolean).join(" · ")),
            item.reason ? h("div", { className: "hao-plan-reason" }, item.reason) : null,
            item.repairExecutionId ? h("div", { className: "hao-audit-link" }, shortRevision(item.sourceExecutionId) + " → " + shortRevision(item.repairExecutionId)) : null
          );
        }))
      ) : null,
      decisions.length ? h("div", { className: "hao-audit-panel" },
        h("h3", null, props.t.strongModelTitle),
        h("div", { className: "hao-audit-decisions" }, decisions.map(function (item) {
          return h("article", { className: "hao-audit-decision", key: item.executionId },
            h("div", { className: "hao-audit-finding-head" }, h("strong", null, decisionReasonLabel(item.reason, props.t)), h("span", { className: "hao-plan-chip" }, item.model || "—")),
            h("div", { className: "hao-audit-path" }, [item.batchKey, item.workItemKey, item.phase, item.backend].filter(Boolean).join(" · ")),
            (item.policyReasons || []).length ? h("div", { className: "hao-plan-meta" }, item.policyReasons.map(function (reason) { return h("span", { className: "hao-plan-chip", key: reason }, reason); })) : null
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
    return h("div", { className: "hao-timeline-step" },
      h("div", { className: "hao-timeline-step-head" },
        h("span", { className: "hao-phase" }, item.phase || "EXECUTION"),
        h(Badge, { value: item.status }),
        item.verdict ? h("span", { className: "hao-timeline-verdict" }, item.verdict) : null,
        h("span", { className: "hao-timeline-time" }, dateTime(item.startedAt, props.locale))
      ),
      h("div", { className: "hao-plan-meta" }, chips.map(function (value, index) {
        return h("span", { className: "hao-plan-chip", key: value + index }, value);
      })),
      item.strongModel && item.decisionReason
        ? h("div", { className: "hao-audit-why" },
            h("strong", null, props.t.whyStrongModel + ": "),
            h("span", null, decisionReasonLabel(item.decisionReason, props.t)),
            (item.policyReasons || []).length ? h("div", { className: "hao-plan-meta" }, item.policyReasons.map(function (reason) { return h("span", { className: "hao-plan-chip", key: reason }, reason); })) : null
          )
        : null,
      item.errorCode || item.errorDetail
        ? h("div", { className: "hao-plan-reason" }, [item.errorCode, item.errorDetail].filter(Boolean).join(" · "))
        : null,
    );
  }

  function TimelineEvent(props) {
    const item = props.event || {};
    return h("div", { className: "hao-timeline-step hao-timeline-event" },
      h("div", { className: "hao-timeline-step-head" },
        h("span", { className: "hao-phase" }, props.t.mechanicalEvent),
        h("strong", null, String(item.type || "EVENT").replace(/_/g, " ")),
        h("span", { className: "hao-timeline-time" }, dateTime(item.createdAt, props.locale))
      ),
      item.reason || item.message
        ? h("div", { className: "hao-plan-reason" }, [item.reason, item.message].filter(Boolean).join(" · "))
        : null,
    );
  }

  function PlanDetail(props) {
    const detail = props.detail;
    const t = props.t;
    if (props.loading) {
      return h("div", { className: "hao-plan-detail-backdrop", onClick: props.onClose },
        h("section", { className: "hao-plan-detail", onClick: function (event) { event.stopPropagation(); } },
          h("div", { className: "hao-loading" }, "Loading…")
        )
      );
    }
    const plan = detail && detail.plan;
    return h("div", { className: "hao-plan-detail-backdrop", onClick: props.onClose },
      h("section", { className: "hao-plan-detail", role: "dialog", "aria-modal": "true", onClick: function (event) { event.stopPropagation(); } },
        h("header", { className: "hao-plan-detail-head" },
          h("div", null,
            h("div", { className: "hao-running-top" }, plan ? h(Badge, { value: plan.status }) : null, h("span", { className: "hao-phase" }, t.planDetail)),
            h("h2", null, plan ? plan.objective : t.planDetail),
            plan ? h("div", { className: "hao-running-project" }, plan.projectKey + " · " + shortRevision(plan.currentRevision)) : null
          ),
          h("button", { type: "button", className: "hao-button hao-button-secondary", onClick: props.onClose }, t.close)
        ),
        props.error ? h("div", { className: "hao-error" }, props.error) : null,
        detail ? h("div", { className: "hao-plan-detail-body" },
          h(AuditOverview, { audit: detail.audit, t: t, locale: props.locale }),
          h(AuditAttention, { audit: detail.audit, t: t, locale: props.locale }),
          (detail.batches || []).length
            ? h("div", { className: "hao-timeline" }, (detail.batches || []).map(function (batch) {
                const isOpen = batch.status === "RUNNING" || batch.status === "BLOCKED";
                const batchAudit = ((((detail.audit || {}).batches) || []).find(function (item) { return item.key === batch.key; })) || {};
                const auditChips = [duration(batchAudit.durationMs || 0), compact(batchAudit.totalTokens || 0, props.locale) + " tok", money(batchAudit.costUsd || 0)];
                if (batchAudit.failures) auditChips.push(batchAudit.failures + " " + t.failures);
                if (batchAudit.repairs) auditChips.push(batchAudit.repairs + " " + t.repairs);
                if (batchAudit.strongModelExecutions) auditChips.push(batchAudit.strongModelExecutions + " " + t.strongModelUses);
                return h("details", { className: "hao-timeline-batch", key: batch.key, open: isOpen },
                  h("summary", null,
                    h("div", { className: "hao-timeline-batch-summary" },
                      h(Badge, { value: batch.status }),
                      h("strong", null, batch.key),
                      h("span", null, batch.title),
                      batch.system ? h("span", { className: "hao-plan-chip" }, t.systemWork) : null,
                      batch.integratedRevision ? h("span", { className: "hao-plan-chip" }, shortRevision(batch.integratedRevision)) : null
                    ),
                    h("div", { className: "hao-timeline-batch-audit" }, auditChips.map(function (value, index) { return h("span", { className: "hao-plan-chip", key: value + index }, value); }))
                  ),
                  h("div", { className: "hao-timeline-batch-body" },
                    (batch.workItems || []).map(function (work) {
                      return h("section", { className: "hao-timeline-work" + (work.system ? " is-system" : ""), key: work.key },
                        h("header", { className: "hao-timeline-work-head" },
                          h("div", null,
                            h("span", { className: "hao-timeline-work-kind" }, work.system ? t.systemWork : t.businessWork),
                            h("strong", null, work.key + " · " + work.title)
                          ),
                          h(Badge, { value: work.status })
                        ),
                        (work.executions || []).length
                          ? h("div", { className: "hao-timeline-executions" }, (work.executions || []).map(function (execution) {
                              return h(TimelineExecution, { key: execution.executionId, execution: execution, t: t, locale: props.locale, now: props.now });
                            }))
                          : h("div", { className: "hao-muted hao-timeline-none" }, t.noTimeline),
                        work.blockedReason ? h("div", { className: "hao-plan-reason" }, work.blockedReason) : null
                      );
                    }),
                    (batch.events || []).length
                      ? h("div", { className: "hao-timeline-events" }, (batch.events || []).map(function (event, index) {
                          return h(TimelineEvent, { key: event.type + index, event: event, t: t, locale: props.locale });
                        }))
                      : null,
                    batch.blockedReason ? h("div", { className: "hao-plan-reason" }, batch.blockedReason) : null
                  )
                );
              }))
            : h("div", { className: "hao-empty" }, t.noTimeline),
          (detail.deliveryEvents || []).length
            ? h("section", { className: "hao-timeline-delivery" },
                h("h3", null, t.deliveryTimeline),
                (detail.deliveryEvents || []).map(function (event, index) {
                  return h(TimelineEvent, { key: event.type + index, event: event, t: t, locale: props.locale });
                })
              )
            : null
        ) : null
      )
    );
  }

  function PlanCards(props) {
    const rows = props.rows || [];
    const t = props.t;
    if (!rows.length) return h("div", { className: "hao-empty" }, props.locale === "zh" ? "暂无项目计划" : "No development plans");
    return h("div", { className: "hao-running-grid" }, rows.map(function (plan) {
      const batch = plan.currentBatch || {};
      const activity = plan.currentActivity || {};
      const activityTitle = activity.workItemTitle || activity.batchTitle || batch.title || "All batches complete";
      const phase = activity.phase || plan.deliveryStage;
      const meta = [];
      if (activity.attempt) meta.push(t.attempt + " " + activity.attempt);
      if (activity.backend) meta.push(activity.backend);
      if (activity.model) meta.push(activity.model);
      const revision = shortRevision(activity.revision);
      if (revision) meta.push(revision);
      const progress = [
        plan.workItems.succeeded + "/" + plan.workItems.total + " " + t.items,
        plan.batches.succeeded + "/" + plan.batches.total + " " + t.batches,
      ];
      if (plan.systemWorkItems && plan.systemWorkItems.total) {
        progress.push(plan.systemWorkItems.succeeded + "/" + plan.systemWorkItems.total + " " + t.automation);
      }
      function openPlan() { props.onOpen(plan); }
      return h("article", {
        className: "hao-running-card hao-plan-card hao-plan-card-clickable",
        key: plan.planId,
        role: "button",
        tabIndex: 0,
        onClick: openPlan,
        onKeyDown: function (event) {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openPlan(); }
        },
      },
        h("div", { className: "hao-running-top" },
          h(Badge, { value: plan.status }),
          h("span", { className: "hao-phase" }, phase || batch.key || "complete")
        ),
        h("h3", null, plan.objective),
        h("div", { className: "hao-running-project" }, plan.projectKey),
        h("div", { className: "hao-plan-activity" },
          h("strong", null, activityLabel(activity.kind, t)),
          h("span", null, activityTitle)
        ),
        meta.length ? h("div", { className: "hao-plan-meta" }, meta.map(function (value, index) {
          return h("span", { className: "hao-plan-chip", key: value + index }, value);
        })) : null,
        h("div", { className: "hao-plan-progress" }, progress.join(" · ")),
        activity.reason || plan.blockedReason
          ? h("div", { className: "hao-plan-reason" }, activity.reason || plan.blockedReason)
          : null,
        plan.pullRequestUrl ? h("div", { className: "hao-running-foot" }, h("a", {
          href: plan.pullRequestUrl, target: "_blank", rel: "noreferrer",
          onClick: function (event) { event.stopPropagation(); }
        }, "Pull request")) : null,
      );
    }));
  }

  function Overview(props) {
    const data = props.data;
    const t = props.t;
    const s = data.summary || {};
    const registryData = data.registry || {};
    const deployments = registryData.deployments || {};
    const readiness = data.readiness || {};
    const representative = (readiness.gates && readiness.gates.representativeWorkflows) || {};
    const [search, setSearch] = React.useState("");
    const query = search.trim().toLowerCase();
    const history = (data.history || []).filter(function (item) {
      if (!query) return true;
      return [item.projectKey, item.objective, item.phase, item.status, item.logicalModel, routeLabel(item)].join(" ").toLowerCase().includes(query);
    });
    return h(
      React.Fragment,
      null,
      h("section", { className: "hao-metrics" },
        h(Metric, { primary: true, label: t.active, value: integer(s.activeExecutions, props.locale), hint: integer(s.totalExecutions, props.locale) + " total" }),
        h(Metric, { label: t.spend, value: money(s.costUsd), hint: integer(s.calls, props.locale) + " " + t.calls.toLowerCase() }),
        h(Metric, { label: t.tokens, value: compact(s.totalTokens, props.locale), hint: t.cache + " " + compact(s.cachedInput, props.locale) }),
        h(Metric, { label: t.duration, value: duration(s.totalDurationMs), hint: integer(s.terminalExecutions, props.locale) + " terminal" }),
        h(Metric, { label: t.success, value: percentage(s.successRate), hint: integer(s.succeeded, props.locale) + " / " + integer(s.failed, props.locale) }),
        h(Metric, { label: t.calls, value: compact(s.calls, props.locale), hint: t.reasoning + " " + compact(s.reasoningOutput, props.locale) }),
      ),
      h(Panel, { title: t.running, className: "hao-running-panel" }, h(RunningCards, { rows: data.active, t: t, locale: props.locale, now: props.now })),
      h(Panel, { title: t.plans, className: "hao-running-panel" }, h(PlanCards, { rows: data.plans, t: t, locale: props.locale, onOpen: props.onOpenPlan })),
      h(
        "div",
        { className: "hao-runtime-strip" },
        h("div", null, h("span", null, t.runtime), h(Badge, { value: ((data.runtime || {}).sourceHealth || {}).openhands || "UNKNOWN" }), h("span", null, "LiteLLM"), h(Badge, { value: ((data.runtime || {}).sourceHealth || {}).litellm || registryData.health || "UNKNOWN" })),
        h("div", null, h("span", null, t.readiness), h("strong", null, (representative.current || 0) + "/" + (representative.required || 10)), h(Badge, { value: readiness.ready ? "READY" : "NOT_READY" })),
        h("div", null, h("span", null, t.providers), h("strong", null, integer(deployments.active || 0, props.locale)), h("span", null, t.activeDeployments), h("span", { className: "hao-muted" }, integer(deployments.paused || 0, props.locale) + " " + t.pausedDeployments)),
      ),
      h(Panel, {
        title: t.history,
        action: h("input", { className: "hao-search", value: search, placeholder: t.search, onChange: function (event) { setSearch(event.target.value); } }),
      }, h(ExecutionTable, { rows: history, t: t, locale: props.locale, now: props.now })),
    );
  }

  function AnalyticsTable(props) {
    return h(
      "div",
      { className: "hao-table-wrap" },
      h("table", { className: "hao-table hao-analytics-table" },
        h("thead", null, h("tr", null,
          h("th", null, props.title), h("th", { className: "hao-right" }, props.t.executions), h("th", { className: "hao-right" }, props.t.success), h("th", { className: "hao-right" }, "Token"), h("th", { className: "hao-right" }, props.t.calls), h("th", { className: "hao-right" }, props.t.duration), h("th", { className: "hao-right" }, props.t.cost),
        )),
        h("tbody", null, (props.rows || []).map(function (row) {
          return h("tr", { key: row.key },
            h("td", null, h("strong", { className: "hao-analytics-key" }, row.key)),
            h("td", { className: "hao-right hao-mono" }, integer(row.executions, props.locale)),
            h("td", { className: "hao-right hao-mono" }, percentage(row.successRate)),
            h("td", { className: "hao-right hao-mono" }, compact(row.totalTokens, props.locale)),
            h("td", { className: "hao-right hao-mono" }, compact(row.calls, props.locale)),
            h("td", { className: "hao-right hao-mono" }, row.durationMs ? duration(row.durationMs) : "—"),
            h("td", { className: "hao-right hao-mono" }, money(row.costUsd)),
          );
        })),
      ),
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
      ["phases", t.groupPhase],
    ];
    const [group, setGroup] = React.useState("providers");
    const selected = groups.find(function (item) { return item[0] === group; }) || groups[0];
    return h(
      React.Fragment,
      null,
      h("div", { className: "hao-segmented" }, groups.map(function (item) {
        return h("button", { type: "button", className: item[0] === group ? "is-active" : "", key: item[0], onClick: function () { setGroup(item[0]); } }, item[1]);
      })),
      h(Panel, { title: selected[1] }, h(AnalyticsTable, { rows: analytics[selected[0]] || [], title: selected[1], t: t, locale: props.locale })),
      h("section", { className: "hao-analytics-notes" },
        h("article", null, h("span", null, t.input), h("strong", null, compact((props.data.summary || {}).input, props.locale))),
        h("article", null, h("span", null, t.output), h("strong", null, compact((props.data.summary || {}).output, props.locale))),
        h("article", null, h("span", null, t.cache), h("strong", null, compact((props.data.summary || {}).cachedInput, props.locale))),
        h("article", null, h("span", null, t.reasoning), h("strong", null, compact((props.data.summary || {}).reasoningOutput, props.locale))),
      ),
    );
  }

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

    const load = React.useCallback(function () {
      setLoading(true);
      return api("/dashboard")
        .then(assertDashboardContract)
        .then(function (value) { setData(value); setError(""); })
        .catch(function (cause) { setError(String(cause)); })
        .finally(function () { setLoading(false); });
    }, []);

    function openPlan(plan) {
      setDetailPlanId(plan.planId);
      setPlanDetail(null);
      setDetailError("");
      setDetailLoading(true);
      return api("/plans/" + encodeURIComponent(plan.planId))
        .then(assertPlanDetailContract)
        .then(function (value) { setPlanDetail(value); })
        .catch(function (cause) { setDetailError(String(cause)); })
        .finally(function () { setDetailLoading(false); });
    }

    function closePlan() {
      setDetailPlanId(null);
      setPlanDetail(null);
      setDetailError("");
      setDetailLoading(false);
    }

    React.useEffect(function () {
      load();
      const refresh = window.setInterval(load, 15000);
      const clock = window.setInterval(function () { setNow(Date.now()); }, 1000);
      return function () { window.clearInterval(refresh); window.clearInterval(clock); };
    }, [load]);

    React.useEffect(function () {
      if (!detailPlanId) return undefined;
      function onKeyDown(event) { if (event.key === "Escape") closePlan(); }
      window.addEventListener("keydown", onKeyDown);
      return function () { window.removeEventListener("keydown", onKeyDown); };
    }, [detailPlanId]);

    const adminUrl = data && data.registry && data.registry.adminUrl;
    return h(
      "main",
      { className: "hao-shell", "data-theme-mode": themeMode },
      h("header", { className: "hao-toolbar" },
        h("nav", { className: "hao-toolbar-nav" },
          h("button", { type: "button", className: view === "overview" ? "is-active" : "", onClick: function () { setView("overview"); } }, t.overview),
          h("button", { type: "button", className: view === "analytics" ? "is-active" : "", onClick: function () { setView("analytics"); } }, t.analytics),
        ),
        h("div", { className: "hao-toolbar-actions" },
          data ? h("span", { className: "hao-updated" }, t.updated + " " + dateTime(data.generatedAt, locale)) : null,
          adminUrl ? h("a", { className: "hao-button hao-button-secondary", href: adminUrl, target: "_blank", rel: "noreferrer" }, t.admin) : null,
          h("button", { className: "hao-button", type: "button", onClick: load, disabled: loading }, loading ? "…" : t.refresh),
        ),
      ),
      error ? h("div", { className: "hao-error" }, error) : null,
      !data ? h("div", { className: "hao-loading" }, loading ? "Loading…" : "No data") : view === "analytics" ? h(Analytics, { data: data, t: t, locale: locale }) : h(Overview, { data: data, t: t, locale: locale, now: now, onOpenPlan: openPlan }),
      detailPlanId ? h(PlanDetail, { detail: planDetail, loading: detailLoading, error: detailError, onClose: closePlan, t: t, locale: locale, now: now }) : null,
    );
  }

  registry.register("hermes-ai-office", App);
})();
