import { asyncRouter } from '../http.js';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { log } from '../store.js';

const router = asyncRouter();
router.use(requireAuth);

const KINDS = [
  'session', 'task', 'tag', 'plan', 'study', 'friend', 'account', 'timer', 'xp',
];

router.get('/', async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const filter = KINDS.includes(String(req.query.kind)) ? String(req.query.kind) : null;

  const rows = filter
    ? await db.prepare('SELECT * FROM logs WHERE user_id = ? AND kind = ? AND id < ? ORDER BY id DESC LIMIT ?')
      .all(req.user.id, filter, before, limit)
    : await db.prepare('SELECT * FROM logs WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
      .all(req.user.id, before, limit);

  const counts = await db.prepare('SELECT kind, COUNT(*) AS n FROM logs WHERE user_id = ? GROUP BY kind')
    .all(req.user.id);

  res.json({
    entries: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      message: r.message,
      payload: JSON.parse(r.payload || '{}'),
      createdAt: r.created_at,
    })),
    counts: Object.fromEntries(counts.map((c) => [c.kind, c.n])),
    hasMore: rows.length === limit,
  });
});

router.post('/', async (req, res) => {
  const kind = KINDS.includes(String(req.body?.kind)) ? req.body.kind : 'timer';
  const message = String(req.body?.message || '').trim().slice(0, 200);
  if (!message) return res.status(400).json({ error: 'A log entry needs a message.' });
  await log(req.user.id, kind, message, req.body?.payload || {});
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  await db.prepare('DELETE FROM logs WHERE id = ? AND user_id = ?')
    .run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

export default router;
