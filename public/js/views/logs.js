import { el, minutesShort, formatTime, formatRelative, toast } from '../ui.js';
import { api } from '../api.js';
import { invalidateStudy } from '../store.js';

/**
 * Logs, in two filters and no more.
 *
 * STUDYLOG is the study ledger: every change to a day's total, whether typed in
 * or produced by a finished pomodoro. LOG is the task archive — a task that was
 * ticked complete leaves the Tasks window and lands here, where Restore undoes
 * it. Nothing else is logged, because a feed of "created tag" and "signed in"
 * rows is noise next to the two things somebody actually looks up.
 */

const FILTERS = {
  studylog: { label: 'STUDYLOG', hint: 'Every change to your study time, newest first.' },
  log: { label: 'LOG', hint: 'Tasks you completed. Restore one to put it back on the board.' },
};

let host = null;
let panel = null;
let filter = 'studylog';

let entries = [];
let cursor = null;
let hasMore = false;
let loaded = false;

let tasks = [];
let tagsById = new Map();

export const logsSection = {
  async mount(container, ctx = {}) {
    host = container;
    panel = ctx.panel || null;
    entries = [];
    cursor = null;
    loaded = false;
    await load({ reset: true });
  },
  reload: () => load({ reset: true }),
  sidePanel: logsSidePanel,
};

async function load({ reset = false } = {}) {
  if (!host) return;
  if (reset) {
    entries = [];
    cursor = null;
    loaded = false;
    show('Loading your history…');
  }

  try {
    if (filter === 'studylog') {
      const params = new URLSearchParams({ limit: '60' });
      if (cursor) params.set('before', String(cursor));
      const data = await api.get(`/api/study/logs?${params}`);
      entries = [...entries, ...data.entries];
      cursor = data.entries.at(-1)?.id ?? null;
      hasMore = data.hasMore;
    } else {
      const data = await api.get('/api/tasks');
      tasks = data.tasks;
      tagsById = new Map(data.tags.map((t) => [t.id, t]));
      hasMore = false;
    }
  } catch (err) {
    loaded = true;
    show(err.message || 'Could not load your logs.');
    return;
  }

  loaded = true;
  render();
  if (panel) logsSidePanel(panel);
}

function show(message) {
  host.innerHTML = '';
  host.append(el('div', { class: 'pane' }, [el('div', { class: 'empty', text: message })]));
}

// ── render ───────────────────────────────────────────────────────────────

function render() {
  // One feed for study entries, one for the task archive; whichever is active
  // decides both the empty state and what gets appended below.
  const study = filter === 'studylog';
  const emptyText = study
    ? 'Nothing logged yet. Type hours into the Calendar, or finish a pomodoro and let it add itself.'
    : 'No completed tasks yet. Tick something off in Tasks and it will appear here.';

  host.innerHTML = '';
  host.append(el('div', { class: 'pane' }, [
    el('div', { class: 'pane-hd' }, [
      el('div', { class: 'pane-title', text: 'LOGS' }),
      el('div', { class: 'pane-sub', text: FILTERS[filter].hint }),
    ]),
    filterRow(),
    (study ? entries.length === 0 : tasks.every((t) => !t.done))
      ? el('div', { class: 'empty', text: emptyText })
      : null,
  ]));

  if (study) {
    renderStudyGroups();
    if (hasMore) {
      host.append(el('button', {
        class: 'btn block',
        text: 'Load older entries',
        style: { marginBottom: '14px' },
        onclick: () => load(),
      }));
    }
    return;
  }
  renderTaskList();
}

/** The two filters sit in the main pane, not the side panel. */
function filterRow() {
  return el('div', { class: 'chart-toggle logs-filters' }, Object.entries(FILTERS).map(([key, meta]) => el('button', {
    class: filter === key ? 'active' : '',
    text: meta.label,
    'aria-pressed': String(filter === key),
    onclick: async () => {
      if (filter === key) return;
      filter = key;
      await load({ reset: true });
    },
  })));
}

function renderStudyGroups() {
  // Group by the study day an entry belongs to, not by when it was typed, so a
  // correction filed this afternoon still sits under the day it corrects.
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.date)) groups.set(entry.date, []);
    groups.get(entry.date).push(entry);
  }

  for (const [day, list] of groups) {
    const total = list.reduce((sum, e) => sum + e.minutes, 0);
    host.append(el('div', { class: 'pane' }, [
      el('div', { class: 'pane-hd' }, [
        el('div', { class: 'pane-title', text: dayLabel(day) }),
        el('div', { class: 'pane-sub', text: `${minutesShort(total)} across ${list.length} ${list.length === 1 ? 'entry' : 'entries'}` }),
      ]),
      el('div', { class: 'log-list' }, list.map(studyRow)),
    ]));
  }
}

/** One ledger row. Pomodoro and manual are coloured apart so the source reads. */
function studyRow(entry) {
  const timer = entry.source === 'timer';
  const amount = entry.minutes;

  const row = el('div', { class: `log-entry study ${entry.source}` }, [
    el('div', { class: `log-icon ${entry.source}`, text: timer ? '🍅' : '✎' }),
    el('div', { class: 'log-main' }, [
      el('div', { class: 'log-msg' }, [
        el('b', {
          class: amount < 0 ? 'neg' : '',
          text: amount < 0 ? `−${minutesShort(-amount)}` : `+${minutesShort(amount)}`,
        }),
        document.createTextNode(timer ? ' from a pomodoro' : ' entered by hand'),
      ]),
      el('div', { class: 'log-time' }, [
        entry.tag
          ? el('span', { class: 'log-tag' }, [
            el('i', { class: 'dot', style: { background: entry.tag.color } }),
            document.createTextNode(entry.tag.name),
          ])
          : null,
        document.createTextNode(formatTime(entry.createdAt)),
      ]),
    ]),
    el('button', {
      class: 'task-x',
      text: '×',
      style: { opacity: '1' },
      'aria-label': 'Delete this entry',
      title: 'Delete this entry and take its minutes off the day',
      onclick: async () => {
        try {
          // Removing a ledger row also reverses it on the day total, so the
          // calendar cannot keep hours this feed no longer shows.
          await api.del(`/api/study/logs/${entry.id}`);
          entries = entries.filter((e) => e.id !== entry.id);
          invalidateStudy();
          render();
          if (panel) logsSidePanel(panel);
          window.dispatchEvent(new CustomEvent('pixelflow:stats'));
          toast('Entry deleted and the day adjusted');
        } catch (err) {
          toast(err.message || 'Could not delete that entry', 3000);
        }
      },
    }),
  ]);
  return row;
}

function renderTaskList() {
  const done = tasks
    .filter((t) => t.done)
    .sort((a, b) => String(b.doneAt || '').localeCompare(String(a.doneAt || '')));

  if (done.length === 0) return;

  host.append(el('div', { class: 'pane' }, [
    el('div', { class: 'log-list' }, done.map(taskRow)),
  ]));
}

function taskRow(task) {
  return el('div', { class: 'log-entry task' }, [
    el('div', { class: 'log-icon task', text: '✅' }),
    el('div', { class: 'log-main' }, [
      el('div', { class: 'log-msg', text: task.text }),
      el('div', { class: 'log-time' }, [
        task.tags.length
          ? el('span', { class: 'log-tag' }, [
            el('i', { class: 'dot', style: { background: task.tags[0].color } }),
            document.createTextNode(task.tags.map((t) => t.name).join(', ')),
          ])
          : null,
        // A task completed before done_at existed still needs a readable time,
        // so fall back to when it was created rather than printing nothing.
        document.createTextNode(task.doneAt ? `done ${formatRelative(task.doneAt)}` : 'done'),
      ]),
    ]),
    el('button', {
      class: 'btn small',
      text: 'Restore',
      title: 'Put this task back on the board',
      onclick: async () => {
        try {
          await api.put(`/api/tasks/${task.id}`, { done: false });
          toast(`“${task.text}” is back on the board`);
          await load({ reset: true });
        } catch (err) {
          toast(err.message || 'Could not restore that task', 3000);
        }
      },
    }),
  ]);
}

function dayLabel(key) {
  const today = new Date();
  const local = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const yesterday = new Date(local);
  yesterday.setDate(local.getDate() - 1);
  const same = (a, b) => a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  if (same(new Date(`${key}T00:00:00`), local)) return 'TODAY';
  if (same(new Date(`${key}T00:00:00`), yesterday)) return 'YESTERDAY';
  return new Date(`${key}T00:00:00`)
    .toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
    .toUpperCase();
}

// ── right panel: totals ──────────────────────────────────────────────────

export function logsSidePanel(body) {
  panel = body;
  body.innerHTML = '';
  if (!loaded) return;

  if (filter === 'studylog') {
    const timerMinutes = entries.filter((e) => e.source === 'timer').reduce((s, e) => s + e.minutes, 0);
    const manualMinutes = entries.filter((e) => e.source === 'manual').reduce((s, e) => s + e.minutes, 0);
    const total = timerMinutes + manualMinutes;

    body.append(el('div', { class: 'sect-hd', text: 'WHAT IS LOADED' }));
    body.append(el('div', { class: 'kpi' }, [
      row('Shown here', `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`),
      row('Pomodoro', minutesShort(timerMinutes)),
      row('Entered by hand', minutesShort(manualMinutes)),
      row('Net change', minutesShort(total), total < 0 ? 'neg' : ''),
    ]));
    body.append(el('div', { class: 'pane-sub', style: { marginTop: '12px' }, text: 'Deleting an entry takes its minutes back off that day.' }));
    return;
  }

  const done = tasks.filter((t) => t.done).length;
  body.append(el('div', { class: 'sect-hd', text: 'TASK ARCHIVE' }));
  body.append(el('div', { class: 'kpi' }, [
    row('Completed', String(done)),
    row('Still on the board', String(tasks.length - done)),
  ]));
  body.append(el('div', { class: 'pane-sub', style: { marginTop: '12px' }, text: 'Ticking a task moves it here. Nothing is deleted, so a mis-click is one button away from undone.' }));
}

function row(label, value, cls = '') {
  return el('div', { class: 'kpi-row' }, [
    el('div', {}, [el('div', { class: 'kpi-label', text: label })]),
    el('div', { class: `kpi-value${cls ? ` ${cls}` : ''}`, text: value }),
  ]);
}