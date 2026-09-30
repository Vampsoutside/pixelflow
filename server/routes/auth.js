import { Router } from 'express';
import { db, tx } from '../db.js';
import {
  hashPassword, verifyPassword, setSessionCookie, clearSessionCookie,
  requireAuth, csrfToken,
} from '../auth.js';
import { getUser, log, DEFAULT_SETTINGS } from '../store.js';

const router = Router();

const USERNAME_RE = /^[a-z0-9_]{3,20}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

function validateCredentials({ username, email, password }) {
  if (!USERNAME_RE.test(String(username || ''))) {
    return 'Username must be 3–20 letters, numbers or underscores.';
  }
  if (!EMAIL_RE.test(String(email || ''))) return 'That email address does not look right.';
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters.';
  }
  return null;
}

router.post('/signup', (req, res) => {
  const { username, email, password } = req.body || {};
  const problem = validateCredentials({ username, email, password });
  if (problem) return res.status(400).json({ error: problem });

  const clash = db.prepare('SELECT username, email FROM users WHERE username = ? OR email = ?')
    .get(username, email);
  if (clash) {
    return res.status(409).json({
      error: clash.username.toLowerCase() === String(username).toLowerCase()
        ? 'That username is taken.'
        : 'That email is already registered.',
    });
  }

  const info = db.prepare(
    'INSERT INTO users (username, email, password_hash) VALUES (?,?,?)',
  ).run(username, email, hashPassword(password));
  const id = Number(info.lastInsertRowid);

  // A brand-new account starts with a sensible plan: Mon–Fri at the default
  // focus duration, so the tracker and its bars render something real.
  tx(() => {
    const insert = db.prepare(
      'INSERT INTO study_plans (user_id, weekday, planned_minutes, active) VALUES (?,?,?,1)',
    );
    for (const weekday of [1, 2, 3, 4, 5]) {
      insert.run(id, weekday, DEFAULT_SETTINGS.focusMins * 60);
    }
    // Carry over the prototype's starter tags so the Tasks pane is not empty.
    const tag = db.prepare('INSERT INTO tags (user_id, name, color) VALUES (?,?,?)');
    tag.run(id, 'Study', '#7c6fff');
    tag.run(id, 'Work', '#6bffda');
  });

  log(id, 'account', `Welcome to PixelFlow, ${username}!`);
  setSessionCookie(res, id);
  return res.json({ user: getUser(id), csrfToken: csrfToken() });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const row = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?')
    .get(username, username);

  // Same message either way so the endpoint cannot be used to enumerate accounts.
  if (!row || !verifyPassword(String(password || ''), row.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  setSessionCookie(res, row.id);
  log(row.id, 'account', 'Signed in');
  return res.json({ user: getUser(row.id), csrfToken: csrfToken() });
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/session', (req, res) => {
  res.json({ user: req.user ? getUser(req.user.id) : null });
});

router.get('/users/:id', requireAuth, (req, res) => {
  const user = getUser(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'No such user' });
  res.json({ user });
});

export default router;
