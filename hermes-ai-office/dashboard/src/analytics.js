import { React, h } from "./runtime.js";
import { compact, duration, integer, money, percentage } from "./format.js";
import { Panel } from "./components.js";

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
          h("td", null, h("strong", { className: "hao-analytics-key" }, row.key)),
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

export function Analytics(props) {
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
