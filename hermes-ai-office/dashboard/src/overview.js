import { React, h } from "./runtime.js";
import { activityLabel, compact, duration, integer, money, percentage, routeLabel, shortRevision } from "./format.js";
import { Badge, ExecutionTable, Metric, Panel, RunningCards } from "./components.js";
import { HealthSummary } from "./plan-detail.js";

function portfolioHealthRank(plan) {
  const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const statusRank = { BLOCKED: 0, RUNNING: 1, PENDING: 2, ORCHESTRATING: 3, SUCCEEDED: 4, CANCELLED: 5 };
  const priority = String(((plan.health || {}).topPriority) || "").toUpperCase();
  const status = String(plan.status || "").toUpperCase();
  return [priorityRank[priority] == null ? 4 : priorityRank[priority], statusRank[status] == null ? 6 : statusRank[status], -(Number((plan.health || {}).issueCount || 0)), -(Number(plan.updatedAt || 0))];
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
  return h("div", { className: "hao-running-grid" }, rows.map(function (plan) {
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
        h("div", { className: "hao-running-top-left" }, h(Badge, { value: plan.status }), h("span", { className: "hao-phase" }, phase || batch.key || "complete")),
        h(HealthSummary, { health: health, t: t })
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
      topIssue.reason || activity.reason || plan.blockedReason
        ? h("div", { className: "hao-plan-reason hao-plan-health-issue" },
            topIssue.priority ? h("span", { className: "hao-health-priority hao-health-priority-" + String(topIssue.priority).toLowerCase() }, topIssue.priority) : null,
            h("span", null, topIssue.reason || activity.reason || plan.blockedReason)
          )
        : null,
      h("div", { className: "hao-plan-card-actions" },
        plan.status === "BLOCKED" && batch.status === "BLOCKED" ? h("button", {
          type: "button",
          className: "hao-button hao-plan-continue-button",
          disabled: syncing,
          onClick: function (event) { event.stopPropagation(); props.onHandoff(plan); },
        }, t.continueHandoff) : null,
        plan.status === "BLOCKED" && batch.status === "BLOCKED" ? h("button", {
          type: "button",
          className: "hao-button hao-button-secondary hao-plan-scan-button",
          disabled: syncing,
          onClick: function (event) { event.stopPropagation(); props.onScan(plan); },
        }, syncing ? t.syncingExternal : t.continueExternal) : null,
        plan.pullRequestUrl ? h("a", {
          className: "hao-button hao-button-secondary",
          href: plan.pullRequestUrl, target: "_blank", rel: "noreferrer",
          onClick: function (event) { event.stopPropagation(); }
        }, "PR") : null,
        h("button", {
          type: "button",
          className: "hao-button hao-button-secondary hao-plan-details-button",
          onClick: function (event) { event.stopPropagation(); openPlan(); },
        }, t.details)
      )
    );
  }));
}

export function Overview(props) {
  const data = props.data;
  const t = props.t;
  const s = data.summary || {};
  const registryData = data.registry || {};
  const deployments = registryData.deployments || {};
  const projectStats = data.planSummary || {};
  const criticalProjects = (data.plans || []).filter(function (plan) { return String(((plan.health || {}).state) || "").toUpperCase() === "CRITICAL"; }).length;
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
    h(Panel, { title: t.plans, className: "hao-running-panel" }, h(PlanCards, { rows: data.plans, t: t, locale: props.locale, onOpen: props.onOpenPlan, onHandoff: props.onHandoffPlan, onScan: props.onScanPlan, syncingPlanIds: props.syncingPlanIds })),
    h(
      "div",
      { className: "hao-runtime-strip" },
      h("div", null, h("span", null, t.runtime), h(Badge, { value: ((data.runtime || {}).sourceHealth || {}).openhands || "UNKNOWN" }), h("span", null, "LiteLLM"), h(Badge, { value: ((data.runtime || {}).sourceHealth || {}).litellm || registryData.health || "UNKNOWN" })),
      h("div", null,
        h("span", null, t.projectStats),
        h("strong", null, integer(projectStats.active || 0, props.locale)), h("span", null, t.implementingProjects),
        h("strong", null, integer(projectStats.succeeded || 0, props.locale)), h("span", null, t.completedProjects),
        h("strong", null, integer(projectStats.blocked || 0, props.locale)), h("span", null, t.blockedProjects),
        criticalProjects ? h("span", { className: "hao-health-priority hao-health-priority-p0" }, criticalProjects + " " + t.criticalProjects) : null
      ),
      h("div", null, h("span", null, t.providers), h("strong", null, integer(deployments.active || 0, props.locale)), h("span", null, t.activeDeployments), h("span", { className: "hao-muted" }, integer(deployments.paused || 0, props.locale) + " " + t.pausedDeployments)),
    ),
    h(Panel, {
      title: t.history,
      action: h("input", { className: "hao-search", value: search, placeholder: t.search, onChange: function (event) { setSearch(event.target.value); } }),
    }, h(ExecutionTable, { rows: history, t: t, locale: props.locale, now: props.now })),
  );
}
