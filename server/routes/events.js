import { asyncRouter } from '../http.js';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { eventsBetween } from '../store.js';
import { parseDay, dayKey } from '../metrics.js';

/**
 * Events and deadlines.
 *
 * These are deliberately inert with respect to study data. Nothing in this file
 * touches study_entries, study_plans or timer_sessions, which is the property
 * that lets a calendar item be added without moving a total, a streak, a
 * pomodoro count or any chart. If a future change needs an item to reserve
 * study time, that is a different feature with a different data model.
 */

const router = asyncRouter();
router.use(requireAuth);

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** First and last day of a 'YYYY-MM' prefix, as 'YYYY-MM-DD' keys. */
function monthBounds(month) {
  const [year, mo] = month.split('-').map(Number);
  const first = new Date(year, mo - 1, 1);
  const last = new Date(year, mo, 0);
  return { from: dayKey(first), to: dayKey(last) };
}

/**
 * Validates a create/update body.
 *
 * Returns `{ ok: true, value }` or `{ ok: false, error }` so every route answers
 * the same 400 shape. A deadline has no clock time, so one is dropped rather
 * than stored and then hidden.
 */
function readItem(body) {
  const title = String(body?.title || '').trim().slice(0, 120);
  if (!title) return { ok: false, error: 'Give it a title.' };

  const date = String(body?.date || '');
  if (!DATE_RE.test(date)) return { ok: false, error: 'date must look like YYYY-MM-DD' };
  try {
    parseDay(date);
  } catch {
    return { ok: false, error: 'That is not a real calendar date.' };
  }

  const kind = body?.kind === 'deadline' ? 'deadline' : 'event';

  const rawTime = String(body?.time || '').trim();
  let time = null;
  if (rawTime) {
    if (kind === 'deadline') {
      // A deadline is a day, not a moment. Silently keeping the time would show
      // a time the UI never renders, so the rule is enforced in the data.
      return { ok: false, error: 'A deadline has no time of day.' };
    }
    if (!TIME_RE.test(rawTime)) return { ok: false, error: 'time must look like HH:MM' };
    time = rawTime;
  }

  const minutes = Number(body?.minutes);
  const safeMinutes = Number.isFinite(minutes)
    ? Math.max(0, Math.min(24 * 60, Math.round(minutes)))
    : 0;

  return {
    ok: true,
    value: { date, kind, title, time, minutes: safeMinutes },
  };
}

/** True when the tag exists and belongs to this user. */
async function ownsTag(userId, raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const tagId = Number(raw);
  if (!Number.isInteger(tagId)) return null;
  const row = await db.prepare('SELECT id FROM tags WHERE id = ? AND user_id = ?').get(tagId, userId);
  return row ? tagId : null;
}

/** Everything in one month, with the tag each item carries. */
router.get('/', async (req, res) => {
  const month = String(req.query.month || '').slice(0, 7) || undefined;
  if (month && !MONTH_RE.test(month)) {
    return res.status(400).json({ error: 'month must look like YYYY-MM' });
  }
  const { from, to } = month
    ? monthBounds(month)
    : monthBounds(new Date().toISOString().slice(0, 7));

  return res.json({ events: await eventsBetween(req.user.id, from, to) });
});

router.post('/', async (req, res) => {
  const parsed = readItem(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const tagId = await ownsTag(req.user.id, req.body?.tagId);
  const { date, kind, title, time, minutes } = parsed.value;
  const info = await db.prepare(`
    INSERT INTO events (user_id, date, kind, title, time, minutes, tag_id)
    VALUES (?,?,?,?,?,?,?)
  `).run(req.user.id, date, kind, title, time, minutes, tagId);

  const { from, to } = monthBounds(date.slice(0, 7));
  return res.json({
    id: Number(info.lastInsertRowid),
    events: await eventsBetween(req.user.id, from, to),
  });
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?')
    .get(id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'No such item' });

  // Fields are optional here: an edit that only ticks something done should not
  // have to resend the title, and one that only renames should not clear the
  // tag. Anything absent keeps its current value.
  let next = {
    date: existing.date,
    kind: existing.kind,
    title: existing.title,
    time: existing.time,
    minutes: existing.minutes,
  };

  const body = req.body || {};
  if (body.title !== undefined || body.date !== undefined || body.kind !== undefined
      || body.time !== undefined || body.minutes !== undefined) {
    const parsed = readItem({
      title: body.title ?? existing.title,
      date: body.date ?? existing.date,
      kind: body.kind ?? existing.kind,
      time: body.time ?? existing.time ?? '',
      minutes: body.minutes ?? existing.minutes,
    });
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    next = parsed.value;
  }

  const tagId = body.tagId !== undefined
    ? await ownsTag(req.user.id, body.tagId)
    : existing.tag_id;

  const done = body.done === undefined ? existing.done : (body.done ? 1 : 0);

  await db.prepare(`
    UPDATE events SET date = ?, kind = ?, title = ?, time = ?, minutes = ?, tag_id = ?, done = ?
    WHERE id = ? AND user_id = ?
  `).run(next.date, next.kind, next.title, next.time, next.minutes, tagId, done, id, req.user.id);

  const { from, to } = monthBounds(next.date.slice(0, 7));
  return res.json({ events: await eventsBetween(req.user.id, from, to) });
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?')
    .get(id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'No such item' });

  await db.prepare('DELETE FROM events WHERE id = ? AND user_id = ?').run(id, req.user.id);
  const { from, to } = monthBounds(existing.date.slice(0, 7));
  return res.json({ events: await eventsBetween(req.user.id, from, to) });
});

export default router;