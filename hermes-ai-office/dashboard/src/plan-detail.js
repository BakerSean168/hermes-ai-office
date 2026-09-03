import { React, h } from "./runtime.js";
import { compact, dateTime, duration, integer, money, runningElapsed, shortRevision } from "./format.js";
import { Badge } from "./components.js";

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

function healthStateLabel(state, t) {
  const labels = { HEALTHY: t.healthHealthy, WATCH: t.healthWatch, DEGRADED: t.healthDegraded, CRITICAL: t.healthCritical };
  return labels[String(state || "").toUpperCase()] || String(state || "").replace(/_/g, " ");
}

export function HealthSummary(props) {
  const health = props.health || {};
  const state = String(health.state || "HEALTHY").toLowerCase();
  return h("div", { className: "hao-health hao-health-" + state },
    h("strong", null, String(health.score == null ? 100 : health.score) + "/100"),
    h("span", null, healthStateLabel(health.state || "HEALTHY", props.t)),
    health.topPriority ? h("span", { className: "hao-health-priority hao-health-priority-" + String(health.topPriority).toLowerCase() }, health.topPriority) : null
  );
}

function isFailureExecution(item) {
  const status = String((item && item.status) || "").toUpperCase();
  return status === "FAILED" || status === "STUCK" || status === "CANCELLED" || String((item && item.verdict) || "").toUpperCase() === "FAIL" || Boolean(item && item.errorCode);
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
  window.setTimeout(function () {
    const target = executionId
      ? document.getElementById("hao-exec-" + executionId)
      : batchKey ? document.getElementById("hao-batch-" + batchKey) : null;
    if (!target) return;
    const batch = target.closest ? target.closest("details") : null;
    if (batch) batch.open = true;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    if (executionId) {
      window.setTimeout(function () { controls.setTargetExecutionId(null); }, 1800);
    }
  }, 80);
}

function AuditFilters(props) {
  const filters = [
    ["all", props.t.auditFilterAll],
    ["failures", props.t.auditFilterFailures],
    ["repairs", props.t.auditFilterRepairs],
    ["strong", props.t.auditFilterStrong],
  ];
  return h("section", { className: "hao-audit-filters" },
    h("div", { className: "hao-audit-filter-group" }, filters.map(function (item) {
      return h("button", {
        type: "button",
        className: "hao-audit-filter" + (props.auditFilter === item[0] ? " is-active" : ""),
        key: item[0],
        onClick: function () {
          if (item[0] === "failures") props.setAuditFilter("failures");
          else if (item[0] === "repairs") props.setAuditFilter("repairs");
          else if (item[0] === "strong") props.setAuditFilter("strong");
          else props.setAuditFilter("all");
          props.setTargetExecutionId(null);
        },
      }, item[1]);
    })),
    h("label", { className: "hao-audit-batch-filter" },
      h("span", null, props.t.auditFilterBatch),
      h("select", { value: props.batchFilter, onChange: function (event) { props.setBatchFilter(event.target.value); props.setTargetExecutionId(null); } },
        h("option", { value: "all" }, props.t.auditFilterAllBatches),
        (props.batches || []).map(function (batch) { return h("option", { value: batch.key, key: batch.key }, batch.key + " · " + batch.title); })
      )
    )
  );
}

function AuditOverview(props) {
  const summary = (props.audit && props.audit.summary) || {};
  const health = (props.audit && props.audit.health) || {};
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
    h("div", { className: "hao-audit-head" }, h("h3", null, props.t.auditTitle), h(HealthSummary, { health: health, t: props.t })),
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
          h("div", { className: "hao-audit-finding-head" },
            h("strong", null, label),
            h("div", { className: "hao-audit-finding-status" }, h("span", { className: "hao-health-priority hao-health-priority-" + String(item.priority || "P3").toLowerCase() }, item.priority || "P3"), h(Badge, { value: item.resolved ? "SUCCEEDED" : "BLOCKED" }))
          ),
          h("div", { className: "hao-audit-path" }, [item.batchKey, item.workItemKey, item.sourcePhase].filter(Boolean).join(" · ")),
          item.reason ? h("div", { className: "hao-plan-reason" }, item.reason) : null,
          h("div", { className: "hao-audit-jumps" },
            item.sourceExecutionId ? h("button", { type: "button", className: "hao-audit-finding-button", onClick: function () { props.onJump(item.sourceExecutionId, item.batchKey); } }, props.t.jumpFailure) : null,
            item.repairExecutionId ? h("button", { type: "button", className: "hao-audit-finding-button", onClick: function () { props.onJump(item.repairExecutionId, item.batchKey); } }, props.t.jumpRepair) : null,
            !item.sourceExecutionId && item.batchKey ? h("button", { type: "button", className: "hao-audit-finding-button", onClick: function () { props.onJump(null, item.batchKey); } }, props.t.jumpBatch) : null
          ),
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
          (item.policyReasons || []).length ? h("div", { className: "hao-plan-meta" }, item.policyReasons.map(function (reason) { return h("span", { className: "hao-plan-chip", key: reason }, reason); })) : null,
          h("div", { className: "hao-audit-jumps" }, h("button", { type: "button", className: "hao-audit-finding-button", onClick: function () { props.onJump(item.executionId, item.batchKey); } }, props.t.jumpExecution))
        );
      }))
    ) : null
  );
}

function TimelineExecution(props) {
  const item = props.execution || {};
  const selection = item.resourceSelection || null;
  const chips = [];
  if (item.attempt) chips.push(props.t.attempt + " " + item.attempt);
  if (item.backend) chips.push(props.t.agent + ": " + item.backend);
  if (item.model) chips.push(props.t.selectedModel + ": " + item.model);
  if (selection) {
    chips.push(props.t.selectedResource + ": " + selection.resourceId);
    chips.push(props.t.tier + ": " + selection.resourceTier);
    chips.push(props.t.sequence + ": " + selection.resourceSequence);
    chips.push(props.t.transport + ": " + selection.transport);
  }
  chips.push(duration(runningElapsed(item, props.now)));
  chips.push(compact(item.totalTokens || 0, props.locale) + " tok");
  chips.push(money(item.costUsd));
  return h("div", {
    id: "hao-exec-" + item.executionId,
    className: "hao-timeline-step" + (props.targetExecutionId === item.executionId ? " is-target" : ""),
    "data-execution-id": item.executionId,
    "data-batch-key": props.batchKey || "",
  },
    h("div", { className: "hao-timeline-step-head" },
      h("span", { className: "hao-phase" }, item.phase || "EXECUTION"),
      h(Badge, { value: item.status }),
      item.verdict ? h("span", { className: "hao-timeline-verdict" }, item.verdict) : null,
      h("span", { className: "hao-timeline-time" },
        dateTime(item.startedAt, props.locale) +
        (item.lastObservedAt ? " · " + props.t.lastObserved + " " + dateTime(item.lastObservedAt, props.locale) : "")
      )
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

export function PlanDetail(props) {
  const detail = props.detail;
  const t = props.t;
  const [auditFilter, setAuditFilter] = React.useState("all");
  const [batchFilter, setBatchFilter] = React.useState("all");
  const [targetExecutionId, setTargetExecutionId] = React.useState(null);
  if (props.loading) {
    return h("div", { className: "hao-plan-detail-backdrop", onClick: props.onClose },
      h("section", { className: "hao-plan-detail", onClick: function (event) { event.stopPropagation(); } },
        h("div", { className: "hao-loading" }, "Loading…")
      )
    );
  }
  const plan = detail && detail.plan;
  const audit = (detail && detail.audit) || {};
  const repairIds = new Set((audit.attention || []).map(function (item) { return item.repairExecutionId; }).filter(Boolean));
  const controls = { setAuditFilter: setAuditFilter, setBatchFilter: setBatchFilter, setTargetExecutionId: setTargetExecutionId };
  function onJump(executionId, batchKey) { jumpToTimelineTarget(executionId, batchKey, controls); }
  const visibleBatches = !detail ? [] : (detail.batches || []).map(function (batch) {
    if (batchFilter !== "all" && batch.key !== batchFilter) return null;
    const controlFailure = (audit.attention || []).some(function (item) { return item.kind === "CONTROL_PLANE_FAILURE" && item.batchKey === batch.key && !item.resolved; });
    const workItems = (batch.workItems || []).map(function (work) {
      const executions = (work.executions || []).filter(function (execution) { return executionMatchesAuditFilter(execution, auditFilter, repairIds); });
      if (auditFilter !== "all" && !executions.length) return null;
      return Object.assign({}, work, { executions: executions });
    }).filter(Boolean);
    if (auditFilter !== "all" && !workItems.length && !(auditFilter === "failures" && controlFailure)) return null;
    return Object.assign({}, batch, { workItems: workItems, showEvents: auditFilter === "all" || (auditFilter === "failures" && controlFailure) });
  }).filter(Boolean);
  return h("div", { className: "hao-plan-detail-backdrop", onClick: props.onClose },
    h("section", { className: "hao-plan-detail", role: "dialog", "aria-modal": "true", onClick: function (event) { event.stopPropagation(); } },
      h("header", { className: "hao-plan-detail-head" },
        h("div", null,
          h("div", { className: "hao-running-top" }, plan ? h(Badge, { value: plan.status }) : null, h("span", { className: "hao-phase" }, t.planDetail)),
          h("h2", null, plan ? plan.objective : t.planDetail),
          plan ? h("div", { className: "hao-running-project" }, plan.projectKey + " · " + shortRevision(plan.currentRevision)) : null,
          plan && plan.governance ? h("div", { className: "hao-plan-meta" },
            h("span", { className: "hao-plan-chip" }, props.t.governance + " · PR #" + (plan.governance.pullRequestNumber || "—")),
            plan.governance.producer ? h("span", { className: "hao-plan-chip" }, plan.governance.producer) : null,
            plan.governance.governedRevision ? h("span", { className: "hao-plan-chip" }, shortRevision(plan.governance.governedRevision)) : null,
            plan.governance.publishedPlanStatus ? h(Badge, { value: plan.governance.publishedPlanStatus }) : null
          ) : null
        ),
        h("button", { type: "button", className: "hao-button hao-button-secondary", onClick: props.onClose }, t.close)
      ),
      props.error ? h("div", { className: "hao-error" }, props.error) : null,
      detail ? h("div", { className: "hao-plan-detail-body" },
        h(AuditOverview, { audit: audit, t: t, locale: props.locale }),
        h(AuditAttention, { audit: audit, t: t, locale: props.locale, onJump: onJump }),
        h(AuditFilters, { auditFilter: auditFilter, setAuditFilter: setAuditFilter, batchFilter: batchFilter, setBatchFilter: setBatchFilter, setTargetExecutionId: setTargetExecutionId, batches: detail.batches || [], t: t }),
        visibleBatches.length
          ? h("div", { className: "hao-timeline" }, visibleBatches.map(function (batch) {
              const isOpen = batch.status === "RUNNING" || batch.status === "BLOCKED" || batchFilter !== "all" || Boolean(targetExecutionId);
              const batchAudit = ((audit.batches || []).find(function (item) { return item.key === batch.key; })) || {};
              const auditChips = [duration(batchAudit.durationMs || 0), compact(batchAudit.totalTokens || 0, props.locale) + " tok", money(batchAudit.costUsd || 0)];
              if (batchAudit.failures) auditChips.push(batchAudit.failures + " " + t.failures);
              if (batchAudit.repairs) auditChips.push(batchAudit.repairs + " " + t.repairs);
              if (batchAudit.strongModelExecutions) auditChips.push(batchAudit.strongModelExecutions + " " + t.strongModelUses);
              return h("details", { id: "hao-batch-" + batch.key, className: "hao-timeline-batch", key: batch.key, open: isOpen, "data-batch-key": batch.key },
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
                            return h(TimelineExecution, { key: execution.executionId, execution: execution, t: t, locale: props.locale, now: props.now, targetExecutionId: targetExecutionId, batchKey: batch.key });
                          }))
                        : h("div", { className: "hao-muted hao-timeline-none" }, t.noTimeline),
                      work.blockedReason ? h("div", { className: "hao-plan-reason" }, work.blockedReason) : null
                    );
                  }),
                  batch.showEvents && (batch.events || []).length
                    ? h("div", { className: "hao-timeline-events" }, (batch.events || []).map(function (event, index) {
                        return h(TimelineEvent, { key: event.type + index, event: event, t: t, locale: props.locale });
                      }))
                    : null,
                  batch.blockedReason ? h("div", { className: "hao-plan-reason" }, batch.blockedReason) : null
                )
              );
            }))
          : h("div", { className: "hao-empty" }, t.filteredTimelineEmpty),
        auditFilter === "all" && batchFilter === "all" && (detail.deliveryEvents || []).length
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
