import { React, h } from "./runtime.js";
import { dateTime, integer } from "./format.js";
import { Badge, Panel } from "./components.js";

function tierLabel(value, t) {
  const labels = {
    PROMOTIONAL: t.tierPromotional,
    FREE: t.tierFree,
    SUBSCRIPTION: t.tierSubscription,
    METERED: t.tierMetered,
    OTHER: t.tierOther,
  };
  return labels[String(value || "").toUpperCase()] || String(value || "—");
}

function transportLabel(value, t) {
  return String(value || "").toUpperCase() === "PROVIDER_NATIVE" ? t.providerNative : t.litellmManaged;
}

function BindingList(props) {
  const bindings = props.bindings || [];
  if (!bindings.length) return h("span", { className: "hao-muted" }, "—");
  return h("div", { className: "hao-resource-bindings" }, bindings.map(function (binding, index) {
    const parts = [binding.modelFamily];
    if (binding.capability) parts.push(binding.capability);
    if (binding.agentBackend) parts.push(binding.agentBackend);
    if (binding.protocol) parts.push(binding.protocol);
    return h("div", { className: "hao-resource-binding", key: binding.modelFamily + index },
      h("span", { className: "hao-mono" }, parts.join(" · ")),
      binding.enabled === false ? h(Badge, { value: "DISABLED" }) : null
    );
  }));
}

function Failure(props) {
  const failure = props.failure;
  if (!failure) return h("span", { className: "hao-muted" }, "—");
  return h("div", { className: "hao-resource-failure" },
    h("strong", null, failure.reasonClass || "UNKNOWN_PROVIDER_FAILURE"),
    failure.sanitizedReason ? h("span", null, failure.sanitizedReason) : null,
    failure.changedAt ? h("small", null, dateTime(failure.changedAt, props.locale)) : null
  );
}

function ResourceActions(props) {
  const resource = props.resource;
  const state = String(resource.state || "").toUpperCase();
  const busy = Boolean(props.pending);
  function action(nextState) {
    props.onState(resource, nextState);
  }
  return h("div", { className: "hao-resource-actions" },
    h("button", {
      type: "button",
      className: "hao-button hao-button-secondary",
      disabled: busy || state === "ACTIVE",
      onClick: function () { action("ACTIVE"); },
    }, props.t.enable),
    h("button", {
      type: "button",
      className: "hao-button hao-button-secondary",
      disabled: busy || state === "DISABLED",
      onClick: function () { action("DISABLED"); },
    }, props.t.disable),
    h("button", {
      type: "button",
      className: "hao-button hao-button-secondary",
      disabled: busy || state === "SUSPENDED",
      onClick: function () { action("SUSPENDED"); },
    }, props.t.suspend)
  );
}

export function ResourcePage(props) {
  const rows = props.data.resources || [];
  const t = props.t;
  return h(Panel, {
    title: t.resourceDirectory,
    subtitle: t.resourceDirectoryHelp,
  },
    rows.length ? h("div", { className: "hao-table-wrap hao-resource-table-wrap" },
      h("table", { className: "hao-table hao-resource-table" },
        h("thead", null, h("tr", null,
          h("th", null, t.resource),
          h("th", null, t.tier),
          h("th", null, t.sequence),
          h("th", null, t.state),
          h("th", null, t.transport),
          h("th", null, t.modelBindings),
          h("th", null, t.lastFailure),
          h("th", null, t.actions)
        )),
        h("tbody", null, rows.map(function (resource) {
          return h("tr", { key: resource.resourceId },
            h("td", null,
              h("strong", { className: "hao-resource-name" }, resource.displayName),
              h("span", { className: "hao-resource-id hao-mono" }, resource.resourceId),
              resource.providerKey ? h("span", { className: "hao-muted" }, resource.providerKey) : null
            ),
            h("td", null, h("span", { className: "hao-plan-chip" }, tierLabel(resource.resourceTier, t))),
            h("td", { className: "hao-mono" }, integer(resource.resourceSequence, props.locale)),
            h("td", null,
              h(Badge, { value: resource.state }),
              resource.suspendedUntil ? h("small", { className: "hao-resource-until" }, t.until + " " + dateTime(resource.suspendedUntil, props.locale)) : null
            ),
            h("td", null, transportLabel(resource.transport, t)),
            h("td", null, h(BindingList, { bindings: resource.modelBindings })),
            h("td", null, h(Failure, { failure: resource.lastNormalizedFailure, locale: props.locale })),
            h("td", null, h(ResourceActions, { resource: resource, pending: props.pendingResourceIds && props.pendingResourceIds[resource.resourceId], onState: props.onState, t: t }))
          );
        }))
      )
    ) : h("div", { className: "hao-empty" }, t.noResources)
  );
}

