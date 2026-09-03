import { COPY } from "./i18n.js";
import { React, api, assertDashboardContract, assertPlanDetailContract, h, useLocale, useThemeMode } from "./runtime.js";
import { dateTime } from "./format.js";
import { Analytics } from "./analytics.js";
import { Overview } from "./overview.js";
import { PlanDetail } from "./plan-detail.js";
import { ResourcePage } from "./resources.js";

export function App() {
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
  const [pendingResourceIds, setPendingResourceIds] = React.useState({});

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
      body: JSON.stringify(handoff),
    })
      .then(function () {
        setError("");
        setHandoffPlan(null);
        setHandoffText("");
        window.setTimeout(load, 500);
        window.setTimeout(load, 2500);
      })
      .catch(function (cause) { setHandoffError(String(cause)); })
      .finally(function () { setHandoffSubmitting(false); });
  }

  function syncExternalProgress(plan) {
    if (window.confirm && !window.confirm(t.continueExternalConfirm)) return Promise.resolve();
    const planId = plan.planId;
    setSyncingPlanIds(function (current) { return Object.assign({}, current, { [planId]: true }); });
    return api("/plans/" + encodeURIComponent(plan.planId) + "/sync-and-continue", { method: "POST" })
      .then(function () {
        setError("");
        window.setTimeout(load, 1000);
        window.setTimeout(load, 5000);
        window.setTimeout(load, 15000);
        window.setTimeout(load, 30000);
        window.setTimeout(function () {
          setSyncingPlanIds(function (current) {
            const next = Object.assign({}, current);
            delete next[planId];
            return next;
          });
        }, 12 * 60 * 1000);
      })
      .catch(function (cause) {
        setError(String(cause));
        setSyncingPlanIds(function (current) {
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

  function updateResourceState(resource, state) {
    const resourceId = String(resource && resource.resourceId || "");
    if (!resourceId) return Promise.resolve();
    setPendingResourceIds(function (current) {
      return Object.assign({}, current, { [resourceId]: true });
    });
    const payload = {
      state: state,
      reason: "DASHBOARD_OPERATOR_" + state,
    };
    if (state === "SUSPENDED") {
      payload.suspendedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    }
    if (resource.version != null) payload.expectedVersion = resource.version;
    return api("/resources/" + encodeURIComponent(resourceId) + "/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function () { setError(""); return load(); })
      .catch(function (cause) { setError(String(cause)); })
      .finally(function () {
        setPendingResourceIds(function (current) {
          const next = Object.assign({}, current);
          delete next[resourceId];
          return next;
        });
      });
  }

  React.useEffect(function () {
    if (!data) return;
    setSyncingPlanIds(function (current) {
      const next = Object.assign({}, current);
      let changed = false;
      (data.plans || []).forEach(function (plan) {
        if (next[plan.planId] && plan.status !== "BLOCKED") { delete next[plan.planId]; changed = true; }
      });
      return changed ? next : current;
    });
  }, [data]);

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

  React.useEffect(function () {
    if (!handoffPlan) return undefined;
    function onKeyDown(event) { if (event.key === "Escape") closeHandoff(); }
    window.addEventListener("keydown", onKeyDown);
    return function () { window.removeEventListener("keydown", onKeyDown); };
  }, [handoffPlan, handoffSubmitting]);

  const adminUrl = data && data.registry && data.registry.adminUrl;
  return h(
    "main",
    { className: "hao-shell", "data-theme-mode": themeMode },
    h("header", { className: "hao-toolbar" },
      h("nav", { className: "hao-toolbar-nav" },
        h("button", { type: "button", className: view === "overview" ? "is-active" : "", onClick: function () { setView("overview"); } }, t.overview),
        h("button", { type: "button", className: view === "analytics" ? "is-active" : "", onClick: function () { setView("analytics"); } }, t.analytics),
        h("button", { type: "button", className: view === "resources" ? "is-active" : "", onClick: function () { setView("resources"); } }, t.resources),
      ),
      h("div", { className: "hao-toolbar-actions" },
        data ? h("span", { className: "hao-updated" }, t.updated + " " + dateTime(data.generatedAt, locale)) : null,
        adminUrl ? h("a", { className: "hao-button hao-button-secondary", href: adminUrl, target: "_blank", rel: "noreferrer" }, t.admin) : null,
        h("button", { className: "hao-button", type: "button", onClick: load, disabled: loading }, loading ? "…" : t.refresh),
      ),
    ),
    error ? h("div", { className: "hao-error" }, error) : null,
    !data ? h("div", { className: "hao-loading" }, loading ? "Loading…" : "No data") : view === "analytics" ? h(Analytics, { data: data, t: t, locale: locale }) : view === "resources" ? h(ResourcePage, { data: data, t: t, locale: locale, onState: updateResourceState, pendingResourceIds: pendingResourceIds }) : h(Overview, { data: data, t: t, locale: locale, now: now, onOpenPlan: openPlan, onHandoffPlan: openHandoff, onScanPlan: syncExternalProgress, syncingPlanIds: syncingPlanIds }),
    detailPlanId ? h(PlanDetail, { detail: planDetail, loading: detailLoading, error: detailError, onClose: closePlan, t: t, locale: locale, now: now }) : null,
    handoffPlan ? h("div", { className: "hao-handoff-backdrop", role: "presentation", onMouseDown: function (event) { if (event.target === event.currentTarget) closeHandoff(); } },
      h("section", { className: "hao-handoff-dialog", role: "dialog", "aria-modal": "true", "aria-label": t.handoffTitle },
        h("div", { className: "hao-handoff-head" },
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
          onChange: function (event) { setHandoffText(event.target.value); setHandoffError(""); },
        }),
        handoffError ? h("div", { className: "hao-error hao-handoff-error" }, handoffError) : null,
        h("div", { className: "hao-handoff-actions" },
          h("button", { type: "button", className: "hao-button hao-button-secondary", onClick: closeHandoff, disabled: handoffSubmitting }, t.handoffCancel),
          h("button", { type: "button", className: "hao-button", onClick: resumeFromHandoff, disabled: handoffSubmitting || !handoffText.trim() }, handoffSubmitting ? t.handoffSubmitting : t.handoffSubmit)
        )
      )
    ) : null,
  );
}
