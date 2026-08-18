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
      "shell.localOnly": "Local control plane · API keys stay inside Hermes/LiteLLM credential boundaries and never enter workforce projections",
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
      "workforce.subtitle": "Employees ranked by verified contribution. Open details for positions, employment, and observed evidence.",
      "workforce.searchPlaceholder": "Search employee, supplier, model, or position",
      "workforce.filterAll": "All employees",
      "workforce.filterAppointed": "Appointed",
      "workforce.filterObserved": "Observed activity",
      "workforce.filterWorking": "Working now",
      "workforce.filterInternal": "Internal employees",
      "workforce.internalSource": "Internal",
      "workforce.employee": "Employee",
      "workforce.contributionTokens": "Contribution tokens",
      "workforce.apiEquivalent": "API-equivalent value",
      "workforce.positionCount": "Positions",
      "workforce.actions": "Actions",
      "workforce.details": "View details",
      "workforce.detailTitle": "Employee details",
      "workforce.detailSubtitle": "Identity, verified contribution, appointments, employment, and observation evidence",
      "workforce.verifiedContribution": "Verified contribution",
      "workforce.positions": "Current positions",
      "workforce.employments": "Current employment",
      "workforce.currentWork": "Current work",
      "workforce.observationEvidence": "Observation evidence",
      "workforce.requests": "Requests",
      "workforce.actualCost": "Actual cost",
      "workforce.marketValue": "API-equivalent value",
      "workforce.inputTokens": "Input tokens",
      "workforce.outputTokens": "Output tokens",
      "workforce.noPositions": "No current positions",
      "workforce.noEmployments": "No current employment",
      "workforce.noCurrentWork": "No current work",
      "workforce.loadingDetails": "Loading employee details…",
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
      "suppliers.supplier": "Supplier",
      "suppliers.actions": "Actions",
      "suppliers.internal": "Internal supplier",
      "suppliers.subtitle": "All workforce suppliers in one place. Internal account pools are marked as internal suppliers; technical connections stay in details.",
      "suppliers.add": "Add supplier",
      "suppliers.details": "View details",
      "suppliers.website": "Website",
      "suppliers.close": "Close",
      "suppliers.employees": "Employees",
      "suppliers.enabledEmployees": "Enabled employees",
      "suppliers.defaultEmployee": "Default employee",
      "suppliers.defaultEmployeeNone": "No preferred employee",
      "suppliers.agreements": "Agreements",
      "suppliers.channels": "Technical channels",
      "suppliers.connections": "Provider connections",
      "suppliers.connectionsLoading": "Loading connection details…",
      "suppliers.noConnections": "No provider connection metadata",
      "suppliers.effectiveState": "Effective state",
      "suppliers.adminState": "Admin state",
      "suppliers.routable": "Routable",
      "suppliers.retryable": "Retryable",
      "suppliers.consecutiveFailures": "Consecutive failures",
      "suppliers.lastError": "Last error",
      "suppliers.lastSuccess": "Last success",
      "suppliers.lastFailure": "Last failure",
      "suppliers.retryAfter": "Retry after",
      "suppliers.recentAttempts": "Recent attempts",
      "suppliers.enable": "Enable / reset trial",
      "suppliers.disable": "Disable",
      "suppliers.retry": "Retry / reset trial",
      "suppliers.controlBusy": "Updating…",
      "suppliers.controlReason": "AI Office dashboard operator",
      "suppliers.runtimeAccess": "Agent access",
      "suppliers.nativeAccess": "Native config",
      "suppliers.gatewayAccess": "Gateway adapter",
      "suppliers.accessProvider": "Provider / profile",
      "suppliers.accessModel": "Model",
      "suppliers.observed": "Observed requests",
      "suppliers.noPlan": "No explicit plan metadata",
      "suppliers.noEmployees": "No employee identities",
      "suppliers.legacySelection": "All existing employees are eligible until an explicit selection is saved.",
      "suppliers.enabled": "Enabled",
      "suppliers.disabled": "Not selected",
      "suppliers.preferred": "Default",
      "suppliers.detailTitle": "Supplier details",
      "suppliers.detailSubtitle": "Business identity, selected employees, native Agent access, agreements, and technical evidence",
      "suppliers.addTitle": "Add supplier",
      "suppliers.addSubtitle": "Choose a common provider or use any OpenAI-compatible endpoint.",
      "suppliers.chooseProvider": "1. Choose provider",
      "suppliers.credentials": "2. Connection",
      "suppliers.apiKey": "API Key",
      "suppliers.apiKeyExisting": "Already configured in Hermes. Leave blank to reuse it.",
      "suppliers.apiKeyRequired": "Paste the provider API key.",
      "suppliers.baseUrl": "API request URL",
      "suppliers.supplierName": "Supplier name (optional)",
      "suppliers.supplierNameHint": "Leave blank and Hermes will generate a name from the URL.",
      "suppliers.discover": "Fetch models",
      "suppliers.discovering": "Fetching models…",
      "suppliers.selectModels": "3. Choose employees",
      "suppliers.selectModelsHint": "Only checked models become enabled employees. Pick one as the default employee.",
      "suppliers.modelSearch": "Search discovered models",
      "suppliers.selectedCount": "{count} selected",
      "suppliers.saveSupplier": "Save supplier",
      "suppliers.savingSupplier": "Saving supplier…",
      "suppliers.saved": "Supplier saved. Workforce policy has been updated.",
      "suppliers.security": "The API key stays in Hermes local credential storage. Agent calls use native OpenCode/Codex configuration by default; LiteLLM is only an optional compatibility adapter. AI Office business storage never stores the key.",
      "suppliers.custom": "Custom endpoint",
      "suppliers.customHint": "OpenAI-compatible URL + API key",
      "suppliers.configured": "Configured",
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
      "status.READY": "Ready",
      "status.UNAVAILABLE": "Unavailable",
      "status.UNKNOWN": "Unknown",
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
      "shell.localOnly": "本地控制面 · API Key 仅保存在 Hermes/LiteLLM 本地凭证边界，不进入员工与经营投影",
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
      "workforce.subtitle": "按已核验贡献排序员工；岗位、Employment 与观测证据需要时再查看详情。",
      "workforce.searchPlaceholder": "搜索员工、供应商、模型或岗位",
      "workforce.filterAll": "全部员工",
      "workforce.filterAppointed": "已有岗位",
      "workforce.filterObserved": "有观测活动",
      "workforce.filterWorking": "正在工作",
      "workforce.filterInternal": "内部员工",
      "workforce.internalSource": "内部",
      "workforce.employee": "员工",
      "workforce.contributionTokens": "贡献 Token",
      "workforce.apiEquivalent": "API 等价金额",
      "workforce.positionCount": "担任职位",
      "workforce.actions": "操作",
      "workforce.details": "查看详情",
      "workforce.detailTitle": "员工详情",
      "workforce.detailSubtitle": "员工身份、已核验贡献、岗位、Employment 与观测证据",
      "workforce.verifiedContribution": "已核验贡献",
      "workforce.positions": "当前岗位",
      "workforce.employments": "当前 Employment",
      "workforce.currentWork": "当前工作",
      "workforce.observationEvidence": "观测证据",
      "workforce.requests": "请求数",
      "workforce.actualCost": "实际成本",
      "workforce.marketValue": "API 等价金额",
      "workforce.inputTokens": "输入 Token",
      "workforce.outputTokens": "输出 Token",
      "workforce.noPositions": "暂无当前岗位",
      "workforce.noEmployments": "暂无当前 Employment",
      "workforce.noCurrentWork": "暂无当前工作",
      "workforce.loadingDetails": "正在获取员工详情…",
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
      "suppliers.supplier": "供应商",
      "suppliers.actions": "操作",
      "suppliers.internal": "内部供应商",
      "suppliers.subtitle": "统一管理所有员工来源；My CPA、Grok2API 等账号池作为内部供应商展示，技术连接仍收进详情。",
      "suppliers.add": "添加供应商",
      "suppliers.details": "查看详情",
      "suppliers.website": "官网",
      "suppliers.close": "关闭",
      "suppliers.employees": "员工",
      "suppliers.enabledEmployees": "启用员工",
      "suppliers.defaultEmployee": "默认员工",
      "suppliers.defaultEmployeeNone": "暂无默认员工",
      "suppliers.agreements": "供应协议",
      "suppliers.channels": "技术通道",
      "suppliers.connections": "接入连接",
      "suppliers.connectionsLoading": "正在获取接入详情…",
      "suppliers.noConnections": "暂无 Provider 连接信息",
      "suppliers.effectiveState": "生效状态",
      "suppliers.adminState": "管理状态",
      "suppliers.routable": "可路由",
      "suppliers.retryable": "可重试",
      "suppliers.consecutiveFailures": "连续失败",
      "suppliers.lastError": "最近错误",
      "suppliers.lastSuccess": "最近成功",
      "suppliers.lastFailure": "最近失败",
      "suppliers.retryAfter": "重试时间",
      "suppliers.recentAttempts": "近期尝试",
      "suppliers.enable": "启用 / 重置试用",
      "suppliers.disable": "禁用",
      "suppliers.retry": "重试 / 重置试用",
      "suppliers.controlBusy": "更新中…",
      "suppliers.controlReason": "AI Office 控制台操作员",
      "suppliers.runtimeAccess": "Agent 接入",
      "suppliers.nativeAccess": "原生配置",
      "suppliers.gatewayAccess": "网关适配",
      "suppliers.accessProvider": "Provider / Profile",
      "suppliers.accessModel": "模型",
      "suppliers.observed": "观测请求",
      "suppliers.noPlan": "暂无明确套餐元数据",
      "suppliers.noEmployees": "暂无员工身份",
      "suppliers.legacySelection": "尚未保存显式员工选择；当前已有员工仍按原策略参与候选。",
      "suppliers.enabled": "已启用",
      "suppliers.disabled": "未选用",
      "suppliers.preferred": "默认",
      "suppliers.detailTitle": "供应商详情",
      "suppliers.detailSubtitle": "供应商身份、员工选择、Agent 原生接入、供应协议与技术证据",
      "suppliers.addTitle": "添加供应商",
      "suppliers.addSubtitle": "选择常用供应商，或者直接填写任意 OpenAI 兼容请求地址。",
      "suppliers.chooseProvider": "1. 选择供应商",
      "suppliers.credentials": "2. 连接信息",
      "suppliers.apiKey": "API Key",
      "suppliers.apiKeyExisting": "Hermes 已经配置过凭证；留空即可复用。",
      "suppliers.apiKeyRequired": "粘贴该供应商的 API Key。",
      "suppliers.baseUrl": "API 请求地址",
      "suppliers.supplierName": "供应商名称（选填）",
      "suppliers.supplierNameHint": "不填写时，Hermes 会根据请求地址自动生成。",
      "suppliers.discover": "获取模型",
      "suppliers.discovering": "正在获取模型…",
      "suppliers.selectModels": "3. 挑选员工",
      "suppliers.selectModelsHint": "只有勾选的模型会成为启用员工；再指定其中一名作为默认员工。",
      "suppliers.modelSearch": "搜索已发现模型",
      "suppliers.selectedCount": "已选择 {count} 个",
      "suppliers.saveSupplier": "保存供应商",
      "suppliers.savingSupplier": "正在保存…",
      "suppliers.saved": "供应商已保存，员工策略已同步。",
      "suppliers.security": "API Key 只保存在 Hermes 本地凭证管理中。模型调用默认通过 OpenCode/Codex 等官方 Agent 的原生配置直连；LiteLLM 仅作为可选兼容适配器。AI Office 业务库永不保存 Key。",
      "suppliers.custom": "自定义接口",
      "suppliers.customHint": "OpenAI 兼容地址 + API Key",
      "suppliers.configured": "已配置",
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
      "status.READY": "可用",
      "status.UNAVAILABLE": "不可用",
      "status.UNKNOWN": "未知",
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
        "READY",
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
      ["ERROR", "CRITICAL", "BLOCKED", "UNHEALTHY", "UNAVAILABLE", "DORMANT", "UNFILLED"].includes(
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

  function Modal(props) {
    React.useEffect(
      function () {
        if (!props.open) return undefined;
        function onKeyDown(event) {
          if (event.key === "Escape") props.onClose();
        }
        document.addEventListener("keydown", onKeyDown);
        return function () {
          document.removeEventListener("keydown", onKeyDown);
        };
      },
      [props.open, props.onClose],
    );
    if (!props.open) return null;
    return h(
      "div",
      {
        className: "hao-modal-backdrop",
        role: "presentation",
        onMouseDown: function (event) {
          if (event.target === event.currentTarget) props.onClose();
        },
      },
      h(
        "section",
        {
          className: "hao-modal " + (props.wide ? "hao-modal-wide" : ""),
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": props.labelledBy,
        },
        h(
          "header",
          { className: "hao-modal-head" },
          h(
            "div",
            null,
            h("h2", { id: props.labelledBy }, props.title),
            props.subtitle ? h("p", null, props.subtitle) : null,
          ),
          h(
            "button",
            { className: "hao-modal-close", type: "button", onClick: props.onClose, "aria-label": props.closeLabel },
            "×",
          ),
        ),
        h("div", { className: "hao-modal-body" }, props.children),
        props.footer ? h("footer", { className: "hao-modal-footer" }, props.footer) : null,
      ),
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
          value: props.number(supplySummary.workforceSources || supplySummary.suppliers),
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
    const [detailEmployee, setDetailEmployee] = React.useState(null);
    const [detail, setDetail] = React.useState(null);
    const [detailLoading, setDetailLoading] = React.useState(false);
    const [detailError, setDetailError] = React.useState("");
    if (error) return h(ErrorBanner, { title: props.t("shell.loadError"), error: error });

    const summary = asObject(workforce.summary);
    const observedSummary = asObject(summary.observedUsage);
    const normalized = query.trim().toLowerCase();
    const allEmployees = asArray(workforce.employees);

    function verifiedUsage(employee) {
      return asObject(asObject(employee.career).usage);
    }

    function contributionTokens(employee) {
      const usage = verifiedUsage(employee);
      return Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0);
    }

    function marketValue(employee) {
      return Number(verifiedUsage(employee).marketValue || 0);
    }

    const employees = allEmployees
      .filter(function (employee) {
        const appointments = asArray(employee.currentAppointments);
        const work = asArray(employee.currentWork);
        const observed = asObject(asObject(employee.career).observedUsage);
        if (filter === "appointed" && appointments.length === 0) return false;
        if (filter === "observed" && !signalTotal(observed)) return false;
        if (filter === "working" && work.length === 0) return false;
        if (filter === "internal" && String(asObject(employee.supplier).sourceKind || "EXTERNAL") !== "INTERNAL") return false;
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
        ].flat(2).join(" ").toLowerCase();
        return haystack.includes(normalized);
      })
      .sort(function (left, right) {
        return (
          contributionTokens(right) - contributionTokens(left) ||
          marketValue(right) - marketValue(left) ||
          Number(right.currentAppointmentCount || 0) - Number(left.currentAppointmentCount || 0) ||
          String(left.displayName).localeCompare(String(right.displayName))
        );
      });

    const observedEmployees = allEmployees.filter(function (employee) {
      return signalTotal(asObject(asObject(employee.career).observedUsage)) > 0;
    }).length;

    async function openEmployeeDetail(employee) {
      setDetailEmployee(employee);
      setDetail(null);
      setDetailError("");
      setDetailLoading(true);
      try {
        const result = await api("/employees/" + encodeURIComponent(String(employee.id)) + "/dossier");
        setDetail(result);
      } catch (cause) {
        setDetailError(String(cause));
      } finally {
        setDetailLoading(false);
      }
    }

    function closeEmployeeDetail() {
      setDetailEmployee(null);
      setDetail(null);
      setDetailError("");
      setDetailLoading(false);
    }

    const detailValue = asObject(detail);
    const detailIdentity = asObject(detailValue.identity);
    const detailSupplier = asObject(detailEmployee && detailEmployee.supplier);
    const detailUsage = asObject(asObject(detailValue.career).usage);
    const detailObserved = asObject(asObject(detailValue.career).observedUsage);
    const detailCooperation = asObject(detailValue.cooperation);
    const detailOrganization = asObject(detailValue.organization);
    const detailAppointments = asArray(detailOrganization.currentAppointments);
    const detailEmployments = asArray(detailCooperation.currentEmployments);
    const detailWork = asArray(detailValue.currentWork);

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
        { className: "hao-mini-metrics" },
        h(Metric, {
          label: props.t("workforce.coverage"),
          value: props.percentage(observedSummary.attributedRequests, observedSummary.totalRequests),
          hint: props.t("workforce.coverageHint", { attributed: props.number(observedSummary.attributedRequests), total: props.number(observedSummary.totalRequests) }),
        }),
        h(Metric, {
          label: props.t("workforce.observedEmployees"),
          value: props.number(observedEmployees),
          hint: props.t("workforce.observedEmployeesHint", { count: props.number(observedEmployees), total: props.number(allEmployees.length) }),
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
          { value: "internal", label: props.t("workforce.filterInternal") },
        ],
      }),
      h(
        "div",
        { className: "hao-workforce-list" },
        h(
          "div",
          { className: "hao-workforce-row hao-workforce-row-head", "aria-hidden": "true" },
          h("span", null, props.t("workforce.employee")),
          h("span", null, props.t("workforce.contributionTokens")),
          h("span", null, props.t("workforce.apiEquivalent")),
          h("span", null, props.t("workforce.positionCount")),
          h("span", null, props.t("workforce.state")),
          h("span", null, props.t("workforce.actions")),
        ),
        employees.length
          ? employees.map(function (employee) {
              const source = asObject(employee.supplier);
              const internal = String(source.sourceKind || "EXTERNAL") === "INTERNAL";
              const tokens = contributionTokens(employee);
              const positions = Number(employee.currentAppointmentCount || 0);
              const working = Number(employee.currentDutyCount || 0) > 0;
              return h(
                "article",
                { className: "hao-workforce-row", key: employee.id },
                h(
                  "div",
                  { className: "hao-workforce-employee" },
                  h(Avatar, { name: employee.displayName }),
                  h(
                    "div",
                    { className: "hao-workforce-employee-copy" },
                    h("strong", null, employee.displayName),
                    h("small", null, (internal ? props.t("workforce.internalSource") + " · " : "") + String(source.name || "") + " · " + String(asObject(employee.supplierModel).name || "")),
                  ),
                ),
                h("strong", { className: "hao-workforce-number" }, props.compact(tokens)),
                h("strong", { className: "hao-workforce-number" }, props.money(marketValue(employee))),
                h("strong", { className: "hao-workforce-number" }, props.number(positions)),
                h(Status, { value: working ? "WORKING" : employee.cooperationState, t: props.t }),
                h(Button, { kind: "quiet", onClick: function () { openEmployeeDetail(employee); } }, props.t("workforce.details")),
              );
            })
          : h(Empty, null, props.t("common.noResults")),
      ),
      h(
        Modal,
        {
          open: Boolean(detailEmployee),
          onClose: closeEmployeeDetail,
          labelledBy: "hao-employee-detail-title",
          title: detailEmployee ? detailEmployee.displayName : props.t("workforce.detailTitle"),
          subtitle: props.t("workforce.detailSubtitle"),
          closeLabel: props.t("suppliers.close"),
          wide: true,
          footer: h(Button, { kind: "quiet", onClick: closeEmployeeDetail }, props.t("suppliers.close")),
        },
        detailLoading
          ? h("div", { className: "hao-detail-loading" }, props.t("workforce.loadingDetails"))
          : detailError
            ? h(ErrorBanner, { title: props.t("shell.loadError"), error: detailError })
            : detail
              ? h(
                  "div",
                  { className: "hao-employee-detail" },
                  h(
                    "section",
                    { className: "hao-detail-section" },
                    h("h3", null, props.t("workforce.verifiedContribution")),
                    h(
                      "div",
                      { className: "hao-detail-metrics hao-employee-detail-metrics" },
                      h("div", null, h("span", null, props.t("workforce.contributionTokens")), h("strong", null, props.compact(Number(detailUsage.inputTokens || 0) + Number(detailUsage.outputTokens || 0)))),
                      h("div", null, h("span", null, props.t("workforce.inputTokens")), h("strong", null, props.compact(detailUsage.inputTokens || 0))),
                      h("div", null, h("span", null, props.t("workforce.outputTokens")), h("strong", null, props.compact(detailUsage.outputTokens || 0))),
                      h("div", null, h("span", null, props.t("workforce.requests")), h("strong", null, props.number(detailUsage.requests || 0))),
                      h("div", null, h("span", null, props.t("workforce.actualCost")), h("strong", null, props.money(detailUsage.actualCost || 0))),
                      h("div", null, h("span", null, props.t("workforce.marketValue")), h("strong", null, props.money(detailUsage.marketValue || 0))),
                    ),
                  ),
                  h(
                    "section",
                    { className: "hao-detail-section" },
                    h("h3", null, props.t("workforce.positions")),
                    detailAppointments.length
                      ? h("div", { className: "hao-detail-list" }, detailAppointments.map(function (appointment) {
                          return h("div", { className: "hao-detail-list-row", key: appointment.id },
                            h("strong", null, (appointment.work_scope_name ? appointment.work_scope_name + " / " : "") + (appointment.position_name || appointment.position_slug || "—")),
                            h("span", null, [appointment.appointment_class, appointment.source].filter(Boolean).join(" · ")),
                          );
                        }))
                      : h("span", { className: "hao-cell-empty" }, props.t("workforce.noPositions")),
                  ),
                  h(
                    "section",
                    { className: "hao-detail-section" },
                    h("h3", null, props.t("workforce.employments")),
                    detailEmployments.length
                      ? h("div", { className: "hao-detail-list" }, detailEmployments.map(function (employment) {
                          return h("div", { className: "hao-detail-list-row", key: employment.id },
                            h("strong", null, employment.agreement_name || employment.id),
                            h("span", null, employment.status || "—"),
                          );
                        }))
                      : h("span", { className: "hao-cell-empty" }, props.t("workforce.noEmployments")),
                  ),
                  h(
                    "section",
                    { className: "hao-detail-section" },
                    h("h3", null, props.t("workforce.currentWork")),
                    detailWork.length
                      ? h("div", { className: "hao-detail-list" }, detailWork.map(function (work) {
                          return h("div", { className: "hao-detail-list-row", key: work.id || work.staffingSegmentId },
                            h("strong", null, work.position_name || work.positionName || work.position_id || "—"),
                            h("span", null, [work.run_title || work.runTitle, work.current_activity || work.currentActivity].filter(Boolean).join(" · ")),
                          );
                        }))
                      : h("span", { className: "hao-cell-empty" }, props.t("workforce.noCurrentWork")),
                  ),
                  signalTotal(detailObserved)
                    ? h(
                        "section",
                        { className: "hao-detail-section" },
                        h("h3", null, props.t("workforce.observationEvidence")),
                        h(UsageCell, { usage: detailObserved, observed: true, empty: props.t("workforce.noObserved"), t: props.t, number: props.number, compact: props.compact, percentage: props.percentage }),
                      )
                    : null,
                  h(
                    "section",
                    { className: "hao-detail-section" },
                    h("h3", null, props.t("workforce.employee")),
                    h("div", { className: "hao-detail-list" },
                      h("div", { className: "hao-detail-list-row" }, h("strong", null, detailIdentity.displayName || detailEmployee.displayName), h("span", null, [String(detailSupplier.sourceKind || "EXTERNAL") === "INTERNAL" ? props.t("suppliers.internal") : "", asObject(detailIdentity.supplier).name || detailSupplier.name, asObject(detailIdentity.supplierModel).name].filter(Boolean).join(" · "))),
                    ),
                  ),
                )
              : null,
      ),
    );
  }

  function Suppliers(props) {
    const supply = asObject(props.data.supply);
    const workforce = asObject(props.data.workforce);
    const error = sourceError(supply);
    const [detailSupplier, setDetailSupplier] = React.useState(null);
    const [detailConnections, setDetailConnections] = React.useState([]);
    const [detailConnectionsLoading, setDetailConnectionsLoading] = React.useState(false);
    const [detailConnectionsError, setDetailConnectionsError] = React.useState("");
    const [connectionActionId, setConnectionActionId] = React.useState("");
    const [addOpen, setAddOpen] = React.useState(false);
    const [presets, setPresets] = React.useState([]);
    const [presetId, setPresetId] = React.useState("opencode-go");
    const [apiKey, setApiKey] = React.useState("");
    const [baseUrl, setBaseUrl] = React.useState("");
    const [supplierName, setSupplierName] = React.useState("");
    const [websiteUrl, setWebsiteUrl] = React.useState("");
    const [models, setModels] = React.useState([]);
    const [selectedModels, setSelectedModels] = React.useState([]);
    const [defaultModel, setDefaultModel] = React.useState("");
    const [modelQuery, setModelQuery] = React.useState("");
    const [discovering, setDiscovering] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [formMessage, setFormMessage] = React.useState("");

    if (error) return h(ErrorBanner, { title: props.t("shell.loadError"), error: error });

    const workforceById = new Map(
      asArray(workforce.employees).map(function (employee) {
        return [employee.id, employee];
      }),
    );
    const suppliers = asArray(supply.suppliers);
    const currentPreset =
      presets.find(function (preset) {
        return preset.id === presetId;
      }) || null;
    const visibleModels = models.filter(function (model) {
      const needle = modelQuery.trim().toLowerCase();
      return !needle || String(model.name || model.id).toLowerCase().includes(needle);
    });

    function resetOnboarding() {
      setPresetId("opencode-go");
      setApiKey("");
      setBaseUrl("");
      setSupplierName("");
      setWebsiteUrl("");
      setModels([]);
      setSelectedModels([]);
      setDefaultModel("");
      setModelQuery("");
      setFormMessage("");
      setDiscovering(false);
      setSaving(false);
    }

    async function openSupplierDetail(supplier) {
      setDetailSupplier(supplier);
      setDetailConnections([]);
      setDetailConnectionsError("");
      setDetailConnectionsLoading(true);
      try {
        const result = await api("/suppliers/" + encodeURIComponent(String(supplier.id)) + "/connections");
        setDetailConnections(asArray(result.items));
      } catch (cause) {
        setDetailConnectionsError(String(cause));
      } finally {
        setDetailConnectionsLoading(false);
      }
    }

    async function controlConnection(connection, enabled) {
      setConnectionActionId(String(connection.id));
      try {
        await api("/providers/hub/" + encodeURIComponent(String(connection.id)) + "/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: Boolean(enabled), reason: "AI Office dashboard operator" }),
        });
        if (detailSupplier) await openSupplierDetail(detailSupplier);
      } catch (cause) {
        setDetailConnectionsError(String(cause));
      } finally {
        setConnectionActionId("");
      }
    }

    function connectionTime(value) {
      if (!value) return props.t("common.notRecorded");
      const numeric = Number(value);
      return props.relativeTime(Number.isFinite(numeric) && numeric ? numeric : Date.parse(String(value)));
    }

    function closeSupplierDetail() {
      setDetailSupplier(null);
      setDetailConnections([]);
      setDetailConnectionsError("");
      setDetailConnectionsLoading(false);
    }

    async function openOnboarding() {
      resetOnboarding();
      setAddOpen(true);
      try {
        const result = await api("/providers/presets");
        const items = asArray(result.items);
        setPresets(items);
        const preferred =
          items.find(function (item) {
            return item.id === "opencode-go";
          }) || items[0];
        if (preferred) setPresetId(preferred.id);
      } catch (cause) {
        setFormMessage(String(cause));
      }
    }

    function choosePreset(id) {
      setPresetId(id);
      setModels([]);
      setSelectedModels([]);
      setDefaultModel("");
      setModelQuery("");
      setFormMessage("");
      if (id !== "custom") {
        setBaseUrl("");
        setSupplierName("");
        setWebsiteUrl("");
      }
    }

    async function discoverModels() {
      setDiscovering(true);
      setFormMessage("");
      try {
        const result = await api("/providers/discover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            preset_id: presetId,
            api_key: apiKey,
            base_url: baseUrl,
            supplier_name: supplierName,
            website_url: websiteUrl,
          }),
        });
        setModels(asArray(result.models));
        setSelectedModels([]);
        setDefaultModel("");
      } catch (cause) {
        setModels([]);
        setFormMessage(String(cause));
      } finally {
        setDiscovering(false);
      }
    }

    function toggleModel(modelId) {
      setSelectedModels(function (current) {
        if (current.includes(modelId)) {
          const next = current.filter(function (value) {
            return value !== modelId;
          });
          if (defaultModel === modelId) setDefaultModel(next[0] || "");
          return next;
        }
        const next = current.concat([modelId]);
        if (!defaultModel) setDefaultModel(modelId);
        return next;
      });
    }

    async function saveSupplier() {
      if (!selectedModels.length) return;
      setSaving(true);
      setFormMessage("");
      try {
        await api("/providers/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            preset_id: presetId,
            api_key: apiKey,
            base_url: baseUrl,
            supplier_name: supplierName,
            website_url: websiteUrl,
            selected_models: selectedModels,
            default_model: defaultModel || selectedModels[0],
          }),
        });
        setFormMessage(props.t("suppliers.saved"));
        await props.onRefresh();
        setAddOpen(false);
        resetOnboarding();
      } catch (cause) {
        setFormMessage(String(cause));
      } finally {
        setSaving(false);
      }
    }

    function supplierFacts(supplier) {
      const employees = asArray(supplier.employees);
      const agreements = asArray(supplier.agreements);
      const channels = agreements.flatMap(function (agreement) {
        return asArray(agreement.channels);
      });
      const employments = agreements.flatMap(function (agreement) {
        return asArray(agreement.employments);
      });
      const runtimeAccess = employments.flatMap(function (employment) {
        return asArray(employment.runtimeAccess).map(function (access) {
          return Object.assign({ employeeName: employment.employeeName, employmentId: employment.id }, access);
        });
      });
      const nativeAccess = runtimeAccess.filter(function (access) {
        return access.adapterKind === "NATIVE_CONFIG" && access.lifecycle === "ACTIVE";
      });
      const gatewayAccess = runtimeAccess.filter(function (access) {
        return access.adapterKind === "GATEWAY" && access.lifecycle === "ACTIVE";
      });
      const metadata = asObject(supplier.metadata);
      const preferences = asObject(metadata.staffingPreferences);
      const explicitlySelected = Array.isArray(preferences.enabledEmployeeIds);
      const enabledIds = explicitlySelected ? asArray(preferences.enabledEmployeeIds).map(String) : employees.map(function (employee) { return String(employee.id); });
      const defaultEmployeeId = String(preferences.defaultEmployeeId || "");
      const defaultEmployee = employees.find(function (employee) {
        return String(employee.id) === defaultEmployeeId;
      });
      const observedRequests = employees.reduce(function (sum, employee) {
        const workforceEmployee = workforceById.get(employee.id);
        return sum + Number(asObject(asObject(workforceEmployee && workforceEmployee.career).observedUsage).requests || 0);
      }, 0);
      const healthyChannels = channels.filter(function (channel) {
        return channel.health === "HEALTHY";
      }).length;
      return {
        employees: employees,
        agreements: agreements,
        channels: channels,
        employments: employments,
        runtimeAccess: runtimeAccess,
        nativeAccess: nativeAccess,
        gatewayAccess: gatewayAccess,
        enabledIds: enabledIds,
        explicitlySelected: explicitlySelected,
        defaultEmployee: defaultEmployee,
        defaultEmployeeId: defaultEmployeeId,
        observedRequests: observedRequests,
        healthyChannels: healthyChannels,
      };
    }

    const detailFacts = detailSupplier ? supplierFacts(detailSupplier) : null;

    return h(
      "div",
      { className: "hao-section-stack" },
      h(
        "div",
        { className: "hao-section-head" },
        h("div", null, h("h1", null, props.t("suppliers.title")), h("p", null, props.t("suppliers.subtitle"))),
        h(
          "div",
          { className: "hao-section-actions" },
          h("span", { className: "hao-count" }, props.t("common.records", { count: props.number(suppliers.length) })),
          h(Button, { onClick: openOnboarding }, "+ " + props.t("suppliers.add")),
        ),
      ),
      suppliers.length
        ? h(
            "div",
            { className: "hao-supplier-list" },
            h(
              "div",
              { className: "hao-supplier-row hao-supplier-row-head", "aria-hidden": "true" },
              h("span", null, props.t("suppliers.supplier")),
              h("span", null, props.t("suppliers.enabledEmployees")),
              h("span", null, props.t("suppliers.defaultEmployee")),
              h("span", null, props.t("workforce.state")),
              h("span", null, props.t("suppliers.actions")),
            ),
            suppliers.map(function (supplier) {
              const facts = supplierFacts(supplier);
              const internal = String(supplier.sourceKind || "EXTERNAL") === "INTERNAL";
              return h(
                "article",
                { className: "hao-supplier-row", key: supplier.id },
                h(
                  "div",
                  { className: "hao-supplier-row-main" },
                  h("span", { className: "hao-supplier-mark", "aria-hidden": "true" }, String(supplier.name || "S")[0]),
                  h(
                    "div",
                    { className: "hao-supplier-row-copy" },
                    h("h2", null, supplier.name, internal ? h("span", { className: "hao-badge hao-badge-internal" }, props.t("suppliers.internal")) : null),
                    h("p", null, supplier.slug),
                    supplier.websiteUrl
                      ? h("a", { className: "hao-external-link hao-supplier-website", href: supplier.websiteUrl, target: "_blank", rel: "noreferrer" }, supplier.websiteUrl)
                      : null,
                  ),
                ),
                h(
                  "div",
                  { className: "hao-supplier-compact-stat" },
                  h("span", null, props.t("suppliers.enabledEmployees")),
                  h("strong", null, props.number(facts.enabledIds.length) + " / " + props.number(facts.employees.length)),
                ),
                h(
                  "div",
                  { className: "hao-supplier-default" },
                  h("span", null, props.t("suppliers.defaultEmployee")),
                  h("strong", null, facts.defaultEmployee ? facts.defaultEmployee.displayName : props.t("suppliers.defaultEmployeeNone")),
                ),
                h(
                  "div",
                  { className: "hao-supplier-row-status" },
                  h(Status, { value: supplier.lifecycle, t: props.t }),
                  facts.nativeAccess.length
                    ? h("span", { className: "hao-supplier-route-health" }, props.number(facts.nativeAccess.length) + " " + props.t("suppliers.nativeAccess"))
                    : facts.channels.length
                      ? h("span", { className: "hao-supplier-route-health" }, props.number(facts.healthyChannels) + "/" + props.number(facts.channels.length) + " " + props.t("suppliers.channels"))
                      : null,
                ),
                h(Button, { kind: "quiet", onClick: function () { openSupplierDetail(supplier); } }, props.t("suppliers.details")),
              );
            }),
          )
        : h(Empty, null, props.t("common.noData")),
      h(
        Modal,
        {
          open: Boolean(detailSupplier),
          onClose: closeSupplierDetail,
          labelledBy: "hao-supplier-detail-title",
          title: detailSupplier ? detailSupplier.name : props.t("suppliers.detailTitle"),
          subtitle: props.t("suppliers.detailSubtitle"),
          closeLabel: props.t("suppliers.close"),
          wide: true,
          footer: h(Button, { kind: "quiet", onClick: closeSupplierDetail }, props.t("suppliers.close")),
        },
        detailSupplier && detailFacts
          ? h(
              "div",
              { className: "hao-supplier-detail" },
              detailSupplier.websiteUrl
                ? h("div", { className: "hao-detail-website" },
                    h("span", null, props.t("suppliers.website")),
                    h("a", { className: "hao-external-link", href: detailSupplier.websiteUrl, target: "_blank", rel: "noreferrer" }, detailSupplier.websiteUrl),
                  )
                : null,
              !detailFacts.explicitlySelected
                ? h(Notice, { icon: "i" }, props.t("suppliers.legacySelection"))
                : null,
              h(
                "section",
                { className: "hao-detail-section" },
                h("h3", null, props.t("suppliers.employees")),
                detailFacts.employees.length
                  ? h(
                      "div",
                      { className: "hao-detail-employee-list" },
                      detailFacts.employees.map(function (employee) {
                        const id = String(employee.id);
                        const enabled = detailFacts.enabledIds.includes(id);
                        const preferred = detailFacts.defaultEmployeeId === id;
                        return h(
                          "div",
                          { className: "hao-detail-employee", key: id },
                          h(Avatar, { name: employee.displayName }),
                          h("div", { className: "hao-detail-employee-copy" }, h("strong", null, employee.displayName), h("small", null, asObject(employee.supplierModel).key || "")),
                          preferred
                            ? h("span", { className: "hao-badge hao-badge-good" }, props.t("suppliers.preferred"))
                            : h("span", { className: "hao-badge" }, props.t(enabled ? "suppliers.enabled" : "suppliers.disabled")),
                        );
                      }),
                    )
                  : h("span", { className: "hao-cell-empty" }, props.t("suppliers.noEmployees")),
              ),
              h(
                "section",
                { className: "hao-detail-section" },
                h("h3", null, props.t("suppliers.connections")),
                detailConnectionsLoading
                  ? h("span", { className: "hao-muted" }, props.t("suppliers.connectionsLoading"))
                  : detailConnectionsError
                    ? h(ErrorBanner, { title: props.t("shell.loadError"), error: detailConnectionsError })
                    : detailConnections.length
                      ? h(
                          "div",
                          { className: "hao-agreement-list" },
                          detailConnections.map(function (connection) {
                            const models = asArray(connection.models);
                            const links = asArray(connection.profileLinks);
                            const adminState = String(connection.adminState || "DISABLED").toUpperCase();
                            const effectiveState = String(connection.effectiveState || connection.health || "UNKNOWN").toUpperCase();
                            const retryStates = ["UNAVAILABLE", "TEMP_UNAVAILABLE"];
                            const actionEnabled = adminState === "DISABLED" || (adminState === "ENABLED" && retryStates.includes(effectiveState));
                            const actionLabel = adminState === "DISABLED"
                              ? props.t("suppliers.enable")
                              : (adminState === "ENABLED" && retryStates.includes(effectiveState) ? props.t("suppliers.retry") : props.t("suppliers.disable"));
                            const attempts = asArray(connection.recentAttempts).slice().sort(function (left, right) {
                              const leftObservedAt = asObject(left).observedAt;
                              const rightObservedAt = asObject(right).observedAt;
                              const leftNumeric = Number(leftObservedAt);
                              const rightNumeric = Number(rightObservedAt);
                              const leftTime = leftObservedAt != null && leftObservedAt !== "" && Number.isFinite(leftNumeric) ? leftNumeric : Date.parse(String(leftObservedAt || ""));
                              const rightTime = rightObservedAt != null && rightObservedAt !== "" && Number.isFinite(rightNumeric) ? rightNumeric : Date.parse(String(rightObservedAt || ""));
                              return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
                            }).slice(0, 5);
                            return h(
                              "div",
                              { className: "hao-agreement-row hao-supplier-connection", key: connection.id },
                              h(
                                "div",
                                { className: "hao-primary-cell" },
                                h("strong", null, connection.display_name || connection.provider_key),
                                h("small", null, connection.base_url || "—"),
                                h("small", null, [connection.auth_kind, connection.credential_ref].filter(Boolean).join(" · ") || "—"),
                                models.length
                                  ? h("div", { className: "hao-chip-row" }, models.slice(0, 6).map(function (model) { return h("code", { className: "hao-code", key: model }, model); }), models.length > 6 ? h("span", { className: "hao-count" }, "+" + props.number(models.length - 6)) : null)
                                  : null,
                                links.length
                                  ? h("small", null, links.map(function (link) { return [link.profile_id, link.runtime_kind, link.model_ref].filter(Boolean).join(" / "); }).join(" · "))
                                  : null,
                                h("small", null, props.t("suppliers.effectiveState") + ": " + effectiveState + " · " + props.t("suppliers.adminState") + ": " + adminState),
                                h("small", null, props.t("suppliers.routable") + ": " + (connection.routable ? "yes" : "no") + " · " + props.t("suppliers.retryable") + ": " + (connection.retryable ? "yes" : "no") + " · " + props.t("suppliers.consecutiveFailures") + ": " + String(connection.consecutiveFailures == null ? 0 : connection.consecutiveFailures)),
                                connection.lastErrorKind || connection.lastErrorStatus || connection.lastErrorMessage
                                  ? h("small", null, props.t("suppliers.lastError") + ": " + [connection.lastErrorKind, connection.lastErrorStatus, connection.lastErrorMessage].filter(Boolean).join(" · "))
                                  : null,
                                h("small", null, [props.t("suppliers.lastSuccess") + ": " + connectionTime(connection.lastSuccessAt), props.t("suppliers.lastFailure") + ": " + connectionTime(connection.lastFailureAt), props.t("suppliers.retryAfter") + ": " + connectionTime(connection.retryAfterAt)].join(" · ")),
                                h("small", null, props.t("suppliers.recentAttempts") + ": " + props.number(attempts.length)),
                                attempts.length
                                  ? h("div", { className: "hao-supplier-attempts" }, attempts.map(function (attempt, index) {
                                      const item = asObject(attempt);
                                      return h("small", { key: String(item.id || item.observedAt || index) }, [item.outcome, item.errorKind, item.httpStatus, item.observedAt == null ? null : connectionTime(item.observedAt), item.errorMessage].filter(function (value) { return value != null && String(value) !== ""; }).map(String).join(" · "));
                                    }))
                                  : null,
                              ),
                              h("div", { className: "hao-supplier-connection-actions" }, h(Status, { value: effectiveState, t: props.t }), h(Button, { kind: "quiet", disabled: connectionActionId === String(connection.id), onClick: function () { controlConnection(connection, actionEnabled); } }, connectionActionId === String(connection.id) ? props.t("suppliers.controlBusy") : actionLabel)),
                            );
                          }),
                        )
                      : h("span", { className: "hao-cell-empty" }, props.t("suppliers.noConnections")),
              ),
              h(
                "section",
                { className: "hao-detail-section" },
                h("h3", null, props.t("suppliers.runtimeAccess")),
                detailFacts.runtimeAccess.length
                  ? h(
                      "div",
                      { className: "hao-agreement-list" },
                      detailFacts.runtimeAccess.map(function (access) {
                        const provider = access.profileRef || access.providerRef || "—";
                        return h(
                          "div",
                          { className: "hao-agreement-row", key: access.id },
                          h(
                            "div",
                            null,
                            h("strong", null, (access.employeeName || "") + " · " + (access.runtimeKind || "")),
                            h("small", null, props.t("suppliers.accessProvider") + ": " + provider + " · " + props.t("suppliers.accessModel") + ": " + (access.modelRef || "—")),
                          ),
                          h("span", { className: access.adapterKind === "NATIVE_CONFIG" ? "hao-badge hao-badge-good" : "hao-badge" }, access.adapterKind === "NATIVE_CONFIG" ? props.t("suppliers.nativeAccess") : props.t("suppliers.gatewayAccess")),
                        );
                      }),
                    )
                  : h("span", { className: "hao-cell-empty" }, props.t("common.noData")),
              ),
              h(
                "section",
                { className: "hao-detail-section" },
                h("h3", null, props.t("suppliers.agreements")),
                detailFacts.agreements.length
                  ? h(
                      "div",
                      { className: "hao-agreement-list" },
                      detailFacts.agreements.map(function (agreement) {
                        return h("div", { className: "hao-agreement-row", key: agreement.id }, h("div", null, h("strong", null, agreement.name), h("small", null, agreement.planName || props.t("suppliers.noPlan"))), h(Status, { value: agreement.lifecycle, t: props.t }));
                      }),
                    )
                  : h("span", { className: "hao-cell-empty" }, props.t("common.noData")),
              ),
              h(
                "div",
                { className: "hao-detail-metrics" },
                h("div", null, h("span", null, props.t("suppliers.channels")), h("strong", null, props.number(detailFacts.healthyChannels) + "/" + props.number(detailFacts.channels.length))),
                h("div", null, h("span", null, props.t("suppliers.observed")), h("strong", null, props.number(detailFacts.observedRequests))),
              ),
            )
          : null,
      ),
      h(
        Modal,
        {
          open: addOpen,
          onClose: function () { setAddOpen(false); },
          labelledBy: "hao-supplier-add-title",
          title: props.t("suppliers.addTitle"),
          subtitle: props.t("suppliers.addSubtitle"),
          closeLabel: props.t("suppliers.close"),
          wide: true,
          footer: models.length
            ? h(
                "div",
                { className: "hao-onboarding-footer" },
                h("span", null, props.t("suppliers.selectedCount", { count: props.number(selectedModels.length) })),
                h(Button, { disabled: saving || !selectedModels.length, onClick: saveSupplier }, saving ? props.t("suppliers.savingSupplier") : props.t("suppliers.saveSupplier")),
              )
            : null,
        },
        h(
          "div",
          { className: "hao-onboarding" },
          h(
            "section",
            { className: "hao-onboarding-step" },
            h("h3", null, props.t("suppliers.chooseProvider")),
            h(
              "div",
              { className: "hao-preset-grid" },
              presets.map(function (preset) {
                return h(
                  "button",
                  {
                    className: "hao-preset-card",
                    key: preset.id,
                    type: "button",
                    "aria-pressed": presetId === preset.id,
                    onClick: function () { choosePreset(preset.id); },
                  },
                  h("span", { className: "hao-preset-mark", "aria-hidden": "true" }, preset.id === "custom" ? "+" : String(preset.name || "P")[0]),
                  h("span", { className: "hao-preset-copy" }, h("strong", null, preset.id === "custom" ? props.t("suppliers.custom") : preset.name), h("small", null, preset.id === "custom" ? props.t("suppliers.customHint") : preset.supplierName || preset.name)),
                  preset.configured ? h("span", { className: "hao-badge hao-badge-good" }, props.t("suppliers.configured")) : null,
                );
              }),
            ),
          ),
          h(
            "section",
            { className: "hao-onboarding-step" },
            h("h3", null, props.t("suppliers.credentials")),
            h(
              "div",
              { className: "hao-onboarding-form" },
              presetId === "custom"
                ? h(
                    React.Fragment,
                    null,
                    h("label", { className: "hao-field hao-field-wide" }, h("span", null, props.t("suppliers.baseUrl")), h("input", { type: "url", value: baseUrl, placeholder: "https://api.example.com/v1", onChange: function (event) { setBaseUrl(event.target.value); } })),
                    h("label", { className: "hao-field" }, h("span", null, props.t("suppliers.supplierName")), h("input", { type: "text", value: supplierName, placeholder: props.t("suppliers.supplierNameHint"), onChange: function (event) { setSupplierName(event.target.value); } })),
                    h("label", { className: "hao-field" }, h("span", null, props.t("suppliers.website")), h("input", { type: "url", value: websiteUrl, placeholder: "https://example.com", onChange: function (event) { setWebsiteUrl(event.target.value); } })),
                  )
                : null,
              h(
                "label",
                { className: "hao-field " + (presetId === "custom" ? "" : "hao-field-wide") },
                h("span", null, props.t("suppliers.apiKey")),
                h("input", { type: "password", value: apiKey, autoComplete: "off", placeholder: currentPreset && currentPreset.configured ? props.t("suppliers.apiKeyExisting") : props.t("suppliers.apiKeyRequired"), onChange: function (event) { setApiKey(event.target.value); } }),
                h("small", null, currentPreset && currentPreset.configured ? props.t("suppliers.apiKeyExisting") : props.t("suppliers.apiKeyRequired")),
              ),
              h("div", { className: "hao-discover-action" }, h(Button, { disabled: discovering || (presetId === "custom" && !baseUrl.trim()), onClick: discoverModels }, discovering ? props.t("suppliers.discovering") : props.t("suppliers.discover"))),
            ),
            h("p", { className: "hao-security-note" }, props.t("suppliers.security")),
          ),
          models.length
            ? h(
                "section",
                { className: "hao-onboarding-step" },
                h("div", { className: "hao-onboarding-step-head" }, h("div", null, h("h3", null, props.t("suppliers.selectModels")), h("p", null, props.t("suppliers.selectModelsHint"))), h("span", { className: "hao-count" }, props.t("suppliers.selectedCount", { count: props.number(selectedModels.length) }))),
                h("input", { className: "hao-model-search", type: "search", value: modelQuery, placeholder: props.t("suppliers.modelSearch"), onChange: function (event) { setModelQuery(event.target.value); } }),
                h(
                  "div",
                  { className: "hao-model-picker" },
                  visibleModels.map(function (model) {
                    const modelId = String(model.id);
                    const checked = selectedModels.includes(modelId);
                    return h(
                      "label",
                      { className: "hao-model-option", key: modelId },
                      h("input", { type: "checkbox", checked: checked, onChange: function () { toggleModel(modelId); } }),
                      h("span", { className: "hao-model-name" }, model.name || modelId),
                      h(
                        "span",
                        { className: "hao-default-choice" },
                        h("input", { type: "radio", name: "hao-default-employee", disabled: !checked, checked: defaultModel === modelId, onChange: function () { if (checked) setDefaultModel(modelId); } }),
                        h("span", null, props.t("suppliers.preferred")),
                      ),
                    );
                  }),
                ),
              )
            : null,
          formMessage ? h("div", { className: "hao-save-message", role: "status" }, formMessage) : null,
        ),
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
      else if (tab === "suppliers") content = h(Suppliers, Object.assign({}, shared, { onRefresh: load }));
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
