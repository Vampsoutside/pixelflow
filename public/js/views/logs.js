import { el, minutesShort, formatTime, formatRelative, toast } from '../ui.js';
import { api } from '../api.js';
import { invalidateStudy } from '../store.js';

/**
 * Logs, as one feed.
 *
 * STUDYLOG and LOG used to be two filters over the same pane, so every visit
 * began by choosing a lens and then half the history was invisible. There was
 * no reason for the split: both are dated, both are append-only until you act
 * on them, and each row carries its own icon and wording. So both streams are
 * merged into a single chronological feed, newest first, with a filter that
 * narrows the feed rather than replacing it. Nothing is logged beyond these
 * two, because a feed of "created tag" and "signed in" rows is noise next to
 * the things somebody actually looks up.
 */

const FILTERS = {
  all: { label: 'ALL', hint: 'Every change to your study time and every task you finished, newest first.' },
  study: { label: 'STUDY', hint: 'Every change to your study time, newest first.' },
  tasks: { label: 'TASKS', hint: 'Tasks you completed. Restore one to put it back on the board.' },
};

let host = null;
let panel = null;
/** Which streams are shown. 'all' shows both; the rest narrow the same feed. */
let filter = 'all';

let entries = [];
let cursor = null;
let hasMore = false;
let loaded = false;

let tasks = [];

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

  // Both streams are needed by every filter now, so they load together rather
  // than one filter at a time.
  try {
    const params = new URLSearchParams({ limit: '60' });
    if (cursor) params.set('before', String(cursor));
    const [study, taskData] = await Promise.all([
      api.get(`/api/study/logs?${params}`),
      api.get('/api/tasks'),
    ]);
    entries = [...entries, ...study.entries];
    cursor = study.entries.at(-1)?.id ?? null;
    hasMore = study.hasMore;
    tasks = taskData.tasks;
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
  const { study, tasks: taskRows } = merged();
  const empty = study.length === 0 && taskRows.length === 0;

  host.innerHTML = '';
  host.append(el('div', { class: 'pane' }, [
    el('div', { class: 'pane-hd' }, [
      el('div', { class: 'pane-title', text: 'LOGS' }),
      el('div', { class: 'pane-sub', text: FILTERS[filter].hint }),
    ]),
    filterRow(),
    empty
      ? el('div', {
        class: 'empty',
        text: filter === 'tasks'
          ? 'No completed tasks yet. Tick something off in Tasks and it will appear here.'
          : filter === 'study'
            ? 'Nothing logged yet. Type hours into the Calendar, or finish a pomodoro and let it add itself.'
            : 'Nothing logged yet. Type hours into the Calendar, finish a pomodoro, or tick off a task.',
      })
      : null,
  ]));

  for (const row of study) host.append(studyRow(row));
  for (const row of taskRows) host.append(taskRow(row));
  if (hasMore && filter !== 'tasks') {
    host.append(el('button', {
      class: 'btn block',
      text: 'Load older entries',
      style: { marginBottom: '14px' },
      onclick: () => load(),
    }));
  }
}

/**
 * The two streams as one list, newest first.
 *
 * Study rows carry a createdAt timestamp; a task only carries the moment it
 * was ticked done, so that is used for both. They are merged on a single
 * comparable timestamp rather than being concatenated, because "newest first"
 * has to mean the same thing across the whole feed.
 */
function merged() {
  const wantStudy = filter === 'all' || filter === 'study';
  const wantTasks = filter === 'all' || filter === 'tasks';

  const study = wantStudy
    ? entries.map((entry) => ({ kind: 'study', at: entry.createdAt, entry }))
    : [];
  const taskRows = wantTasks
    ? tasks
      .filter((t) => t.done)
      .map((task) => ({ kind: 'task', at: task.doneAt || task.createdAt || '', task }))
    : [];

  const byTime = (a, b) => String(b.at).localeCompare(String(a.at));
  return { study: study.sort(byTime), tasks: taskRows.sort(byTime) };
}

/** Narrows the feed. The streams are already loaded, so this never refetches. */
function filterRow() {
  return el('div', { class: 'chart-toggle logs-filters' }, Object.entries(FILTERS).map(([key, meta]) => el('button', {
    class: filter === key ? 'active' : '',
    text: meta.label,
    'aria-pressed': String(filter === key),
    onclick: () => {
      if (filter === key) return;
      filter = key;
      render();
      if (panel) logsSidePanel(panel);
    },
  })));
}

/** One ledger row. Pomodoro and manual are coloured apart so the source reads. */
function studyRow({ entry }) {
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
        // The day this belongs to, then the moment it was filed: a correction
        // made today for yesterday should read as such.
        el('span', { class: 'log-tag', text: dayLabel(entry.date) }),
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

function taskRow({ task }) {
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

  // Both streams, whatever the filter is showing, so the totals describe the
  // feed rather than one tab of it.
  const timerMinutes = entries.filter((e) => e.source === 'timer').reduce((s, e) => s + e.minutes, 0);
  const manualMinutes = entries.filter((e) => e.source === 'manual').reduce((s, e) => s + e.minutes, 0);
  const total = timerMinutes + manualMinutes;
  const done = tasks.filter((t) => t.done).length;
  const shownStudy = filter === 'tasks' ? 0 : entries.length;
  const shownTasks = filter === 'study' ? 0 : done;

  body.append(el('div', { class: 'sect-hd', text: 'WHAT IS LOADED' }));
  body.append(el('div', { class: 'kpi' }, [
    row('Shown here', `${shownStudy + shownTasks} ${shownStudy + shownTasks === 1 ? 'entry' : 'entries'}`),
    row('Study entries', String(shownStudy)),
    row('Pomodoro', minutesShort(timerMinutes)),
    row('Entered by hand', minutesShort(manualMinutes)),
    row('Net study change', minutesShort(total), total < 0 ? 'neg' : ''),
    row('Completed tasks', String(shownTasks)),
    row('Still on the board', String(tasks.length - done)),
  ]));
  body.append(el('div', { class: 'pane-sub', style: { marginTop: '12px' }, text: 'Deleting a study entry takes its minutes back off that day. Restoring a task puts it back on the board — nothing here is a hard delete.' }));
}

function row(label, value, cls = '') {
  return el('div', { class: 'kpi-row' }, [
    el('div', {}, [el('div', { class: 'kpi-label', text: label })]),
    el('div', { class: `kpi-value${cls ? ` ${cls}` : ''}`, text: value }),
  ]);
}