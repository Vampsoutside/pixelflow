import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { tagWithCounts, log } from '../store.js';

const router = Router();
router.use(requireAuth);

const TAG_COLORS = ['#7c6fff', '#ff6b9d', '#6bffda', '#ffb347', '#ff5555', '#44aaff', '#aaffaa', '#ffaaff'];
const HEX = /^#[0-9a-f]{6}$/i;

router.post('/', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 32);
  if (!name) return res.status(400).json({ error: 'A tag needs a name.' });

  const dupe = db.prepare('SELECT id FROM tags WHERE user_id = ? AND name = ?')
    .get(req.user.id, name);
  if (dupe) return res.status(409).json({ error: 'You already have that tag.' });

  const color = HEX.test(String(req.body?.color || ''))
    ? req.body.color
    : TAG_COLORS[db.prepare('SELECT COUNT(*) AS n FROM tags WHERE user_id = ?')
      .get(req.user.id).n % TAG_COLORS.length];

  const info = db.prepare('INSERT INTO tags (user_id, name, color) VALUES (?,?,?)')
    .run(req.user.id, name, color);
  log(req.user.id, 'tag', `Created tag “${name}”`, { tagId: Number(info.lastInsertRowid) });
  return res.json({ tags: tagWithCounts(req.user.id) });
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const tag = db.prepare('SELECT * FROM tags WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!tag) return res.status(404).json({ error: 'No such tag' });

  if (typeof req.body?.name === 'string' && req.body.name.trim()) {
    db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(req.body.name.trim().slice(0, 32), id);
  }
  if (HEX.test(String(req.body?.color || ''))) {
    db.prepare('UPDATE tags SET color = ? WHERE id = ?').run(req.body.color, id);
  }
  return res.json({ tags: tagWithCounts(req.user.id) });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM tags WHERE user_id = ? AND id = ?').run(req.user.id, id);
  log(req.user.id, 'tag', 'Deleted a tag');
  return res.json({ tags: tagWithCounts(req.user.id) });
});

export default router;
