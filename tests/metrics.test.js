import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDay, dayKey, addDays, weekStart, monthWeeks, daysInMonth,
  planIndex, studiedIndex, plannedForWeekday, weekTotals, dayTotals,
  monthSummary, chartSeries, ratio, streakFromDays, formatMinutes,
} from '../server/metrics.js';

/** Builds `study_plans`-shaped rows from a compact Mon..Sun spec. */
const plan = (spec) => spec.map(([weekday, hours, active]) => ({
  weekday,
  planned_minutes: hours * 60,
  active: active ? 1 : 0,
}));

const entries = (spec) => spec.map(([date, hours]) => ({ date, minutes: hours * 60 }));

// ── calendar primitives ──────────────────────────────────────────────────

test('parseDay rejects malformed and impossible dates', () => {
  assert.equal(dayKey(parseDay('2026-02-28')), '2026-02-28');
  assert.throws(() => parseDay('2026-2-8'), TypeError);
  assert.throws(() => parseDay('2026-02-31'), RangeError);
  assert.throws(() => parseDay('nope'), TypeError);
});

test('weekStart always lands on a Monday at local midnight', () => {
  // 2026-09-30 is a Wednesday.
  assert.equal(dayKey(weekStart(parseDay('2026-09-30'))), '2026-09-28');
  // A Sunday belongs to the week that started the previous Monday, not the next.
  assert.equal(dayKey(weekStart(parseDay('2026-10-04'))), '2026-09-28');
  // A Monday is its own week start.
  assert.equal(dayKey(weekStart(parseDay('2026-09-28'))), '2026-09-28');
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(dayKey(addDays(parseDay('2026-01-31'), 1)), '2026-02-01');
  assert.equal(dayKey(addDays(parseDay('2026-12-31'), 1)), '2027-01-01');
});

// ── week-of-month partition ──────────────────────────────────────────────

test('monthWeeks yields 5 weeks and clips the first and last to the month', () => {
  const weeks = monthWeeks(2026, 8); // September 2026
  assert.equal(weeks.length, 5);
  assert.equal(weeks[0].start, '2026-09-01', 'W1 starts on the 1st, not the prior Monday');
  assert.equal(weeks.at(-1).end, '2026-09-30', 'last week ends on the last day of the month');

  // Contiguous, gapless, and every day of the month appears exactly once.
  for (let i = 1; i < weeks.length; i += 1) {
    assert.equal(dayKey(addDays(parseDay(weeks[i - 1].end), 1)), weeks[i].start);
  }
  const totalDays = weeks.reduce((s, w) => s + w.days, 0);
  assert.equal(totalDays, daysInMonth(2026, 8));
});

test('daysInMonth knows February can be 29 days', () => {
  // daysInMonth was only ever exercised against a September (30 days), so a
  // version that returned 28 for every February passed the whole suite. A
  // month-length error of one day silently shifts every date downstream, so
  // the leap rule is pinned here directly.
  assert.equal(daysInMonth(2024, 1), 29, '2024 is a leap year');
  assert.equal(daysInMonth(2028, 1), 29, '2028 is a leap year');
  assert.equal(daysInMonth(2026, 1), 28, '2026 is not');
  assert.equal(daysInMonth(2027, 1), 28, '2027 is not');
  // Century rules: divisible by 400 is a leap year, divisible by 100 is not.
  assert.equal(daysInMonth(2000, 1), 29, '2000 is divisible by 400');
  assert.equal(daysInMonth(1900, 1), 28, '1900 is divisible by 100 but not 400');

  // The same rule must hold through the derived week partition, which is what
  // actually uses it.
  assert.equal(monthWeeks(2024, 1).reduce((s, w) => s + w.days, 0), 29);
  assert.equal(monthWeeks(2026, 1).reduce((s, w) => s + w.days, 0), 28);
});

test('monthWeeks handles a 28-day month that yields only 4 weeks', () => {
  // February 2027 has 28 days and starts on a Monday -> exactly four weeks.
  const weeks = monthWeeks(2027, 1);
  assert.equal(weeks.length, 4);
  assert.equal(weeks[0].start, '2027-02-01');
  assert.equal(weeks.at(-1).end, '2027-02-28');
  for (const w of weeks) assert.equal(w.days, 7);
});

test('a month starting on Sunday still ends each week on a Sunday', () => {
  // February 2026 has 28 days and starts on a Sunday, so W1 is a single day.
  const weeks = monthWeeks(2026, 1);
  assert.equal(weeks.length, 5);
  assert.equal(weeks[0].start, '2026-02-01');
  assert.equal(weeks[0].end, '2026-02-01');
  assert.equal(weeks[0].days, 1);
  assert.equal(weeks[1].start, '2026-02-02');
  for (const w of weeks) assert.equal(parseDay(w.start).getDay(), w.index === 0 ? 0 : 1);
});

test('a week split across a month boundary counts once per month', () => {
  const sept = monthWeeks(2026, 8);
  // 2026-09-28 (Mon) – 2026-10-04 (Sun) straddles the October boundary.
  assert.equal(sept.at(-1).start, '2026-09-28');
  assert.equal(sept.at(-1).end, '2026-09-30');
  const oct = monthWeeks(2026, 9);
  assert.equal(oct[0].start, '2026-10-01');
  assert.equal(oct[0].end, '2026-10-04');
});

// ── planned-hours model ──────────────────────────────────────────────────

test('planned minutes come only from ticked days', () => {
  const p = planIndex(plan([[1, 4, true], [3, 6, true], [0, 3, false]]));
  assert.equal(plannedForWeekday(p, 1), 240); // Mon ticked
  assert.equal(plannedForWeekday(p, 3), 360); // Wed ticked
  assert.equal(plannedForWeekday(p, 0), 0);   // Sun present but unticked
  assert.equal(plannedForWeekday(p, 2), 0);   // Tue never planned
});

test('unticking a day removes its minutes from the weekly total', () => {
  const rows = plan([[1, 4, true], [3, 6, true], [6, 3, true]]);
  const monday = parseDay('2026-09-28');

  const withSat = weekTotals([], rows, monday);
  assert.equal(withSat.planned, 13 * 60);

  const withoutSat = weekTotals([], plan([[1, 4, true], [3, 6, true], [6, 3, false]]), monday);
  assert.equal(withoutSat.planned, 10 * 60);

  const noneTicked = weekTotals([], plan([[1, 4, false], [3, 6, false], [6, 3, false]]), monday);
  assert.equal(noneTicked.planned, 0, 'all-unticked week plans for nothing');
});

test('weekTotals byDay covers Mon..Sun in order with the right weekdays', () => {
  const totals = weekTotals(entries([['2026-09-28', 4]]), plan([[1, 4, true]]), parseDay('2026-09-28'));
  assert.equal(totals.byDay.length, 7);
  assert.equal(totals.byDay[0].date, '2026-09-28');
  assert.equal(totals.byDay[0].short, 'MON');
  assert.equal(totals.byDay[6].short, 'SUN');
  assert.equal(totals.byDay[0].studied, 240);
  assert.equal(totals.byDay[0].active, true);
  assert.equal(totals.studied, 240);
  assert.equal(totals.planned, 240);
});

// ── summaries and series ────────────────────────────────────────────────

test('monthSummary sums week-of-month totals', () => {
  const rows = plan([[1, 8, true], [3, 8, true]]); // 16h planned each week
  const data = entries([['2026-09-01', 4], ['2026-09-02', 4], ['2026-09-15', 6]]);
  const s = monthSummary(data, rows, 2026, 8);
  assert.equal(s.studied, 14 * 60);
  assert.equal(s.weeks.length, 5);
  // W1 of September 2026 runs Tue 1st – Sun 6th, so it holds both logged days.
  assert.equal(s.weeks[0].studied, 8 * 60);
  assert.equal(s.weeks[0].planned, 8 * 60, 'W1 holds only the ticked Wednesday');
  // W2 (Mon 7th – Sun 13th) contains one Monday and one Wednesday: 16h planned.
  assert.equal(s.weeks[1].planned, 16 * 60);
  assert.equal(s.weeks[2].studied, 6 * 60);
  const sumOfWeeks = s.weeks.reduce((t, w) => t + w.studied, 0);
  assert.equal(sumOfWeeks, s.studied, 'week rows must add up to the month total');
});

test('an empty month yields zeroes rather than NaN', () => {
  const s = monthSummary([], [], 2026, 8);
  assert.equal(s.studied, 0);
  assert.equal(s.planned, 0);
  for (const w of s.weeks) assert.equal(w.studied, 0);

  const series = chartSeries([], [], 2026, 8, 'daily');
  assert.equal(series.points.length, 30);
  assert.ok(Number.isFinite(series.max));
  assert.equal(ratio(0, 0), 0);
  assert.equal(formatMinutes(0), '0m');
});

test('chartSeries daily has one point per day and weekly one per week', () => {
  const rows = plan([[1, 8, true]]);
  const data = entries([['2026-09-01', 4]]);
  const daily = chartSeries(data, rows, 2026, 8, 'daily');
  assert.equal(daily.points.length, 30);
  assert.equal(daily.points[0].value, 240);
  assert.equal(daily.points[0].planned, 0); // 2026-09-01 is a Tuesday
  assert.equal(daily.points[0].sub, 'Tue');

  const weekly = chartSeries(data, rows, 2026, 8, 'weekly');
  assert.equal(weekly.points.length, 5);
  assert.equal(weekly.points[0].label, 'W1');
  assert.equal(weekly.points[0].value, 240);
});

test('ratio clamps to 1 when studied exceeds planned', () => {
  assert.equal(ratio(10, 4), 1);
  assert.equal(ratio(4, 8), 0.5);
  assert.equal(ratio(3, 0), 0, 'no plan means no progress bar fill, never NaN');
});

test('dayTotals reads the plan from the weekday tick', () => {
  const d = dayTotals(entries([['2026-09-28', 4]]), plan([[1, 8, true]]), parseDay('2026-09-28'));
  assert.equal(d.planned, 480);
  assert.equal(d.studied, 240);
  assert.equal(d.ratio, 0.5);
  assert.equal(d.active, true);
});

test('studiedIndex merges duplicate rows for the same day', () => {
  const idx = studiedIndex([{ date: '2026-09-28', minutes: 60 }, { date: '2026-09-28', minutes: 90 }]);
  assert.equal(idx.get('2026-09-28'), 150);
});

test('streak counts back from today and tolerates an unlogged today', () => {
  const days = ['2026-09-26', '2026-09-27', '2026-09-28'];
  assert.equal(streakFromDays(days, '2026-09-28'), 3);
  assert.equal(streakFromDays(days, '2026-09-29'), 3, 'today unlogged keeps yesterday streak alive');
  assert.equal(streakFromDays([], '2026-09-30'), 0);
});

test('formatMinutes renders hours and minutes', () => {
  assert.equal(formatMinutes(240), '4h 00m');
  assert.equal(formatMinutes(45), '45m');
  assert.equal(formatMinutes(125), '2h 05m');
});
