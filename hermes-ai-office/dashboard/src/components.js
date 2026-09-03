import { h } from './runtime.js';
import { compact, dateTime, duration, money, routeLabel, runningElapsed, selectedAgent, selectedModel, selectedResource } from './format.js';

function measuredTokens(item, locale, suffix) {
  const usage = item && item.usage;
  const selection = item && item.resourceSelection;
  if (!usage || Number(usage.calls || 0) <= 0 || (selection && selection.transport === 'PROVIDER_NATIVE' && Number(item.totalTokens || 0) <= 0)) return '—';
  return compact(item.totalTokens || 0, locale) + (suffix || '');
}

export function Badge(props) {
  const value = String(props.value || 'UNKNOWN').toUpperCase();
  return h(
    'span',
    { className: 'hao-badge hao-badge-' + value.toLowerCase().replace(/_/g, '-') },
    value,
  );
}
export function Metric(props) {
  return h(
    'article',
    { className: 'hao-metric' + (props.primary ? ' hao-metric-primary' : '') },
    h('span', { className: 'hao-metric-label' }, props.label),
    h('strong', { className: 'hao-metric-value' }, props.value),
    props.hint ? h('span', { className: 'hao-metric-hint' }, props.hint) : null,
  );
}
export function Panel(props) {
  return h(
    'section',
    { className: 'hao-panel ' + (props.className || '') },
    props.title
      ? h(
          'header',
          { className: 'hao-panel-head' },
          h(
            'div',
            null,
            h('h2', null, props.title),
            props.subtitle ? h('p', null, props.subtitle) : null,
          ),
          props.action || null,
        )
      : null,
    props.children,
  );
}

export function ExecutionTable(props) {
  const rows = props.rows || [];
  const t = props.t;
  const locale = props.locale;
  const now = props.now;
  return h(
    'div',
    { className: 'hao-table-wrap' },
    h(
      'table',
      { className: 'hao-table' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', null, t.project),
          h('th', null, t.task),
          h('th', null, t.phase),
          h('th', null, t.status),
          h('th', null, t.selectedModel),
          h('th', null, t.agent),
          h('th', null, t.selectedResource),
          h('th', null, t.route),
          h('th', null, t.started),
          h('th', null, t.elapsed),
          h('th', { className: 'hao-right' }, 'Token'),
          h('th', { className: 'hao-right' }, t.cost),
        ),
      ),
      h(
        'tbody',
        null,
        rows.map(function (item) {
          return h(
            'tr',
            { key: item.executionId, title: item.executionId },
            h('td', null, h('span', { className: 'hao-project' }, item.projectKey)),
            h('td', null, h('div', { className: 'hao-objective' }, item.objective)),
            h('td', null, h('span', { className: 'hao-phase' }, item.phase)),
            h('td', null, h(Badge, { value: item.status })),
            h('td', null, h('span', { className: 'hao-mono' }, selectedModel(item))),
            h('td', null, h('span', { className: 'hao-mono' }, selectedAgent(item))),
            h('td', null, h('span', { className: 'hao-mono' }, selectedResource(item))),
            h('td', null, h('span', { className: 'hao-route' }, routeLabel(item))),
            h('td', { className: 'hao-muted' }, dateTime(item.startedAt, locale)),
            h('td', { className: 'hao-mono' }, duration(runningElapsed(item, now))),
            h('td', { className: 'hao-right hao-mono' }, measuredTokens(item, locale, '')),
            h('td', { className: 'hao-right hao-mono' }, money(item.usage && item.usage.costUsd)),
          );
        }),
      ),
    ),
  );
}

export function RunningCards(props) {
  const rows = props.rows || [];
  if (!rows.length) return h('div', { className: 'hao-empty' }, props.t.noRunning);
  return h(
    'div',
    { className: 'hao-running-grid' },
    rows.map(function (item) {
      return h(
        'article',
        { className: 'hao-running-card', key: item.executionId },
        h(
          'div',
          { className: 'hao-running-top' },
          h(Badge, { value: item.status }),
          h('span', { className: 'hao-phase' }, item.phase),
        ),
        h('h3', null, item.objective || item.projectKey),
        h('div', { className: 'hao-running-project' }, item.projectKey),
        h(
          'div',
          { className: 'hao-running-route' },
          selectedModel(item),
          h('span', null, ' · '),
          selectedAgent(item),
          h('span', null, ' · '),
          selectedResource(item),
        ),
        h('div', { className: 'hao-running-physical' }, props.t.route + ': ' + routeLabel(item)),
        h(
          'div',
          { className: 'hao-running-foot' },
          h('span', null, props.t.started + ' ' + dateTime(item.startedAt, props.locale)),
          h('strong', null, duration(runningElapsed(item, props.now))),
        ),
        h(
          'div',
          { className: 'hao-running-usage' },
          h('span', null, measuredTokens(item, props.locale, ' tok')),
          h('span', null, money(item.usage && item.usage.costUsd)),
        ),
      );
    }),
  );
}
