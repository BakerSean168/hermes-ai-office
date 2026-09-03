export function num(value) {
  return Number(value || 0);
}
export function compact(value, locale) {
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(num(value));
}
export function integer(value, locale) {
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US").format(num(value));
}
export function money(value) {
  const n = num(value);
  return "$" + (n < 0.01 && n > 0 ? n.toFixed(5) : n.toFixed(2));
}
export function duration(ms) {
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
export function dateTime(value, locale) {
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
export function runningElapsed(item, now) {
  if (item.durationMs != null) return item.durationMs;
  const start = Date.parse(item.startedAt || "");
  return Number.isFinite(start) ? Math.max(0, now - start) : 0;
}
export function percentage(value) {
  return value == null ? "—" : Math.round(num(value) * 100) + "%";
}
export function routeLabel(item) {
  const route = item && item.route;
  if (!route) return "—";
  return route.providerKey + " · " + route.physicalModel;
}
export function selectedModel(item) {
  const selection = item && item.resourceSelection;
  return (selection && selection.modelFamily) || (item && item.logicalModel) || "—";
}
export function selectedAgent(item) {
  const selection = item && item.resourceSelection;
  return (selection && selection.agentBackend) || (item && item.backend) || "—";
}
export function selectedResource(item) {
  const selection = item && item.resourceSelection;
  return (selection && selection.resourceId) || "—";
}
export function hasSelectionTelemetry(item) {
  const usage = item && item.usage;
  if (!usage) return false;
  return Number(usage.calls || 0) > 0 || Number(usage.input || 0) > 0 || Number(usage.output || 0) > 0;
}
export function activityLabel(kind, t) {
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
export function shortRevision(value) {
  const text = String(value || "");
  return text ? text.slice(0, 10) : null;
}
