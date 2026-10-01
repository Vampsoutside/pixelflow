import { asyncRouter } from '../http.js';
import { db, tx, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import { tagWithCounts, tasksWithTags } from '../store.js';

const router = asyncRouter();
router.use(requireAuth);

router.get('/', async (req, res) => {
  res.json({ tags: await tagWithCounts(req.user.id), tasks: await tasksWithTags(req.user.id) });
});

// ── tasks ────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 240);
  if (!text) return res.status(400).json({ error: 'A task needs some text.' });

  const info = await db.prepare('INSERT INTO tasks (user_id, text) VALUES (?,?)')
    .run(req.user.id, text);
  return res.json({ taskId: Number(info.lastInsertRowid) });
});

/**
 * Editing a task: completion, wording, or its whole tag set.
 *
 * `done` is the archive switch. Completing a task is not logged as an event —
 * the row itself is the record, and the Logs tab renders completed tasks with
 * a Restore button that sends `done: false`. That makes a mis-click a one-click
 * undo instead of a deleted task.
 */
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const task = await db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!task) return res.status(404).json({ error: 'No such task' });

  if (req.body?.done !== undefined) {
    const done = req.body.done ? 1 : 0;
    await db.prepare('UPDATE tasks SET done = ?, done_at = ? WHERE id = ?')
      .run(done, done ? nowIso() : null, id);
  }
  if (typeof req.body?.text === 'string' && req.body.text.trim()) {
    await db.prepare('UPDATE tasks SET text = ? WHERE id = ?').run(req.body.text.trim().slice(0, 240), id);
  }

  // Tag set is replaced wholesale when `tagIds` is present.
  if (Array.isArray(req.body?.tagIds)) {
    await tx(async (t) => {
      await t.prepare('DELETE FROM task_tags WHERE task_id = ?').run(id);
      const link = t.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?,?)');
      for (const raw of req.body.tagIds.slice(0, 12)) {
        const tagId = Number(raw);
        const owns = await t.prepare('SELECT id FROM tags WHERE id = ? AND user_id = ?')
          .get(tagId, req.user.id);
        if (owns) await link.run(id, tagId);
      }
    });
  }

  return res.json({ tasks: await tasksWithTags(req.user.id) });
});

router.delete('/:id', async (req, res) => {
  await db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?')
    .run(Number(req.params.id), req.user.id);
  res.json({ tasks: await tasksWithTags(req.user.id) });
});

export default router;
