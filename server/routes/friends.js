import { asyncRouter } from '../http.js';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import {
  getUser, findFriendship, acceptedFriendIds, upsertPresence, presenceFor,
  minutesBetween, loggedDayKeys, pomodoroCount, log,
} from '../store.js';
import { localDate } from '../db.js';
import {
  dayKey, addDays, weekStart, planIndex, weekTotals, streakFromDays, formatMinutes,
} from '../metrics.js';

const router = asyncRouter();
router.use(requireAuth);

/** The public shape of a friend row, built from real server-side data. */
async function friendCard(friendId, viewerId) {
  const user = await getUser(friendId);
  if (!user) return null;

  const today = new Date();
  const todayKey = localDate(today);
  const monday = weekStart(today);

  const entries = await db.prepare(
    'SELECT date, minutes FROM study_entries WHERE user_id = ? AND date >= ?',
  ).all(friendId, dayKey(addDays(monday, -30)));

  const plan = planIndex(await db.prepare(
    'SELECT weekday, planned_minutes, active FROM study_plans WHERE user_id = ?',
  ).all(friendId));

  const week = weekTotals(entries, plan, monday);
  const todayMinutes = await minutesBetween(friendId, todayKey, todayKey);
  const todayPlanned = plan.get(today.getDay())?.active ? plan.get(today.getDay()).planned_minutes : 0;
  const presence = await presenceFor(friendId);

  return {
    id: user.id,
    username: user.username,
    level: user.level,
    xp: user.xp,
    avatar: user.avatar,
    today: { minutes: todayMinutes, text: formatMinutes(todayMinutes), planned: todayPlanned },
    week: { minutes: week.studied, text: formatMinutes(week.studied), planned: week.planned },
    streak: streakFromDays(await loggedDayKeys(friendId, dayKey(addDays(today, -60))), todayKey),
    pomodoros: await pomodoroCount(friendId),
    presence,
  };
}

// ── search + send / accept / decline ─────────────────────────────────────

router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ users: [] });

  const rows = await db.prepare(`
    SELECT id, username FROM users
    WHERE username LIKE ? AND id <> ?
    ORDER BY username COLLATE NOCASE LIMIT 20
  `).all(`%${q}%`, req.user.id);

  res.json({
    users: await Promise.all(rows.map(async (r) => {
      const link = await findFriendship(req.user.id, r.id);
      return {
        id: r.id,
        username: r.username,
        relation: link
          ? (link.status === 'accepted' ? 'friends' : (link.requester_id === req.user.id ? 'outgoing' : 'incoming'))
          : 'none',
      };
    })),
  });
});

router.post('/request', async (req, res) => {
  const target = Number(req.body?.userId);
  if (!Number.isInteger(target) || target === req.user.id) {
    return res.status(400).json({ error: 'Pick someone else to befriend.' });
  }
  const other = await getUser(target);
  if (!other) return res.status(404).json({ error: 'No such user' });

  const existing = await findFriendship(req.user.id, target);
  if (existing?.status === 'accepted') {
    return res.status(409).json({ error: `You and ${other.username} are already friends.` });
  }
  if (existing) {
    // They already asked you, so this counts as accepting it.
    await db.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").run(existing.id);
    await log(req.user.id, 'friend', `You and ${other.username} are now friends`, { userId: target });
    return res.json({ status: 'friends' });
  }

  await db.prepare(
    "INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?,?,'pending')",
  ).run(req.user.id, target);
  await log(req.user.id, 'friend', `Friend request sent to ${other.username}`, { userId: target });
  return res.json({ status: 'outgoing' });
});

router.post('/respond', async (req, res) => {
  const id = Number(req.body?.requestId);
  const accept = req.body?.accept !== false;
  const row = await db.prepare("SELECT * FROM friendships WHERE id = ? AND status = 'pending'").get(id);
  if (!row || row.addressee_id !== req.user.id) {
    return res.status(404).json({ error: 'That request is no longer pending.' });
  }
  if (accept) {
    await db.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").run(id);
  } else {
    await db.prepare('DELETE FROM friendships WHERE id = ?').run(id);
  }
  const other = await getUser(row.requester_id);
  await log(req.user.id, 'friend',
    accept ? `You and ${other?.username} are now friends` : `Declined ${other?.username}'s request`,
    { userId: row.requester_id });
  return res.json({ status: accept ? 'friends' : 'none' });
});

router.delete('/:friendId', async (req, res) => {
  const target = Number(req.params.friendId);
  const existing = await findFriendship(req.user.id, target);
  if (existing) await db.prepare('DELETE FROM friendships WHERE id = ?').run(existing.id);
  res.json({ ok: true });
});

// ── the list, requests and leaderboard ────────────────────────────────────

router.get('/', async (req, res) => {
  const me = req.user.id;
  const ids = await acceptedFriendIds(me);
  const friends = (await Promise.all(ids.map((id) => friendCard(id, me)))).filter(Boolean);

  const requestRows = await db.prepare(`
    SELECT f.id, f.created_at, u.id AS user_id, u.username, u.level
    FROM friendships f JOIN users u ON u.id = f.requester_id
    WHERE f.addressee_id = ? AND f.status = 'pending'
  `).all(me);
  const requests = requestRows.map((r) => ({
    requestId: r.id, id: r.user_id, username: r.username,
    level: r.level, since: r.created_at,
  }));

  const outgoingRows = await db.prepare(`
    SELECT f.id, f.created_at, u.id AS user_id, u.username
    FROM friendships f JOIN users u ON u.id = f.addressee_id
    WHERE f.requester_id = ? AND f.status = 'pending'
  `).all(me);
  const outgoing = outgoingRows.map((r) => ({
    requestId: r.id, id: r.user_id, username: r.username, since: r.created_at,
  }));

  // Ranked by this week's studied minutes; the viewer's own card is included
  // so the leaderboard shows where you stand among your friends.
  const board = [...friends.map((f) => ({
    id: f.id, username: f.username, level: f.level,
    week: f.week, streak: f.streak, pomodoros: f.pomodoros,
    me: false, presence: f.presence,
  }))];

  const own = await friendCard(me, me);
  if (own) {
    board.push({
      id: own.id, username: own.username, level: own.level,
      week: own.week, streak: own.streak, pomodoros: own.pomodoros,
      me: true, presence: own.presence,
    });
  }
  board.sort((a, b) => b.week.minutes - a.week.minutes || b.streak - a.streak);
  board.forEach((row, i) => { row.rank = i + 1; });

  res.json({
    friends: friends.sort((a, b) => b.week.minutes - a.week.minutes),
    requests,
    outgoing,
    leaderboard: board,
  });
});

// ── presence ─────────────────────────────────────────────────────────────

router.post('/presence', async (req, res) => {
  const state = ['online', 'away', 'offline'].includes(req.body?.state)
    ? req.body.state
    : 'offline';
  await upsertPresence(req.user.id, state, String(req.body?.activity || '').slice(0, 40));
  res.json({ ok: true });
});

export default router;
