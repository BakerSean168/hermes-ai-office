(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  const registry = window.__HERMES_PLUGINS__;
  if (!SDK || !registry || typeof registry.register !== "function") return;
  const React = SDK.React;
  const h = React.createElement;
  const API_ROOT = "/api/plugins/hermes-ai-office";

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
      title: "AI Office",
      subtitle: "Execution console for OpenHands + LiteLLM",
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
    },
    zh: {
      title: "AI Office",
      subtitle: "OpenHands + LiteLLM 执行控制台",
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
    },
  };

  function api(path) {
    return fetch(API_ROOT + path, { credentials: "same-origin" }).then(async function (response) {
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    });
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
    const provider = route.providerKey || route.provider || "unknown";
    const model = route.physicalModel || "unknown";
    return provider + " · " + model;
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
              h("td", h("span", { className: "hao-project" }, item.projectKey || "—")),
              h("td", h("div", { className: "hao-objective" }, item.objective || "—")),
              h("td", h("span", { className: "hao-phase" }, item.phase || "—")),
              h("td", h(Badge, { value: item.status })),
              h("td", h("span", { className: "hao-mono" }, item.logicalModel || "—")),
              h("td", h("span", { className: "hao-route" }, routeLabel(item))),
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
          h("div", { className: "hao-running-route" }, item.logicalModel || "—", h("span", null, "→"), routeLabel(item)),
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
            h("td", h("strong", { className: "hao-analytics-key" }, row.key)),
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
    const t = COPY[locale];
    const [view, setView] = React.useState("overview");
    const [data, setData] = React.useState(null);
    const [error, setError] = React.useState("");
    const [loading, setLoading] = React.useState(true);
    const [now, setNow] = React.useState(Date.now());

    const load = React.useCallback(function () {
      setLoading(true);
      return api("/dashboard")
        .then(function (value) { setData(value); setError(""); })
        .catch(function (cause) { setError(String(cause)); })
        .finally(function () { setLoading(false); });
    }, []);

    React.useEffect(function () {
      load();
      const refresh = window.setInterval(load, 15000);
      const clock = window.setInterval(function () { setNow(Date.now()); }, 1000);
      return function () { window.clearInterval(refresh); window.clearInterval(clock); };
    }, [load]);

    const adminUrl = data && data.registry && data.registry.adminUrl;
    return h(
      "main",
      { className: "hao-shell" },
      h("header", { className: "hao-header" },
        h("div", null, h("div", { className: "hao-kicker" }, "HERMES · EXECUTION CONTROL PLANE"), h("h1", null, t.title), h("p", null, t.subtitle)),
        h("div", { className: "hao-header-actions" },
          data ? h("span", { className: "hao-updated" }, t.updated + " " + dateTime(data.generatedAt, locale)) : null,
          adminUrl ? h("a", { className: "hao-button hao-button-secondary", href: adminUrl, target: "_blank", rel: "noreferrer" }, t.admin) : null,
          h("button", { className: "hao-button", type: "button", onClick: load, disabled: loading }, loading ? "…" : t.refresh),
        ),
      ),
      h("nav", { className: "hao-nav" },
        h("button", { type: "button", className: view === "overview" ? "is-active" : "", onClick: function () { setView("overview"); } }, t.overview),
        h("button", { type: "button", className: view === "analytics" ? "is-active" : "", onClick: function () { setView("analytics"); } }, t.analytics),
      ),
      error ? h("div", { className: "hao-error" }, error) : null,
      !data ? h("div", { className: "hao-loading" }, loading ? "Loading…" : "No data") : view === "analytics" ? h(Analytics, { data: data, t: t, locale: locale }) : h(Overview, { data: data, t: t, locale: locale, now: now }),
    );
  }

  registry.register("hermes-ai-office", App);
})();
