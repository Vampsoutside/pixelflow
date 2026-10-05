import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { db, dbIsEphemeral, dbPath, isRemote, migrate, migrationError } from './db.js';
import { attachUser, ensureCsrfCookie, csrfGuard, requireAuth } from './auth.js';
import { getUser, saveUserFields } from './store.js';
import authRoutes from './routes/auth.js';
import studyRoutes from './routes/study.js';
import friendsRoutes from './routes/friends.js';
import tasksRoutes from './routes/tasks.js';
import eventsRoutes from './routes/events.js';
import tagsRoutes from './routes/tags.js';
import spotifyRoutes from './routes/spotify.js';
import googleCalendarRoutes from './routes/googlecalendar.js';

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

app.get('/api/health', async (_req, res) => {
  const storage = isRemote ? 'turso' : (dbIsEphemeral ? 'ephemeral' : 'persistent');

  // The database path is an operational detail, but when a host cannot give us
  // one at all it is the only thing that explains why every other endpoint is
  // failing — so it is reported alongside the error.
  try {
    const users = await db.prepare('SELECT COUNT(*) AS n FROM users').get();
    return res.json({
      ok: migrationError === null,
      users: users.n,
      storage,
      ...(migrationError ? { databaseError: migrationError } : {}),
      ...(!isRemote && !dbIsEphemeral ? {} : { databasePath: dbPath }),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      storage,
      databaseError: migrationError || err.message,
      databasePath: dbPath,
    });
  }
});

// Profile reads and writes live at the top level so the client can use one
// stable /api/me path for both.
app.get('/api/me', async (req, res) => {
  res.json({ user: req.user ? await getUser(req.user.id) : null });
});

app.put('/api/me', requireAuth, async (req, res) => {
  const user = await getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'No such user' });
  const { avatar, settings } = req.body || {};
  await saveUserFields(user.id, {
    avatar: avatar && typeof avatar === 'object' ? avatar : undefined,
    settings: settings && typeof settings === 'object' ? settings : undefined,
  });
  return res.json({ user: await getUser(user.id) });
});

/**
 * Delete the signed-in account and everything belonging to it.
 *
 * Not a nicety: Google's API Services User Data Policy requires an app holding
 * Google user data to give users a way to delete it, and verification is
 * refused without one.
 *
 * Three deliberate choices:
 *
 *  - No password. Someone who has forgotten theirs still has a right to
 *    erasure, and demanding it here would mean the data outlives the account
 *    for anyone who lost their credentials. The session cookie and the CSRF
 *    check are what actually protect this route.
 *  - No id in the body. There is no way to name a target, so there is no way
 *    to delete anyone else — a caller can only ever delete themselves.
 *  - Relies on the ON DELETE CASCADE every owned table declares. Spelling out
 *    twenty DELETEs here would be twenty chances to miss one, and a study log
 *    outliving the account is precisely what the policy is about.
 */
app.delete('/api/me', requireAuth, async (req, res) => {
  await db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  // The session row goes with the account, but the cookie is already in the
  // browser — clear it, or a deleted account keeps presenting a valid-looking
  // cookie to the client.
  res.clearCookie('pf_session');
  res.clearCookie('pf_session_csrf');
  return res.json({ ok: true, deleted: true });
});

app.use('/api/auth', authRoutes);
app.use('/api/study', studyRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/tags', tagsRoutes);
app.use('/api/spotify', spotifyRoutes);
app.use('/api/googlecalendar', googleCalendarRoutes);

app.use('/api', (_req, res) => res.status(404).json({ error: 'No such endpoint' }));

// ── static app ───────────────────────────────────────────────────────────

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: 0 }));

/**
 * The app itself, at /app.
 *
 * `/` is the public landing page — it has to explain the app to a crawler and
 * to anyone who has not signed in, which is a hard requirement of Google OAuth
 * verification. The login-walled shell used to sit at `/`, where a reviewer
 * found nothing but a sign-in form.
 */
app.get('/app', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'app.html')));

// A section inside the app, e.g. /app#timer or /app/timer, serves the shell
// too. Anything else unknown falls through to the landing page rather than the
// shell, so a mistyped URL explains itself instead of asking for a login.
app.get('/app/*', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'app.html')));

// An unknown path falls back to the landing page rather than a bare 404, so a
// mistyped URL explains itself instead of erroring. This is a server-side
// fallback, deliberately NOT a vercel.json rewrite: a rewrite there is evaluated
// before the filesystem and would shadow /about, /privacy and every other real
// page, returning the landing page for all of them.
app.get(/.*/, (_req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));

// ── errors ───────────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('[pixelflow]', err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

await migrate();

// No demo accounts are created on boot — the first person to arrive makes
// their own account through the sign-up form. `npm run seed` still exists for
// filling a local database with sample data.
export default app;
