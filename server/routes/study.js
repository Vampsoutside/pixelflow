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

  const summary = monthSummary(entries, plan, year, monthIndex);
  const chart = chartSeries(entries, plan, year, monthIndex,
    req.query.mode === 'weekly' ? 'weekly' : 'daily');

  return res.json({
    month,
    today: { ...decorate(todayStats), date: todayStats.date, active: todayStats.active },
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
  const { weekday, active, planned_minutes: plannedMinutes } = req.body || {};
  const day = Number(weekday);
  if (!Number.isInteger(day) || day < 0 || day > 6) {
    return res.status(400).json({ error: 'weekday must be 0 (Sunday) to 6 (Saturday)' });
  }

  const existing = await db.prepare(
    'SELECT * FROM study_plans WHERE user_id = ? AND weekday = ?',
  ).get(req.user.id, day);

  const next = {
    active: active === undefined ? Boolean(existing?.active) : Boolean(active),
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
    stmt.run(req.user.id, day,
      Math.max(0, Math.min(24 * 60, Math.round(Number(r.planned_minutes) || 0))),
      r.active ? 1 : 0);
  }
  res.json({ plan: await planRows(req.user.id) });
});

// ── timer session completion (drives the auto-add toggle) ────────────────

router.post('/sessions', async (req, res) => {
  const seconds = Math.max(0, Math.round(Number(req.body?.focus_seconds) || 0));
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
      added = seconds / 60;
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
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = await studyLedgerPage(req.user.id, before, limit);

  return res.json({
    entries: rows.map((r) => ({
      id: r.id,
      date: r.date,
      minutes: r.minutes,
      source: r.source,
      tag: r.tag_id ? { id: r.tag_id, name: r.tag_name, color: r.tag_color } : null,
      createdAt: r.created_at,
    })),
    hasMore: rows.length === limit,
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
