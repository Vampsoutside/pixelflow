import { el, formatTime, toast } from '../ui.js';
import { api } from '../api.js';

const ICONS = {
  session: '🍅', task: '✅', tag: '🏷️', plan: '📅',
  study: '📘', friend: '👥', account: '🔐', timer: '⏱️', xp: '⭐',
};
const LABELS = {
  session: 'Sessions', task: 'Tasks', tag: 'Tags', plan: 'Plan',
  study: 'Study log', friend: 'Friends', account: 'Account', timer: 'Timer', xp: 'XP',
};

let host = null;
let panel = null;
let filter = 'all';
let cursor = null;
let entries = [];
let counts = {};
let loaded = false;

export const logsSection = {
  async mount(container, ctx = {}) {
    host = container;
    panel = ctx.panel || null;
    entries = [];
    cursor = null;
    filter = 'all';
    await load({ reset: true });
  },
  sidePanel: logsSidePanel,
};

async function load({ reset = false } = {}) {
  if (!host) return;
  if (reset) {
    entries = [];
    cursor = null;
    host.innerHTML = '';
    host.append(el('div', { class: 'pane' }, [el('div', { class: 'empty', text: 'Loading your history…' })]));
  }

  const params = new URLSearchParams({ limit: '60' });
  if (cursor) params.set('before', String(cursor));
  if (filter !== 'all') params.set('kind', filter);

  let data;
  try {
    data = await api.get(`/api/logs?${params}`);
  } catch (err) {
    if (reset) {
      host.innerHTML = '';
      host.append(el('div', { class: 'pane' }, [el('div', { class: 'empty', text: err.message || 'Could not load your logs.' })]));
    }
    return;
  }

  if (reset) host.innerHTML = '';
  entries = [...entries, ...data.entries];
  loaded = true;
  cursor = data.entries.at(-1)?.id ?? null;
  counts = data.counts;
  render(data.hasMore);
  if (panel) logsSidePanel(panel);
}

function render(hasMore) {
  if (entries.length === 0) {
    host.innerHTML = '';
    // Before the first fetch settles we show the loading pane instead of
    // claiming there is nothing logged.
    if (!loaded) {
      host.append(el('div', { class: 'pane' }, [el('div', { class: 'empty', text: 'Loading your history…' })]));
      return;
    }
    host.append(el('div', { class: 'pane' }, [
      el('div', { class: 'empty', text: filter === 'all' ? 'Nothing logged yet. Start a timer session or edit your study plan.' : `No ${LABELS[filter]?.toLowerCase() || filter} entries yet.` }),
    ]));
    return;
  }

  // Group by calendar day so the feed reads like a journal.
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.createdAt.slice(0, 10);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  host.innerHTML = '';
  for (const [day, list] of groups) {
    host.append(el('div', { class: 'pane' }, [
      el('div', { class: 'pane-hd' }, [
        el('div', { class: 'pane-title', text: dayLabel(day) }),
        el('div', { class: 'pane-sub', text: `${list.length} ${list.length === 1 ? 'entry' : 'entries'}` }),
      ]),
      list.map(logRow),
    ]));
  }

  if (hasMore) {
    host.append(el('button', {
      class: 'btn block', text: 'Load older entries', style: { marginBottom: '14px' },
      onclick: () => load(),
    }));
  }
}

function logRow(entry) {
  return el('div', { class: 'log-entry' }, [
    el('div', { class: `log-icon ${entry.kind}`, text: ICONS[entry.kind] || '•' }),
    el('div', { class: 'log-main' }, [
      el('div', { class: 'log-msg', text: entry.message }),
      el('div', { class: 'log-time', text: formatTime(entry.createdAt) }),
    ]),
    el('button', {
      class: 'task-x', text: '×', style: { opacity: '1' }, 'aria-label': 'Delete this entry',
      onclick: async () => {
        try {
          await api.del(`/api/logs/${entry.id}`);
          entries = entries.filter((e) => e.id !== entry.id);
          render(true);
          toast('Entry deleted');
        } catch (err) {
          toast(err.message || 'Could not delete that entry', 3000);
        }
      },
    }),
  ]);
}

function dayLabel(key) {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (key === today) return 'TODAY';
  if (key === yesterday) return 'YESTERDAY';
  const date = new Date(`${key}T00:00:00`);
  return date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();
}

export function logsSidePanel(body) {
  panel = body;
  body.innerHTML = '';
  body.append(el('div', { class: 'sect-hd', text: 'FILTER' }));
  body.append(el('div', { class: 'opt-row' }, [
    el('button', {
      class: `opt-btn${filter === 'all' ? ' active' : ''}`,
      text: 'All',
      onclick: () => { filter = 'all'; load({ reset: true }); },
    }),
    ...Object.keys(LABELS).map((kind) => el('button', {
      class: `opt-btn${filter === kind ? ' active' : ''}`,
      text: `${ICONS[kind]} ${LABELS[kind]}${counts[kind] ? ` (${counts[kind]})` : ''}`,
      onclick: () => { filter = kind; load({ reset: true }); },
    })),
  ]));

  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  body.append(el('div', { class: 'sect-hd', text: 'SUMMARY' }));
  body.append(el('div', { class: 'kpi' }, Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => el('div', { class: 'kpi-row' }, [
      el('div', {}, [
        el('div', { class: 'kpi-label', text: `${ICONS[kind] || '•'} ${LABELS[kind] || kind}` }),
      ]),
      el('div', { class: 'kpi-value', text: String(n) }),
    ]))));

  body.append(el('div', { class: 'pane-sub', style: { marginTop: '12px' }, text: `${total} entries recorded in total.` }));
}
