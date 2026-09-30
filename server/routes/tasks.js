import { Router } from 'express';
import { db, tx } from '../db.js';
import { requireAuth } from '../auth.js';
import { tagWithCounts, tasksWithTags, log } from '../store.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  res.json({ tags: tagWithCounts(req.user.id), tasks: tasksWithTags(req.user.id) });
});

// ── tasks ────────────────────────────────────────────────────────────────

router.post('/', (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 240);
  if (!text) return res.status(400).json({ error: 'A task needs some text.' });

  const info = db.prepare('INSERT INTO tasks (user_id, text) VALUES (?,?)')
    .run(req.user.id, text);
  log(req.user.id, 'task', `Added task “${text}”`, { taskId: Number(info.lastInsertRowid) });
  return res.json({ taskId: Number(info.lastInsertRowid) });
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!task) return res.status(404).json({ error: 'No such task' });

  if (req.body?.done !== undefined) {
    const done = req.body.done ? 1 : 0;
    db.prepare('UPDATE tasks SET done = ? WHERE id = ?').run(done, id);
    if (done) log(req.user.id, 'task', `Completed “${task.text}”`, { taskId: id });
  }
  if (typeof req.body?.text === 'string' && req.body.text.trim()) {
    db.prepare('UPDATE tasks SET text = ? WHERE id = ?').run(req.body.text.trim().slice(0, 240), id);
  }

  // Tag set is replaced wholesale when `tagIds` is present.
  if (Array.isArray(req.body?.tagIds)) {
    tx(() => {
      db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(id);
      const link = db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?,?)');
      for (const raw of req.body.tagIds.slice(0, 12)) {
        const tagId = Number(raw);
        const owns = db.prepare('SELECT id FROM tags WHERE id = ? AND user_id = ?')
          .get(tagId, req.user.id);
        if (owns) link.run(id, tagId);
      }
    });
  }

  return res.json({ tasks: tasksWithTags(req.user.id) });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?')
    .run(Number(req.params.id), req.user.id);
  log(req.user.id, 'task', 'Deleted a task');
  res.json({ tasks: tasksWithTags(req.user.id) });
});

export default router;
