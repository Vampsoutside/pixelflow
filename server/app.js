import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { db, dbIsEphemeral } from './db.js';
import { attachUser, ensureCsrfCookie, csrfGuard, requireAuth } from './auth.js';
import { getUser, saveUserFields } from './store.js';
import authRoutes from './routes/auth.js';
import studyRoutes from './routes/study.js';
import friendsRoutes from './routes/friends.js';
import tasksRoutes from './routes/tasks.js';
import tagsRoutes from './routes/tags.js';
import logsRoutes from './routes/logs.js';
import spotifyRoutes from './routes/spotify.js';

const here = dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = join(here, '..', 'public');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

// ── minimal cookie parsing ───────────────────────────────────────────────
// A tiny hand-rolled parser keeps express the only runtime dependency.

app.use((req, _res, next) => {
  req.cookies = Object.create(null);
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 1) continue;
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      try {
        req.cookies[key] = decodeURIComponent(value);
      } catch {
        req.cookies[key] = value;
      }
    }
  }
  next();
});

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// ── API ──────────────────────────────────────────────────────────────────

app.use('/api', attachUser, ensureCsrfCookie);

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Safe methods are exempt (see csrfGuard), which covers the Spotify callback
// because it is reached by a top-level browser redirect with no custom header.
app.use('/api', csrfGuard);

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    storage: dbIsEphemeral ? 'ephemeral' : 'persistent',
  });
});

// Profile reads and writes live at the top level so the client can use one
// stable /api/me path for both.
app.get('/api/me', (req, res) => {
  res.json({ user: req.user ? getUser(req.user.id) : null });
});

app.put('/api/me', requireAuth, (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'No such user' });
  const { avatar, settings } = req.body || {};
  saveUserFields(user.id, {
    avatar: avatar && typeof avatar === 'object' ? avatar : undefined,
    settings: settings && typeof settings === 'object' ? settings : undefined,
  });
  return res.json({ user: getUser(user.id) });
});

app.use('/api/auth', authRoutes);
app.use('/api/study', studyRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/tags', tagsRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/spotify', spotifyRoutes);

app.use('/api', (_req, res) => res.status(404).json({ error: 'No such endpoint' }));

// ── static app ───────────────────────────────────────────────────────────

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: 0 }));

// Everything that is not an API route renders the shell.
app.get(/.*/, (_req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));

// ── errors ───────────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('[pixelflow]', err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// ── first boot ───────────────────────────────────────────────────────────

// A fresh database is unusable, and on an ephemeral host every cold start is a
// fresh database, so seed the demo accounts whenever there are none. Set
// PIXELFLOW_NO_AUTOSEED=1 to start empty instead.
if (process.env.PIXELFLOW_NO_AUTOSEED !== '1'
  && db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  const { seed } = await import('./seed.js');
  seed({ quiet: true });
  console.log('[pixelflow] seeded demo data — sign in as kira or milo, password: pixelflow');
}

export default app;
