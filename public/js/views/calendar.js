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
  overview = await fetchOverview({ month: prefix, mode: 'daily' });

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

    let miniClass = '';
    if (studied > 0 && planned > 0) miniClass = studied > planned ? 'over' : (studied >= planned ? 'met' : '');
    else if (studied > 0) miniClass = '';
    else if (planned > 0) miniClass = 'rest';

    cells.push(el('div', {
      class: `cal-day${key === todayKey ? ' today' : ''}${key === state.selected ? ' selected' : ''}`,
      role: 'button',
      tabindex: '0',
      title: `${key} — ${minutes(studied)} studied${planned ? ` of ${minutes(planned)} planned` : ''}`,
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
    el('div', { class: 'pane-sub', style: { marginTop: '14px' }, text: 'Each cell shows the hours logged that day. Click one to edit it in the panel on the right.' }),
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
}
