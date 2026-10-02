import { el, minutes, minutesShort, dayKey, monthKey, addDays, toast } from '../ui.js';
import { store, studyCache, fetchOverview, fetchInsights, invalidateStudy, updateSetting } from '../store.js';
import { api } from '../api.js';
import { drawChart, drawHeatmap, drawCumulative } from '../study/chart.js';

let state = null;
let host = null;

export const analyticsSection = {
  async mount(container) {
    host = container;
    state = {
      month: store.view.month || monthKey(),
      mode: store.view.chartMode || 'daily',
      date: dayKey(),
    };
    await reload();
  },
  reload: () => reload(),
};

async function reload() {
  if (!host || !state) return;
  // A short skeleton rather than a blank pane, so the layout never jumps.
  host.innerHTML = '';
  host.append(el('div', { class: 'pane' }, [
    el('div', { class: 'chart-skeleton' },
      Array.from({ length: 30 }, (_, i) => el('i', { style: { height: `${20 + (i % 5) * 16}%` } }))),
  ]));

  let data;
  let insights;
  try {
    // Both reads cover the same month, so they are fetched together and the
    // insights pane renders without a second round trip.
    [data, insights] = await Promise.all([
      fetchOverview({ month: state.month, mode: state.mode }),
      fetchInsights({ month: state.month }),
    ]);
  } catch (err) {
    host.innerHTML = '';
    host.append(el('div', { class: 'pane' }, [
      el('div', { class: 'empty', text: err.message || 'Could not load your study data.' }),
      el('button', { class: 'btn block', text: 'Try again', style: { marginTop: '12px' }, onclick: () => reload() }),
    ]));
    return;
  }

  host.innerHTML = '';
  host.append(todayPane(data), weekPane(data), monthPane(data), insightsPane(insights));
}

// ═══════════════════════════════════════════════════════════════════════════
//  TODAY — date, hours entered, and the planned-vs-actual bar
// ═══════════════════════════════════════════════════════════════════════════

function todayPane(data) {
  const today = data.today;
  const planned = today.planned;
  const ratio = planned > 0 ? today.studied / planned : 0;

  const studiedNode = el('div', {
    class: `progress-studied ${today.met ? 'met' : ''}`,
    text: today.studiedText,
  });
  const pctNode = el('div', {
    class: `progress-pct ${today.met ? 'met' : ''}`,
    text: planned > 0 ? `${Math.round(ratio * 100)}%` : 'no plan',
  });
  const barFill = el('div', {
    class: `bar-fill ${fillClass(ratio, planned)}`,
    style: { width: `${Math.min(100, ratio * 100)}%` },
  });

  let draft = today.studied;
  const stepperValue = el('div', { class: 'stepper-val', text: minutesShort(draft) });

  /** Live preview so the bar answers before the save round trip completes. */
  function setDraft(next) {
    draft = Math.max(0, Math.min(24 * 60, next));
    stepperValue.textContent = minutesShort(draft);
    const previewRatio = planned > 0 ? draft / planned : 0;
    studiedNode.textContent = minutes(draft);
    barFill.style.width = `${Math.min(100, previewRatio * 100)}%`;
    barFill.className = `bar-fill ${fillClass(previewRatio, planned)}`;
    pctNode.textContent = planned > 0 ? `${Math.round(previewRatio * 100)}%` : 'no plan';
    saveBtn.disabled = draft === today.studied;
  }

  async function save() {
    saveBtn.disabled = true;
    try {
      await api.put('/api/study/entry', { date: state.date, minutes: draft });
      invalidateStudy();
      toast(`Logged ${minutesShort(draft)} for ${state.date}`);
      await reload();
      window.dispatchEvent(new CustomEvent('pixelflow:stats'));
    } catch (err) {
      saveBtn.disabled = false;
      toast(err.message || 'Could not save', 3000);
    }
  }

  const saveBtn = el('button', { class: 'btn primary', text: 'Save', onclick: save, disabled: true });

  const autoAdd = store.user?.settings?.autoLogStudy !== false;
  const autoToggle = el('div', {
    class: `toggle-wrap ${autoAdd ? 'on' : 'off'}`,
    role: 'switch',
    tabindex: '0',
    'aria-checked': String(autoAdd),
    title: 'Automatically add finished focus sessions to today',
  }, [el('div', { class: 'toggle-thumb' })]);

  const flip = () => {
    const next = autoToggle.classList.contains('off');
    autoToggle.className = `toggle-wrap ${next ? 'on' : 'off'}`;
    autoToggle.setAttribute('aria-checked', String(next));
    updateSetting('autoLogStudy', next)
      .then(() => toast(`Auto-add finished sessions ${next ? 'on' : 'off'}`))
      .catch(() => toast('Could not save that setting', 3000));
  };
  autoToggle.addEventListener('click', flip);
  autoToggle.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); flip(); }
  });

  return el('div', { class: 'pane' }, [
    el('div', { class: 'pane-hd' }, [
      el('div', { class: 'pane-title', text: 'TODAY' }),
      el('div', { style: { display: 'flex', gap: '9px', alignItems: 'center' } }, [
        el('span', { class: 'pane-sub', text: 'Auto-add finished sessions' }),
        autoToggle,
      ]),
    ]),
    el('div', { class: 'today-grid' }, [
      el('div', {}, [
        el('div', { class: 'field-label', text: 'Date' }),
        el('input', {
          class: 'date-input',
          type: 'date',
          value: state.date,
          max: dayKey(addDays(new Date(), 1)),
          onchange: async (event) => {
            state.date = event.target.value || dayKey();
            await reload();
          },
        }),
        el('div', { class: 'field-label', style: { marginTop: '16px' }, text: 'Hours studied' }),
        el('div', { class: 'minutes-stepper' }, [
          el('div', { class: 'stepper' }, [
            el('button', { text: '−', title: '15 minutes less', 'aria-label': 'Subtract 15 minutes', onclick: () => setDraft(draft - 15) }),
            stepperValue,
            el('button', { text: '+', title: '15 minutes more', 'aria-label': 'Add 15 minutes', onclick: () => setDraft(draft + 15) }),
          ]),
          saveBtn,
        ]),
        el('div', { class: 'preset-mins' },
          [30, 60, 90, 120, 180].map((m) => el('button', {
            class: 'quick-chip',
            text: `+${m}m`,
            title: `Add ${m} minutes to this day`,
            onclick: () => setDraft(draft + m),
          }))),
      ]),
      el('div', {}, [
        el('div', { class: 'field-label', text: 'Progress' }),
        el('div', { class: 'progress-readout' }, [
          el('div', { class: 'progress-nums' }, [
            studiedNode,
            el('div', {}, [
              pctNode,
              el('div', {
                class: 'progress-planned',
                text: planned > 0 ? `of ${today.plannedText} planned` : 'no plan for this weekday',
              }),
            ]),
          ]),
          el('div', { class: 'bar', style: { height: '12px', borderRadius: '6px' } }, [barFill]),
        ]),
        planned === 0
          ? el('div', { class: 'sp-note', style: { marginTop: '14px' }, text: 'This weekday is not ticked in your weekly plan, so there is no target to aim at. Tick it in the plan below and set its hours.' })
          : null,
      ]),
    ]),
  ]);
}

function fillClass(ratio, planned) {
  if (!planned || ratio < 1) return ratio > 1 ? 'over' : '';
  return ratio > 1 ? 'over' : 'met';
}

// ═══════════════════════════════════════════════════════════════════════════
//  WEEKLY PLAN — Mon–Sun ticks with per-day hours
// ═══════════════════════════════════════════════════════════════════════════

function weekPane(data) {
  const week = data.week;
  const todayKey = dayKey();

  // The +/- steppers must not go through reload(). That wiped the pane to a
  // skeleton, refetched the month and rebuilt every chart, so each click threw
  // away the scroll position and re-rendered the whole view — which is what
  // "it refreshes the page for each +" looked like. The server already returns
  // the new weekly total in the PUT response, so the stepper updates in place
  // and one quiet reload reconciles everything else afterwards.
  let reconcile = null;
  const scheduleReconcile = () => {
    clearTimeout(reconcile);
    reconcile = setTimeout(() => { invalidateStudy(); reload(); }, 700);
  };

  // One element, shared by every row and the summary below, so stepping a day
  // never has to re-render the pane to move the total.
  const totalNum = el('div', { class: 'week-total-num', text: week.plannedText });

  const rows = data.planGrid.map((day) => {
    const isToday = day.date === todayKey;
    const fill = day.planned > 0
      ? (day.studied >= day.planned ? (day.studied > day.planned ? 'over' : 'met') : '')
      : '';
    const barWidth = day.planned > 0 ? Math.min(100, (day.studied / day.planned) * 100) : 0;

    // Painted locally the instant a click lands, so the number under the
    // cursor moves immediately even before the network answers.
    const plannedLabel = el('div', { class: 'stepper-val', text: day.active ? hours(day.planned) : '—' });
    const tick = el('div', {
      class: 'plan-tick',
      role: 'checkbox',
      tabindex: '0',
      'aria-checked': String(day.active),
      'aria-label': `Plan to study on ${day.label}`,
      text: day.active ? '✓' : '',
    });

    // Optimistic state for this row, so rapid clicks accumulate instead of
    // fighting over the stale server value.
    let planned = day.planned;
    let active = day.active;

    function paintOptimistic() {
      tick.textContent = active ? '✓' : '';
      tick.setAttribute('aria-checked', String(active));
      plannedLabel.textContent = active ? hours(planned) : '—';
      const row = tick.closest('.plan-row');
      row?.classList.toggle('active', active);
      row?.classList.toggle('rest', !active);
      // Keep the weekly total honest while stepping — it is the number people
      // watch when adjusting several days in a row.
      let sum = 0;
      for (const d of data.planGrid) {
        if (d.date === day.date) sum += active ? planned : 0;
        else if (d.active) sum += d.planned;
      }
      totalNum.textContent = minutes(sum);
    }

    // One request at a time per row, with clicks that landed mid-flight queued
    // behind it, so hammering + cannot reorder the writes.
    let inFlight = false;
    let queued = null;

    async function patch(changes) {
      queued = { ...(queued || {}), ...changes };
      if (inFlight) return;
      inFlight = true;
      try {
        while (queued) {
          const body = { weekday: day.weekday, ...queued };
          queued = null;
          const res = await api.put('/api/study/plan', body);
          // Adopt the server's values so the stepper follows the real state.
          if (typeof res.minutes === 'number') planned = res.minutes;
          if (typeof res.active === 'boolean') active = res.active;
          paintOptimistic();
          if (res.weekly?.plannedText) totalNum.textContent = res.weekly.plannedText;
        }
        window.dispatchEvent(new CustomEvent('pixelflow:stats'));
        scheduleReconcile();
      } catch (err) {
        toast(err.message || 'Could not update the plan', 3000);
        invalidateStudy();
        await reload();
      } finally {
        inFlight = false;
      }
    }

    const toggleDay = () => {
      active = !active;
      paintOptimistic();
      patch({ active });
    };
    tick.addEventListener('click', toggleDay);
    tick.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleDay(); }
    });

    return el('div', {
      class: `plan-row${day.active ? ' active' : ' rest'}${isToday ? ' today' : ''}`,
      title: isToday ? 'Today' : day.date,
    }, [
      el('div', { class: 'plan-day' }, [
        tick,
        el('div', {}, [
          el('div', { class: 'plan-day-name', text: day.label }),
          isToday ? el('div', { class: 'pane-sub', style: { fontSize: '9px' }, text: 'today' }) : null,
        ]),
      ]),
      el('div', { class: 'plan-mini-bar' }, [
        el('div', { class: `plan-mini-fill ${fill}`, style: { width: `${barWidth}%` } }),
      ]),
      el('div', { class: 'plan-hrs' }, [
        el('div', { class: 'stepper' }, [
          el('button', {
            text: '−', 'aria-label': `Less planned time on ${day.label}`,
            onclick: () => {
              planned = Math.max(0, planned - 30);
              active = true;
              paintOptimistic();
              patch({ planned_minutes: planned, active: true });
            },
          }),
          plannedLabel,
          el('button', {
            text: '+', 'aria-label': `More planned time on ${day.label}`,
            onclick: () => {
              planned += 30;
              active = true;
              paintOptimistic();
              patch({ planned_minutes: planned, active: true });
            },
          }),
        ]),
      ]),
      el('div', {
        class: `plan-actual${fill === 'met' ? ' met' : ''}`,
        text: day.studied > 0 ? `${minutesShort(day.studied)} done` : '—',
      }),
    ]);
  });

  return el('div', { class: 'pane' }, [
    el('div', { class: 'pane-hd' }, [
      el('div', { class: 'pane-title', text: 'WEEKLY PLAN' }),
      el('div', { class: 'pane-sub', text: 'Tick a day, then set its hours. The weekly total is always the sum of ticked days.' }),
    ]),
    el('div', { class: 'week-total' }, [
      el('div', { style: { minWidth: '92px' } }, [
        totalNum,
        el('div', { class: 'pane-sub', text: 'planned' }),
      ]),
      el('div', { style: { flex: '1' } }, [
        el('div', { class: 'progress-nums' }, [
          el('div', { class: 'progress-planned', style: { textAlign: 'left' } }, [
            el('b', { text: week.studiedText }),
            document.createTextNode(` studied of ${week.plannedText} planned`),
          ]),
          el('div', {
            class: `progress-pct${week.met ? ' met' : ''}`,
            text: week.planned > 0 ? `${Math.round(week.ratio * 100)}%` : '',
          }),
        ]),
        el('div', { class: 'bar' }, [
          el('div', { class: `bar-fill${week.met ? ' met' : ''}`, style: { width: `${week.ratio * 100}%` } }),
        ]),
        el('div', { class: 'pane-sub', style: { marginTop: '5px' }, text: `${week.start} → ${week.end}` }),
      ]),
    ]),
    el('div', { class: 'plan-grid' }, rows),
  ]);
}

/** 90 -> "1h30", 480 -> "8h", 30 -> "30m". */
function hours(minutesValue) {
  const m = Math.max(0, minutesValue);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  return r === 0 ? `${h}h` : `${h}h${r}`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  MONTH — weeks of the month plus the daily/weekly chart
// ═══════════════════════════════════════════════════════════════════════════

function monthPane(data) {
  const month = data.month;
  const today = new Date();

  const shift = async (delta) => {
    const [y, m] = state.month.split('-').map(Number);
    state.month = monthKey(new Date(y, m - 1 + delta, 1));
    store.view.month = state.month;
    await reload();
  };

  const setMode = async (mode) => {
    state.mode = mode;
    store.view.chartMode = mode;
    await reload();
  };

  const svgHost = el('div');
  const weekRows = month.weeks.map((w) => {
    const isCurrent = month.year === today.getFullYear()
      && month.month === today.getMonth()
      && today.getDate() >= Number(w.start.slice(8))
      && today.getDate() <= Number(w.end.slice(8));
    return el('div', { class: `wom-row${isCurrent ? ' current' : ''}` }, [
      el('div', {}, [
        el('div', { class: 'wom-label', text: w.label }),
        el('div', { class: 'wom-range', text: `${w.start.slice(5)} → ${w.end.slice(5)}` }),
      ]),
      el('div', { class: 'bar', style: { height: '9px', borderRadius: '5px' } }, [
        el('div', { class: `bar-fill${w.met ? ' met' : ''}`, style: { width: `${w.ratio * 100}%` } }),
      ]),
      el('div', { class: 'wom-nums' }, [
        el('b', { text: w.studiedText }),
        document.createTextNode(` / ${w.plannedText}`),
      ]),
    ]);
  });

  const pane = el('div', { class: 'pane' }, [
    el('div', { class: 'chart-head' }, [
      el('div', {}, [
        el('div', { class: 'pane-title', text: `MONTH OF ${month.name.toUpperCase()}` }),
        el('div', {
          class: 'pane-sub',
          text: `${month.studiedText} studied of ${month.plannedText} planned · ${month.days} days`,
        }),
      ]),
      el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, [
        el('div', { class: 'cal-nav' }, [
          el('button', { text: '‹', title: 'Previous month', 'aria-label': 'Previous month', onclick: () => shift(-1) }),
          el('button', { text: '›', title: 'Next month', 'aria-label': 'Next month', onclick: () => shift(1) }),
        ]),
        el('div', { class: 'chart-toggle' }, [
          el('button', {
            class: state.mode === 'daily' ? 'active' : '',
            text: 'DAILY',
            onclick: () => setMode('daily'),
          }),
          el('button', {
            class: state.mode === 'weekly' ? 'active' : '',
            text: 'WEEKLY',
            onclick: () => setMode('weekly'),
          }),
        ]),
      ]),
    ]),

    el('div', { class: 'sect-hd', text: 'EACH WEEK OF THIS MONTH' }),
    el('div', { class: 'wom-list' }, weekRows),

    el('div', { class: 'sect-hd', text: state.mode === 'daily' ? 'DAILY HOURS' : 'HOURS PER WEEK' }),
    el('div', { class: 'chart-legend' }, [
      el('span', {}, [
        el('i', { class: 'legend-swatch', style: { background: 'var(--accent)' } }),
        document.createTextNode('Studied'),
      ]),
      el('span', {}, [
        el('i', { class: 'legend-swatch', style: { background: 'var(--accent4)' } }),
        document.createTextNode('Planned'),
      ]),
    ]),
    svgHost,
  ]);

  // Measured after the pane is in the document, so the SVG can size to it.
  queueMicrotask(() => drawChart(svgHost, data.chart, { height: 200 }));
  return pane;
}

// ═══════════════════════════════════════════════════════════════════════════
//  INSIGHTS — consistency heatmap, cumulative race, per-tag split
// ═══════════════════════════════════════════════════════════════════════════

function insightsPane(insights) {
  const heatHost = el('div', { class: 'heat-wrap' });
  const cumulativeHost = el('div');
  const byTag = insights.byTag || [];
  const tagTotal = byTag.reduce((sum, t) => sum + t.minutes, 0);

  const pane = el('div', { class: 'pane' }, [
    el('div', { class: 'pane-hd' }, [
      el('div', { class: 'pane-title', text: 'INSIGHTS' }),
      el('div', { class: 'pane-sub', text: 'Twelve weeks of consistency, this month in total, and where the hours went.' }),
    ]),

    el('div', { class: 'sect-hd', text: 'DAILY CONSISTENCY' }),
    el('div', { class: 'pane-sub', style: { marginBottom: '8px' }, text: `${insights.heatmap.from} → ${insights.heatmap.to}. Each square is one day.` }),
    heatHost,

    el('div', { class: 'sect-hd', style: { marginTop: '18px' }, text: 'CUMULATIVE PROGRESS' }),
    el('div', { class: 'chart-legend' }, [
      el('span', {}, [
        el('i', { class: 'legend-swatch', style: { background: '#6bffda' } }),
        document.createTextNode('Studied'),
      ]),
      el('span', {}, [
        el('i', { class: 'legend-swatch', style: { background: '#ffb347' } }),
        document.createTextNode('Planned'),
      ]),
    ]),
    cumulativeHost,

    el('div', { class: 'sect-hd', style: { marginTop: '18px' }, text: 'WHERE THE HOURS WENT' }),
    byTag.length === 0
      ? el('div', { class: 'empty', text: 'No tagged study entries this month. Pick a tag on an entry, or a focus tag in the timer, and it will show up here.' })
      : el('div', { class: 'tag-stats' }, byTag.map((tag) => {
        const share = tagTotal > 0 ? tag.minutes / tagTotal : 0;
        return el('div', { class: 'tag-stat' }, [
          el('div', { class: 'tag-stat-head' }, [
            el('span', { class: 'tag-stat-name' }, [
              el('i', { class: 'dot', style: { background: tag.color } }),
              document.createTextNode(tag.name),
            ]),
            el('span', { class: 'tag-stat-val', text: `${minutesShort(tag.minutes)} · ${Math.round(share * 100)}%` }),
          ]),
          el('div', { class: 'bar', style: { height: '8px', borderRadius: '4px' } }, [
            el('div', { class: 'bar-fill', style: { width: `${Math.max(2, share * 100)}%`, background: tag.color } }),
          ]),
        ]);
      })),
  ]);

  // Measured after the pane is in the document, so the SVGs can size to it.
  queueMicrotask(() => {
    drawHeatmap(heatHost, insights.heatmap);
    drawCumulative(cumulativeHost, insights.cumulative);
  });
  return pane;
}

// ── right-panel KPI summary ──────────────────────────────────────────────

export function analyticsSidePanel(body) {
  body.innerHTML = '';
  const overview = studyCache.overview;
  if (!overview) {
    body.append(el('div', { class: 'empty', text: 'Loading your totals…' }));
    return;
  }
  const { today, week, month } = overview;
  const rows = [
    { label: 'Studied today', value: today.studiedText, sub: today.planned > 0 ? `of ${today.plannedText} planned` : 'no plan', met: today.met },
    { label: 'This week', value: week.studiedText, sub: `of ${week.plannedText} planned`, met: week.met },
    { label: 'This month', value: month.studiedText, sub: `of ${month.plannedText} planned`, met: month.studied >= month.planned && month.planned > 0 },
  ];

  body.append(el('div', { class: 'kpi' }, rows.map((r) => el('div', { class: `kpi-row${r.met ? ' met' : ''}` }, [
    el('div', {}, [
      el('div', { class: 'kpi-label', text: r.label }),
      el('div', { class: 'kpi-sub', text: r.sub }),
    ]),
    el('div', { class: 'kpi-value', text: r.value }),
  ]))));

  body.append(el('div', { class: 'sect-hd', text: 'MONTH AT A GLANCE' }));
  body.append(el('div', { class: 'wom-list' }, month.weeks.map((w) => el('div', { class: 'wom-row', style: { gridTemplateColumns: '40px 1fr', padding: '7px 9px' } }, [
    el('div', { class: 'wom-label', text: w.label }),
    el('div', { class: 'wom-nums', style: { fontSize: '10px' } }, [
      el('b', { text: w.studiedText }),
      document.createTextNode(` / ${w.plannedText}`),
    ]),
  ]))));
}
