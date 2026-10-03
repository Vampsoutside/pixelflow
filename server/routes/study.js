import { asyncRouter } from '../http.js';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { localDate, weekStart } from '../db.js';
import {
  planRows, entriesBetween, upsertEntry, getUser,
  recordStudyChange, studyChange, reverseStudyChange,
  studyLedgerPage, studyMinutesByTag,
} from '../store.js';
import {
  parseDay, dayKey, addDays, weekTotals, dayTotals,
  monthSummary, chartSeries, formatMinutes, ratio, daysInMonth,
} from '../metrics.js';

const router = asyncRouter();
router.use(requireAuth);

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Twelve weeks of daily cells for the consistency heatmap. */
const HEATMAP_DAYS = 84;

/**
 * Loads every study row the metrics functions need for one month, plus a
 * little slack either side so week rows clipped at the edges still resolve.
 */
async function monthInputs(userId, year, month) {
  const first = new Date(year, month, 1);
  const last = new Date(year, month, daysInMonth(year, month));
  const from = dayKey(addDays(weekStart(first), -7));
  const to = dayKey(addDays(last, 7));
  return {
    entries: await entriesBetween(userId, from, to),
    plan: await planRows(userId),
  };
}

/** Shapes a metric block for the client: raw minutes plus display strings. */
function decorate({ studied, planned }) {
  return {
    studied,
    planned,
    studiedText: formatMinutes(studied),
    plannedText: formatMinutes(planned),
    ratio: ratio(studied, planned),
    met: planned > 0 && studied >= planned,
  };
}

/**
 * Resolves a client-supplied tag to one this user actually owns.
 *
 * Anything absent, non-numeric or belonging to somebody else becomes null, so
 * a study entry can never be filed under a tag that is not theirs — or be
 * rejected outright for carrying one.
 */
async function ownedTagId(userId, raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const tagId = Number(raw);
  if (!Number.isInteger(tagId)) return null;
  const row = await db.prepare('SELECT id FROM tags WHERE id = ? AND user_id = ?').get(tagId, userId);
  return row ? tagId : null;
}

// ── the single big read the Analytics pane uses ──────────────────────────

router.get('/overview', async (req, res) => {
  const user = await getUser(req.user.id);
  const now = new Date();
  const fallback = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  // An absent month means "the current one", which is what the footer stats
  // and the calendar ask for.
  const month = String(req.query.month || fallback).slice(0, 7);
  if (!MONTH_RE.test(month)) {
    return res.status(400).json({ error: 'month must look like YYYY-MM' });
  }
  const [year, mo] = month.split('-').map(Number);
  const monthIndex = mo - 1;

  const today = new Date();
  const { entries, plan } = await monthInputs(req.user.id, year, monthIndex);

  const todayKey = localDate(today);
  const todayStats = dayTotals(entries, plan, today);
  const weekStats = weekTotals(entries, plan, weekStart(today));

  // Which day the `today` block describes. It can be asked for another one so
  // the Analytics date picker does not have to refetch the whole overview (and
  // rebuild every chart) to move a single box — see swapTodayPane.
  //
  // A date in a *different month* is refused rather than answered from this
  // month's rows: monthInputs only loaded this month, so the figures would come
  // back zero and quietly overwrite the day with a wrong number. The client
  // switches month first in that case.
  let focusDate = today;
  if (req.query.date) {
    const raw = String(req.query.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return res.status(400).json({ error: 'date must look like YYYY-MM-DD' });
    }
    try {
      parseDay(raw);
    } catch {
      return res.status(400).json({ error: 'That is not a real calendar date.' });
    }
    // Not in the future: logging time you have not studied yet is never a thing.
    if (raw > todayKey) {
      return res.status(400).json({ error: 'That day has not happened yet.' });
    }
    if (raw.slice(0, 7) !== month) {
      return res.status(409).json({
        error: 'That day is in another month.',
        month: raw.slice(0, 7),
      });
    }
    focusDate = new Date(`${raw}T00:00:00`);
  }
  const focusStats = focusDate === today ? todayStats : dayTotals(entries, plan, focusDate);

  const summary = monthSummary(entries, plan, year, monthIndex);
  const chart = chartSeries(entries, plan, year, monthIndex,
    req.query.mode === 'weekly' ? 'weekly' : 'daily');

  return res.json({
    month,
    // Named `today` because that is what the client's Today pane reads; `date`
    // carries which day it is actually about, so the client can tell a moved
    // focus from a stale response.
    today: { ...decorate(focusStats), date: focusStats.date, active: focusStats.active },
    week: {
      ...decorate(weekStats),
      start: weekStats.start,
      end: weekStats.end,
      byDay: weekStats.byDay.map((d) => ({ ...d, ...decorate(d) })),
    },
    // The Mon–Sun plan grid, always ordered Monday first regardless of today.
    planGrid: weekStats.byDay,
    month: {
      ...summary,
      weeks: summary.weeks.map((w) => ({ ...w, ...decorate(w) })),
    },
    chart,
  });
});

// ── daily entry ──────────────────────────────────────────────────────────

router.put('/entry', async (req, res) => {
  const date = String(req.body?.date || '');
  const minutes = Number(req.body?.minutes);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must look like YYYY-MM-DD' });
  }
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60) {
    return res.status(400).json({ error: 'minutes must be between 0 and 1440' });
  }
  try {
    parseDay(date);
  } catch {
    return res.status(400).json({ error: 'That is not a real calendar date.' });
  }

  const before = await db.prepare('SELECT minutes FROM study_entries WHERE user_id = ? AND date = ?')
    .get(req.user.id, date);
  await upsertEntry(req.user.id, date, Math.round(minutes), 'manual', null);

  // The ledger records the change, not the resulting total: saving 30 then 60
  // on the same day is two rows, and lowering the day again is a negative one.
  // That is what makes the Logs feed read as a journal that adds up.
  const delta = Math.round(minutes) - (before?.minutes ?? 0);
  if (delta !== 0) {
    const tagId = await ownedTagId(req.user.id, req.body?.tagId);
    await recordStudyChange(req.user.id, { date, minutes: delta, source: 'manual', tagId });
  }

  const rows = await db.prepare('SELECT date, minutes FROM study_entries WHERE user_id = ? AND date = ?')
    .all(req.user.id, date);
  return res.json({ date, ...decorate({ studied: rows[0]?.minutes ?? 0, planned: 0 }) });
});

// ── weekly plan ticks and per-day planned hours ──────────────────────────

router.put('/plan', async (req, res) => {
  const raw = req.body?.weekday;
  const { active, planned_minutes: plannedMinutes } = req.body || {};
  // Number(null) is 0 and Number('') is 0, so a client that sends `weekday: null`
  // — or omits it entirely, since undefined arrives the same way through a
  // destructured body — used to be silently written to Sunday instead of being
  // told the field was wrong. Coerce from the raw value and reject anything
  // that was not already a number or a clean numeric string.
  const day = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) {
    return res.status(400).json({ error: 'weekday must be 0 (Sunday) to 6 (Saturday)' });
  }

  const existing = await db.prepare(
    'SELECT * FROM study_plans WHERE user_id = ? AND weekday = ?',
  ).get(req.user.id, day);

  const next = {
    // Boolean('false') is true, so a client sending a JSON-stringified boolean
    // silently inverted the tick. Accept the real booleans and the strings a
    // form post produces, and treat anything else as absent.
    active: active === undefined
      ? Boolean(existing?.active)
      : (active === true || active === 'true' || active === 1),
    minutes: plannedMinutes === undefined
      ? (existing?.planned_minutes ?? 0)
      : Math.max(0, Math.min(24 * 60, Math.round(Number(plannedMinutes) || 0))),
  };

  await db.prepare(`
    INSERT INTO study_plans (user_id, weekday, planned_minutes, active) VALUES (?,?,?,?)
    ON CONFLICT(user_id, weekday) DO UPDATE SET planned_minutes = excluded.planned_minutes, active = excluded.active
  `).run(req.user.id, day, next.minutes, next.active ? 1 : 0);

  // The weekly total is derived, never stored, so it updates as a side effect.
  const rows = await planRows(req.user.id);
  const thisWeek = weekTotals([], rows, weekStart(new Date()));
  return res.json({
    weekday: day,
    ...next,
    weekly: decorate({ studied: 0, planned: thisWeek.planned }),
  });
});

router.put('/plan/all', async (req, res) => {
  const rows = Array.isArray(req.body?.plan) ? req.body.plan : [];
  const stmt = await db.prepare(`
    INSERT INTO study_plans (user_id, weekday, planned_minutes, active) VALUES (?,?,?,?)
    ON CONFLICT(user_id, weekday) DO UPDATE SET planned_minutes = excluded.planned_minutes, active = excluded.active
  `);
  for (const r of rows) {
    const day = Number(r?.weekday);
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    // Awaited: the response below re-reads the plan, so an un-awaited write
    // could be answered with the values it just replaced. That is invisible
    // against a local file and a real race over Turso, where the round trip
    // outlasts the read.
    await stmt.run(req.user.id, day,
      Math.max(0, Math.min(24 * 60, Math.round(Number(r.planned_minutes) || 0))),
      r.active ? 1 : 0);
  }
  res.json({ plan: await planRows(req.user.id) });
});

// ── timer session completion (drives the auto-add toggle) ────────────────

router.post('/sessions', async (req, res) => {
  // A pomodoro cannot exceed a day, and the manual /entry route already caps at
  // 1440 minutes. Unbounded, a client sending focus_seconds: 999999 logged
  // 16,666,666 minutes into study_entries — a figure past every chart's
  // assumptions, and one no edit could later bring back into range.
  const MAX_SESSION_SECONDS = 24 * 60 * 60;
  const seconds = Math.min(
    MAX_SESSION_SECONDS,
    Math.max(0, Math.round(Number(req.body?.focus_seconds) || 0)),
  );
  const topic = String(req.body?.topic || '').slice(0, 40);
  const kind = req.body?.kind === 'break' ? 'break' : 'focus';
  const tagId = await ownedTagId(req.user.id, req.body?.tagId);

  const info = await db.prepare(
    'INSERT INTO timer_sessions (user_id, topic, kind, ended_at, focus_seconds) VALUES (?,?,?,?,?)',
  ).run(req.user.id, topic, kind, new Date().toISOString(), seconds);
  const sessionId = Number(info.lastInsertRowid);

  // Break time is never study time, and the auto-add toggle can be off.
  let added = 0;
  if (kind === 'focus' && seconds > 0) {
    const user = await getUser(req.user.id);
    if (user?.settings?.autoLogStudy) {
      const date = localDate();
      const row = await db.prepare('SELECT minutes FROM study_entries WHERE user_id = ? AND date = ?')
        .get(req.user.id, date);
      // Whole minutes only. The rollup and the ledger are read by different
      // screens (every chart reads study_entries, the Logs feed and the
      // per-tag breakdown read study_log_entries), and recordStudyChange
      // rounds — so an unrounded 1.5 here left the day and the log permanently
      // a half-minute apart.
      added = Math.round(seconds / 60);
      if (added > 0) {
        await db.prepare(`
          INSERT INTO study_entries (user_id, date, minutes, source, session_id, updated_at)
          VALUES (?,?,?,'timer',?,?)
          ON CONFLICT(user_id, date) DO UPDATE SET
            minutes = study_entries.minutes + excluded.minutes,
            source = 'timer', session_id = excluded.session_id, updated_at = excluded.updated_at
        `).run(req.user.id, date, added, sessionId, new Date().toISOString());
        await recordStudyChange(req.user.id, {
          date, minutes: added, source: 'timer', sessionId, tagId,
        });
      }
    }
  }

  return res.json({ sessionId, loggedMinutes: added, autoLogged: added > 0, tagId });
});

// ── the study log feed ───────────────────────────────────────────────────

/**
 * The ledger, newest first, paginated by id.
 *
 * Manual changes and finished pomodoros come from one table, which is what
 * lets the client colour them differently and sum them together.
 */
router.get('/logs', async (req, res) => {
  // Truncated to an integer: a fractional limit reached SQLite as `LIMIT 2.5`
  // and raised SQLITE_MISMATCH, which the error middleware turned into a 500.
  const asked = Math.trunc(Number(req.query.limit));
  const limit = Number.isFinite(asked) ? Math.min(200, Math.max(1, asked)) : 60;
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;

  // hasMore cannot be inferred from a full page alone: when the row count is an
  // exact multiple of the limit, `rows.length === limit` is true on the LAST
  // page too, so the feed kept offering to load older entries and paging never
  // terminated. Fetch one extra row instead and report whether it was real.
  const more = await studyLedgerPage(req.user.id, before, limit + 1);
  const rows = more.slice(0, limit);

  return res.json({
    entries: rows.map((r) => ({
      id: r.id,
      date: r.date,
      minutes: r.minutes,
      source: r.source,
      tag: r.tag_id ? { id: r.tag_id, name: r.tag_name, color: r.tag_color } : null,
      createdAt: r.created_at,
    })),
    hasMore: more.length > limit,
  });
});

/**
 * Deletes one ledger row and reverses its effect on the day.
 *
 * Both halves run in a transaction: a row removed without its minutes being
 * given back would leave the Logs feed and the calendar permanently disagreeing
 * about how much was studied.
 */
router.delete('/logs/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'That is not a log entry.' });

  const entry = await studyChange(req.user.id, id);
  if (!entry) return res.status(404).json({ error: 'No such entry' });

  await reverseStudyChange(req.user.id, entry);

  const row = await db.prepare('SELECT minutes FROM study_entries WHERE user_id = ? AND date = ?')
    .get(req.user.id, entry.date);
  return res.json({
    ok: true,
    date: entry.date,
    ...decorate({ studied: row?.minutes ?? 0, planned: 0 }),
  });
});

// ── the extra Analytics charts ───────────────────────────────────────────

/**
 * Everything the three new charts need, in one read.
 *
 * The heatmap deliberately spans 84 days ending today rather than the selected
 * month: a grid of a partial month looks like a mostly-empty box and says
 * nothing about consistency.
 */
router.get('/insights', async (req, res) => {
  const now = new Date();
  const fallback = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const month = String(req.query.month || fallback).slice(0, 7);
  if (!MONTH_RE.test(month)) {
    return res.status(400).json({ error: 'month must look like YYYY-MM' });
  }
  const [year, mo] = month.split('-').map(Number);
  const monthIndex = mo - 1;

  const first = new Date(year, monthIndex, 1);
  const last = new Date(year, monthIndex, daysInMonth(year, monthIndex));

  // Heatmap window: whole weeks, so columns line up on Mondays.
  const today = localDate(now);
  const heatFrom = dayKey(addDays(new Date(`${today}T00:00:00`), -(HEATMAP_DAYS - 1)));
  const heat = await entriesBetween(req.user.id, heatFrom, today);
  const heatByKey = new Map(heat.map((e) => [e.date, e.minutes]));

  const heatmap = [];
  for (let i = 0; i < HEATMAP_DAYS; i += 1) {
    const key = dayKey(addDays(new Date(`${heatFrom}T00:00:00`), i));
    heatmap.push({ key, minutes: heatByKey.get(key) ?? 0 });
  }

  // Cumulative study against cumulative plan across the month.
  const entries = await entriesBetween(req.user.id, dayKey(first), dayKey(last));
  const plan = await planRows(req.user.id);
  const series = chartSeries(entries, plan, year, monthIndex, 'daily');
  let studiedSoFar = 0;
  let plannedSoFar = 0;
  const cumulative = series.points.map((point) => {
    studiedSoFar += point.value;
    plannedSoFar += point.planned;
    return { label: point.label, studied: studiedSoFar, planned: plannedSoFar };
  });

  const byTag = await studyMinutesByTag(req.user.id, dayKey(first), dayKey(last));

  return res.json({
    month,
    heatmap: { from: heatFrom, to: today, max: Math.max(1, ...heatmap.map((h) => h.minutes)), points: heatmap },
    cumulative: { points: cumulative, studiedTotal: studiedSoFar, plannedTotal: plannedSoFar },
    byTag: byTag
      .filter((t) => t.minutes !== 0)
      .map((t) => ({ id: t.id, name: t.name, color: t.color, minutes: Math.round(t.minutes) })),
  });
});

export default router;
