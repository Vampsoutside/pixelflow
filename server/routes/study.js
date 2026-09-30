import { asyncRouter } from '../http.js';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { localDate } from '../db.js';
import {
  planRows, entriesBetween, upsertEntry, log, getUser,
} from '../store.js';
import {
  parseDay, dayKey, addDays, weekStart, weekTotals, dayTotals,
  monthSummary, chartSeries, formatMinutes, ratio, daysInMonth,
} from '../metrics.js';

const router = asyncRouter();
router.use(requireAuth);

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

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

  const delta = Math.round(minutes) - (before?.minutes ?? 0);
  if (delta !== 0) {
    await log(req.user.id, 'study',
      delta > 0
        ? `Logged ${formatMinutes(delta)} of study for ${date}`
        : `Removed ${formatMinutes(-delta)} from ${date}`,
      { date, minutes: Math.round(minutes), delta });
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

  if (active !== undefined) {
    await log(req.user.id, 'plan',
      `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day]} `
      + `${next.active ? 'added to' : 'removed from'} the weekly plan`,
      { weekday: day, active: next.active, planned_minutes: next.minutes });
  }

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
  await log(req.user.id, 'plan', 'Weekly plan updated', { rows: rows.length });
  res.json({ plan: await planRows(req.user.id) });
});

// ── timer session completion (drives the auto-add toggle) ────────────────

router.post('/sessions', async (req, res) => {
  const seconds = Math.max(0, Math.round(Number(req.body?.focus_seconds) || 0));
  const topic = String(req.body?.topic || '').slice(0, 40);
  const kind = req.body?.kind === 'break' ? 'break' : 'focus';

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
      await log(req.user.id, 'session',
        `Finished a ${formatMinutes(added)} ${topic || 'focus'} session — added to today`,
        { session_id: sessionId, minutes: added, topic });
    }
  }

  return res.json({ sessionId, loggedMinutes: added, autoLogged: added > 0 });
});

export default router;
