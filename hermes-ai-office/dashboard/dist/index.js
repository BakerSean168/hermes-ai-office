(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  const registry = window.__HERMES_PLUGINS__;
  if (!SDK || !registry || typeof registry.register !== "function") return;

  const React = SDK.React;
  const h = React.createElement;
  const API_ROOT = "/api/plugins/hermes-ai-office";

  function api(path, options) {
    return SDK.fetchJSON(API_ROOT + path, options);
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function compact(value) {
    return new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(Number(value || 0));
  }

  function money(value) {
    return "$" + Number(value || 0).toFixed(2);
  }

  function relativeTime(timestamp) {
    const value = Number(timestamp || 0);
    if (!value) return "unknown";
    const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
    if (seconds < 60) return seconds + "s ago";
    if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
    if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
    return Math.floor(seconds / 86400) + "d ago";
  }

  function statusClass(value) {
    const normalized = String(value || "unknown").toLowerCase();
    if (["active", "healthy", "employed", "working", "selected", "current"].includes(normalized)) {
      return "hao-status hao-status-good";
    }
    if (["degraded", "warning", "scheduled", "prefer", "unresolved"].includes(normalized)) {
      return "hao-status hao-status-warn";
    }
    if (["error", "critical", "blocked", "unhealthy", "dormant", "unfilled"].includes(normalized)) {
      return "hao-status hao-status-bad";
    }
    return "hao-status";
  }

  function Status(props) {
    return h("span", { className: statusClass(props.value) }, String(props.value || "unknown"));
  }

  function Panel(props) {
    return h(
      "section",
      { className: "hao-panel " + (props.className || "") },
      props.title
        ? h(
            "div",
            { className: "hao-panel-head" },
            h("div", null, h("h2", null, props.title), props.subtitle ? h("p", null, props.subtitle) : null),
            props.action || null,
          )
        : null,
      props.children,
    );
  }

  function StatCard(props) {
    return h(
      "div",
      { className: "hao-stat" },
      h("span", null, props.label),
      h("strong", null, props.value),
      props.hint ? h("small", null, props.hint) : null,
    );
  }

  function Empty(props) {
    return h("div", { className: "hao-empty" }, props.children || "No records yet.");
  }

  function ErrorBanner(props) {
    return h(
      "div",
      { className: "hao-error", role: "alert" },
      h("strong", null, props.title || "Data unavailable"),
      h("span", null, String(props.error || "Unknown error")),
    );
  }

  function sourceError(value) {
    return value && value.unavailable ? value.error || "Unavailable" : null;
  }

  function Overview(props) {
    const data = props.data;
    const workforce = asObject(data.workforce);
    const workforceSummary = asObject(workforce.summary);
    const supply = asObject(data.supply);
    const supplySummary = asObject(supply.summary);
    const organization = asObject(data.organization);
    const orgSummary = asObject(organization.summary);
    const incidents = asArray(asObject(data.incidents).items).filter(function (item) {
      return item.lifecycle === "OPEN" || item.lifecycle === "ACKNOWLEDGED";
    });
    const policy = asObject(data.runtimePolicy);
    const attention = [];
    if (Number(orgSummary.unfilledPositions || 0) > 0) {
      attention.push(Number(orgSummary.unfilledPositions) + " positions have no current appointment.");
    }
    if (Number(orgSummary.runtimeActiveUnattributedPositions || 0) > 0) {
      attention.push(
        Number(orgSummary.runtimeActiveUnattributedPositions) +
          " active runtimes have no asserted Employee attribution.",
      );
    }
    if (Number(supplySummary.unmappedChannels || 0) > 0) {
      attention.push(
        Number(supplySummary.unmappedChannels) +
          " gateway routes remain technical evidence without commercial classification.",
      );
    }
    if (incidents.length > 0) attention.push(incidents.length + " active incidents need attention.");

    return h(
      React.Fragment,
      null,
      h(
        "div",
        { className: "hao-stats" },
        h(StatCard, { label: "Workspaces", value: Number(orgSummary.workScopes || 0), hint: "Hermes work scopes" }),
        h(StatCard, { label: "Positions", value: Number(orgSummary.activePositions || 0), hint: Number(orgSummary.staffedPositions || 0) + " staffed" }),
        h(StatCard, { label: "Employees", value: Number(workforceSummary.employees || 0), hint: Number(workforceSummary.currentDuties || 0) + " working now" }),
        h(StatCard, { label: "HR suppliers", value: Number(supplySummary.suppliers || 0), hint: Number(supplySummary.activeAgreements || 0) + " active agreements" }),
        h(StatCard, { label: "Model requests", value: compact(workforceSummary.requests), hint: compact(workforceSummary.inputTokens) + " input tokens" }),
        h(StatCard, { label: "Runtime policy", value: String(policy.mode || "prefer").toUpperCase(), hint: "OpenCode + Codex" }),
      ),
      h(
        "div",
        { className: "hao-two-column" },
        h(
          Panel,
          { title: "Company attention", subtitle: "Business facts that need staffing or classification" },
          attention.length
            ? h(
                "ul",
                { className: "hao-list" },
                attention.map(function (item, index) {
                  return h("li", { key: index }, item);
                }),
              )
            : h(Empty, null, "No current staffing, supply, or incident warnings."),
        ),
        h(
          Panel,
          { title: "Current operating picture", subtitle: "Execution evidence remains distinct from employees" },
          h(
            "dl",
            { className: "hao-kv" },
            h("div", null, h("dt", null, "Active runs"), h("dd", null, Number(orgSummary.activeRuns || 0))),
            h("div", null, h("dt", null, "Active duties"), h("dd", null, Number(orgSummary.activeDuties || 0))),
            h("div", null, h("dt", null, "Runtime sessions"), h("dd", null, Number(orgSummary.activeRuntimeSessions || 0))),
            h("div", null, h("dt", null, "Actual spend"), h("dd", null, money(workforceSummary.actualCost))),
            h("div", null, h("dt", null, "Market value"), h("dd", null, money(workforceSummary.marketValue))),
          ),
        ),
      ),
    );
  }

  function Organization(props) {
    const organization = asObject(props.data.organization);
    const error = sourceError(organization);
    if (error) return h(ErrorBanner, { error: error });
    const positions = asArray(organization.positions);
    const groups = new Map();
    positions.forEach(function (position) {
      const scope = asObject(position.workScope);
      const key = scope.name || scope.slug || "Global";
      const list = groups.get(key) || [];
      list.push(position);
      groups.set(key, list);
    });
    return h(
      "div",
      { className: "hao-stack" },
      Array.from(groups.entries()).map(function (entry) {
        const scopeName = entry[0];
        const items = entry[1];
        return h(
          Panel,
          { key: scopeName, title: scopeName, subtitle: items.length + " organizational positions" },
          h(
            "div",
            { className: "hao-grid" },
            items.map(function (position) {
              const appointments = asArray(position.currentAppointments);
              const duties = asArray(position.currentDuties);
              const runtime = asArray(position.runtimeSessions)[0];
              const current = duties.find(function (duty) { return duty.currentStaffing; });
              const employee = current
                ? asObject(current.currentStaffing).employeeName
                : appointments[0]
                  ? appointments[0].employeeName
                  : null;
              return h(
                "article",
                { className: "hao-card", key: position.id },
                h("div", { className: "hao-card-title" }, h("strong", null, position.name), h(Status, { value: position.status })),
                h("p", { className: "hao-muted" }, [position.role && position.role.name, position.runtimeKind, position.lifecyclePolicy].filter(Boolean).join(" · ")),
                employee
                  ? h("p", null, h("span", { className: "hao-label" }, current ? "On duty" : "Appointed"), " ", h("strong", null, employee))
                  : h("p", { className: "hao-muted" }, "No appointed employee"),
                runtime
                  ? h("p", { className: "hao-muted" }, "Runtime " + (runtime.runtimeKind || position.runtimeKind || "unknown") + " · " + (runtime.state || "unknown") + (runtime.modelHint ? " · hint " + runtime.modelHint : ""))
                  : null,
              );
            }),
          ),
        );
      }),
      positions.length === 0 ? h(Empty, null, "No organizational positions yet.") : null,
    );
  }

  function Workforce(props) {
    const workforce = asObject(props.data.workforce);
    const error = sourceError(workforce);
    if (error) return h(ErrorBanner, { error: error });
    const employees = asArray(workforce.employees);
    return h(
      "div",
      { className: "hao-grid hao-grid-wide" },
      employees.map(function (employee) {
        const career = asObject(employee.career);
        const usage = asObject(career.usage);
        const currentWork = asArray(employee.currentWork);
        const appointments = asArray(employee.currentAppointments);
        return h(
          "article",
          { className: "hao-card", key: employee.id },
          h("div", { className: "hao-card-title" }, h("strong", null, employee.displayName), h(Status, { value: currentWork.length ? "working" : employee.cooperationState })),
          h("p", { className: "hao-muted" }, asObject(employee.supplier).name + " · " + asObject(employee.supplierModel).name),
          h("div", { className: "hao-chip-row" }, appointments.map(function (appointment) {
            return h("span", { className: "hao-chip", key: appointment.id }, (appointment.workScopeName ? appointment.workScopeName + " / " : "") + appointment.positionName + " · " + appointment.class);
          })),
          currentWork.length
            ? h("div", { className: "hao-work" }, currentWork.map(function (work) {
                return h("div", { key: work.staffingSegmentId }, h("strong", null, work.positionName + " · " + work.activity), h("small", null, work.runTitle || work.runId));
              }))
            : h("p", { className: "hao-muted" }, appointments.length ? "Available through current appointments." : "No current appointment."),
          h("div", { className: "hao-card-foot" }, compact(career.staffingSegments) + " duties · " + compact(usage.requests) + " requests · " + compact(usage.inputTokens) + " input · " + compact(usage.outputTokens) + " output"),
          h("div", { className: "hao-card-foot" }, money(usage.actualCost) + " actual · " + money(usage.allocatedCost) + " allocated · " + money(usage.marketValue) + " market value"),
        );
      }),
      employees.length === 0 ? h(Empty, null, "No durable Employee identity has been registered.") : null,
    );
  }

  function Suppliers(props) {
    const supply = asObject(props.data.supply);
    const error = sourceError(supply);
    if (error) return h(ErrorBanner, { error: error });
    const suppliers = asArray(supply.suppliers);
    const infrastructure = asObject(supply.unmappedInfrastructure);
    return h(
      "div",
      { className: "hao-stack" },
      suppliers.map(function (supplier) {
        const employees = asArray(supplier.employees);
        const plans = asArray(supplier.plans);
        const agreements = asArray(supplier.agreements);
        const summary = asObject(supplier.summary);
        return h(
          Panel,
          {
            key: supplier.id,
            title: supplier.name,
            subtitle: Number(summary.employees || 0) + " employees · " + Number(summary.currentEmployments || 0) + " current employments",
            action: h(Status, { value: supplier.lifecycle }),
          },
          h(
            "div",
            { className: "hao-supplier-layout" },
            h(
              "div",
              null,
              h("h3", null, "Employees"),
              employees.length
                ? h("div", { className: "hao-chip-row" }, employees.map(function (employee) {
                    return h("span", { className: "hao-chip", key: employee.id }, employee.displayName);
                  }))
                : h("p", { className: "hao-muted" }, "No employee identities"),
            ),
            h(
              "div",
              null,
              h("h3", null, "Commercial supply"),
              plans.length
                ? h("p", null, plans.map(function (plan) { return plan.name; }).join(" · "))
                : h("p", { className: "hao-muted" }, "No explicit Plan metadata"),
              agreements.map(function (agreement) {
                return h("div", { className: "hao-agreement", key: agreement.id }, h("strong", null, agreement.name), h("small", null, (agreement.planName || "No plan") + " · " + agreement.lifecycle + " · " + asArray(agreement.employments).length + " employments"));
              }),
            ),
          ),
        );
      }),
      h(
        Panel,
        {
          title: "Unclassified infrastructure evidence",
          subtitle: Number(infrastructure.count || 0) + " routes are not allowed to fabricate Supplier or Employee identity",
        },
        asArray(infrastructure.groups).length
          ? h("div", { className: "hao-grid" }, asArray(infrastructure.groups).map(function (group) {
              return h("article", { className: "hao-card", key: String(group.gatewaySlug) + ":" + String(group.channelName) }, h("div", { className: "hao-card-title" }, h("strong", null, group.channelName), h(Status, { value: asArray(group.health).join(" / ") || "unknown" })), h("p", { className: "hao-muted" }, group.gatewayName || group.gatewaySlug), h("p", null, asArray(group.modelHints).join(" · ") || "No model identity hint"));
            }))
          : h(Empty, null, "All observed routes have explicit commercial classification."),
      ),
    );
  }

  function Operations(props) {
    const organization = asObject(props.data.organization);
    const error = sourceError(organization);
    if (error) return h(ErrorBanner, { error: error });
    const runs = asArray(organization.activeRuns);
    const duties = asArray(organization.activeDuties);
    const runtimes = asArray(organization.activeRuntimeSessions);
    return h(
      "div",
      { className: "hao-three-column" },
      h(Panel, { title: "Active runs", subtitle: runs.length + " execution contexts" }, runs.length ? h("div", { className: "hao-stack-tight" }, runs.map(function (run) { return h("article", { className: "hao-row-card", key: run.id }, h("strong", null, run.title || run.id), h(Status, { value: run.status })); })) : h(Empty, null, "No active runs.")),
      h(Panel, { title: "Active duties", subtitle: duties.length + " activated positions" }, duties.length ? h("div", { className: "hao-stack-tight" }, duties.map(function (duty) { return h("article", { className: "hao-row-card", key: duty.id }, h("strong", null, duty.positionName || duty.positionId || duty.id), h(Status, { value: duty.currentActivity || duty.lifecycle })); })) : h(Empty, null, "No active duties.")),
      h(Panel, { title: "Runtime sessions", subtitle: runtimes.length + " technical shells" }, runtimes.length ? h("div", { className: "hao-stack-tight" }, runtimes.map(function (runtime) { return h("article", { className: "hao-row-card", key: runtime.id }, h("strong", null, runtime.runtimeKind || "Runtime"), h(Status, { value: runtime.state }), h("small", null, runtime.modelHint ? "model hint " + runtime.modelHint : "employee attribution is separate")); })) : h(Empty, null, "No active runtimes.")),
    );
  }

  function RuntimePolicy(props) {
    const initial = asObject(props.data.runtimePolicy);
    const [mode, setMode] = React.useState(String(initial.mode || "prefer"));
    const [opencodePosition, setOpenCodePosition] = React.useState(String(initial.opencodePosition || "coding-executor"));
    const [codexPosition, setCodexPosition] = React.useState(String(initial.codexPosition || "codex-executor"));
    const [saving, setSaving] = React.useState(false);
    const [message, setMessage] = React.useState("");

    React.useEffect(function () {
      setMode(String(initial.mode || "prefer"));
      setOpenCodePosition(String(initial.opencodePosition || "coding-executor"));
      setCodexPosition(String(initial.codexPosition || "codex-executor"));
    }, [initial.mode, initial.opencodePosition, initial.codexPosition]);

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
        setMessage("Runtime policy saved. New Hermes tool calls use it immediately.");
        await props.onRefresh();
      } catch (error) {
        setMessage(String(error));
      } finally {
        setSaving(false);
      }
    }

    const decisions = asArray(asObject(props.data.runtimeDecisions).items);
    return h(
      "div",
      { className: "hao-stack" },
      h(
        Panel,
        {
          title: "OpenCode / Codex staffing policy",
          subtitle: "Hermes selects an appointed Employee before the terminal tool launches the external runtime",
          action: h("button", { className: "hao-button", disabled: saving, onClick: save }, saving ? "Saving…" : "Save policy"),
        },
        h(
          "div",
          { className: "hao-policy-form" },
          h("label", null, h("span", null, "Mode"), h("select", { value: mode, onChange: function (event) { setMode(event.target.value); } }, h("option", { value: "observe" }, "Observe — record only"), h("option", { value: "prefer" }, "Prefer — inject when selected, fail open"), h("option", { value: "enforce" }, "Enforce — block without eligible employee"))),
          h("label", null, h("span", null, "OpenCode Position slug"), h("input", { value: opencodePosition, onChange: function (event) { setOpenCodePosition(event.target.value); } })),
          h("label", null, h("span", null, "Codex Position slug"), h("input", { value: codexPosition, onChange: function (event) { setCodexPosition(event.target.value); } })),
        ),
        h("p", { className: "hao-muted" }, "PREFER preserves an explicit --model when it cannot be matched to an appointed Employee. ENFORCE may replace it or block the launch. Raw prompts are never sent to the policy service."),
        message ? h("p", { className: "hao-message" }, message) : null,
      ),
      h(
        Panel,
        { title: "Recent launch decisions", subtitle: decisions.length + " recorded policy resolutions" },
        decisions.length
          ? h("div", { className: "hao-table-wrap" }, h("table", { className: "hao-table" }, h("thead", null, h("tr", null, h("th", null, "When"), h("th", null, "Runtime"), h("th", null, "Position"), h("th", null, "Employee"), h("th", null, "Selected model"), h("th", null, "Outcome"))), h("tbody", null, decisions.map(function (decision) {
              return h("tr", { key: decision.id }, h("td", null, relativeTime(decision.decidedAt)), h("td", null, decision.runtimeKind), h("td", null, asObject(decision.position).name || asObject(decision.position).slug || "—"), h("td", null, asObject(decision.employee).name || "—"), h("td", null, decision.selectedModel || decision.requestedModel || "—"), h("td", null, h(Status, { value: decision.status })));
            }))))
          : h(Empty, null, "No OpenCode or Codex launch has passed through the native policy hook yet."),
      ),
    );
  }

  function Incidents(props) {
    const source = asObject(props.data.incidents);
    const error = sourceError(source);
    if (error) return h(ErrorBanner, { error: error });
    const incidents = asArray(source.items);
    const active = incidents.filter(function (item) { return item.lifecycle === "OPEN" || item.lifecycle === "ACKNOWLEDGED"; });
    return h(
      Panel,
      { title: "Operational incidents", subtitle: active.length + " active incidents derived from the V2 event ledger" },
      active.length
        ? h("div", { className: "hao-stack-tight" }, active.map(function (incident) {
            return h("article", { className: "hao-card", key: incident.id }, h("div", { className: "hao-card-title" }, h("strong", null, incident.title || incident.kind), h(Status, { value: incident.severity })), h("p", { className: "hao-muted" }, incident.kind + " · " + incident.lifecycle + " · " + relativeTime(incident.lastSeenAt)), incident.occurrenceCount > 1 ? h("p", null, incident.occurrenceCount + " occurrences") : null);
          }))
        : h(Empty, null, "No active incidents."),
    );
  }

  const TABS = [
    ["overview", "Overview"],
    ["organization", "Organization"],
    ["workforce", "Workforce"],
    ["suppliers", "Suppliers"],
    ["operations", "Operations"],
    ["policy", "Runtime Policy"],
    ["incidents", "Incidents"],
  ];

  function OfficePage() {
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
      const timer = window.setInterval(load, 10000);
      return function () { window.clearInterval(timer); };
    }, [load]);

    let content = null;
    if (data) {
      if (tab === "organization") content = h(Organization, { data: data });
      else if (tab === "workforce") content = h(Workforce, { data: data });
      else if (tab === "suppliers") content = h(Suppliers, { data: data });
      else if (tab === "operations") content = h(Operations, { data: data });
      else if (tab === "policy") content = h(RuntimePolicy, { data: data, onRefresh: load });
      else if (tab === "incidents") content = h(Incidents, { data: data });
      else content = h(Overview, { data: data });
    }

    return h(
      "div",
      { className: "hao-page" },
      h(
        "header",
        { className: "hao-hero" },
        h("div", null, h("div", { className: "hao-kicker" }, "Hermes native organization plugin"), h("h1", null, "Hermes AI Office"), h("p", null, "Positions are jobs. Models are employees. Hermes runtimes are technical work shells.")),
        h("button", { className: "hao-button", onClick: load, disabled: loading }, loading ? "Loading…" : "Refresh"),
      ),
      h("nav", { className: "hao-tabs", "aria-label": "AI Office sections" }, TABS.map(function (item) {
        return h("button", { key: item[0], className: tab === item[0] ? "active" : "", onClick: function () { setTab(item[0]); } }, item[1]);
      })),
      error ? h(ErrorBanner, { title: "AI Office could not refresh", error: error }) : null,
      !data && loading ? h("div", { className: "hao-loading" }, "Loading AI company state…") : content,
      data ? h("footer", { className: "hao-footer" }, "Projection refreshed " + relativeTime(data.generatedAt) + " · Control plane remains local · No provider credentials enter the dashboard") : null,
    );
  }

  registry.register("hermes-ai-office", OfficePage);
})();
