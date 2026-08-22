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
      "tabs.suppliers": "Models & Providers",
      "registry.title": "Models & Providers",
      "registry.subtitle": "LiteLLM is the single runtime authority for provider credentials, model deployments, routing, health, and spend.",
      "registry.openAdmin": "Open LiteLLM Admin",
      "registry.adminHint": "Create, edit, pause, test, and delete providers/models in LiteLLM Admin. AI Office is read-only here.",
      "registry.credentials": "Credentials",
      "registry.deployments": "Deployments",
      "registry.active": "Active",
      "registry.paused": "Paused",
      "registry.aliases": "Model aliases",
      "registry.group": "Model group",
      "registry.provider": "Provider",
      "registry.physicalModel": "Physical model",
      "registry.commercial": "Commercial",
      "registry.protocol": "Protocol",
      "registry.order": "Order",
      "registry.credential": "Credential",
      "registry.loading": "Loading LiteLLM registry…",
      "registry.loadError": "LiteLLM registry could not refresh",
      "registry.noDeployments": "No LiteLLM deployments found.",
      "tabs.operations": "Operations",
      "tabs.policy": "Runtime policy",
      "tabs.incidents": "Incidents",
      "tabs.development": "Development",
      "development.title": "Development control",
      "development.readiness": "Cutover readiness",
      "development.readinessSubtitle": "Qualification gates derived from V3 facts plus explicit verification evidence; probes never count as representative work.",
      "development.representative": "Representative workflows",
      "development.fixLoop": "Fix loop",
      "development.fallback": "Provider fallback",
      "development.reconnect": "Gateway reconnect",
      "development.rollback": "Rollback",
      "development.observabilityGate": "Observability",
      "development.gatePass": "Verified",
      "development.gatePending": "Pending",
      "development.subtitle": "Live V3 execution state, routing policy, provider health, and observed usage without a duplicate orchestration ledger.",
      "development.active": "Active work",
      "development.activeSubtitle": "Authoritative execution state reconciled from OpenHands",
      "development.history": "Recent history",
      "development.historySubtitle": "Recent terminal executions with usage and trace evidence when available",
      "development.routing": "V3 routing policy",
      "development.routingSubtitle": "Phase policy chooses logical model class, backend candidates, transport, and workspace isolation",
      "development.runtime": "Runtime & providers",
      "development.runtimeSubtitle": "Execution-plane source health and LiteLLM registry availability",
      "development.usage": "Usage & trace summary",
      "development.usageSubtitle": "Observed usage across active work and recent detailed history",
      "development.noActive": "No V3 execution is active right now.",
      "development.noHistory": "No terminal V3 execution has been recorded yet.",
      "development.project": "Project / objective",
      "development.phase": "Phase",
      "development.status": "Status",
      "development.route": "Route",
      "development.observedRoute": "Observed",
      "development.elapsed": "Elapsed",
      "development.tokens": "Usage",
      "development.references": "References",
      "development.backends": "Backends",
      "development.transports": "Transport",
      "development.workspace": "Workspace",
      "development.session": "Session",
      "development.logicalModels": "Logical models",
      "development.providers": "LiteLLM Registry",
      "development.health": "Source health",
      "development.concurrency": "Writer concurrency",
      "development.globalWriters": "Global writers",
      "development.projectWriters": "Per-project writers",
      "development.activeMetric": "Active executions",
      "development.waitingMetric": "Waiting / paused",
      "development.totalMetric": "Recent executions",
      "development.tokenMetric": "Observed tokens",
      "development.costMetric": "Observed cost",
      "development.traceMetric": "Trace coverage",
      "development.available": "{count} available",
      "development.congested": "{count} congested",
      "development.unavailable": "{count} unavailable",
      "development.connections": "{count} connections",
      "development.calls": "{count} model calls",
      "development.cache": "{count} cached input",
      "development.traceCount": "{count} linked traces",
      "development.refresh": "Refresh V3",
      "development.loading": "Loading V3 development state…",
      "development.loadError": "Development state could not refresh",
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
      "suppliers.manage": "Manage",
      "suppliers.manageTitle": "Manage supplier",
      "suppliers.manageSubtitle": "Edit supplier metadata or retire it from the active AI Office workforce.",
      "suppliers.saveProfile": "Save changes",
      "suppliers.deleteSupplier": "Delete supplier",
      "suppliers.deleteSupplierConfirm": "Delete this supplier from the active AI Office workforce? Historical execution records will be preserved.",
      "suppliers.editConnection": "Edit connection",
      "suppliers.saveConnection": "Save connection",
      "suppliers.deleteConnection": "Delete connection",
      "suppliers.deleteConnectionConfirm": "Delete this provider connection from active routing? Historical records will be preserved.",
      "suppliers.connectionName": "Connection name",
      "suppliers.protocol": "Protocol",
      "suppliers.savedProfile": "Supplier updated.",
      "suppliers.savedConnection": "Connection updated.",
      "suppliers.deleted": "Removed from active AI Office.",
      "suppliers.website": "Website",
      "suppliers.close": "Close",
      "suppliers.employees": "Employees",
      "suppliers.enabledEmployees": "Enabled employees",
      "suppliers.enabledOfTotal": "Enabled / total",
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
      "suppliers.economics": "2. Supply economics",
      "suppliers.economicsHint": "Choose a quick profile or edit the three independent routing tags.",
      "suppliers.credentials": "3. Connection",
      "suppliers.supplyOrigin": "Supply origin",
      "suppliers.commercialType": "Billing model",
      "suppliers.routingPolicy": "Routing policy",
      "suppliers.quick.community-free": "Community relay · free",
      "suppliers.quick.event-free": "Event grant · free",
      "suppliers.quick.personal-hosted": "Personal hosted · manual",
      "suppliers.quick.commercial-metered": "Commercial relay · metered",
      "suppliers.quick.official-metered": "Official API · metered",
      "suppliers.quick.official-subscription": "Official coding plan · subscription",
      "suppliers.origin.OFFICIAL": "Official",
      "suppliers.origin.COMMERCIAL_RELAY": "Commercial relay",
      "suppliers.origin.COMMUNITY_RELAY": "Community relay",
      "suppliers.origin.EVENT_GRANT": "Event grant",
      "suppliers.origin.PERSONAL_HOSTED": "Personal hosted",
      "suppliers.origin.INTERNAL_POOL": "Internal pool",
      "suppliers.origin.UNKNOWN": "Unknown origin",
      "suppliers.commercial.FREE": "Free",
      "suppliers.commercial.SPONSORED": "Sponsored / free",
      "suppliers.commercial.SUBSCRIPTION": "Subscription",
      "suppliers.commercial.PREPAID": "Prepaid",
      "suppliers.commercial.METERED": "Pay as you go",
      "suppliers.commercial.OTHER": "Other",
      "suppliers.routing.AUTO": "Auto routing",
      "suppliers.routing.MANUAL_ONLY": "Manual only",
      "suppliers.routing.BRAIN_ONLY": "Brain only",
      "suppliers.routing.DISABLED": "Disabled",
      "suppliers.credentials": "3. Connection",
      "suppliers.apiKey": "API Key",
      "suppliers.apiKeyExisting": "Already configured in Hermes. Leave blank to reuse it.",
      "suppliers.apiKeyRequired": "Paste the provider API key.",
      "suppliers.baseUrl": "API request URL",
      "suppliers.supplierName": "Supplier name (optional)",
      "suppliers.supplierNameHint": "Leave blank and Hermes will generate a name from the URL.",
      "suppliers.discover": "Fetch models",
      "suppliers.discovering": "Fetching models…",
      "suppliers.selectModels": "4. Choose employees",
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
      "policy.executionMode": "Execution mode",
      "policy.executionV3": "V3 — phase delegation through OpenHands",
      "policy.executionV2": "V2 — legacy direct-harness placement",
      "policy.executionDisabled": "Disabled — no AI Office execution routing",
      "policy.mode": "Legacy terminal hook mode",
      "policy.openCodePosition": "OpenCode position slug",
      "policy.codexPosition": "Codex position slug",
      "policy.observe": "Observe — record only",
      "policy.prefer": "Prefer — inject selected employee, fail open",
      "policy.enforce": "Enforce — require an eligible employee",
      "policy.executionHelp": "V3 and V2 are mutually exclusive routing authorities. Changing mode affects new development work; existing V3 executions remain queryable/cancellable for safe recovery.",
      "policy.executionHelp": "V3 与 V2 是互斥的路由权威。切换只影响新的开发任务；已有 V3 execution 仍可查询、取消和恢复，便于安全回滚。",
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
      "status.STARTING": "Starting",
      "status.PAUSED": "Paused",
      "status.WAITING_FOR_CONFIRMATION": "Waiting",
      "status.SUCCEEDED": "Succeeded",
      "status.FAILED": "Failed",
      "status.STUCK": "Stuck",
      "status.CANCELLED": "Cancelled",
      "status.OK": "OK",
      "status.UNCONFIGURED": "Not configured",
      "status.NOT_READY": "Not ready",
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
      "tabs.suppliers": "模型与供应商",
      "registry.title": "模型与供应商",
      "registry.subtitle": "LiteLLM 是 Provider Credential、模型 Deployment、路由、健康度与用量的唯一运行时权威。",
      "registry.openAdmin": "打开 LiteLLM Admin",
      "registry.adminHint": "新增、编辑、暂停、测试和删除 Provider/模型都在 LiteLLM Admin 中完成；AI Office 此处只读展示。",
      "registry.credentials": "Credential",
      "registry.deployments": "Deployment",
      "registry.active": "启用",
      "registry.paused": "暂停",
      "registry.aliases": "模型 Alias",
      "registry.group": "模型组",
      "registry.provider": "Provider",
      "registry.physicalModel": "物理模型",
      "registry.commercial": "商业类型",
      "registry.protocol": "协议",
      "registry.order": "优先级",
      "registry.credential": "Credential",
      "registry.loading": "正在加载 LiteLLM Registry…",
      "registry.loadError": "LiteLLM Registry 刷新失败",
      "registry.noDeployments": "暂无 LiteLLM Deployment。",
      "tabs.operations": "运营",
      "tabs.policy": "运行时策略",
      "tabs.incidents": "事件",
    "tabs.development": "開發控制",
    "development.title": "開發控制",
    "development.subtitle": "統一查看 V3 執行狀態、路由策略、Provider 健康度與真實用量，不維護第二套編排狀態。",
    "development.active": "正在執行",
    "development.history": "最近歷史",
    "development.routing": "V3 路由策略",
    "development.runtime": "執行環境與 Provider",
    "development.usage": "用量與 Trace",
      "tabs.development": "开发控制",
      "development.title": "开发控制",
      "development.readiness": "切换就绪度",
      "development.readinessSubtitle": "由 V3 事实与显式验证证据派生的资格门槛；探针数量不会冒充代表性真实任务。",
      "development.representative": "代表性工作流",
      "development.fixLoop": "修复闭环",
      "development.fallback": "Provider Fallback",
      "development.reconnect": "Gateway 重连",
      "development.rollback": "回滚",
      "development.observabilityGate": "可观测性",
      "development.gatePass": "已验证",
      "development.gatePending": "待完成",
      "development.subtitle": "统一查看 V3 执行状态、路由策略、Provider 健康度和真实用量，不再维护第二套编排状态。",
      "development.active": "正在执行",
      "development.activeSubtitle": "从 OpenHands 权威状态实时对账后的执行列表",
      "development.history": "最近历史",
      "development.historySubtitle": "最近已结束的执行；有数据时展示用量与 Trace 证据",
      "development.routing": "V3 路由策略",
      "development.routingSubtitle": "按阶段选择逻辑模型类、Backend 候选、传输方式与工作区隔离策略",
      "development.runtime": "运行时与 Provider",
      "development.runtimeSubtitle": "执行平面健康状态与 LiteLLM Registry 可用性",
      "development.usage": "用量与 Trace",
      "development.usageSubtitle": "正在执行与最近详细历史中的可观测用量汇总",
      "development.noActive": "当前没有正在运行的 V3 执行。",
      "development.noHistory": "还没有已结束的 V3 执行记录。",
      "development.project": "项目 / 目标",
      "development.phase": "阶段",
      "development.status": "状态",
      "development.route": "路由",
      "development.observedRoute": "已观测",
      "development.elapsed": "耗时",
      "development.tokens": "用量",
      "development.references": "引用",
      "development.backends": "Backend",
      "development.transports": "传输",
      "development.workspace": "工作区",
      "development.session": "会话",
      "development.logicalModels": "逻辑模型",
      "development.providers": "LiteLLM Registry",
      "development.health": "源健康度",
      "development.concurrency": "写入并发",
      "development.globalWriters": "全局 writer",
      "development.projectWriters": "单项目 writer",
      "development.activeMetric": "活跃执行",
      "development.waitingMetric": "等待 / 暂停",
      "development.totalMetric": "最近执行",
      "development.tokenMetric": "已观测 Token",
      "development.costMetric": "已观测成本",
      "development.traceMetric": "Trace 覆盖率",
      "development.available": "{count} 可用",
      "development.congested": "{count} 拥挤",
      "development.unavailable": "{count} 不可用",
      "development.connections": "{count} 条连接",
      "development.calls": "{count} 次模型调用",
      "development.cache": "{count} 缓存输入",
      "development.traceCount": "{count} 条 Trace",
      "development.refresh": "刷新 V3",
      "development.loading": "正在加载 V3 开发状态…",
      "development.loadError": "开发状态刷新失败",
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
      "suppliers.manage": "管理",
      "suppliers.manageTitle": "管理供应商",
      "suppliers.manageSubtitle": "编辑供应商与连接信息，或将其从当前 AI Office 员工体系中退休。",
      "suppliers.saveProfile": "保存修改",
      "suppliers.deleteSupplier": "删除供应商",
      "suppliers.deleteSupplierConfirm": "确定从当前 AI Office 中删除这个供应商吗？历史执行记录会保留。",
      "suppliers.editConnection": "编辑连接",
      "suppliers.saveConnection": "保存连接",
      "suppliers.deleteConnection": "删除连接",
      "suppliers.deleteConnectionConfirm": "确定删除这个 Provider 连接并停止当前路由吗？历史记录会保留。",
      "suppliers.connectionName": "连接名称",
      "suppliers.protocol": "协议",
      "suppliers.savedProfile": "供应商已更新。",
      "suppliers.savedConnection": "连接已更新。",
      "suppliers.deleted": "已从当前 AI Office 中移除。",
      "suppliers.website": "官网",
      "suppliers.close": "关闭",
      "suppliers.employees": "员工",
      "suppliers.enabledEmployees": "启用员工",
      "suppliers.enabledOfTotal": "已启用 / 总数",
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
      "suppliers.economics": "2. 供给与费用策略",
      "suppliers.economicsHint": "可一键选择常用标签组合，也可以分别调整三个独立属性。",
      "suppliers.credentials": "3. 连接信息",
      "suppliers.supplyOrigin": "供给来源",
      "suppliers.commercialType": "计费方式",
      "suppliers.routingPolicy": "路由策略",
      "suppliers.quick.community-free": "公益中转 · 免费",
      "suppliers.quick.event-free": "赛事活动 · 免费",
      "suppliers.quick.personal-hosted": "个人搭建 · 手动",
      "suppliers.quick.commercial-metered": "商业中转 · 按量",
      "suppliers.quick.official-metered": "官方 API · 按量",
      "suppliers.quick.official-subscription": "官方 Coding Plan · 包月",
      "suppliers.origin.OFFICIAL": "官方",
      "suppliers.origin.COMMERCIAL_RELAY": "商业中转",
      "suppliers.origin.COMMUNITY_RELAY": "公益中转",
      "suppliers.origin.EVENT_GRANT": "赛事/活动赠送",
      "suppliers.origin.PERSONAL_HOSTED": "个人搭建",
      "suppliers.origin.INTERNAL_POOL": "内部账号池",
      "suppliers.origin.UNKNOWN": "来源待确认",
      "suppliers.commercial.FREE": "免费",
      "suppliers.commercial.SPONSORED": "赠送/免费",
      "suppliers.commercial.SUBSCRIPTION": "包月/订阅",
      "suppliers.commercial.PREPAID": "预付额度",
      "suppliers.commercial.METERED": "按量付费",
      "suppliers.commercial.OTHER": "其他",
      "suppliers.routing.AUTO": "自动调度",
      "suppliers.routing.MANUAL_ONLY": "仅手动",
      "suppliers.routing.BRAIN_ONLY": "仅大脑",
      "suppliers.routing.DISABLED": "禁用",
      "suppliers.credentials": "3. 连接信息",
      "suppliers.apiKey": "API Key",
      "suppliers.apiKeyExisting": "Hermes 已经配置过凭证；留空即可复用。",
      "suppliers.apiKeyRequired": "粘贴该供应商的 API Key。",
      "suppliers.baseUrl": "API 请求地址",
      "suppliers.supplierName": "供应商名称（选填）",
      "suppliers.supplierNameHint": "不填写时，Hermes 会根据请求地址自动生成。",
      "suppliers.discover": "获取模型",
      "suppliers.discovering": "正在获取模型…",
      "suppliers.selectModels": "4. 挑选员工",
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
      "policy.executionMode": "执行模式",
      "policy.executionV3": "V3 — 通过 OpenHands 按阶段委派",
      "policy.executionV2": "V2 — 旧版直接 Harness 调度",
      "policy.executionDisabled": "禁用 — AI Office 不参与开发执行",
      "policy.mode": "旧版 Terminal Hook 模式",
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
      "status.STARTING": "启动中",
      "status.PAUSED": "已暂停",
      "status.WAITING_FOR_CONFIRMATION": "等待确认",
      "status.SUCCEEDED": "已成功",
      "status.FAILED": "失败",
      "status.STUCK": "卡住",
      "status.CANCELLED": "已取消",
      "status.OK": "正常",
      "status.UNCONFIGURED": "未配置",
      "status.NOT_READY": "尚未就绪",
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
    "tabs.suppliers": "模型與供應商",
      "registry.title": "模型與供應商",
      "registry.subtitle": "LiteLLM 是 Provider Credential、模型 Deployment、路由、健康度與用量的唯一運行時權威。",
      "registry.openAdmin": "開啟 LiteLLM Admin",
      "registry.adminHint": "新增、編輯、暫停、測試和刪除 Provider/模型都在 LiteLLM Admin 中完成；AI Office 此處只讀展示。",
      "registry.credentials": "Credential",
      "registry.deployments": "Deployment",
      "registry.active": "啟用",
      "registry.paused": "暫停",
      "registry.aliases": "模型 Alias",
      "registry.group": "模型組",
      "registry.provider": "Provider",
      "registry.physicalModel": "物理模型",
      "registry.commercial": "商業類型",
      "registry.protocol": "協議",
      "registry.order": "優先級",
      "registry.credential": "Credential",
      "registry.loading": "正在載入 LiteLLM Registry…",
      "registry.loadError": "LiteLLM Registry 更新失敗",
      "registry.noDeployments": "暫無 LiteLLM Deployment。",
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

  function durationLabel(milliseconds, locale) {
    const ms = Math.max(0, Number(milliseconds || 0));
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return seconds + "s";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "m " + (seconds % 60) + "s";
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "h " + (minutes % 60) + "m";
    const days = Math.floor(hours / 24);
    return days + (locale === "zh" || locale === "zh-hant" ? "天 " : "d ") + (hours % 24) + "h";
  }

  function executionDuration(item, locale) {
    const timing = asObject(item && item.timing);
    if (Number(timing.durationMs || 0) > 0) return durationLabel(timing.durationMs, locale);
    const started = Date.parse(String(timing.startedAt || item.createdAt || ""));
    if (!Number.isFinite(started)) return "—";
    return durationLabel(Date.now() - started, locale);
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
        "SUCCEEDED",
        "OK",
        "CODING",
        "REVIEWING",
        "APPOINTED",
        "DEFAULTED",
      ].includes(normalized)
    ) {
      return "good";
    }
    if (["DEGRADED", "WARNING", "SCHEDULED", "PREFER", "UNRESOLVED", "DEFAULT_MODEL", "STARTING", "PAUSED", "WAITING_FOR_CONFIRMATION", "UNCONFIGURED"].includes(normalized)) {
      return "warn";
    }
    if (
      ["ERROR", "CRITICAL", "BLOCKED", "UNHEALTHY", "UNAVAILABLE", "DORMANT", "UNFILLED", "FAILED", "STUCK"].includes(
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
        className:
          "hao-button " +
          (props.kind === "quiet"
            ? "hao-button-quiet"
            : props.kind === "outline"
              ? "hao-button-outline"
              : props.kind === "danger"
                ? "hao-button-danger"
                : ""),
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
    const [registry, setRegistry] = React.useState(null);
    const [error, setError] = React.useState("");
    const [loading, setLoading] = React.useState(true);
    const [query, setQuery] = React.useState("");

    const load = React.useCallback(async function () {
      setLoading(true);
      try {
        const value = await api("/model-registry");
        setRegistry(value);
        setError("");
      } catch (cause) {
        setError(String(cause));
      } finally {
        setLoading(false);
      }
    }, []);

    React.useEffect(function () {
      load();
    }, [load]);

    const value = asObject(registry);
    const credentials = asObject(value.credentials);
    const deploymentSummary = asObject(value.deployments);
    const aliases = asObject(value.aliases);
    const deployments = asArray(deploymentSummary.items);
    const normalizedQuery = String(query || "").trim().toLowerCase();
    const filtered = normalizedQuery
      ? deployments.filter(function (item) {
          return [item.group, item.providerKey, item.model, item.commercialType, item.protocol, item.credential]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(normalizedQuery);
        })
      : deployments;
    const adminUrl = String(value.adminUrl || "");
    const columns = [
      {
        key: "group",
        label: props.t("registry.group"),
        render: function (item) {
          return h("div", { className: "hao-primary-cell" }, h("strong", null, item.group || "—"), h("small", { className: "hao-mono" }, item.id || ""));
        },
      },
      { key: "providerKey", label: props.t("registry.provider"), render: function (item) { return item.providerKey || "—"; } },
      { key: "model", label: props.t("registry.physicalModel"), render: function (item) { return h("span", { className: "hao-mono" }, item.model || "—"); } },
      { key: "commercialType", label: props.t("registry.commercial"), render: function (item) { return item.commercialType || "—"; } },
      { key: "protocol", label: props.t("registry.protocol"), render: function (item) { return item.protocol || "—"; } },
      { key: "order", label: props.t("registry.order"), className: "hao-number-cell", render: function (item) { return item.order == null ? "—" : String(item.order); } },
      { key: "credential", label: props.t("registry.credential"), render: function (item) { return h("span", { className: "hao-mono" }, item.credential || "—"); } },
      { key: "blocked", label: props.t("development.status"), render: function (item) { return h(Status, { value: item.blocked ? "PAUSED" : "AVAILABLE", t: props.t }); } },
    ];

    return h(
      "div",
      { className: "hao-section-stack" },
      h(
        "div",
        { className: "hao-section-head" },
        h("div", null, h("h1", null, props.t("registry.title")), h("p", null, props.t("registry.subtitle"))),
        h(
          "div",
          { className: "hao-actions" },
          adminUrl
            ? h(Button, { kind: "outline", onClick: function () { window.open(adminUrl, "_blank", "noopener,noreferrer"); } }, props.t("registry.openAdmin"))
            : null,
          h(Button, { kind: "outline", onClick: load, disabled: loading }, loading ? props.t("shell.refreshing") : props.t("development.refresh")),
        ),
      ),
      error ? h(ErrorBanner, { title: props.t("registry.loadError"), error: error }) : null,
      !registry && loading ? h("div", { className: "hao-loading" }, props.t("registry.loading")) : null,
      registry
        ? h(
            React.Fragment,
            null,
            h(Notice, { tone: value.health === "OK" ? "info" : "warn", title: "LiteLLM" }, props.t("registry.adminHint")),
            h(
              "div",
              { className: "hao-metrics" },
              h(Metric, { label: props.t("registry.credentials"), value: props.number(credentials.count || 0), hint: "LiteLLM Credentials" }),
              h(Metric, { label: props.t("registry.deployments"), value: props.number(deploymentSummary.count || 0), hint: props.number(Object.keys(asObject(deploymentSummary.groups)).length) + " model groups" }),
              h(Metric, { label: props.t("registry.active"), value: props.number(deploymentSummary.active || 0), hint: "routable" }),
              h(Metric, { label: props.t("registry.paused"), value: props.number(deploymentSummary.paused || 0), hint: "blocked / unavailable" }),
              h(Metric, { label: props.t("registry.aliases"), value: props.number(Object.keys(aliases).length), hint: Object.entries(aliases).map(function (entry) { return entry[0] + " → " + entry[1]; }).join(" · ") || "—" }),
              h(Metric, { label: props.t("development.health"), value: h(Status, { value: value.health || "UNKNOWN", t: props.t }), hint: "runtime authority" }),
            ),
            h(
              "label",
              { className: "hao-search" },
              h("span", { className: "hao-search-icon", "aria-hidden": "true" }, "⌕"),
              h("span", { className: "hao-visually-hidden" }, props.t("common.search")),
              h("input", { type: "search", value: query, placeholder: props.t("common.search"), onChange: function (event) { setQuery(event.target.value); } }),
            ),
            h(DataTable, { columns: columns, rows: filtered, keyField: "id", empty: props.t("registry.noDeployments") }),
          )
        : null,
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
    const [executionMode, setExecutionMode] = React.useState(String(initial.executionMode || "v2"));
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
        setExecutionMode(String(initial.executionMode || "v2"));
        setMode(String(initial.mode || "prefer"));
        setOpenCodePosition(String(initial.opencodePosition || "coding-executor"));
        setCodexPosition(String(initial.codexPosition || "codex-executor"));
      },
      [initial.executionMode, initial.mode, initial.opencodePosition, initial.codexPosition],
    );

    async function save() {
      setSaving(true);
      setMessage("");
      try {
        await api("/settings/runtime-policy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            execution_mode: executionMode,
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
          h("label", null, h("span", null, props.t("policy.executionMode")), h("select", { value: executionMode, onChange: function (event) { setExecutionMode(event.target.value); } }, h("option", { value: "v3" }, props.t("policy.executionV3")), h("option", { value: "v2" }, props.t("policy.executionV2")), h("option", { value: "disabled" }, props.t("policy.executionDisabled")))),
          h("label", null, h("span", null, props.t("policy.mode")), h("select", { value: mode, onChange: function (event) { setMode(event.target.value); }, disabled: executionMode !== "v2" }, h("option", { value: "observe" }, props.t("policy.observe")), h("option", { value: "prefer" }, props.t("policy.prefer")), h("option", { value: "enforce" }, props.t("policy.enforce")))),
          h("label", null, h("span", null, props.t("policy.openCodePosition")), h("input", { value: opencodePosition, onChange: function (event) { setOpenCodePosition(event.target.value); } })),
          h("label", null, h("span", null, props.t("policy.codexPosition")), h("input", { value: codexPosition, onChange: function (event) { setCodexPosition(event.target.value); } })),
        ),
        h("p", { className: "hao-form-help" }, props.t("policy.executionHelp")),
        executionMode === "v2" ? h("p", { className: "hao-form-help" }, props.t("policy.help")) : null,
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

  function Development(props) {
    const [development, setDevelopment] = React.useState(null);
    const [error, setError] = React.useState("");
    const [loading, setLoading] = React.useState(true);

    const load = React.useCallback(async function () {
      try {
        const value = await api("/development");
        setDevelopment(value);
        setError("");
      } catch (cause) {
        setError(String(cause));
      } finally {
        setLoading(false);
      }
    }, []);

    React.useEffect(function () {
      load();
      const timer = window.setInterval(load, 10000);
      return function () {
        window.clearInterval(timer);
      };
    }, [load]);

    if (!development) {
      return h(
        "div",
        { className: "hao-section-stack" },
        h(
          "div",
          { className: "hao-section-head" },
          h("div", null, h("h1", null, props.t("development.title")), h("p", null, props.t("development.subtitle"))),
        ),
        error ? h(ErrorBanner, { title: props.t("development.loadError"), error: error }) : null,
        h("div", { className: "hao-loading" }, props.t("development.loading")),
      );
    }

    const summary = asObject(development.summary);
    const usage = asObject(summary.usage);
    const runtime = asObject(development.runtime);
    const health = asObject(runtime.sourceHealth);
    const providerSummary = asObject(asObject(development.providers).deployments);
    const readiness = asObject(development.readiness);
    const readinessGates = asObject(readiness.gates);
    const policy = asObject(development.policy);
    const concurrency = asObject(policy.concurrency || runtime.concurrency);
    const active = asArray(development.active);
    const history = asArray(development.history);
    const logicalModels = asArray(runtime.logicalModels);
    const enabledBackends = asArray(runtime.enabledBackends);
    const phases = Object.entries(asObject(policy.phases));

    function executionColumns() {
      return [
        {
          key: "project",
          label: props.t("development.project"),
          render: function (item) {
            return h(
              "div",
              { className: "hao-primary-cell" },
              h("strong", null, item.projectKey || "—"),
              h("small", { title: item.objectiveSummary || "" }, item.objectiveSummary || item.executionId || "—"),
            );
          },
        },
        {
          key: "phase",
          label: props.t("development.phase"),
          render: function (item) {
            return h("span", { className: "hao-mono" }, item.phase || "—");
          },
        },
        {
          key: "status",
          label: props.t("development.status"),
          render: function (item) {
            return h(Status, { value: item.status, t: props.t });
          },
        },
        {
          key: "route",
          label: props.t("development.route"),
          render: function (item) {
            const selection = asObject(item.selection);
            const refs = asObject(item.refs);
            const upstream = asObject(refs.upstream);
            const observedRoute = asObject(upstream.route);
            const physical = [observedRoute.model, observedRoute.provider].filter(Boolean).join(" · ");
            return h(
              "div",
              { className: "hao-primary-cell hao-dev-route" },
              h("strong", null, selection.modelClass || "—"),
              h("small", null, [selection.backend, selection.transportMode].filter(Boolean).join(" · ") || "—"),
              physical
                ? h(
                    "small",
                    { className: "hao-dev-observed-route", title: observedRoute.deploymentId || physical },
                    props.t("development.observedRoute") + ": " + physical,
                  )
                : null,
            );
          },
        },
        {
          key: "elapsed",
          label: props.t("development.elapsed"),
          render: function (item) {
            return h("span", { className: "hao-mono" }, executionDuration(item, props.locale));
          },
        },
        {
          key: "usage",
          label: props.t("development.tokens"),
          render: function (item) {
            const itemUsage = asObject(item.usage);
            if (!item.usage) return h("span", { className: "hao-cell-empty" }, "—");
            return h(
              "div",
              { className: "hao-primary-cell" },
              h("strong", null, props.compact(Number(itemUsage.input || 0) + Number(itemUsage.output || 0))),
              h("small", null, props.money(itemUsage.costUsd || 0) + " · " + props.t("development.calls", { count: props.number(itemUsage.calls || 0) })),
            );
          },
        },
        {
          key: "refs",
          label: props.t("development.references"),
          render: function (item) {
            const refs = asObject(item.refs);
            const values = [];
            if (refs.openhandsConversationId) values.push("OH " + String(refs.openhandsConversationId).slice(0, 8));
            if (refs.langfuseTraceId) values.push("LF " + String(refs.langfuseTraceId).slice(0, 8));
            return h("span", { className: "hao-mono", title: values.join(" · ") }, values.join(" · ") || "—");
          },
        },
      ];
    }

    return h(
      "div",
      { className: "hao-section-stack" },
      h(
        "div",
        { className: "hao-section-head" },
        h(
          "div",
          null,
          h("h1", null, props.t("development.title")),
          h("p", null, props.t("development.subtitle")),
        ),
        h(Button, { kind: "outline", onClick: load, disabled: loading }, loading ? props.t("shell.refreshing") : props.t("development.refresh")),
      ),
      error ? h(ErrorBanner, { title: props.t("development.loadError"), error: error }) : null,
      h(
        "div",
        { className: "hao-metrics hao-dev-metrics" },
        h(Metric, { label: props.t("development.activeMetric"), value: props.number(summary.active || 0), hint: String(asObject(summary.statuses).RUNNING || 0) + " running" }),
        h(Metric, { label: props.t("development.waitingMetric"), value: props.number(summary.waiting || 0), hint: "PAUSED / WAITING" }),
        h(Metric, { label: props.t("development.totalMetric"), value: props.number(summary.total || 0), hint: props.number(summary.history || 0) + " terminal" }),
        h(Metric, { label: props.t("development.tokenMetric"), value: props.compact(Number(usage.input || 0) + Number(usage.output || 0)), hint: props.t("development.cache", { count: props.compact(usage.cachedInput || 0) }) }),
        h(Metric, { label: props.t("development.costMetric"), value: props.money(usage.costUsd || 0), hint: props.t("development.calls", { count: props.number(usage.calls || 0) }) }),
        h(Metric, { label: props.t("development.traceMetric"), value: Math.round(Number(summary.traceCoverage || 0) * 100) + "%", hint: props.t("development.traceCount", { count: props.number(usage.traces || 0) }) }),
      ),
      h(
        Panel,
        { title: props.t("development.readiness"), subtitle: props.t("development.readinessSubtitle"), className: "hao-dev-readiness" },
        asObject(development.readiness).unavailable
          ? h(Notice, { tone: "warn" }, String(asObject(development.readiness).error || "Unavailable"))
          : h(
              "div",
              { className: "hao-dev-readiness-grid" },
              h(Metric, {
                label: props.t("development.representative"),
                value: props.number(asObject(readinessGates.representativeWorkflows).current || 0) + "/" + props.number(asObject(readinessGates.representativeWorkflows).required || 10),
                hint: asObject(readinessGates.representativeWorkflows).pass ? props.t("development.gatePass") : props.t("development.gatePending"),
              }),
              h(Metric, { label: props.t("development.fixLoop"), value: h(Status, { value: asObject(readinessGates.fixLoop).pass ? "READY" : "NOT_READY", t: props.t }), hint: asObject(readinessGates.fixLoop).pass ? props.t("development.gatePass") : props.t("development.gatePending") }),
              h(Metric, { label: props.t("development.fallback"), value: h(Status, { value: asObject(readinessGates.providerFallback).pass ? "READY" : "NOT_READY", t: props.t }), hint: asObject(readinessGates.providerFallback).pass ? props.t("development.gatePass") : props.t("development.gatePending") }),
              h(Metric, { label: props.t("development.reconnect"), value: h(Status, { value: asObject(readinessGates.gatewayReconnect).pass ? "READY" : "NOT_READY", t: props.t }), hint: asObject(readinessGates.gatewayReconnect).pass ? props.t("development.gatePass") : props.t("development.gatePending") }),
              h(Metric, { label: props.t("development.rollback"), value: h(Status, { value: asObject(readinessGates.rollback).pass ? "READY" : "NOT_READY", t: props.t }), hint: asObject(readinessGates.rollback).pass ? props.t("development.gatePass") : props.t("development.gatePending") }),
              h(Metric, {
                label: props.t("development.observabilityGate"),
                value: props.number(asObject(readinessGates.observability).verified || 0) + "/" + props.number(asObject(readinessGates.observability).required || 0),
                hint: asObject(readinessGates.observability).pass ? props.t("development.gatePass") : props.t("development.gatePending"),
              }),
            ),
      ),
      h(
        Panel,
        { title: props.t("development.active"), subtitle: props.t("development.activeSubtitle") },
        h(DataTable, { columns: executionColumns(), rows: active, keyField: "executionId", empty: props.t("development.noActive") }),
      ),
      h(
        Panel,
        { title: props.t("development.history"), subtitle: props.t("development.historySubtitle") },
        h(DataTable, { columns: executionColumns(), rows: history.slice(0, 32), keyField: "executionId", empty: props.t("development.noHistory") }),
      ),
      h(
        "div",
        { className: "hao-dev-two-column" },
        h(
          Panel,
          { title: props.t("development.routing"), subtitle: props.t("development.routingSubtitle"), className: "hao-dev-policy-panel" },
          h(
            "div",
            { className: "hao-dev-policy-grid" },
            phases.map(function (entry) {
              const phase = entry[0];
              const config = asObject(entry[1]);
              return h(
                "article",
                { className: "hao-dev-policy-card", key: phase },
                h("div", { className: "hao-dev-policy-phase" }, phase),
                h("strong", null, config.model_class || "—"),
                h("dl", null,
                  h("div", null, h("dt", null, props.t("development.backends")), h("dd", null, asArray(config.backend_candidates).join(" → ") || "—")),
                  h("div", null, h("dt", null, props.t("development.transports")), h("dd", null, asArray(config.transport_preference).join(" → ") || "—")),
                  h("div", null, h("dt", null, props.t("development.workspace")), h("dd", null, config.workspace_mode || "—")),
                  h("div", null, h("dt", null, props.t("development.session")), h("dd", null, config.session_policy || "—")),
                ),
              );
            }),
          ),
        ),
        h(
          "div",
          { className: "hao-section-stack hao-dev-side-stack" },
          h(
            Panel,
            { title: props.t("development.runtime"), subtitle: props.t("development.runtimeSubtitle") },
            asObject(development.runtime).unavailable
              ? h(Notice, { tone: "warn", title: props.t("development.health") }, String(asObject(development.runtime).error || "Unavailable"))
              : h(
                  "div",
                  { className: "hao-dev-runtime" },
                  h(
                    "div",
                    { className: "hao-dev-health-row" },
                    ["openhands", "litellm", "observability", "langfuse"].map(function (source) {
                      return h("div", { className: "hao-dev-health-item", key: source }, h("span", null, source), h(Status, { value: health[source] || "UNKNOWN", t: props.t }));
                    }),
                  ),
                  h("div", { className: "hao-dev-subhead" }, props.t("development.logicalModels")),
                  h("div", { className: "hao-dev-chip-row" }, logicalModels.length ? logicalModels.map(function (model) { return h("span", { className: "hao-dev-chip hao-mono", key: model }, model); }) : h("span", { className: "hao-cell-empty" }, "—")),
                  h("div", { className: "hao-dev-subhead" }, props.t("development.backends")),
                  h("div", { className: "hao-dev-chip-row" }, enabledBackends.map(function (backend) { return h("span", { className: "hao-dev-chip hao-mono", key: backend }, backend); })),
                ),
          ),
          h(
            Panel,
            { title: props.t("development.providers"), subtitle: props.t("development.runtimeSubtitle") },
            asObject(development.providers).unavailable
              ? h(Notice, { tone: "warn" }, String(asObject(development.providers).error || "Unavailable"))
              : h(
                  "div",
                  { className: "hao-mini-metrics" },
                  h(Metric, { label: props.t("development.connections", { count: props.number(providerSummary.count || 0) }), value: props.number(providerSummary.count || 0), hint: "LiteLLM DB" }),
                  h(Metric, { label: props.t("development.available", { count: props.number(providerSummary.active || 0) }), value: props.number(providerSummary.active || 0), hint: "active deployments" }),
                  h(Metric, { label: props.t("registry.paused"), value: props.number(providerSummary.paused || 0), hint: "blocked" }),
                ),
          ),
          h(
            Panel,
            { title: props.t("development.concurrency"), subtitle: props.t("development.routingSubtitle") },
            h(
              "div",
              { className: "hao-mini-metrics" },
              h(Metric, { label: props.t("development.globalWriters"), value: props.number(concurrency.max_active_writers || 0), hint: "fail-closed admission" }),
              h(Metric, { label: props.t("development.projectWriters"), value: props.number(concurrency.max_active_writers_per_project || 0), hint: "isolated workspaces" }),
              h(Metric, { label: props.t("development.status"), value: h(Status, { value: health.openhands || "UNKNOWN", t: props.t }), hint: "writer lease authority" }),
            ),
          ),
        ),
      ),
      h(
        Panel,
        { title: props.t("development.usage"), subtitle: props.t("development.usageSubtitle") },
        h(
          "div",
          { className: "hao-mini-metrics hao-dev-usage-metrics" },
          h(Metric, { label: "Input", value: props.compact(usage.input || 0), hint: "tokens" }),
          h(Metric, { label: "Output", value: props.compact(usage.output || 0), hint: "tokens" }),
          h(Metric, { label: "Cache read", value: props.compact(usage.cachedInput || 0), hint: "tokens" }),
          h(Metric, { label: "Reasoning", value: props.compact(usage.reasoningOutput || 0), hint: "tokens" }),
          h(Metric, { label: "Calls", value: props.number(usage.calls || 0), hint: props.number(usage.executionsWithUsage || 0) + " executions" }),
          h(Metric, { label: "Cost", value: props.money(usage.costUsd || 0), hint: props.t("development.traceCount", { count: props.number(usage.traces || 0) }) }),
        ),
      ),
    );
  }

  const TAB_KEYS = ["overview", "development", "organization", "workforce", "suppliers", "operations", "policy", "incidents"];

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
      if (tab === "development") content = h(Development, shared);
      else if (tab === "organization") content = h(Organization, shared);
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
