/**
 * Study metrics — pure functions.
 *
 * Nothing in here touches the database or `Date.now()`. Callers pass in plain
 * arrays of rows and get plain objects back, which is what makes the maths
 * testable in tests/metrics.test.js without a server or a fixture DB.
 *
 * Conventions
 *   • A calendar day is a 'YYYY-MM-DD' string in the *user's* local time.
 *   • A date object always means local midnight of that day.
 *   • Weeks are Monday-start. `weekday` follows JS: 0 = Sunday … 6 = Saturday.
 *   • All durations are integer MINUTES. The client formats them for display.
 */

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Parse 'YYYY-MM-DD' into a local-midnight Date (throws on malformed input). */
export function parseDay(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
  if (!m) throw new TypeError(`Invalid day key: ${JSON.stringify(key)}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(y, mo - 1, d);
  // Rejects 2026-02-31 and friends, which Date would silently roll over.
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) {
    throw new RangeError(`Invalid calendar day: ${key}`);
  }
  return date;
}

/** Format a Date (or anything Date-like) as 'YYYY-MM-DD' in local time. */
export function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Monday of the week containing `date`, at local midnight. */
export function weekStart(date) {
  const d = new Date(date);
  const shift = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  d.setDate(d.getDate() - shift);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function startOfMonth(year, month) {
  return new Date(year, month, 1);
}

export function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * Partition a month into Monday-start weeks, each *clipped* to the month.
 *
 * A week belongs to the month if any part of it falls inside. A month's first
 * week starts on the 1st (not on the preceding Monday) so W1 covers exactly the
 * days the student can actually log, and its last week ends on the last day of
 * the month. Months yield 4 or 5 weeks — 5 whenever the month contains a
 * Friday-to-Thursday span, which is most of them.
 *
 * @returns {Array<{label: string, index: number, start: string, end: string,
 *                  days: number}>} `start`/`end` are 'YYYY-MM-DD'.
 */
export function monthWeeks(year, month) {
  const last = new Date(year, month, daysInMonth(year, month));

  const out = [];
  let cursor = new Date(year, month, 1);
  let i = 0;
  while (cursor <= last) {
    // Days until the next Monday. The week *ends* one day before it, and the
    // final week is clipped to the month's last day.
    const span = 7 - ((cursor.getDay() + 6) % 7);
    const nominalEnd = addDays(cursor, span - 1);
    const end = nominalEnd > last ? new Date(last) : nominalEnd;
    out.push({
      label: `W${i + 1}`,
      index: i,
      start: dayKey(cursor),
      end: dayKey(end),
      days: Math.round((end - cursor) / 86400000) + 1,
    });
    i += 1;
    cursor = addDays(cursor, span);
  }
  return out;
}

/**
 * Turn `study_plans` rows into a lookup keyed by weekday.
 * Accepts either an array of rows or a Map, so callers can pass either.
 */
export function planIndex(planRows) {
  const idx = new Map();
  const rows = planRows instanceof Map
    ? [...planRows.entries()].map(([weekday, v]) => ({ weekday, ...v }))
    : planRows;
  for (const r of rows) {
    idx.set(Number(r.weekday), {
      weekday: Number(r.weekday),
      active: Boolean(r.active),
      planned_minutes: Math.max(0, Number(r.planned_minutes) || 0),
    });
  }
  return idx;
}

/** Planned minutes for a single weekday. Unticked days plan for 0 minutes. */
export function plannedForWeekday(plan, weekday) {
  const row = plan.get(weekday);
  if (!row || !row.active) return 0;
  return row.planned_minutes;
}

/** Build an O(1) day -> minutes map from `study_entries` rows. */
export function studiedIndex(entryRows) {
  const idx = new Map();
  for (const r of entryRows) {
    idx.set(r.date, (idx.get(r.date) ?? 0) + (Number(r.minutes) || 0));
  }
  return idx;
}

export function studiedForDay(studied, date) {
  return studied.get(dayKey(date)) ?? 0;
}

/**
 * Planned + studied for the seven days of the week containing `monday`.
 *
 * `planned` is the live sum of the ticked days, so unticking a day removes its
 * minutes from the week with no other bookkeeping.
 */
export function weekTotals(entryRows, planRows, monday) {
  const start = monday instanceof Date ? weekStart(monday) : parseDay(monday);
  const studied = studiedIndex(entryRows || []);
  const plan = planIndex(planRows || []);

  const byDay = [];
  let totalStudied = 0;
  let totalPlanned = 0;
  for (let i = 0; i < 7; i += 1) {
    const date = addDays(start, i);
    const weekday = date.getDay();
    const plannedMinutes = plannedForWeekday(plan, weekday);
    const studiedMinutes = studiedForDay(studied, date);
    totalStudied += studiedMinutes;
    totalPlanned += plannedMinutes;
    byDay.push({
      date: dayKey(date),
      weekday,
      label: WEEKDAY_SHORT[weekday],
      short: i === 0 ? 'MON' : i === 6 ? 'SUN' : WEEKDAY_SHORT[weekday].toUpperCase(),
      planned: plannedMinutes,
      studied: studiedMinutes,
      active: Boolean(plan.get(weekday)?.active),
    });
  }
  return {
    start: dayKey(start),
    end: dayKey(addDays(start, 6)),
    studied: totalStudied,
    planned: totalPlanned,
    byDay,
  };
}

/** Today's single-day card: planned comes from the weekday tick, not a row. */
export function dayTotals(entries, planRows, date) {
  const studied = studiedIndex(entries || []);
  const plan = planIndex(planRows || []);
  const planned = plannedForWeekday(plan, date.getDay());
  const actual = studiedForDay(studied, date);
  return {
    date: dayKey(date),
    planned,
    studied: actual,
    active: Boolean(plan.get(date.getDay())?.active),
    ratio: planned > 0 ? actual / planned : null,
  };
}

/**
 * Monthly roll-up: one entry per week-of-month plus the month totals.
 * This is what the Analytics pane's "W1 … W5" rows render.
 */
export function monthSummary(entries, planRows, year, month) {
  const studied = studiedIndex(entries || []);
  const plan = planIndex(planRows || []);
  const weeks = monthWeeks(year, month).map((w) => {
    let wStudied = 0;
    let wPlanned = 0;
    let cursor = parseDay(w.start);
    const end = parseDay(w.end);
    while (cursor <= end) {
      wStudied += studiedForDay(studied, cursor);
      wPlanned += plannedForWeekday(plan, cursor.getDay());
      cursor = addDays(cursor, 1);
    }
    return { ...w, studied: wStudied, planned: wPlanned };
  });

  return {
    year,
    month,
    name: MONTH_NAMES[month],
    weeks,
    studied: weeks.reduce((s, w) => s + w.studied, 0),
    planned: weeks.reduce((s, w) => s + w.planned, 0),
    days: daysInMonth(year, month),
  };
}

/**
 * Chart series. `mode: 'daily'` gives one point per day of the month, with the
 * planned overlay per day; `'weekly'` gives one point per week-of-month with
 * the week's planned total. Both shapes are identical to the renderer, so the
 * daily/weekly toggle is a data switch rather than a redraw.
 */
export function chartSeries(entries, planRows, year, month, mode = 'daily') {
  const summary = monthSummary(entries, planRows, year, month);
  const studied = studiedIndex(entries || []);
  const plan = planIndex(planRows || []);

  if (mode === 'weekly') {
    return {
      mode,
      points: summary.weeks.map((w) => ({
        key: w.label,
        label: w.label,
        value: w.studied,
        planned: w.planned,
        sub: `${w.start.slice(5)} → ${w.end.slice(5)}`,
      })),
      max: Math.max(1, ...summary.weeks.map((w) => Math.max(w.studied, w.planned))),
      totals: { studied: summary.studied, planned: summary.planned },
    };
  }

  const points = [];
  for (let d = 1; d <= summary.days; d += 1) {
    const date = new Date(year, month, d);
    const planned = plannedForWeekday(plan, date.getDay());
    points.push({
      key: dayKey(date),
      label: String(d),
      value: studiedForDay(studied, date),
      planned,
      sub: WEEKDAY_SHORT[date.getDay()],
    });
  }
  return {
    mode: 'daily',
    points,
    max: Math.max(60, ...points.map((p) => Math.max(p.value, p.planned))),
    totals: { studied: summary.studied, planned: summary.planned },
  };
}

/** Format minutes as `4h 00m` / `45m`, for server-rendered strings. */
export function formatMinutes(mins) {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  if (m === 0) return '0m';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h > 0 ? `${h}h ${String(r).padStart(2, '0')}m` : `${r}m`;
}

/** Progress ratio clamped to [0,1] for bar widths. Never NaN. */
export function ratio(studied, planned) {
  if (!planned || planned <= 0) return 0;
  return Math.max(0, Math.min(1, studied / planned));
}

/** Consecutive days ending today (or yesterday) with any logged study time. */
export function streakFromDays(dayKeys, todayKey) {
  const set = new Set(dayKeys);
  const today = parseDay(todayKey);
  // Allow the streak to still be alive if today has not been logged yet.
  let cursor = set.has(todayKey) ? today : addDays(today, -1);
  let count = 0;
  while (set.has(dayKey(cursor))) {
    count += 1;
    cursor = addDays(cursor, -1);
  }
  return count;
}
