(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  const registry = window.__HERMES_PLUGINS__;
  if (!SDK || !registry || typeof registry.register !== "function") return;

  const React = SDK.React;
  const h = React.createElement;
  const API_ROOT = "/api/plugins/hermes-ai-office";
  const useI18n =
    SDK.useI18n ||
    function () {
      let locale = "en";
      try {
        locale = window.localStorage.getItem("hermes-locale") || "en";
      } catch (_error) {
        locale = "en";
      }
      return { locale: locale };
    };

  function resolveHostTheme() {
    const root = document.documentElement;
    const declared = String(document.documentElement.dataset.theme || "").toLowerCase();
    if (declared === "dark" || declared === "light") return declared;
    if (
      document.documentElement.classList.contains("dark") ||
      document.documentElement.classList.contains("dark-theme")
    )
      return "dark";
    if (document.documentElement.classList.contains("light-theme")) return "light";
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch (_error) {
      return "light";
    }
  }

  function useHostTheme() {
    const [theme, setTheme] = React.useState(resolveHostTheme);
    React.useEffect(function () {
      const root = document.documentElement;
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const sync = function () {
        setTheme(resolveHostTheme());
      };
      const observer = new MutationObserver(sync);
      observer.observe(root, { attributes: true, attributeFilter: ["class", "data-theme"] });
      if (typeof media.addEventListener === "function") media.addEventListener("change", sync);
      else if (typeof media.addListener === "function") media.addListener(sync);
      sync();
      return function () {
        observer.disconnect();
        if (typeof media.removeEventListener === "function") media.removeEventListener("change", sync);
        else if (typeof media.removeListener === "function") media.removeListener(sync);
      };
    }, []);
    return theme;
  }

  const COPY = {
    en: {
      "shell.kicker": "Hermes native organization",
      "shell.title": "AI Office",
      "shell.subtitle":
        "A decision console for positions, employees, suppliers, runtime staffing, and operational evidence.",
      "shell.refresh": "Refresh",
      "shell.refreshing": "Refreshing…",
      "shell.lastSync": "Updated {time}",
      "shell.localOnly": "Local control plane · provider credentials never enter this page",
      "shell.loadError": "AI Office could not refresh",
      "shell.loading": "Loading company state…",
      "tabs.overview": "Overview",
      "tabs.organization": "Organization",
      "tabs.workforce": "Workforce",
      "tabs.suppliers": "Suppliers",
      "tabs.operations": "Operations",
      "tabs.policy": "Runtime policy",
      "tabs.incidents": "Incidents",
      "common.search": "Search",
      "common.all": "All",
      "common.noData": "No data",
      "common.unknown": "Unknown",
      "common.notRecorded": "Not recorded",
      "common.noResults": "No matching records",
      "common.save": "Save",
      "common.saving": "Saving…",
      "common.records": "{count} records",
      "common.requests": "{count} requests",
      "common.tokens": "{input} in / {output} out",
      "common.successRate": "{rate} success",
      "common.current": "Current",
      "overview.employees": "Employees",
      "overview.employeesHint": "{appointed} with appointments",
      "overview.positions": "Positions",
      "overview.positionsHint": "{appointed} appointed · {defaulted} default · {unfilled} unfilled",
      "overview.observed": "Gateway-observed requests",
      "overview.observedHint": "{coverage} attributed to employees",
      "overview.operations": "Active work",
      "overview.operationsHint": "{runs} runs · {duties} duties · {runtimes} runtimes",
      "overview.suppliers": "Suppliers",
      "overview.suppliersHint": "{agreements} active agreements",
      "overview.policy": "Runtime policy",
      "overview.policyHint": "OpenCode + Codex",
      "overview.attention": "Needs attention",
      "overview.attentionSubtitle": "Facts that require staffing or classification",
      "overview.noAttention": "No current staffing, supply, or incident warnings.",
      "overview.unfilledTitle": "{count} positions have no appointment or Hermes default",
      "overview.unfilledDetail": "These positions have neither an explicit appointment nor an effective Hermes model default.",
      "overview.unattributedRuntimeTitle": "{count} active runtimes are not attributed to an employee",
      "overview.unattributedRuntimeDetail": "Runtime evidence exists, but no asserted staffing segment is active.",
      "overview.unmappedTitle": "{count} gateway routes remain commercially unclassified",
      "overview.unmappedDetail": "Technical routes are not allowed to fabricate supplier or employee identity.",
      "overview.incidentTitle": "{count} active incidents need attention",
      "overview.incidentDetail": "Open the incident ledger for details and lifecycle state.",
      "overview.coverageTitle": "Data coverage",
      "overview.coverageSubtitle": "Verified ledger and aggregate gateway observation stay separate",
      "overview.verifiedUsage": "Verified employee ledger",
      "overview.verifiedUsageHint": "Per-request, attributable usage",
      "overview.observedUsage": "Gateway observation",
      "overview.observedUsageHint": "Aggregate {windows} evidence",
      "overview.unattributed": "Unattributed observation",
      "overview.unattributedHint": "{count} evidence groups",
      "overview.recentDecisions": "Recent runtime decisions",
      "overview.recentDecisionsSubtitle": "Latest employee-aware OpenCode and Codex selections",
      "overview.noDecisions": "No runtime launch decision has been recorded yet.",
      "organization.title": "Organization",
      "organization.subtitle": "One compact view of work scopes, positions, staffing, and current activity",
      "organization.filterAll": "All positions",
      "organization.filterStaffed": "Configured",
      "organization.filterDefaulted": "Default policy",
      "organization.filterUnfilled": "Unfilled",
      "organization.filterActive": "Active now",
      "organization.searchPlaceholder": "Search work scope, position, runtime, or employee",
      "organization.scope": "Work scope",
      "organization.position": "Position",
      "organization.runtime": "Runtime",
      "organization.staffing": "Staffing",
      "organization.employee": "Employee",
      "organization.activity": "Current activity",
      "organization.noEmployee": "No staffing evidence",
      "organization.defaultModel": "Default model",
      "organization.employeePending": "Employee attribution pending",
      "organization.source.APPOINTMENT": "Explicit appointment",
      "organization.source.HERMES_PROFILE_CONFIG": "Profile model default",
      "organization.source.HERMES_GLOBAL_CONFIG": "Hermes global default",
      "organization.noActivity": "Idle",
      "organization.appointed": "Appointed",
      "organization.onDuty": "On duty",
      "workforce.title": "Workforce",
      "workforce.subtitle": "Durable employee identities, appointments, verified work, and observed supply usage",
      "workforce.searchPlaceholder": "Search employee, supplier, model, or position",
      "workforce.filterAll": "All employees",
      "workforce.filterAppointed": "Appointed",
      "workforce.filterObserved": "Observed activity",
      "workforce.filterWorking": "Working now",
      "workforce.employee": "Employee",
      "workforce.appointment": "Current appointment",
      "workforce.verified": "Verified ledger",
      "workforce.observed": "Gateway observation",
      "workforce.state": "State",
      "workforce.noAppointment": "No current appointment",
      "workforce.noVerified": "No verified request record",
      "workforce.noObserved": "No attributable aggregate observation",
      "workforce.verifiedHelp": "Verified ledger",
      "workforce.verifiedHelpText":
        "Only per-request usage tied to an invocation, employment, and employee. This is authoritative career history.",
      "workforce.observedHelp": "Gateway observation",
      "workforce.observedHelpText":
        "Aggregate gateway evidence, typically over 30 days. It may be attributed by classified route, supplier hint, or unique model, and is never written back as verified career history.",
      "workforce.coverage": "Attribution coverage",
      "workforce.coverageHint": "{attributed} of {total} observed requests",
      "workforce.observedEmployees": "Employees with observation",
      "workforce.observedEmployeesHint": "{count} of {total} employees",
      "workforce.unattributedRequests": "Unattributed requests",
      "workforce.unattributedRequestsHint": "Remain outside employee history",
      "workforce.basis.CLASSIFIED_ROUTE": "classified route",
      "workforce.basis.SUPPLIER_HINT": "supplier hint",
      "workforce.basis.UNIQUE_MODEL": "unique model",
      "suppliers.title": "Suppliers",
      "suppliers.subtitle": "Commercial supply, employee identities, agreements, channels, and observed usage",
      "suppliers.employees": "Employees",
      "suppliers.agreements": "Agreements",
      "suppliers.channels": "Channels",
      "suppliers.observed": "Observed requests",
      "suppliers.noPlan": "No explicit plan metadata",
      "suppliers.noEmployees": "No employee identities",
      "suppliers.unclassified": "Unclassified infrastructure",
      "suppliers.unclassifiedSubtitle":
        "These routes remain technical evidence and cannot create supplier or employee identity",
      "suppliers.gateway": "Gateway",
      "suppliers.channel": "Channel",
      "suppliers.health": "Health",
      "suppliers.models": "Model hints",
      "operations.title": "Operations",
      "operations.subtitle": "Current runs, activated duties, and technical runtime shells",
      "operations.runs": "Active runs",
      "operations.duties": "Active duties",
      "operations.runtimes": "Runtime sessions",
      "operations.run": "Run",
      "operations.scope": "Work scope",
      "operations.position": "Position",
      "operations.activity": "Activity",
      "operations.runtime": "Runtime",
      "operations.model": "Model hint",
      "operations.lastSeen": "Last seen",
      "operations.noRuns": "No active runs",
      "operations.noDuties": "No active duties",
      "operations.noRuntimes": "No active runtimes",
      "policy.title": "OpenCode / Codex staffing policy",
      "policy.subtitle": "Hermes resolves an appointed employee before launching the external runtime",
      "policy.mode": "Mode",
      "policy.openCodePosition": "OpenCode position slug",
      "policy.codexPosition": "Codex position slug",
      "policy.observe": "Observe — record only",
      "policy.prefer": "Prefer — inject selected employee, fail open",
      "policy.enforce": "Enforce — require an eligible employee",
      "policy.help":
        "PREFER preserves an unmatched explicit model. ENFORCE may replace it or block the launch. Raw prompts never enter the policy service.",
      "policy.saved": "Runtime policy saved. New Hermes tool calls use it immediately.",
      "policy.decisions": "Recent launch decisions",
      "policy.decisionsSubtitle": "Recorded policy resolutions",
      "policy.when": "When",
      "policy.runtime": "Runtime",
      "policy.position": "Position",
      "policy.employee": "Employee",
      "policy.model": "Selected model",
      "policy.outcome": "Outcome",
      "policy.noDecisions": "No OpenCode or Codex launch has passed through the native policy hook yet.",
      "incidents.title": "Operational incidents",
      "incidents.subtitle": "Active incidents derived from the V2 event ledger",
      "incidents.incident": "Incident",
      "incidents.kind": "Kind",
      "incidents.severity": "Severity",
      "incidents.lifecycle": "Lifecycle",
      "incidents.lastSeen": "Last seen",
      "incidents.occurrences": "Occurrences",
      "incidents.none": "No active incidents",
      "status.ACTIVE": "Active",
      "status.HEALTHY": "Healthy",
      "status.EMPLOYED": "Employed",
      "status.WORKING": "Working",
      "status.SELECTED": "Selected",
      "status.CURRENT": "Current",
      "status.STAFFED": "Staffed",
      "status.APPOINTED": "Appointed",
      "status.DEFAULTED": "Default staffing",
      "status.DEFAULT_MODEL": "Default model",
      "status.RUNNING": "Running",
      "status.CODING": "Coding",
      "status.REVIEWING": "Reviewing",
      "status.PREFER": "Prefer",
      "status.OBSERVE": "Observe",
      "status.ENFORCE": "Enforce",
      "status.DEGRADED": "Degraded",
      "status.WARNING": "Warning",
      "status.SCHEDULED": "Scheduled",
      "status.UNRESOLVED": "Unresolved",
      "status.ERROR": "Error",
      "status.CRITICAL": "Critical",
      "status.BLOCKED": "Blocked",
      "status.UNHEALTHY": "Unhealthy",
      "status.DORMANT": "Dormant",
      "status.UNFILLED": "Unfilled",
      "status.UNKNOWN": "Unknown",
      "status.OPEN": "Open",
      "status.ACKNOWLEDGED": "Acknowledged",
    },
    zh: {
      "shell.kicker": "Hermes 原生组织插件",
      "shell.title": "AI 办公室",
      "shell.subtitle": "统一查看岗位、员工、供应商、运行时调度与经营证据。",
      "shell.refresh": "刷新",
      "shell.refreshing": "刷新中…",
      "shell.lastSync": "更新于 {time}",
      "shell.localOnly": "本地控制面 · 供应商凭证不会进入此页面",
      "shell.loadError": "AI 办公室刷新失败",
      "shell.loading": "正在加载公司状态…",
      "tabs.overview": "总览",
      "tabs.organization": "组织架构",
      "tabs.workforce": "员工",
      "tabs.suppliers": "供应商",
      "tabs.operations": "运营",
      "tabs.policy": "运行时策略",
      "tabs.incidents": "事件",
      "common.search": "搜索",
      "common.all": "全部",
      "common.noData": "暂无数据",
      "common.unknown": "未知",
      "common.notRecorded": "未记录",
      "common.noResults": "没有符合条件的记录",
      "common.save": "保存",
      "common.saving": "保存中…",
      "common.records": "{count} 条记录",
      "common.requests": "{count} 次请求",
      "common.tokens": "输入 {input} / 输出 {output}",
      "common.successRate": "成功率 {rate}",
      "common.current": "当前",
      "overview.employees": "员工",
      "overview.employeesHint": "{appointed} 人已有岗位任命",
      "overview.positions": "岗位",
      "overview.positionsHint": "{appointed} 显式任命 · {defaulted} 默认策略 · {unfilled} 真空缺",
      "overview.observed": "网关观测请求",
      "overview.observedHint": "{coverage} 已归因到员工",
      "overview.operations": "活跃工作",
      "overview.operationsHint": "{runs} 个运行 · {duties} 个职责 · {runtimes} 个运行时",
      "overview.suppliers": "供应商",
      "overview.suppliersHint": "{agreements} 份有效协议",
      "overview.policy": "运行时策略",
      "overview.policyHint": "OpenCode + Codex",
      "overview.attention": "需要关注",
      "overview.attentionSubtitle": "需要补充任职或商业分类的事实",
      "overview.noAttention": "当前没有岗位、供应或事件告警。",
      "overview.unfilledTitle": "{count} 个岗位既无任命也无 Hermes 默认策略",
      "overview.unfilledDetail": "这些岗位既没有显式 Appointment，也没有可生效的 Hermes 默认模型。",
      "overview.unattributedRuntimeTitle": "{count} 个活跃运行时尚未归因到员工",
      "overview.unattributedRuntimeDetail": "已有运行证据，但当前没有明确的 Staffing Segment。",
      "overview.unmappedTitle": "{count} 条网关路由尚未完成商业分类",
      "overview.unmappedDetail": "技术路由不能自动伪造供应商或员工身份。",
      "overview.incidentTitle": "{count} 个活跃事件需要处理",
      "overview.incidentDetail": "打开事件账本查看详情和生命周期。",
      "overview.coverageTitle": "数据覆盖",
      "overview.coverageSubtitle": "已核验账本与网关汇总观测严格分离",
      "overview.verifiedUsage": "已核验员工账本",
      "overview.verifiedUsageHint": "逐请求、可归因的员工用量",
      "overview.observedUsage": "网关观测",
      "overview.observedUsageHint": "{windows} 汇总证据",
      "overview.unattributed": "未归因观测",
      "overview.unattributedHint": "{count} 个证据分组",
      "overview.recentDecisions": "最近运行时决策",
      "overview.recentDecisionsSubtitle": "最新的 OpenCode / Codex 员工选择",
      "overview.noDecisions": "尚未记录运行时启动决策。",
      "organization.title": "组织架构",
      "organization.subtitle": "紧凑查看工作域、岗位、任职与当前活动",
      "organization.filterAll": "全部岗位",
      "organization.filterStaffed": "已配置",
      "organization.filterDefaulted": "默认策略",
      "organization.filterUnfilled": "空缺",
      "organization.filterActive": "正在工作",
      "organization.searchPlaceholder": "搜索工作域、岗位、运行时或员工",
      "organization.scope": "工作域",
      "organization.position": "岗位",
      "organization.runtime": "运行时",
      "organization.staffing": "配置状态",
      "organization.employee": "员工",
      "organization.activity": "当前活动",
      "organization.noEmployee": "暂无任职证据",
      "organization.defaultModel": "默认模型",
      "organization.employeePending": "员工商业归因待确认",
      "organization.source.APPOINTMENT": "显式任命",
      "organization.source.HERMES_PROFILE_CONFIG": "Profile 默认模型",
      "organization.source.HERMES_GLOBAL_CONFIG": "Hermes 全局默认",
      "organization.noActivity": "空闲",
      "organization.appointed": "已任命",
      "organization.onDuty": "执行中",
      "workforce.title": "员工",
      "workforce.subtitle": "持久员工身份、岗位任命、已核验工作与供应侧观测",
      "workforce.searchPlaceholder": "搜索员工、供应商、模型或岗位",
      "workforce.filterAll": "全部员工",
      "workforce.filterAppointed": "已有岗位",
      "workforce.filterObserved": "有观测活动",
      "workforce.filterWorking": "正在工作",
      "workforce.employee": "员工",
      "workforce.appointment": "当前岗位",
      "workforce.verified": "已核验账本",
      "workforce.observed": "网关观测",
      "workforce.state": "状态",
      "workforce.noAppointment": "暂无当前岗位",
      "workforce.noVerified": "暂无逐请求核验记录",
      "workforce.noObserved": "暂无可归因的汇总观测",
      "workforce.verifiedHelp": "已核验账本",
      "workforce.verifiedHelpText": "仅包含已关联调用、Employment 和员工的逐请求用量，是权威职业履历。",
      "workforce.observedHelp": "网关观测",
      "workforce.observedHelpText":
        "通常为 CPA 的 30 天汇总数据，可按已分类路由、供应商提示或唯一模型归因；绝不会回写成已核验员工履历。",
      "workforce.coverage": "观测归因率",
      "workforce.coverageHint": "{total} 次观测请求中已归因 {attributed} 次",
      "workforce.observedEmployees": "有观测的员工",
      "workforce.observedEmployeesHint": "共 {total} 名员工中的 {count} 名",
      "workforce.unattributedRequests": "未归因请求",
      "workforce.unattributedRequestsHint": "继续保留在员工履历之外",
      "workforce.basis.CLASSIFIED_ROUTE": "已分类路由",
      "workforce.basis.SUPPLIER_HINT": "供应商提示",
      "workforce.basis.UNIQUE_MODEL": "唯一模型",
      "suppliers.title": "供应商",
      "suppliers.subtitle": "商业供应、员工身份、协议、通道与观测用量",
      "suppliers.employees": "员工",
      "suppliers.agreements": "协议",
      "suppliers.channels": "通道",
      "suppliers.observed": "观测请求",
      "suppliers.noPlan": "暂无明确套餐元数据",
      "suppliers.noEmployees": "暂无员工身份",
      "suppliers.unclassified": "未分类基础设施",
      "suppliers.unclassifiedSubtitle": "这些路由仍是技术证据，不能创建供应商或员工身份",
      "suppliers.gateway": "网关",
      "suppliers.channel": "通道",
      "suppliers.health": "健康状态",
      "suppliers.models": "模型提示",
      "operations.title": "运营",
      "operations.subtitle": "当前运行、已激活职责与技术运行时外壳",
      "operations.runs": "活跃运行",
      "operations.duties": "活跃职责",
      "operations.runtimes": "运行时会话",
      "operations.run": "运行",
      "operations.scope": "工作域",
      "operations.position": "岗位",
      "operations.activity": "活动",
      "operations.runtime": "运行时",
      "operations.model": "模型提示",
      "operations.lastSeen": "最后出现",
      "operations.noRuns": "暂无活跃运行",
      "operations.noDuties": "暂无活跃职责",
      "operations.noRuntimes": "暂无活跃运行时",
      "policy.title": "OpenCode / Codex 员工调度策略",
      "policy.subtitle": "Hermes 在启动外部运行时前，先解析已任命的员工",
      "policy.mode": "模式",
      "policy.openCodePosition": "OpenCode 岗位标识",
      "policy.codexPosition": "Codex 岗位标识",
      "policy.observe": "观察 — 只记录，不改写",
      "policy.prefer": "优先 — 注入已选员工，服务不可用时放行",
      "policy.enforce": "强制 — 必须存在合格员工",
      "policy.help":
        "PREFER 会保留无法匹配的显式模型；ENFORCE 可以替换或阻止启动。原始提示词不会进入策略服务。",
      "policy.saved": "运行时策略已保存，新的 Hermes 工具调用会立即使用。",
      "policy.decisions": "最近启动决策",
      "policy.decisionsSubtitle": "已记录的策略解析结果",
      "policy.when": "时间",
      "policy.runtime": "运行时",
      "policy.position": "岗位",
      "policy.employee": "员工",
      "policy.model": "选定模型",
      "policy.outcome": "结果",
      "policy.noDecisions": "尚无 OpenCode 或 Codex 启动经过原生策略 Hook。",
      "incidents.title": "运营事件",
      "incidents.subtitle": "由 V2 事件账本生成的活跃事件",
      "incidents.incident": "事件",
      "incidents.kind": "类型",
      "incidents.severity": "严重级别",
      "incidents.lifecycle": "生命周期",
      "incidents.lastSeen": "最后出现",
      "incidents.occurrences": "次数",
      "incidents.none": "暂无活跃事件",
      "status.ACTIVE": "活跃",
      "status.HEALTHY": "健康",
      "status.EMPLOYED": "受雇中",
      "status.WORKING": "工作中",
      "status.SELECTED": "已选择",
      "status.CURRENT": "当前",
      "status.STAFFED": "已配置",
      "status.APPOINTED": "已任命",
      "status.DEFAULTED": "默认指派",
      "status.DEFAULT_MODEL": "默认模型",
      "status.RUNNING": "运行中",
      "status.CODING": "编码中",
      "status.REVIEWING": "审查中",
      "status.PREFER": "优先",
      "status.OBSERVE": "观察",
      "status.ENFORCE": "强制",
      "status.DEGRADED": "降级",
      "status.WARNING": "警告",
      "status.SCHEDULED": "已计划",
      "status.UNRESOLVED": "未解析",
      "status.ERROR": "错误",
      "status.CRITICAL": "严重",
      "status.BLOCKED": "已阻止",
      "status.UNHEALTHY": "不健康",
      "status.DORMANT": "休眠",
      "status.UNFILLED": "空缺",
      "status.UNKNOWN": "未知",
      "status.OPEN": "待处理",
      "status.ACKNOWLEDGED": "已确认",
    },
  };
  COPY["zh-hant"] = Object.assign({}, COPY.zh, {
    "shell.kicker": "Hermes 原生組織外掛",
    "shell.title": "AI 辦公室",
    "shell.subtitle": "統一查看職位、員工、供應商、執行階段調度與營運證據。",
    "shell.refresh": "重新整理",
    "shell.refreshing": "重新整理中…",
    "tabs.overview": "總覽",
    "tabs.organization": "組織架構",
    "tabs.workforce": "員工",
    "tabs.suppliers": "供應商",
    "tabs.operations": "營運",
    "tabs.policy": "執行階段策略",
    "tabs.incidents": "事件",
    "workforce.observed": "閘道觀測",
    "workforce.observedHelp": "閘道觀測",
  });

  function api(path, options) {
    return SDK.fetchJSON(API_ROOT + path, options);
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function localeKey(value) {
    const normalized = String(value || "en").toLowerCase();
    if (normalized === "zh" || normalized.startsWith("zh-cn") || normalized.startsWith("zh-sg")) {
      return "zh";
    }
    if (
      normalized === "zh-hant" ||
      normalized.startsWith("zh-tw") ||
      normalized.startsWith("zh-hk")
    ) {
      return "zh-hant";
    }
    return COPY[normalized] ? normalized : "en";
  }

  function localeTag(locale) {
    if (locale === "zh") return "zh-CN";
    if (locale === "zh-hant") return "zh-TW";
    return "en-US";
  }

  function translator(locale) {
    const selected = COPY[locale] || COPY.en;
    return function (key, variables) {
      let value = selected[key] || COPY.en[key] || key;
      Object.entries(variables || {}).forEach(function (entry) {
        value = value.replace(new RegExp("\\{" + entry[0] + "\\}", "g"), String(entry[1]));
      });
      return value;
    };
  }

  function number(value, locale) {
    return new Intl.NumberFormat(localeTag(locale)).format(Number(value || 0));
  }

  function compact(value, locale) {
    return new Intl.NumberFormat(localeTag(locale), {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(Number(value || 0));
  }

  function money(value, locale) {
    return new Intl.NumberFormat(localeTag(locale), {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(Number(value || 0));
  }

  function percentage(part, total, locale) {
    if (!Number(total || 0)) return "—";
    return new Intl.NumberFormat(localeTag(locale), {
      style: "percent",
      maximumFractionDigits: 0,
    }).format(Number(part || 0) / Number(total || 1));
  }

  function relativeTime(timestamp, locale) {
    const value = Number(timestamp || 0);
    if (!value) return locale === "zh" || locale === "zh-hant" ? "未知" : "unknown";
    const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
    if (locale === "zh" || locale === "zh-hant") {
      if (seconds < 60) return seconds + " 秒前";
      if (seconds < 3600) return Math.floor(seconds / 60) + " 分钟前";
      if (seconds < 86400) return Math.floor(seconds / 3600) + " 小时前";
      return Math.floor(seconds / 86400) + " 天前";
    }
    if (seconds < 60) return seconds + "s ago";
    if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
    if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
    return Math.floor(seconds / 86400) + "d ago";
  }

  function signalTotal(usage) {
    const value = asObject(usage);
    return (
      Number(value.requests || 0) +
      Number(value.inputTokens || 0) +
      Number(value.outputTokens || 0) +
      Number(value.actualCost || 0)
    );
  }

  function statusTone(value) {
    const normalized = String(value || "unknown").toUpperCase();
    if (
      [
        "ACTIVE",
        "HEALTHY",
        "EMPLOYED",
        "WORKING",
        "SELECTED",
        "CURRENT",
        "STAFFED",
        "RUNNING",
        "CODING",
        "REVIEWING",
        "APPOINTED",
        "DEFAULTED",
      ].includes(normalized)
    ) {
      return "good";
    }
    if (["DEGRADED", "WARNING", "SCHEDULED", "PREFER", "UNRESOLVED", "DEFAULT_MODEL"].includes(normalized)) {
      return "warn";
    }
    if (
      ["ERROR", "CRITICAL", "BLOCKED", "UNHEALTHY", "DORMANT", "UNFILLED"].includes(
        normalized,
      )
    ) {
      return "bad";
    }
    return "neutral";
  }

  function Status(props) {
    const raw = String(props.value || "UNKNOWN").toUpperCase();
    return h(
      "span",
      { className: "hao-badge hao-badge-" + statusTone(raw), title: String(props.value || "") },
      props.t("status." + raw),
    );
  }

  function Avatar(props) {
    const words = String(props.name || "AI")
      .replace(/@.*/, "")
      .split(/\s+/)
      .filter(Boolean);
    const initials = words
      .slice(0, 2)
      .map(function (word) {
        return word[0];
      })
      .join("")
      .toUpperCase();
    return h("span", { className: "hao-avatar", "aria-hidden": "true" }, initials || "AI");
  }

  function Button(props) {
    return h(
      "button",
      {
        className: "hao-button " + (props.kind === "quiet" ? "hao-button-quiet" : ""),
        type: props.type || "button",
        disabled: props.disabled,
        onClick: props.onClick,
      },
      props.children,
    );
  }

  function Panel(props) {
    return h(
      "section",
      { className: "hao-panel " + (props.className || "") },
      props.title
        ? h(
            "div",
            { className: "hao-panel-head" },
            h(
              "div",
              { className: "hao-panel-copy" },
              h("h2", null, props.title),
              props.subtitle ? h("p", null, props.subtitle) : null,
            ),
            props.action || null,
          )
        : null,
      props.children,
    );
  }

  function Metric(props) {
    return h(
      "article",
      { className: "hao-metric" },
      h("div", { className: "hao-metric-label" }, props.label),
      h("div", { className: "hao-metric-value" }, props.value),
      h("div", { className: "hao-metric-hint" }, props.hint || "\u00a0"),
    );
  }

  function Empty(props) {
    return h(
      "div",
      { className: "hao-empty" },
      h("span", { className: "hao-empty-mark", "aria-hidden": "true" }, "·"),
      h("span", null, props.children),
    );
  }

  function Notice(props) {
    return h(
      "div",
      { className: "hao-notice hao-notice-" + (props.tone || "info") },
      h("div", { className: "hao-notice-icon", "aria-hidden": "true" }, props.icon || "i"),
      h(
        "div",
        null,
        props.title ? h("strong", null, props.title) : null,
        h("p", null, props.children),
      ),
    );
  }

  function ErrorBanner(props) {
    return h(
      "div",
      { className: "hao-error", role: "alert" },
      h("strong", null, props.title),
      h("span", null, String(props.error || "")),
    );
  }

  function sourceError(value) {
    return value && value.unavailable ? value.error || "Unavailable" : null;
  }

  function Toolbar(props) {
    return h(
      "div",
      { className: "hao-toolbar" },
      h(
        "label",
        { className: "hao-search" },
        h("span", { className: "hao-search-icon", "aria-hidden": "true" }, "⌕"),
        h("span", { className: "hao-visually-hidden" }, props.t("common.search")),
        h("input", {
          type: "search",
          value: props.query,
          placeholder: props.placeholder,
          onChange: function (event) {
            props.onQuery(event.target.value);
          },
        }),
      ),
      h(
        "div",
        { className: "hao-segments", role: "group" },
        props.options.map(function (option) {
          return h(
            "button",
            {
              type: "button",
              key: option.value,
              className: "hao-segment",
              "aria-pressed": props.value === option.value,
              onClick: function () {
                props.onChange(option.value);
              },
            },
            option.label,
          );
        }),
      ),
    );
  }

  function DataTable(props) {
    return h(
      "div",
      { className: "hao-table-shell" },
      h(
        "table",
        { className: "hao-data-table" },
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            props.columns.map(function (column) {
              return h(
                "th",
                {
                  key: column.key,
                  className: column.className || "",
                  scope: "col",
                },
                column.label,
              );
            }),
          ),
        ),
        h(
          "tbody",
          null,
          props.rows.length
            ? props.rows.map(function (row, index) {
                return h(
                  "tr",
                  { key: row[props.keyField || "id"] || index },
                  props.columns.map(function (column) {
                    return h(
                      "td",
                      { key: column.key, className: column.className || "" },
                      column.render ? column.render(row, index) : row[column.key],
                    );
                  }),
                );
              })
            : h(
                "tr",
                { className: "hao-empty-row" },
                h("td", { colSpan: props.columns.length }, h(Empty, null, props.empty)),
              ),
        ),
      ),
    );
  }

  function PersonCell(props) {
    return h(
      "div",
      { className: "hao-person" },
      h(Avatar, { name: props.name }),
      h(
        "div",
        { className: "hao-person-copy" },
        h("strong", null, props.name),
        props.detail ? h("span", null, props.detail) : null,
      ),
    );
  }

  function UsageCell(props) {
    const usage = asObject(props.usage);
    if (!props.usage || !signalTotal(usage)) {
      return h("span", { className: "hao-cell-empty" }, props.empty);
    }
    const requests = Number(usage.requests || 0);
    const failed = Number(usage.failedRequests || 0);
    const successful = Number(
      usage.successfulRequests == null ? Math.max(0, requests - failed) : usage.successfulRequests,
    );
    const bases = asArray(usage.attributionBases).map(function (basis) {
      return props.t("workforce.basis." + basis);
    });
    return h(
      "div",
      { className: "hao-usage-cell" },
      h(
        "strong",
        null,
        props.observed
          ? props.t("common.requests", { count: props.number(requests) })
          : props.t("common.requests", { count: props.number(requests) }),
      ),
      props.observed
        ? h(
            "span",
            null,
            props.t("common.successRate", {
              rate: requests ? props.percentage(successful, requests) : "—",
            }),
          )
        : null,
      h(
        "span",
        null,
        props.t("common.tokens", {
          input: props.compact(usage.inputTokens),
          output: props.compact(usage.outputTokens),
        }),
      ),
      bases.length ? h("small", null, bases.join(" · ")) : null,
    );
  }

  function Overview(props) {
    const data = props.data;
    const workforce = asObject(data.workforce);
    const workforceSummary = asObject(workforce.summary);
    const observed = asObject(workforceSummary.observedUsage);
    const supplySummary = asObject(asObject(data.supply).summary);
    const organization = asObject(data.organization);
    const orgSummary = asObject(organization.summary);
    const incidents = asArray(asObject(data.incidents).items).filter(function (item) {
      return item.lifecycle === "OPEN" || item.lifecycle === "ACKNOWLEDGED";
    });
    const decisions = asArray(asObject(data.runtimeDecisions).items).slice(0, 5);
    const policy = asObject(data.runtimePolicy);
    const employees = asArray(workforce.employees);
    const appointed = employees.filter(function (employee) {
      return asArray(employee.currentAppointments).length > 0;
    }).length;
    const coverage = props.percentage(observed.attributedRequests, observed.totalRequests);
    const attention = [];
    if (Number(orgSummary.unfilledPositions || 0) > 0) {
      attention.push({
        tone: "bad",
        title: props.t("overview.unfilledTitle", { count: orgSummary.unfilledPositions }),
        detail: props.t("overview.unfilledDetail"),
        tab: "organization",
      });
    }
    if (Number(orgSummary.runtimeActiveUnattributedPositions || 0) > 0) {
      attention.push({
        tone: "warn",
        title: props.t("overview.unattributedRuntimeTitle", {
          count: orgSummary.runtimeActiveUnattributedPositions,
        }),
        detail: props.t("overview.unattributedRuntimeDetail"),
        tab: "operations",
      });
    }
    if (Number(supplySummary.unmappedChannels || 0) > 0) {
      attention.push({
        tone: "warn",
        title: props.t("overview.unmappedTitle", { count: supplySummary.unmappedChannels }),
        detail: props.t("overview.unmappedDetail"),
        tab: "suppliers",
      });
    }
    if (incidents.length > 0) {
      attention.push({
        tone: "bad",
        title: props.t("overview.incidentTitle", { count: incidents.length }),
        detail: props.t("overview.incidentDetail"),
        tab: "incidents",
      });
    }

    const decisionColumns = [
      {
        key: "when",
        label: props.t("policy.when"),
        render: function (item) {
          return props.relativeTime(item.decidedAt);
        },
      },
      { key: "runtimeKind", label: props.t("policy.runtime") },
      {
        key: "employee",
        label: props.t("policy.employee"),
        render: function (item) {
          return asObject(item.employee).name || "—";
        },
      },
      {
        key: "selectedModel",
        label: props.t("policy.model"),
        className: "hao-mono",
        render: function (item) {
          return item.selectedModel || item.requestedModel || "—";
        },
      },
      {
        key: "status",
        label: props.t("policy.outcome"),
        render: function (item) {
          return h(Status, { value: item.status, t: props.t });
        },
      },
    ];

    return h(
      "div",
      { className: "hao-section-stack" },
      h(
        "div",
        { className: "hao-metrics" },
        h(Metric, {
          label: props.t("overview.employees"),
          value: props.number(workforceSummary.employees),
          hint: props.t("overview.employeesHint", { appointed: props.number(appointed) }),
        }),
        h(Metric, {
          label: props.t("overview.positions"),
          value: props.number(orgSummary.activePositions),
          hint: props.t("overview.positionsHint", {
            appointed: props.number(orgSummary.explicitlyAppointedPositions),
            defaulted: props.number(orgSummary.defaultedPositions),
            unfilled: props.number(orgSummary.unfilledPositions),
          }),
        }),
        h(Metric, {
          label: props.t("overview.observed"),
          value: props.compact(observed.totalRequests),
          hint: props.t("overview.observedHint", { coverage: coverage }),
        }),
        h(Metric, {
          label: props.t("overview.operations"),
          value: props.number(
            Number(orgSummary.activeRuns || 0) +
              Number(orgSummary.activeDuties || 0) +
              Number(orgSummary.activeRuntimeSessions || 0),
          ),
          hint: props.t("overview.operationsHint", {
            runs: props.number(orgSummary.activeRuns),
            duties: props.number(orgSummary.activeDuties),
            runtimes: props.number(orgSummary.activeRuntimeSessions),
          }),
        }),
        h(Metric, {
          label: props.t("overview.suppliers"),
          value: props.number(supplySummary.suppliers),
          hint: props.t("overview.suppliersHint", {
            agreements: props.number(supplySummary.activeAgreements),
          }),
        }),
        h(Metric, {
          label: props.t("overview.policy"),
          value: h(Status, { value: policy.mode || "prefer", t: props.t }),
          hint: props.t("overview.policyHint"),
        }),
      ),
      h(
        "div",
        { className: "hao-dashboard-grid" },
        h(
          Panel,
          {
            title: props.t("overview.attention"),
            subtitle: props.t("overview.attentionSubtitle"),
            className: "hao-span-7",
          },
          attention.length
            ? h(
                "div",
                { className: "hao-attention-list" },
                attention.map(function (item, index) {
                  return h(
                    "button",
                    {
                      key: index,
                      type: "button",
                      className: "hao-attention hao-attention-" + item.tone,
                      onClick: function () {
                        props.onNavigate(item.tab);
                      },
                    },
                    h("span", { className: "hao-attention-dot", "aria-hidden": "true" }),
                    h(
                      "span",
                      null,
                      h("strong", null, item.title),
                      h("small", null, item.detail),
                    ),
                    h("span", { className: "hao-attention-arrow", "aria-hidden": "true" }, "→"),
                  );
                }),
              )
            : h(Empty, null, props.t("overview.noAttention")),
        ),
        h(
          Panel,
          {
            title: props.t("overview.coverageTitle"),
            subtitle: props.t("overview.coverageSubtitle"),
            className: "hao-span-5",
          },
          h(
            "div",
            { className: "hao-coverage-list" },
            h(
              "div",
              { className: "hao-coverage-row" },
              h("span", null, props.t("overview.verifiedUsage")),
              h("strong", null, props.number(workforceSummary.requests)),
              h("small", null, props.t("overview.verifiedUsageHint")),
            ),
            h(
              "div",
              { className: "hao-coverage-row" },
              h("span", null, props.t("overview.observedUsage")),
              h("strong", null, props.number(observed.totalRequests)),
              h("small", null, props.t("overview.observedUsageHint", {
                windows: asArray(observed.windows).join(" / ") || "—",
              })),
            ),
            h(
              "div",
              { className: "hao-coverage-row" },
              h("span", null, props.t("overview.unattributed")),
              h("strong", null, props.number(observed.unattributedRequests)),
              h("small", null, props.t("overview.unattributedHint", {
                count: props.number(observed.unattributedEvidenceCount),
              })),
            ),
          ),
        ),
        h(
          Panel,
          {
            title: props.t("overview.recentDecisions"),
            subtitle: props.t("overview.recentDecisionsSubtitle"),
            className: "hao-span-12",
          },
          h(DataTable, {
            columns: decisionColumns,
            rows: decisions,
            empty: props.t("overview.noDecisions"),
          }),
        ),
      ),
    );
  }

  function Organization(props) {
    const organization = asObject(props.data.organization);
    const error = sourceError(organization);
    const [query, setQuery] = React.useState("");
    const [filter, setFilter] = React.useState("all");
    if (error) return h(ErrorBanner, { title: props.t("shell.loadError"), error: error });
    const normalized = query.trim().toLowerCase();
    const positions = asArray(organization.positions)
      .filter(function (position) {
        const appointments = asArray(position.currentAppointments);
        const duties = asArray(position.currentDuties);
        const effective = asObject(position.effectiveStaffing);
        const effectiveState = String(effective.state || position.status || "UNFILLED");
        if (filter === "staffed" && !["APPOINTED", "DEFAULTED", "DEFAULT_MODEL"].includes(effectiveState)) return false;
        if (filter === "defaulted" && !["DEFAULTED", "DEFAULT_MODEL"].includes(effectiveState)) return false;
        if (filter === "unfilled" && effectiveState !== "UNFILLED") return false;
        if (filter === "active" && duties.length === 0 && asArray(position.runtimeSessions).length === 0) {
          return false;
        }
        if (!normalized) return true;
        const haystack = [
          asObject(position.workScope).name,
          asObject(position.workScope).slug,
          position.name,
          position.slug,
          position.runtimeKind,
          appointments.map(function (item) {
            return item.employeeName;
          }),
          asObject(position.effectiveStaffing).employeeName,
          asObject(position.effectiveStaffing).provider,
          asObject(position.effectiveStaffing).model,
        ]
          .flat()
          .join(" ")
          .toLowerCase();
        return haystack.includes(normalized);
      })
      .sort(function (left, right) {
        const leftScope = String(asObject(left.workScope).name || "");
        const rightScope = String(asObject(right.workScope).name || "");
        return leftScope.localeCompare(rightScope) || String(left.name).localeCompare(String(right.name));
      });

    const columns = [
      {
        key: "scope",
        label: props.t("organization.scope"),
        render: function (position) {
          const scope = asObject(position.workScope);
          return h(
            "div",
            { className: "hao-primary-cell" },
            h("strong", null, scope.name || scope.slug || "—"),
            scope.slug && scope.slug !== scope.name ? h("small", null, scope.slug) : null,
          );
        },
      },
      {
        key: "position",
        label: props.t("organization.position"),
        render: function (position) {
          return h(
            "div",
            { className: "hao-primary-cell" },
            h("strong", null, position.name || position.slug),
            h("small", null, [position.kind, position.lifecyclePolicy].filter(Boolean).join(" · ")),
          );
        },
      },
      {
        key: "runtime",
        label: props.t("organization.runtime"),
        render: function (position) {
          return h("code", { className: "hao-code" }, position.runtimeKind || "—");
        },
      },
      {
        key: "staffing",
        label: props.t("organization.staffing"),
        render: function (position) {
          const effective = asObject(position.effectiveStaffing);
          return h(Status, { value: effective.state || position.status, t: props.t });
        },
      },
      {
        key: "employee",
        label: props.t("organization.employee"),
        render: function (position) {
          const appointments = asArray(position.currentAppointments);
          const duties = asArray(position.currentDuties);
          const effective = asObject(position.effectiveStaffing);
          const staffed = duties.find(function (duty) {
            return asObject(duty.currentStaffing).employeeName;
          });
          const name = staffed
            ? asObject(staffed.currentStaffing).employeeName
            : effective.employeeName || (appointments[0] && appointments[0].employeeName);
          const source = effective.source ? props.t("organization.source." + effective.source) : "";
          if (name) {
            return h(
              "div",
              { className: "hao-person" },
              h(Avatar, { name: name }),
              h(
                "div",
                { className: "hao-person-copy" },
                h("strong", null, name),
                source ? h("span", null, source) : null,
              ),
            );
          }
          if (effective.model) {
            return h(
              "div",
              { className: "hao-primary-cell" },
              h("strong", null, props.t("organization.defaultModel") + " · " + effective.model),
              h(
                "small",
                null,
                [effective.provider, props.t("organization.employeePending"), source].filter(Boolean).join(" · "),
              ),
            );
          }
          return h("span", { className: "hao-cell-empty" }, props.t("organization.noEmployee"));
        },
      },
      {
        key: "activity",
        label: props.t("organization.activity"),
        render: function (position) {
          const duty = asArray(position.currentDuties)[0];
          const runtime = asArray(position.runtimeSessions)[0];
          const activity = (duty && (duty.currentActivity || duty.lifecycle)) ||
            (runtime && (runtime.state || runtime.lifecycle));
          return activity
            ? h(Status, { value: activity, t: props.t })
            : h("span", { className: "hao-cell-empty" }, props.t("organization.noActivity"));
        },
      },
    ];

    return h(
      "div",
      { className: "hao-section-stack" },
      h(
        "div",
        { className: "hao-section-head" },
        h("div", null, h("h1", null, props.t("organization.title")), h("p", null, props.t("organization.subtitle"))),
        h("span", { className: "hao-count" }, props.t("common.records", { count: props.number(positions.length) })),
      ),
      h(Toolbar, {
        t: props.t,
        query: query,
        onQuery: setQuery,
        placeholder: props.t("organization.searchPlaceholder"),
        value: filter,
        onChange: setFilter,
        options: [
          { value: "all", label: props.t("organization.filterAll") },
          { value: "staffed", label: props.t("organization.filterStaffed") },
          { value: "defaulted", label: props.t("organization.filterDefaulted") },
          { value: "unfilled", label: props.t("organization.filterUnfilled") },
          { value: "active", label: props.t("organization.filterActive") },
        ],
      }),
      h(DataTable, { columns: columns, rows: positions, empty: props.t("common.noResults") }),
    );
  }

  function Workforce(props) {
    const workforce = asObject(props.data.workforce);
    const error = sourceError(workforce);
    const [query, setQuery] = React.useState("");
    const [filter, setFilter] = React.useState("all");
    if (error) return h(ErrorBanner, { title: props.t("shell.loadError"), error: error });
    const summary = asObject(workforce.summary);
    const observedSummary = asObject(summary.observedUsage);
    const normalized = query.trim().toLowerCase();
    const allEmployees = asArray(workforce.employees);
    const employees = allEmployees
      .filter(function (employee) {
        const appointments = asArray(employee.currentAppointments);
        const work = asArray(employee.currentWork);
        const observed = asObject(asObject(employee.career).observedUsage);
        if (filter === "appointed" && appointments.length === 0) return false;
        if (filter === "observed" && !signalTotal(observed)) return false;
        if (filter === "working" && work.length === 0) return false;
        if (!normalized) return true;
        const haystack = [
          employee.displayName,
          asObject(employee.supplier).name,
          asObject(employee.supplier).slug,
          asObject(employee.supplierModel).name,
          asObject(employee.supplierModel).key,
          appointments.map(function (appointment) {
            return [appointment.workScopeName, appointment.positionName, appointment.positionSlug];
          }),
        ]
          .flat(2)
          .join(" ")
          .toLowerCase();
        return haystack.includes(normalized);
      })
      .sort(function (left, right) {
        const leftAppointments = asArray(left.currentAppointments).length;
        const rightAppointments = asArray(right.currentAppointments).length;
        const leftObserved = Number(asObject(asObject(left.career).observedUsage).requests || 0);
        const rightObserved = Number(asObject(asObject(right.career).observedUsage).requests || 0);
        return (
          rightAppointments - leftAppointments ||
          rightObserved - leftObserved ||
          String(left.displayName).localeCompare(String(right.displayName))
        );
      });
    const observedEmployees = allEmployees.filter(function (employee) {
      return signalTotal(asObject(asObject(employee.career).observedUsage)) > 0;
    }).length;

    const columns = [
      {
        key: "employee",
        label: props.t("workforce.employee"),
        render: function (employee) {
          return h(PersonCell, {
            name: employee.displayName,
            detail:
              String(asObject(employee.supplier).name || "") +
              " · " +
              String(asObject(employee.supplierModel).name || ""),
          });
        },
      },
      {
        key: "appointment",
        label: props.t("workforce.appointment"),
        render: function (employee) {
          const appointments = asArray(employee.currentAppointments);
          if (!appointments.length) {
            return h("span", { className: "hao-cell-empty" }, props.t("workforce.noAppointment"));
          }
          return h(
            "div",
            { className: "hao-stack-mini" },
            appointments.map(function (appointment) {
              return h(
                "span",
                { className: "hao-position-pill", key: appointment.id },
                (appointment.workScopeName ? appointment.workScopeName + " / " : "") +
                  appointment.positionName,
                h("small", null, appointment.class),
              );
            }),
          );
        },
      },
      {
        key: "verified",
        label: props.t("workforce.verified"),
        className: "hao-number-cell",
        render: function (employee) {
          return h(UsageCell, {
            usage: asObject(asObject(employee.career).usage),
            empty: props.t("workforce.noVerified"),
            t: props.t,
            number: props.number,
            compact: props.compact,
            percentage: props.percentage,
          });
        },
      },
      {
        key: "observed",
        label: props.t("workforce.observed"),
        className: "hao-number-cell",
        render: function (employee) {
          return h(UsageCell, {
            usage: asObject(employee.career).observedUsage,
            observed: true,
            empty: props.t("workforce.noObserved"),
            t: props.t,
            number: props.number,
            compact: props.compact,
            percentage: props.percentage,
          });
        },
      },
      {
        key: "state",
        label: props.t("workforce.state"),
        render: function (employee) {
          const working = asArray(employee.currentWork).length > 0;
          return h(
            "div",
            { className: "hao-state-cell" },
            h(Status, { value: working ? "WORKING" : employee.cooperationState, t: props.t }),
            h(
              "small",
              null,
              props.number(employee.currentEmploymentCount) +
                " / " +
                props.number(employee.currentAppointmentCount),
            ),
          );
        },
      },
    ];

    return h(
      "div",
      { className: "hao-section-stack" },
      h(
        "div",
        { className: "hao-section-head" },
        h("div", null, h("h1", null, props.t("workforce.title")), h("p", null, props.t("workforce.subtitle"))),
        h("span", { className: "hao-count" }, props.t("common.records", { count: props.number(employees.length) })),
      ),
      h(
        "div",
        { className: "hao-provenance-grid" },
        h(Notice, { title: props.t("workforce.verifiedHelp"), icon: "✓" }, props.t("workforce.verifiedHelpText")),
        h(Notice, { title: props.t("workforce.observedHelp"), icon: "≈", tone: "observed" }, props.t("workforce.observedHelpText")),
      ),
      h(
        "div",
        { className: "hao-mini-metrics" },
        h(Metric, {
          label: props.t("workforce.coverage"),
          value: props.percentage(observedSummary.attributedRequests, observedSummary.totalRequests),
          hint: props.t("workforce.coverageHint", {
            attributed: props.number(observedSummary.attributedRequests),
            total: props.number(observedSummary.totalRequests),
          }),
        }),
        h(Metric, {
          label: props.t("workforce.observedEmployees"),
          value: props.number(observedEmployees),
          hint: props.t("workforce.observedEmployeesHint", {
            count: props.number(observedEmployees),
            total: props.number(allEmployees.length),
          }),
        }),
        h(Metric, {
          label: props.t("workforce.unattributedRequests"),
          value: props.number(observedSummary.unattributedRequests),
          hint: props.t("workforce.unattributedRequestsHint"),
        }),
      ),
      h(Toolbar, {
        t: props.t,
        query: query,
        onQuery: setQuery,
        placeholder: props.t("workforce.searchPlaceholder"),
        value: filter,
        onChange: setFilter,
        options: [
          { value: "all", label: props.t("workforce.filterAll") },
          { value: "appointed", label: props.t("workforce.filterAppointed") },
          { value: "observed", label: props.t("workforce.filterObserved") },
          { value: "working", label: props.t("workforce.filterWorking") },
        ],
      }),
      h(DataTable, { columns: columns, rows: employees, empty: props.t("common.noResults") }),
    );
  }

  function Suppliers(props) {
    const supply = asObject(props.data.supply);
    const workforce = asObject(props.data.workforce);
    const error = sourceError(supply);
    if (error) return h(ErrorBanner, { title: props.t("shell.loadError"), error: error });
    const workforceById = new Map(
      asArray(workforce.employees).map(function (employee) {
        return [employee.id, employee];
      }),
    );
    const suppliers = asArray(supply.suppliers);
    const infrastructure = asObject(supply.unmappedInfrastructure);
    const infrastructureRows = asArray(infrastructure.groups);
    const infrastructureColumns = [
      { key: "gatewayName", label: props.t("suppliers.gateway"), render: function (row) { return row.gatewayName || row.gatewaySlug || "—"; } },
      { key: "channelName", label: props.t("suppliers.channel") },
      {
        key: "health",
        label: props.t("suppliers.health"),
        render: function (row) {
          return h(
            "div",
            { className: "hao-inline-badges" },
            asArray(row.health).map(function (value) {
              return h(Status, { key: value, value: value, t: props.t });
            }),
          );
        },
      },
      {
        key: "modelHints",
        label: props.t("suppliers.models"),
        render: function (row) {
          return asArray(row.modelHints).length
            ? h("div", { className: "hao-code-list" }, asArray(row.modelHints).map(function (model) {
                return h("code", { key: model, className: "hao-code" }, model);
              }))
            : "—";
        },
      },
    ];

    return h(
      "div",
      { className: "hao-section-stack" },
      h(
        "div",
        { className: "hao-section-head" },
        h("div", null, h("h1", null, props.t("suppliers.title")), h("p", null, props.t("suppliers.subtitle"))),
        h("span", { className: "hao-count" }, props.t("common.records", { count: props.number(suppliers.length) })),
      ),
      h(
        "div",
        { className: "hao-supplier-grid" },
        suppliers.map(function (supplier) {
          const employees = asArray(supplier.employees);
          const agreements = asArray(supplier.agreements);
          const channels = agreements.flatMap(function (agreement) {
            return asArray(agreement.channels);
          });
          const observedRequests = employees.reduce(function (sum, employee) {
            const workforceEmployee = workforceById.get(employee.id);
            return (
              sum + Number(asObject(asObject(workforceEmployee && workforceEmployee.career).observedUsage).requests || 0)
            );
          }, 0);
          const healthyChannels = channels.filter(function (channel) {
            return channel.health === "HEALTHY";
          }).length;
          return h(
            "article",
            { className: "hao-supplier-card", key: supplier.id },
            h(
              "header",
              { className: "hao-supplier-head" },
              h(
                "div",
                { className: "hao-supplier-brand" },
                h("span", { className: "hao-supplier-mark", "aria-hidden": "true" }, String(supplier.name || "S")[0]),
                h("div", null, h("h2", null, supplier.name), h("p", null, supplier.slug)),
              ),
              h(Status, { value: supplier.lifecycle, t: props.t }),
            ),
            h(
              "div",
              { className: "hao-supplier-stats" },
              h("div", null, h("span", null, props.t("suppliers.employees")), h("strong", null, props.number(employees.length))),
              h("div", null, h("span", null, props.t("suppliers.agreements")), h("strong", null, props.number(agreements.length))),
              h("div", null, h("span", null, props.t("suppliers.channels")), h("strong", null, props.number(healthyChannels) + "/" + props.number(channels.length))),
              h("div", null, h("span", null, props.t("suppliers.observed")), h("strong", null, props.number(observedRequests))),
            ),
            h(
              "div",
              { className: "hao-supplier-section" },
              h("h3", null, props.t("suppliers.employees")),
              employees.length
                ? h(
                    "div",
                    { className: "hao-employee-cloud" },
                    employees.map(function (employee) {
                      const workforceEmployee = workforceById.get(employee.id);
                      const hasObservation = signalTotal(
                        asObject(asObject(workforceEmployee && workforceEmployee.career).observedUsage),
                      );
                      return h(
                        "span",
                        { className: "hao-employee-chip", key: employee.id },
                        h("span", { className: hasObservation ? "hao-live-dot" : "hao-idle-dot" }),
                        employee.displayName,
                      );
                    }),
                  )
                : h("span", { className: "hao-cell-empty" }, props.t("suppliers.noEmployees")),
            ),
            h(
              "div",
              { className: "hao-supplier-section" },
              h("h3", null, props.t("suppliers.agreements")),
              h(
                "div",
                { className: "hao-agreement-list" },
                agreements.map(function (agreement) {
                  return h(
                    "div",
                    { className: "hao-agreement-row", key: agreement.id },
                    h("div", null, h("strong", null, agreement.name), h("small", null, agreement.planName || props.t("suppliers.noPlan"))),
                    h(Status, { value: agreement.lifecycle, t: props.t }),
                  );
                }),
              ),
            ),
          );
        }),
      ),
      h(
        Panel,
        {
          title: props.t("suppliers.unclassified"),
          subtitle: props.t("suppliers.unclassifiedSubtitle"),
          action: h("span", { className: "hao-count" }, props.number(infrastructure.count)),
        },
        h(DataTable, {
          columns: infrastructureColumns,
          rows: infrastructureRows,
          empty: props.t("common.noData"),
        }),
      ),
    );
  }

  function Operations(props) {
    const organization = asObject(props.data.organization);
    const error = sourceError(organization);
    if (error) return h(ErrorBanner, { title: props.t("shell.loadError"), error: error });
    const runs = asArray(organization.activeRuns);
    const duties = asArray(organization.activeDuties);
    const runtimes = asArray(organization.activeRuntimeSessions);
    const runColumns = [
      {
        key: "title",
        label: props.t("operations.run"),
        render: function (run) {
          return h("div", { className: "hao-primary-cell" }, h("strong", null, run.title || run.id), h("small", null, run.externalRunRef || run.id));
        },
      },
      {
        key: "workScope",
        label: props.t("operations.scope"),
        render: function (run) {
          return asObject(run.workScope).name || asObject(run.workScope).slug || "—";
        },
      },
      { key: "status", label: props.t("workforce.state"), render: function (run) { return h(Status, { value: run.status, t: props.t }); } },
    ];
    const dutyColumns = [
      { key: "runTitle", label: props.t("operations.run") },
      { key: "positionName", label: props.t("operations.position") },
      { key: "currentActivity", label: props.t("operations.activity"), render: function (duty) { return h(Status, { value: duty.currentActivity || duty.lifecycle, t: props.t }); } },
      { key: "employee", label: props.t("workforce.employee"), render: function (duty) { return asObject(duty.currentStaffing).employeeName || "—"; } },
    ];
    const runtimeColumns = [
      { key: "runtimeKind", label: props.t("operations.runtime"), render: function (runtime) { return h("code", { className: "hao-code" }, runtime.runtimeKind || "—"); } },
      { key: "positionName", label: props.t("operations.position") },
      { key: "modelHint", label: props.t("operations.model"), render: function (runtime) { return runtime.modelHint ? h("code", { className: "hao-code" }, runtime.modelHint) : "—"; } },
      { key: "state", label: props.t("workforce.state"), render: function (runtime) { return h(Status, { value: runtime.state || runtime.lifecycle, t: props.t }); } },
      { key: "lastSeenAt", label: props.t("operations.lastSeen"), render: function (runtime) { return props.relativeTime(runtime.lastSeenAt); } },
    ];
    return h(
      "div",
      { className: "hao-section-stack" },
      h("div", { className: "hao-section-head" }, h("div", null, h("h1", null, props.t("operations.title")), h("p", null, props.t("operations.subtitle")))),
      h(Panel, { title: props.t("operations.runs"), action: h("span", { className: "hao-count" }, props.number(runs.length)) }, h(DataTable, { columns: runColumns, rows: runs, empty: props.t("operations.noRuns") })),
      h(Panel, { title: props.t("operations.duties"), action: h("span", { className: "hao-count" }, props.number(duties.length)) }, h(DataTable, { columns: dutyColumns, rows: duties, empty: props.t("operations.noDuties") })),
      h(Panel, { title: props.t("operations.runtimes"), action: h("span", { className: "hao-count" }, props.number(runtimes.length)) }, h(DataTable, { columns: runtimeColumns, rows: runtimes, empty: props.t("operations.noRuntimes") })),
    );
  }

  function RuntimePolicy(props) {
    const initial = asObject(props.data.runtimePolicy);
    const [mode, setMode] = React.useState(String(initial.mode || "prefer"));
    const [opencodePosition, setOpenCodePosition] = React.useState(
      String(initial.opencodePosition || "coding-executor"),
    );
    const [codexPosition, setCodexPosition] = React.useState(
      String(initial.codexPosition || "codex-executor"),
    );
    const [saving, setSaving] = React.useState(false);
    const [message, setMessage] = React.useState("");
    React.useEffect(
      function () {
        setMode(String(initial.mode || "prefer"));
        setOpenCodePosition(String(initial.opencodePosition || "coding-executor"));
        setCodexPosition(String(initial.codexPosition || "codex-executor"));
      },
      [initial.mode, initial.opencodePosition, initial.codexPosition],
    );

    async function save() {
      setSaving(true);
      setMessage("");
      try {
        await api("/settings/runtime-policy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: mode,
            opencode_position: opencodePosition,
            codex_position: codexPosition,
          }),
        });
        setMessage(props.t("policy.saved"));
        await props.onRefresh();
      } catch (error) {
        setMessage(String(error));
      } finally {
        setSaving(false);
      }
    }

    const decisions = asArray(asObject(props.data.runtimeDecisions).items);
    const columns = [
      { key: "when", label: props.t("policy.when"), render: function (item) { return props.relativeTime(item.decidedAt); } },
      { key: "runtimeKind", label: props.t("policy.runtime") },
      { key: "position", label: props.t("policy.position"), render: function (item) { return asObject(item.position).name || asObject(item.position).slug || "—"; } },
      { key: "employee", label: props.t("policy.employee"), render: function (item) { return asObject(item.employee).name || "—"; } },
      { key: "selectedModel", label: props.t("policy.model"), className: "hao-mono", render: function (item) { return item.selectedModel || item.requestedModel || "—"; } },
      { key: "status", label: props.t("policy.outcome"), render: function (item) { return h(Status, { value: item.status, t: props.t }); } },
    ];

    return h(
      "div",
      { className: "hao-section-stack" },
      h(
        Panel,
        {
          title: props.t("policy.title"),
          subtitle: props.t("policy.subtitle"),
          action: h(Button, { disabled: saving, onClick: save }, saving ? props.t("common.saving") : props.t("common.save")),
        },
        h(
          "div",
          { className: "hao-policy-form" },
          h("label", null, h("span", null, props.t("policy.mode")), h("select", { value: mode, onChange: function (event) { setMode(event.target.value); } }, h("option", { value: "observe" }, props.t("policy.observe")), h("option", { value: "prefer" }, props.t("policy.prefer")), h("option", { value: "enforce" }, props.t("policy.enforce")))),
          h("label", null, h("span", null, props.t("policy.openCodePosition")), h("input", { value: opencodePosition, onChange: function (event) { setOpenCodePosition(event.target.value); } })),
          h("label", null, h("span", null, props.t("policy.codexPosition")), h("input", { value: codexPosition, onChange: function (event) { setCodexPosition(event.target.value); } })),
        ),
        h("p", { className: "hao-form-help" }, props.t("policy.help")),
        message ? h("div", { className: "hao-save-message", role: "status" }, message) : null,
      ),
      h(
        Panel,
        {
          title: props.t("policy.decisions"),
          subtitle: props.t("policy.decisionsSubtitle"),
          action: h("span", { className: "hao-count" }, props.number(decisions.length)),
        },
        h(DataTable, { columns: columns, rows: decisions, empty: props.t("policy.noDecisions") }),
      ),
    );
  }

  function Incidents(props) {
    const source = asObject(props.data.incidents);
    const error = sourceError(source);
    if (error) return h(ErrorBanner, { title: props.t("shell.loadError"), error: error });
    const incidents = asArray(source.items).filter(function (item) {
      return item.lifecycle === "OPEN" || item.lifecycle === "ACKNOWLEDGED";
    });
    const columns = [
      { key: "title", label: props.t("incidents.incident"), render: function (item) { return h("div", { className: "hao-primary-cell" }, h("strong", null, item.title || item.kind), item.summary ? h("small", null, item.summary) : null); } },
      { key: "kind", label: props.t("incidents.kind") },
      { key: "severity", label: props.t("incidents.severity"), render: function (item) { return h(Status, { value: item.severity, t: props.t }); } },
      { key: "lifecycle", label: props.t("incidents.lifecycle"), render: function (item) { return h(Status, { value: item.lifecycle, t: props.t }); } },
      { key: "lastSeenAt", label: props.t("incidents.lastSeen"), render: function (item) { return props.relativeTime(item.lastSeenAt); } },
      { key: "occurrenceCount", label: props.t("incidents.occurrences"), className: "hao-number-cell", render: function (item) { return props.number(item.occurrenceCount || 1); } },
    ];
    return h(
      "div",
      { className: "hao-section-stack" },
      h("div", { className: "hao-section-head" }, h("div", null, h("h1", null, props.t("incidents.title")), h("p", null, props.t("incidents.subtitle"))), h("span", { className: "hao-count" }, props.number(incidents.length))),
      h(DataTable, { columns: columns, rows: incidents, empty: props.t("incidents.none") }),
    );
  }

  const TAB_KEYS = ["overview", "organization", "workforce", "suppliers", "operations", "policy", "incidents"];

  function OfficePage() {
    const i18n = useI18n();
    const locale = localeKey(i18n && i18n.locale);
    const theme = useHostTheme();
    const t = React.useMemo(function () {
      return translator(locale);
    }, [locale]);
    const [tab, setTab] = React.useState("overview");
    const [data, setData] = React.useState(null);
    const [error, setError] = React.useState("");
    const [loading, setLoading] = React.useState(true);

    const load = React.useCallback(async function () {
      try {
        const value = await api("/overview");
        setData(value);
        setError("");
      } catch (cause) {
        setError(String(cause));
      } finally {
        setLoading(false);
      }
    }, []);

    React.useEffect(function () {
      load();
      const timer = window.setInterval(load, 15000);
      return function () {
        window.clearInterval(timer);
      };
    }, [load]);

    const shared = {
      data: data,
      t: t,
      locale: locale,
      number: function (value) {
        return number(value, locale);
      },
      compact: function (value) {
        return compact(value, locale);
      },
      money: function (value) {
        return money(value, locale);
      },
      percentage: function (part, total) {
        return percentage(part, total, locale);
      },
      relativeTime: function (value) {
        return relativeTime(value, locale);
      },
    };

    let content = null;
    if (data) {
      if (tab === "organization") content = h(Organization, shared);
      else if (tab === "workforce") content = h(Workforce, shared);
      else if (tab === "suppliers") content = h(Suppliers, shared);
      else if (tab === "operations") content = h(Operations, shared);
      else if (tab === "policy") content = h(RuntimePolicy, Object.assign({}, shared, { onRefresh: load }));
      else if (tab === "incidents") content = h(Incidents, shared);
      else content = h(Overview, Object.assign({}, shared, { onNavigate: setTab }));
    }

    return h(
      "main",
      { className: "hao-page", "data-locale": locale, "data-hao-theme": theme },
      h(
        "header",
        { className: "hao-hero" },
        h(
          "div",
          { className: "hao-hero-copy" },
          h("div", { className: "hao-kicker" }, t("shell.kicker")),
          h("h1", null, t("shell.title")),
          h("p", null, t("shell.subtitle")),
        ),
        h(
          "div",
          { className: "hao-hero-actions" },
          data
            ? h("span", { className: "hao-sync" }, t("shell.lastSync", { time: relativeTime(data.generatedAt, locale) }))
            : null,
          h(Button, { onClick: load, disabled: loading }, loading ? t("shell.refreshing") : t("shell.refresh")),
        ),
      ),
      h(
        "nav",
        { className: "hao-tabs", role: "tablist", "aria-label": "AI Office" },
        TAB_KEYS.map(function (key) {
          return h(
            "button",
            {
              key: key,
              className: "hao-tab",
              type: "button",
              role: "tab",
              "aria-selected": tab === key,
              onClick: function () {
                setTab(key);
              },
            },
            t("tabs." + key),
          );
        }),
      ),
      error ? h(ErrorBanner, { title: t("shell.loadError"), error: error }) : null,
      !data && loading ? h("div", { className: "hao-loading" }, t("shell.loading")) : content,
      data
        ? h(
            "footer",
            { className: "hao-footer" },
            h("span", null, t("shell.lastSync", { time: relativeTime(data.generatedAt, locale) })),
            h("span", { "aria-hidden": "true" }, "·"),
            h("span", null, t("shell.localOnly")),
          )
        : null,
    );
  }

  registry.register("hermes-ai-office", OfficePage);
})();
