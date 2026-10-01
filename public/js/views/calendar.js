import { el, minutes, minutesShort, dayKey, parseDay, toast } from '../ui.js';
import { store, fetchOverview, invalidateStudy } from '../store.js';
import { api } from '../api.js';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

let host = null;
let panel = null;
let state = null;
let overview = null;
let entries = {};
let tags = [];
// date -> items, so the grid and the side panel read the same set.
let itemsByDate = new Map();

export const calendarSection = {
  async mount(container, ctx = {}) {
    host = container;
    panel = ctx.panel || null;
    const today = new Date();
    state = {
      // A 0-based month index, matching Date#getMonth and the nav arrows.
      month: today.getMonth(),
      year: today.getFullYear(),
      selected: dayKey(today),
    };
    await load();
  },
  sidePanel: calendarSidePanel,
};

async function load() {
  const prefix = `${state.year}-${String(state.month + 1).padStart(2, '0')}`;
  // Two independent reads: study minutes drive the totals, items only decorate
  // the cells. Keeping them separate is what stops an item from ever moving a
  // number — nothing here writes to /api/study.
  const [study, items, tagData] = await Promise.all([
    fetchOverview({ month: prefix, mode: 'daily' }),
    api.get(`/api/events?month=${prefix}`).catch(() => ({ events: [] })),
    api.get('/api/tags').catch(() => ({ tags: [] })),
  ]);
  overview = study;
  tags = tagData.tags;
  itemsByDate = new Map();
  for (const item of items.events) {
    if (!itemsByDate.has(item.date)) itemsByDate.set(item.date, []);
    itemsByDate.get(item.date).push(item);
  }

  // The month grid only has its own days; reuse the weekly plan for targets.
  const planByWeekday = new Map();
  for (const day of overview.week.byDay) planByWeekday.set(day.weekday, day);

  const studiedByDate = new Map();
  for (const point of overview.chart.points) studiedByDate.set(point.key, point.value);
  for (const day of overview.week.byDay) studiedByDate.set(day.date, day.studied);
  entries = studiedByDate;

  render(planByWeekday);
  if (panel) calendarSidePanel(panel);
}

function render(planByWeekday) {
  const first = new Date(state.year, state.month, 1);
  const daysInMonth = new Date(state.year, state.month + 1, 0).getDate();
  const leading = first.getDay();
  const todayKey = dayKey();

  const cells = [];
  for (let i = 0; i < leading; i += 1) {
    cells.push(el('div', { class: 'cal-day other' }));
  }

  for (let d = 1; d <= daysInMonth; d += 1) {
    const date = new Date(state.year, state.month, d);
    const key = dayKey(date);
    const studied = entries.get(key) || 0;
    const plan = planByWeekday.get(date.getDay());
    const planned = plan?.active ? plan.planned : 0;
    const items = itemsByDate.get(key) || [];

    let miniClass = '';
    if (studied > 0 && planned > 0) miniClass = studied > planned ? 'over' : (studied >= planned ? 'met' : '');
    else if (studied > 0) miniClass = '';
    else if (planned > 0) miniClass = 'rest';

    const markers = items.length ? el('div', { class: 'cal-day-items' },
      items.slice(0, 4).map((item) => el('i', {
        class: `cal-item ${item.kind}${item.done ? ' done' : ''}`,
        style: item.tag ? { background: item.tag.color, borderColor: item.tag.color } : {},
        title: `${item.kind === 'deadline' ? 'Deadline' : item.time ? `${item.time} ` : 'Event'}: ${item.title}`,
      }))) : null;

    const itemHint = items.length
      ? ` · ${items.length} ${items.length === 1 ? 'item' : 'items'}`
      : '';

    cells.push(el('div', {
      class: `cal-day${key === todayKey ? ' today' : ''}${key === state.selected ? ' selected' : ''}${items.length ? ' has-items' : ''}`,
      role: 'button',
      tabindex: '0',
      title: `${key} — ${minutes(studied)} studied${planned ? ` of ${minutes(planned)} planned` : ''}${itemHint}`,
      onclick: () => { state.selected = key; render(planByWeekday); if (panel) calendarSidePanel(panel); },
      onkeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          state.selected = key;
          render(planByWeekday);
          if (panel) calendarSidePanel(panel);
        }
      },
    }, [
      document.createTextNode(String(d)),
      el('div', {
        class: `cal-day-mini ${miniClass}`,
        text: studied > 0 ? minutesShort(studied) : (planned > 0 ? 'plan' : ''),
      }),
      markers,
    ]));
  }

  const shift = async (delta) => {
    let m = state.month + delta;
    if (m < 0) { m = 11; state.year -= 1; }
    if (m > 11) { m = 0; state.year += 1; }
    state.month = m;
    state.selected = dayKey(new Date(state.year, m, Math.min(28, new Date().getDate())));
    await load();
  };

  host.innerHTML = '';
  host.append(el('div', { class: 'pane' }, [
    el('div', { class: 'cal-header' }, [
      el('div', { class: 'cal-month-lbl', text: `${MONTHS[state.month]} ${state.year}` }),
      el('div', { class: 'cal-nav' }, [
        el('button', { text: '‹', 'aria-label': 'Previous month', onclick: () => shift(-1) }),
        el('button', { text: '›', 'aria-label': 'Next month', onclick: () => shift(1) }),
      ]),
    ]),
    el('div', { class: 'chart-legend', style: { marginBottom: '10px' } }, [
      el('span', {}, [el('i', { class: 'legend-swatch', style: { background: 'rgba(124,111,255,.5)' } }), 'Study log']),
      el('span', {}, [el('i', { class: 'legend-swatch', style: { background: 'rgba(107,255,218,.5)' } }), 'Hit the target']),
      el('span', {}, [el('i', { class: 'legend-swatch', style: { background: 'var(--surface3)' } }), 'Planned, nothing logged']),
    ]),
    el('div', { class: 'cal-grid' }, [
      ...WEEKDAYS.map((d) => el('div', { class: 'cal-wkd', text: d })),
      ...cells,
    ]),
    el('div', { class: 'pane-sub', style: { marginTop: '14px' }, text: 'Each cell shows the hours logged that day, plus a marker for anything scheduled on it. Click one to edit the study time or manage its items in the panel on the right.' }),
  ]));
}

export function calendarSidePanel(body) {
  if (!overview) return;
  body.innerHTML = '';

  const key = state.selected;
  const studied = entries.get(key) || 0;
  const date = parseDay(key);
  const planDay = overview.week.byDay.find((d) => d.date === key);
  const planned = planDay?.active ? planDay.planned : 0;

  body.append(el('div', { class: 'sect-hd', text: key }));
  body.append(el('div', { class: 'kpi' }, [
    el('div', { class: `kpi-row${planned > 0 && studied >= planned ? ' met' : ''}` }, [
      el('div', {}, [
        el('div', { class: 'kpi-label', text: 'Studied' }),
        el('div', { class: 'kpi-sub', text: planned > 0 ? `target ${minutesShort(planned)}` : 'not in your weekly plan' }),
      ]),
      el('div', { class: 'kpi-value', text: minutesShort(studied) }),
    ]),
  ]));

  // A stepper to add or remove study time on the selected day.
  let draft = studied;
  const value = el('div', { class: 'stepper-val', text: minutesShort(draft) });
  const save = el('button', {
    class: 'btn primary small', text: 'Save', disabled: true,
    onclick: async () => {
      try {
        await api.put('/api/study/entry', { date: key, minutes: draft });
        invalidateStudy();
        toast(`Saved ${minutesShort(draft)} for ${key}`);
        await load();
        window.dispatchEvent(new CustomEvent('pixelflow:stats'));
      } catch (err) { toast(err.message || 'Could not save', 3000); }
    },
  });

  const setDraft = (next) => {
    draft = Math.max(0, Math.min(24 * 60, next));
    value.textContent = minutesShort(draft);
    save.disabled = draft === studied;
  };

  body.append(el('div', { class: 'sect-hd', text: 'ADD STUDY TIME' }));
  body.append(el('div', { class: 'minutes-stepper' }, [
    el('div', { class: 'stepper' }, [
      el('button', { text: '−', 'aria-label': 'Less', onclick: () => setDraft(draft - 30) }),
      value,
      el('button', { text: '+', 'aria-label': 'More', onclick: () => setDraft(draft + 30) }),
    ]),
    save,
  ]));

  body.append(el('div', { class: 'sect-hd', text: 'WEEK AROUND THIS DAY' }));
  const monday = new Date(date);
  monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  body.append(el('div', { class: 'plan-grid' },
    Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const k = dayKey(d);
      const s = entries.get(k) || 0;
      const p = overview.week.byDay[i]?.planned || 0;
      const pct = p > 0 ? Math.min(100, (s / p) * 100) : 0;
      return el('div', { class: `plan-row${s > 0 ? ' active' : ''}`, style: { gridTemplateColumns: '52px 1fr' } }, [
        el('div', { class: 'plan-day-name', text: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i] }),
        el('div', {}, [
          el('div', { class: 'plan-mini-bar' }, [
            el('div', {
              class: `plan-mini-fill${p > 0 && s >= p ? ' met' : ''}`,
              style: { width: `${pct}%` },
            }),
          ]),
          el('div', { class: 'plan-actual', style: { textAlign: 'left', fontSize: '9px' }, text: `${minutesShort(s)}${p ? ` / ${minutesShort(p)}` : ''}` }),
        ]),
      ]);
    })));

  body.append(el('button', {
    class: 'btn block', text: 'Open the full tracker', style: { marginTop: '12px' },
    onclick: () => document.querySelector('[data-section="analytics"]')?.click(),
  }));

  itemsSection(body, key);
}

// ── events and deadlines ─────────────────────────────────────────────────

/** Saves whatever the item form currently holds. Never touches study data. */
async function saveItem(draft, { id = null } = {}) {
  const payload = {
    date: draft.date,
    kind: draft.kind,
    title: draft.title,
    tagId: draft.tagId ?? null,
  };
  // A deadline is a day, not a moment: sending a time with one is a 400, so it
  // is only ever sent for an event.
  payload.time = draft.kind === 'event' ? (draft.time || '') : '';
  payload.minutes = draft.kind === 'event' ? Number(draft.minutes) || 0 : 0;

  if (id) await api.put(`/api/events/${id}`, payload);
  else await api.post('/api/events', payload);
  await load();
  if (panel) calendarSidePanel(panel);
  window.dispatchEvent(new CustomEvent('pixelflow:stats'));
}

function itemRow(item, key) {
  const remove = el('button', {
    class: 'task-x', text: '×', style: { opacity: '1' },
    'aria-label': `Delete ${item.title}`,
    onclick: async () => {
      try {
        await api.del(`/api/events/${item.id}`);
        await load();
        if (panel) calendarSidePanel(panel);
        toast('Deleted');
      } catch (err) { toast(err.message || 'Could not delete that item', 3000); }
    },
  });

  const toggle = el('div', {
    class: `item-done${item.done ? ' on' : ''}`,
    role: 'checkbox', tabindex: '0',
    'aria-checked': String(item.done),
    title: item.done ? 'Mark as not done' : 'Mark as done',
    text: item.done ? '✓' : '',
    onclick: async () => {
      try {
        await api.put(`/api/events/${item.id}`, { done: !item.done });
        await load();
        if (panel) calendarSidePanel(panel);
      } catch (err) { toast(err.message || 'Could not update that item', 3000); }
    },
    onkeydown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle.click();
      }
    },
  });

  const head = el('div', { class: 'item-head' }, [
    toggle,
    el('div', { class: 'item-title-row' }, [
      el('div', { class: `item-kind ${item.kind}`, text: item.kind === 'deadline' ? 'DUE' : (item.time || 'EVENT') }),
      el('div', { class: `item-title${item.done ? ' done' : ''}`, text: item.title }),
    ]),
    remove,
  ]);

  const edit = el('button', {
    class: 'item-edit', text: item.title,
    onclick: () => editItem(item, key),
  });
  head.querySelector('.item-title-row').replaceChild(edit, head.querySelector('.item-title'));

  const meta = [];
  if (item.kind === 'event' && item.minutes > 0) meta.push(minutesShort(item.minutes));
  if (item.tag) {
    meta.push(el('i', { class: 'dot', style: { background: item.tag.color, display: 'inline-block' } }));
    meta.push(document.createTextNode(item.tag.name));
  }

  return el('div', { class: 'cal-item-row' }, [
    head,
    meta.length ? el('div', { class: 'item-meta' }, meta) : null,
  ]);
}

/** Turns a row into an inline edit form. */
function editItem(item, key) {
  const host2 = panel;
  if (!host2) return;
  const existing = host2.querySelector('.item-editor');
  if (existing) existing.remove();

  const draft = {
    kind: item.kind,
    title: item.title,
    time: item.time || '',
    minutes: item.minutes || 0,
    tagId: item.tag?.id ?? null,
  };

  const title = el('input', { class: 'inp', value: draft.title, maxlength: '120' });
  const time = el('input', { class: 'inp', type: 'time', value: draft.time });
  const mins = el('input', { class: 'inp', type: 'number', min: '0', max: '1440', step: '5', value: String(draft.minutes) });

  const editor = el('div', { class: 'item-editor' }, [
    el('div', { class: 'item-editor-row' }, [title]),
    el('div', { class: 'item-editor-row' }, [
      time,
      el('span', { class: 'pane-sub', text: 'minutes' }),
      mins,
    ]),
    tagPicker(draft, () => {}),
    el('div', { class: 'item-editor-actions' }, [
      el('button', {
        class: 'btn primary small', text: 'Save',
        onclick: async () => {
          const next = {
            ...draft,
            title: title.value.trim(),
            time: time.value,
            minutes: Number(mins.value) || 0,
          };
          if (!next.title) return toast('Give it a title', 2000);
          try {
            await saveItem(next, { id: item.id });
            toast('Saved');
          } catch (err) { toast(err.message || 'Could not save', 3000); }
        },
      }),
      el('button', {
        class: 'btn small ghost', text: 'Cancel', onclick: () => editor.remove(),
      }),
    ]),
  ]);

  host2.append(editor);
  title.focus();
}

/** A row of tag chips bound to `draft.tagId`. */
function tagPicker(draft, onChange) {
  if (tags.length === 0) {
    return el('div', { class: 'pane-sub', text: 'Create tags in the Tasks panel to label these.' });
  }
  return el('div', { class: 'chip-row' }, tags.map((tag) => {
    const chip = el('button', {
      class: `chip${draft.tagId === tag.id ? ' active' : ''}`,
      style: draft.tagId === tag.id
        ? { background: tag.color, color: '#12121f', borderColor: tag.color }
        : {},
      onclick: () => {
        draft.tagId = draft.tagId === tag.id ? null : tag.id;
        chip.className = `chip${draft.tagId === tag.id ? ' active' : ''}`;
        if (draft.tagId === tag.id) {
          chip.style.background = tag.color;
          chip.style.color = '#12121f';
          chip.style.borderColor = tag.color;
        } else {
          chip.style.background = '';
          chip.style.color = '';
          chip.style.borderColor = '';
        }
        onChange();
      },
    }, [
      el('i', { class: 'dot', style: { width: '7px', height: '7px', borderRadius: '50%', background: tag.color, display: 'inline-block' } }),
      document.createTextNode(tag.name),
    ]);
    return chip;
  }));
}

/** Lists the selected day's items and offers a form for adding one. */
function itemsSection(body, key) {
  const items = itemsByDate.get(key) || [];

  body.append(el('div', { class: 'sect-hd', text: `EVENTS & DEADLINES (${items.length})` }));
  body.append(el('div', { class: 'pane-sub', style: { marginBottom: '8px' }, text: 'Informational only — an item never counts toward your study totals.' }));

  if (items.length === 0) {
    body.append(el('div', { class: 'empty', style: { padding: '10px' }, text: 'Nothing scheduled for this day.' }));
  } else {
    for (const item of items) body.append(itemRow(item, key));
  }

  // Event / deadline toggle. The two shapes differ enough (a deadline has no
  // time and no length) that offering both at once would just be confusing.
  const draft = { kind: 'event', title: '', time: '', minutes: 30, tagId: null, date: key };
  const title = el('input', { class: 'inp', placeholder: 'What is it?', maxlength: '120' });
  const time = el('input', { class: 'inp', type: 'time', value: '' });
  const mins = el('input', { class: 'inp', type: 'number', min: '0', max: '1440', step: '5', value: '30' });

  const timeRow = el('div', { class: 'item-editor-row' }, [time, el('span', { class: 'pane-sub', text: 'minutes' }), mins]);

  const kindRow = el('div', { class: 'opt-row' }, ['event', 'deadline'].map((kind) => el('button', {
    class: `opt-btn${draft.kind === kind ? ' active' : ''}`,
    text: kind === 'event' ? '🕐 Event' : '🚩 Deadline',
    onclick: (event) => {
      draft.kind = kind;
      for (const node of kindRow.children) node.classList.remove('active');
      event.currentTarget.classList.add('active');
      // A deadline has no time of day and no length, so those inputs go away
      // rather than sit there being ignored.
      timeRow.hidden = kind === 'deadline';
    },
  })));

  const submit = async () => {
    draft.title = title.value.trim();
    if (!draft.title) return toast('Give it a title', 2000);
    try {
      await saveItem(draft);
      toast(draft.kind === 'deadline' ? 'Deadline added' : 'Event added');
      if (panel) calendarSidePanel(panel);
    } catch (err) { toast(err.message || 'Could not add that', 3000); }
  };

  body.append(el('div', { class: 'item-editor', style: { marginTop: '10px' } }, [
    kindRow,
    el('div', { class: 'item-editor-row' }, [title]),
    timeRow,
    tagPicker(draft, () => {}),
    el('button', { class: 'btn primary block', text: 'Add to this day', style: { marginTop: '8px' }, onclick: submit }),
  ]));

  title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); submit(); }
  });
}
