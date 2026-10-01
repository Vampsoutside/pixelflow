import { asyncRouter } from '../http.js';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { tagWithCounts } from '../store.js';

const router = asyncRouter();
router.use(requireAuth);

const TAG_COLORS = ['#7c6fff', '#ff6b9d', '#6bffda', '#ffb347', '#ff5555', '#44aaff', '#aaffaa', '#ffaaff'];
const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Every tag this user owns.
 *
 * The Tasks panel had only ever created and deleted tags, so there was no way
 * to read them. The timer's focus topics are tags, and the study log and the
 * calendar's item forms both offer a tag picker, so something outside Tasks
 * needs the list.
 */
router.get('/', async (req, res) => {
  res.json({ tags: await tagWithCounts(req.user.id) });
});

router.post('/', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 32);
  if (!name) return res.status(400).json({ error: 'A tag needs a name.' });

  const dupe = await db.prepare('SELECT id FROM tags WHERE user_id = ? AND name = ?')
    .get(req.user.id, name);
  if (dupe) return res.status(409).json({ error: 'You already have that tag.' });

  // `await db.prepare(…).get(…).n` awaits the *property*, not the query, so it
  // read undefined, indexed the palette with NaN and inserted a NULL colour that
  // the NOT NULL constraint rejected — a 500 for any tag created without an
  // explicit colour. The count has to be awaited on its own line.
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM tags WHERE user_id = ?')
    .get(req.user.id);
  const color = HEX.test(String(req.body?.color || ''))
    ? req.body.color
    : TAG_COLORS[n % TAG_COLORS.length];

  const info = await db.prepare('INSERT INTO tags (user_id, name, color) VALUES (?,?,?)')
    .run(req.user.id, name, color);
  return res.json({ tags: await tagWithCounts(req.user.id) });
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const tag = await db.prepare('SELECT * FROM tags WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!tag) return res.status(404).json({ error: 'No such tag' });

  if (typeof req.body?.name === 'string' && req.body.name.trim()) {
    await db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(req.body.name.trim().slice(0, 32), id);
  }
  if (HEX.test(String(req.body?.color || ''))) {
    await db.prepare('UPDATE tags SET color = ? WHERE id = ?').run(req.body.color, id);
  }
  return res.json({ tags: await tagWithCounts(req.user.id) });
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  await db.prepare('DELETE FROM tags WHERE user_id = ? AND id = ?').run(req.user.id, id);
  return res.json({ tags: await tagWithCounts(req.user.id) });
});

export default router;
