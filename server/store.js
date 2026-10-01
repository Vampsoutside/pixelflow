import { db, tx, nowIso } from './db.js';

/**
 * Shared queries and small business helpers used across the route modules.
 * Keeping them here means the routes stay thin and the SQL lives in one place.
 */

// ── users ────────────────────────────────────────────────────────────────

export const DEFAULT_AVATAR = {
  companion: 'none',
  gender: 'female',
  skin: '#f5c5a3',
  hair: '#4a2c2a',
  outfit: '#7c6fff',
  hat: 'none',
  glasses: false,
  outline: true,
  deskTint: '#7a5c14',
  backdrop: 'default',
  focusPose: 'desk',
  breakPose: 'coffee',
  presets: [],
};

export const DEFAULT_SETTINGS = {
  focusMins: 25,
  shortBreak: 5,
  longBreak: 15,
  pomsBefore: 4,
  sound: true,
  notifs: false,
  friendActivity: true,
  autoStartBreak: true,
  autoLogStudy: true,
  // The tag a finished pomodoro files itself under. Focus topics used to be a
  // hardcoded list in the browser that was lost on reload; they are tags now.
  activeTagId: null,
  activeTopic: 'Study',
};

function parseJson(text, fallback) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export async function getUser(id) {
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    // True while the account is a throwaway guest session that has never been
    // given a password. The client uses this to prompt for one.
    isGuest: Boolean(row.is_guest),
    xp: row.xp,
    level: row.level,
    createdAt: row.created_at,
    avatar: { ...DEFAULT_AVATAR, ...parseJson(row.avatar_json, {}) },
    settings: { ...DEFAULT_SETTINGS, ...parseJson(row.settings_json, {}) },
  };
}

export async function saveUserFields(id, { avatar, settings } = {}) {
  // The client always sends complete objects, so a full replace is correct.
  if (avatar && settings) {
    await db.prepare('UPDATE users SET avatar_json = ?, settings_json = ? WHERE id = ?')
      .run(JSON.stringify(avatar), JSON.stringify(settings), id);
    return;
  }
  if (avatar) {
    await db.prepare('UPDATE users SET avatar_json = ? WHERE id = ?')
      .run(JSON.stringify(avatar), id);
  }
  if (settings) {
    await db.prepare('UPDATE users SET settings_json = ? WHERE id = ?')
      .run(JSON.stringify(settings), id);
  }
}

export async function addXp(userId, amount) {
  const row = await db.prepare('SELECT xp FROM users WHERE id = ?').get(userId);
  if (!row) return;
  const xp = row.xp + amount;
  // Every 100 XP is one level, matching the prototype's LVL 7 at 620/1000 XP.
  const level = Math.floor(xp / 100) + 1;
  await db.prepare('UPDATE users SET xp = ?, level = ? WHERE id = ?').run(xp, level, userId);
}

// ── OAuth state ──────────────────────────────────────────────────────────

/**
 * Atomically consumes a sign-in state row, returning it or undefined.
 *
 * The read has to happen before the delete: a DELETE returns no rows, so
 * trying to read the row out of the DELETE always yields undefined and every
 * callback looks like a forgery. Doing both in one transaction is what stops
 * two callbacks carrying the same state from both being accepted.
 */
export async function consumeLoginState(state, provider) {
  return tx(async (t) => {
    const row = await t.prepare(
      'SELECT * FROM oauth_login_states WHERE state = ? AND provider = ?',
    ).get(state, provider);
    if (row) await t.prepare('DELETE FROM oauth_login_states WHERE state = ?').run(state);
    return row;
  });
}

/** The same single-use consumption for the "connect a provider" flow. */
export async function consumeLinkState(state) {
  return tx(async (t) => {
    const row = await t.prepare('SELECT * FROM oauth_states WHERE state = ?').get(state);
    if (row) await t.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
    return row;
  });
}

// ── study data ───────────────────────────────────────────────────────────

export async function planRows(userId) {
  return await db.prepare('SELECT weekday, planned_minutes, active FROM study_plans WHERE user_id = ?')
    .all(userId);
}

/** Entries from `from` to `to` inclusive, both 'YYYY-MM-DD'. */
export async function entriesBetween(userId, from, to) {
  return await db.prepare(
    'SELECT date, minutes FROM study_entries WHERE user_id = ? AND date >= ? AND date <= ?',
  ).all(userId, from, to);
}

export async function upsertEntry(userId, date, minutes, source = 'manual', sessionId = null) {
  await db.prepare(`
    INSERT INTO study_entries (user_id, date, minutes, source, session_id, updated_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(user_id, date) DO UPDATE SET
      minutes = excluded.minutes,
      source = excluded.source,
      session_id = excluded.session_id,
      updated_at = excluded.updated_at
  `).run(userId, date, minutes, source, sessionId, nowIso());
}

/** Adds minutes onto whatever is already logged for that day. */
export async function addEntryMinutes(userId, date, minutes, sessionId = null) {
  const row = await db.prepare('SELECT minutes FROM study_entries WHERE user_id = ? AND date = ?')
    .get(userId, date);
  const next = Math.max(0, (row?.minutes ?? 0) + minutes);
  upsertEntry(userId, date, next, sessionId ? 'timer' : 'manual', sessionId);
  return next;
}

// ── study ledger ─────────────────────────────────────────────────────────

/**
 * Appends one signed change to a day's study total to the ledger that backs
 * the Logs feed.
 *
 * This deliberately does NOT touch study_entries. The caller owns the rollup so
 * there is exactly one place that decides a day's total, and so the ledger
 * cannot silently disagree with the number every chart reads. The one case
 * where the two can differ is documented on the table: a day lowered below what
 * the timer already contributed keeps the lower rollup.
 *
 * @param {number} userId
 * @param {{date:string, minutes:number, source:'manual'|'timer',
 *          sessionId?:number|null, tagId?:number|null}} change
 * @returns {Promise<number>} the new ledger row id
 */
export async function recordStudyChange(userId, { date, minutes, source, sessionId = null, tagId = null }) {
  const info = await db.prepare(`
    INSERT INTO study_log_entries (user_id, date, minutes, source, session_id, tag_id, created_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(userId, date, Math.round(minutes), source, sessionId, tagId, nowIso());
  return Number(info.lastInsertRowid);
}

/** One ledger row, or undefined when it is not this user's to read. */
export async function studyChange(userId, id) {
  return await db.prepare('SELECT * FROM study_log_entries WHERE id = ? AND user_id = ?')
    .get(id, userId);
}

/**
 * Reverses a ledger row's effect on its day's total.
 * Called when somebody deletes an entry from the Logs feed. Clamped at zero
 * because the ledger can read lower than the rollup (see the table comment), and
 * the rollout must never go negative.
 */
export async function reverseStudyChange(userId, entry) {
  await tx(async (t) => {
    await t.prepare('DELETE FROM study_log_entries WHERE id = ? AND user_id = ?')
      .run(entry.id, userId);
    const row = await t.prepare('SELECT minutes FROM study_entries WHERE user_id = ? AND date = ?')
      .get(userId, entry.date);
    if (!row) return;
    const next = Math.max(0, Math.round(row.minutes) - Math.round(entry.minutes));
    await t.prepare('UPDATE study_entries SET minutes = ?, updated_at = ? WHERE user_id = ? AND date = ?')
      .run(next, nowIso(), userId, entry.date);
  });
}

/**
 * One page of the study ledger, newest first, with the tag it was filed under.
 *
 * Cursor pagination on `id` rather than OFFSET so a row inserted mid-scroll
 * cannot shift the next page and duplicate or skip an entry.
 */
export async function studyLedgerPage(userId, before, limit) {
  return await db.prepare(`
    SELECT e.id, e.date, e.minutes, e.source, e.created_at,
           t.id AS tag_id, t.name AS tag_name, t.color AS tag_color
    FROM study_log_entries e
    LEFT JOIN tags t ON t.id = e.tag_id
    WHERE e.user_id = ? AND e.id < ?
    ORDER BY e.id DESC
    LIMIT ?
  `).all(userId, before, limit);
}

/** Hours filed under each tag, newest month included. Never splits a day. */
export async function studyMinutesByTag(userId, from, to) {
  return await db.prepare(`
    SELECT t.id, t.name, t.color, SUM(e.minutes) AS minutes
    FROM study_log_entries e
    JOIN tags t ON t.id = e.tag_id
    WHERE e.user_id = ? AND e.date >= ? AND e.date <= ?
    GROUP BY t.id, t.name, t.color
    ORDER BY minutes DESC, t.name COLLATE NOCASE
  `).all(userId, from, to);
}

// ── timer sessions ───────────────────────────────────────────────────────

export async function startSession(userId, topic, kind = 'focus') {
  const info = await db.prepare(
    'INSERT INTO timer_sessions (user_id, topic, kind) VALUES (?,?,?)',
  ).run(userId, topic, kind);
  return Number(info.lastInsertRowid);
}

export async function finishSession(sessionId, focusSeconds) {
  await db.prepare('UPDATE timer_sessions SET ended_at = ?, focus_seconds = ? WHERE id = ?')
    .run(nowIso(), focusSeconds, sessionId);
}

// ── friend graph ─────────────────────────────────────────────────────────

/** A pair of users can only have one relationship, stored in one direction. */
export async function findFriendship(a, b) {
  return await db.prepare(
    'SELECT * FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)',
  ).get(a, b, b, a);
}

export async function acceptedFriendIds(userId) {
  const rows = await db.prepare(
    'SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END AS id FROM friendships WHERE status = ? AND (requester_id = ? OR addressee_id = ?)',
  ).all(userId, 'accepted', userId, userId);
  return rows.map((r) => r.id);
}

// ── presence ─────────────────────────────────────────────────────────────

/** Anything not seen for 90s is reported as offline regardless of stored state. */
const PRESENCE_STALE_MS = 90_000;

export async function upsertPresence(userId, state, activity = '') {
  await db.prepare(`
    INSERT INTO presence (user_id, state, activity, last_seen_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, activity = excluded.activity, last_seen_at = excluded.last_seen_at
  `).run(userId, state, activity, nowIso());
}

export async function presenceFor(userId) {
  const row = await db.prepare('SELECT * FROM presence WHERE user_id = ?').get(userId);
  if (!row) return { state: 'offline', activity: '', lastSeenAt: null };
  const age = Date.now() - Date.parse(row.last_seen_at);
  if (Number.isNaN(age) || age > PRESENCE_STALE_MS) {
    return { state: 'offline', activity: '', lastSeenAt: row.last_seen_at };
  }
  return { state: row.state, activity: row.activity, lastSeenAt: row.last_seen_at };
}

// ── stats used by the friends list and leaderboard ────────────────────────

export async function minutesBetween(userId, from, to) {
  const row = await db.prepare(
    'SELECT COALESCE(SUM(minutes), 0) AS total FROM study_entries WHERE user_id = ? AND date >= ? AND date <= ?',
  ).get(userId, from, to);
  return row.total;
}

export async function loggedDayKeys(userId, sinceKey) {
  const rows = await db.prepare(
    'SELECT date FROM study_entries WHERE user_id = ? AND date >= ? AND minutes > 0',
  ).all(userId, sinceKey);
  return rows.map((r) => r.date);
}

export async function pomodoroCount(userId) {
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM timer_sessions WHERE user_id = ? AND kind = 'focus' AND ended_at IS NOT NULL",
  ).get(userId);
  return row.n;
}

// ── tags and tasks ───────────────────────────────────────────────────────

export async function tagWithCounts(userId) {
  return await db.prepare(`
    SELECT t.id, t.name, t.color,
      (SELECT COUNT(*) FROM tasks k WHERE k.user_id = t.user_id) AS total,
      (SELECT COUNT(*) FROM task_tags tt JOIN tasks k ON k.id = tt.task_id
        WHERE tt.tag_id = t.id AND k.done = 1) AS done
    FROM tags t WHERE t.user_id = ? ORDER BY t.name COLLATE NOCASE
  `).all(userId);
}

export async function tasksWithTags(userId) {
  const tasks = await db.prepare('SELECT id, text, done, done_at, created_at FROM tasks WHERE user_id = ? ORDER BY id DESC')
    .all(userId);
  const links = await db.prepare(`
    SELECT tt.task_id, t.id AS tag_id, t.name, t.color
    FROM task_tags tt JOIN tags t ON t.id = tt.tag_id
    JOIN tasks k ON k.id = tt.task_id
    WHERE k.user_id = ? ORDER BY t.name COLLATE NOCASE
  `).all(userId);
  const byTask = new Map();
  for (const l of links) {
    if (!byTask.has(l.task_id)) byTask.set(l.task_id, []);
    byTask.get(l.task_id).push({ id: l.tag_id, name: l.name, color: l.color });
  }
  return tasks.map((t) => ({
    id: t.id,
    text: t.text,
    done: Boolean(t.done),
    doneAt: t.done_at ?? null,
    createdAt: t.created_at,
    tags: byTask.get(t.id) || [],
  }));
}

// ── calendar items ───────────────────────────────────────────────────────

/**
 * Events and deadlines from `from` to `to` inclusive, both 'YYYY-MM-DD'.
 *
 * Read-only with respect to study data: nothing in this file or its callers
 * writes to study_entries or study_plans, which is what keeps an item from
 * moving a total, a streak or a chart.
 */
export async function eventsBetween(userId, from, to) {
  const rows = await db.prepare(`
    SELECT e.id, e.date, e.kind, e.title, e.time, e.minutes, e.done, e.created_at,
           t.id AS tag_id, t.name AS tag_name, t.color AS tag_color
    FROM events e
    LEFT JOIN tags t ON t.id = e.tag_id
    WHERE e.user_id = ? AND e.date >= ? AND e.date <= ?
    ORDER BY e.date ASC,
             CASE WHEN e.time IS NULL THEN 1 ELSE 0 END ASC,
             e.time ASC, e.id ASC
  `).all(userId, from, to);

  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    kind: r.kind,
    title: r.title,
    time: r.time ?? null,
    minutes: r.minutes,
    done: Boolean(r.done),
    createdAt: r.created_at,
    tag: r.tag_id ? { id: r.tag_id, name: r.tag_name, color: r.tag_color } : null,
  }));
}
