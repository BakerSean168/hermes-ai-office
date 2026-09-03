import { React, h } from './runtime.js';
import { compact, duration, integer, money, percentage } from './format.js';
import { Panel } from './components.js';

function providerCopy(locale) {
  return locale === 'zh'
    ? {
        providerModelGroup: '按渠道 × 物理模型',
        callSuccess: '调用成功率',
        promptCacheRate: 'Prompt 缓存率',
        costPerMillionTokens: '每百万 Token 成本',
        avgLatency: '成功调用平均延迟',
        note: '渠道对比基于 LiteLLM 实测调用：调用成功率 = 成功模型调用 / 已测调用；Prompt 缓存率 = cached input / input token；每百万 Token 成本使用 LiteLLM 实测花费，只有在模型组合相近时才适合直接比较。',
      }
    : {
        providerModelGroup: 'Provider × physical model',
        callSuccess: 'Call success',
        promptCacheRate: 'Prompt cache',
        costPerMillionTokens: 'Cost / 1M tok',
        avgLatency: 'Avg success latency',
        note: 'Provider comparison uses LiteLLM-observed calls: call success = successful model calls / measured calls; prompt cache = cached input / input tokens; cost / 1M tok is observed LiteLLM spend and should be compared within the same model mix.',
      };
}

function AnalyticsTable(props) {
  const providerMode = props.group === 'providers' || props.group === 'providerModels';
  const providerLabels = providerCopy(props.locale);
  const headers = providerMode
    ? [
        props.title,
        props.t.executions,
        providerLabels.callSuccess,
        providerLabels.promptCacheRate,
        'Token',
        providerLabels.costPerMillionTokens,
        providerLabels.avgLatency,
        props.t.calls,
        props.t.cost,
      ]
    : [
        props.title,
        props.t.executions,
        props.t.success,
        'Token',
        props.t.calls,
        props.t.duration,
        props.t.cost,
      ];
  return h(
    'div',
    { className: 'hao-table-wrap' },
    h(
      'table',
      { className: 'hao-table hao-analytics-table' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          headers.map(function (label, index) {
            return h('th', { className: index ? 'hao-right' : '', key: label }, label);
          }),
        ),
      ),
      h(
        'tbody',
        null,
        (props.rows || []).map(function (row) {
          const common = [
            h('td', { key: 'key' }, h('strong', { className: 'hao-analytics-key' }, row.key)),
            h(
              'td',
              { className: 'hao-right hao-mono', key: 'executions' },
              integer(row.executions, props.locale),
            ),
          ];
          const metrics = providerMode
            ? [
                h(
                  'td',
                  { className: 'hao-right hao-mono', key: 'call-success' },
                  percentage(row.callSuccessRate),
                ),
                h(
                  'td',
                  { className: 'hao-right hao-mono', key: 'cache-rate' },
                  percentage(row.promptCacheRate),
                ),
                h(
                  'td',
                  { className: 'hao-right hao-mono', key: 'tokens' },
                  row.totalTokens == null ? '—' : compact(row.totalTokens, props.locale),
                ),
                h(
                  'td',
                  { className: 'hao-right hao-mono', key: 'unit-cost' },
                  row.costPerMillionTokens == null ? '—' : money(row.costPerMillionTokens),
                ),
                h(
                  'td',
                  { className: 'hao-right hao-mono', key: 'latency' },
                  row.avgSuccessfulLatencyMs == null ? '—' : duration(row.avgSuccessfulLatencyMs),
                ),
                h(
                  'td',
                  { className: 'hao-right hao-mono', key: 'calls' },
                  compact(row.calls, props.locale),
                ),
                h('td', { className: 'hao-right hao-mono', key: 'cost' }, row.costUsd == null ? '—' : money(row.costUsd)),
              ]
            : [
                h(
                  'td',
                  { className: 'hao-right hao-mono', key: 'success' },
                  percentage(row.successRate),
                ),
                h(
                  'td',
                  { className: 'hao-right hao-mono', key: 'tokens' },
                  row.totalTokens == null ? '—' : compact(row.totalTokens, props.locale),
                ),
                h(
                  'td',
                  { className: 'hao-right hao-mono', key: 'calls' },
                  row.calls == null ? '—' : compact(row.calls, props.locale),
                ),
                h(
                  'td',
                  { className: 'hao-right hao-mono', key: 'duration' },
                  row.durationMs ? duration(row.durationMs) : '—',
                ),
                h('td', { className: 'hao-right hao-mono', key: 'cost' }, row.costUsd == null ? '—' : money(row.costUsd)),
              ];
          return h('tr', { key: row.key }, common.concat(metrics));
        }),
      ),
    ),
  );
}

export function Analytics(props) {
  const t = props.t;
  const providerLabels = providerCopy(props.locale);
  const analytics = props.data.analytics || {};
  const groups = [
    ['providers', t.groupProvider],
    ['providerModels', providerLabels.providerModelGroup],
    ['logicalModels', t.groupLogical],
    ['physicalModels', t.groupPhysical],
    ['projects', t.groupProject],
    ['phases', t.groupPhase],
    ['selectedModels', t.selectedModels],
    ['agents', t.agents],
    ['resources', t.selectedResources],
  ];
  const [group, setGroup] = React.useState('providers');
  const selected =
    groups.find(function (item) {
      return item[0] === group;
    }) || groups[0];
  const selectionMode = ['selectedModels', 'agents', 'resources'].includes(selected[0]);
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'hao-segmented' },
      groups.map(function (item) {
        return h(
          'button',
          {
            type: 'button',
            className: item[0] === group ? 'is-active' : '',
            key: item[0],
            onClick: function () {
              setGroup(item[0]);
            },
          },
          item[1],
        );
      }),
    ),
    h(
      Panel,
      { title: selected[1] },
      h(AnalyticsTable, {
        rows: analytics[selected[0]] || [],
        title: selected[1],
        group: selected[0],
        t: t,
        locale: props.locale,
      }),
      selected[0] === 'providers' || selected[0] === 'providerModels'
        ? h('p', { className: 'hao-muted' }, providerLabels.note)
        : selectionMode
          ? h('p', { className: 'hao-muted' }, props.locale === 'zh'
            ? '这些统计来自执行时的静态选择；物理 LiteLLM 渠道遥测仍在渠道视图中单独统计。Provider 原生资源没有可用 Token 时显示为 —。'
            : 'These aggregates come from static execution selection; physical LiteLLM telemetry remains separate in provider views. Provider-native resources show — when token data is unavailable.')
          : null,
    ),
    h(
      'section',
      { className: 'hao-analytics-notes' },
      h(
        'article',
        null,
        h('span', null, t.input),
        h('strong', null, compact((props.data.summary || {}).input, props.locale)),
      ),
      h(
        'article',
        null,
        h('span', null, t.output),
        h('strong', null, compact((props.data.summary || {}).output, props.locale)),
      ),
      h(
        'article',
        null,
        h('span', null, t.cache),
        h('strong', null, compact((props.data.summary || {}).cachedInput, props.locale)),
      ),
      h(
        'article',
        null,
        h('span', null, t.reasoning),
        h('strong', null, compact((props.data.summary || {}).reasoningOutput, props.locale)),
      ),
    ),
  );
}
