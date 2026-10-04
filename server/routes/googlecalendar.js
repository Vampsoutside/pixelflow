/**
 * Google Calendar sync.
 *
 * The app keeps its own `events` table and its own calendar UI, because that is
 * where tags, deadlines and the "informational, never study time" rule live. A
 * Google Calendar connection does not replace any of that — it copies events
 * across so the same schedule is visible on every device.
 *
 * The shape of a sync, and why:
 *
 *  - Google is read with the Calendar API, never embedded. An <iframe> embed is
 *    a read-only anonymous view of a calendar you have had to make public, so it
 *    can neither sign in nor sync, and it would leak the user's schedule. OAuth
 *    with a refresh token is the only thing that actually delivers sync.
 *  - Linkage lives in google_event_links rather than a column on events, so this
 *    feature needs no migration and a disconnect can drop the linkage while
 *    leaving every local event in place.
 *  - A pull compares Google's `updated` against the value stored at link time.
 *    Without that, every sync would stomp a local edit made since the last pull,
 *    which is the single most annoying failure mode a two-way sync can have.
 *
 * Study data is never touched here. Nothing in this file writes to
 * study_entries, study_plans or timer_sessions.
 */

import { asyncRouter } from '../http.js';
import { db } from '../db.js';
import { requireAuth, newState, verifyState } from '../auth.js';
import { publicOrigin } from '../oauth.js';

const router = asyncRouter();

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

export const PORT = Number(process.env.PORT) || 5173;
// From PUBLIC_ORIGIN when deployed — see the note in oauth.js#publicOrigin.
// A loopback default here tells Google the callback is at 127.0.0.1 on Vercel
// and the request is rejected with redirect_uri_mismatch.
export const REDIRECT_URI = process.env.GOOGLE_CALENDAR_REDIRECT_URI
  || `${publicOrigin()}/api/googlecalendar/callback`;

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/calendar/v3/calendars';

/**
 * Full read/write on the primary calendar.
 *
 * calendar.events is what makes an edit in the app reach Google. Google also
 * offers a narrower calendar.events.readonly, which would silently turn every
 * push into a no-op — so this asks for the scope the feature actually needs
 * rather than the one that looks more privacy-conscious.
 */
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar'].join(' ');

export const calendarConfigured = () => Boolean(CLIENT_ID && CLIENT_SECRET);

/** Refresh this far ahead of expiry, so a token cannot lapse mid-request. */
const REFRESH_MARGIN_MS = 60_000;

// ── dates ────────────────────────────────────────────────────────────────

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthBounds(month) {
  const [year, mo] = month.split('-').map(Number);
  const first = new Date(year, mo - 1, 1);
  const last = new Date(year, mo, 0);
  const key = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: key(first), to: key(last) };
}

/**
 * Google's dateTime strings look like 2026-10-14T09:30:00+05:30.
 *
 * The leading ten characters are the local wall-clock day the event belongs to,
 * which is what the app's date column means; taking the literal prefix rather
 * than converting to UTC keeps an evening event on the evening it was created
 * on, instead of sliding it onto the next day for anyone east of Greenwich.
 */
function localDay(value) {
  return String(value || '').slice(0, 10);
}

function localClock(value) {
  const m = String(value || '').match(/^[\d-]+T(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

/** Minutes between two Google timestamps, ignoring any zone suffix. */
function spanMinutes(start, end) {
  const a = Date.parse(String(start).replace(/(Z|[+-]\d{2}:?\d{2})$/, ''));
  const b = Date.parse(String(end).replace(/(Z|[+-]\d{2}:?\d{2})$/, ''));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 60_000));
}

// ── tokens ───────────────────────────────────────────────────────────────

/**
 * A currently-valid access token, refreshing the stored one when it is close
 * to expiry. A failed refresh drops the connection rather than retrying a token
 * Google has already revoked, so the user sees "reconnect" instead of a silent
 * sync that quietly stopped working.
 */
async function accessToken(userId) {
  const row = await db
    .prepare('SELECT * FROM google_calendar_tokens WHERE user_id = ?')
    .get(userId);
  if (!row) return null;

  if (row.access_token && Date.now() < row.expires_at - REFRESH_MARGIN_MS) {
    return { token: row.access_token, calendarId: row.calendar_id };
  }

  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: row.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`token endpoint returned ${res.status}`);
    const token = await res.json();
    const expiresAt = Date.now() + (token.expires_in || 3600) * 1000;

    await db
      .prepare(`UPDATE google_calendar_tokens
                SET access_token = ?, expires_at = ?
                WHERE user_id = ?`)
      .run(token.access_token, expiresAt, userId);

    return { token: token.access_token, calendarId: row.calendar_id };
  } catch (err) {
    console.error('[gcal] refresh failed:', err.message);
    await db.prepare('DELETE FROM google_calendar_tokens WHERE user_id = ?').run(userId);
    return null;
  }
}

/** A call to Google, carrying the bearer token and naming the calendar. */
async function google(auth, path, init = {}) {
  const url = `${API_BASE}/${encodeURIComponent(auth.calendarId || 'primary')}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  return res;
}

// ── connection status ─────────────────────────────────────────────────────

router.get('/status', requireAuth, async (req, res) => {
  const row = await db
    .prepare('SELECT user_id FROM google_calendar_tokens WHERE user_id = ?')
    .get(req.user.id);
  res.json({ connected: Boolean(row) });
});

// ── step 1: send the user to Google's consent screen ──────────────────────

router.get('/login', requireAuth, async (req, res) => {
  if (!calendarConfigured()) return res.redirect('/?gcal=unconfigured');

  const state = newState();
  await db
    .prepare('INSERT INTO oauth_states (state, user_id, created_at) VALUES (?,?,?)')
    .run(state, req.user.id, Date.now());

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    // Without offline access Google returns no refresh token, and the
    // connection dies an hour later with no way to renew it.
    access_type: 'offline',
    // Re-consenting must not silently drop calendar scope already granted.
    include_granted_scopes: 'true',
    prompt: 'consent',
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
  });
  return res.redirect(`${AUTHORIZE_URL}?${params}`);
});

// ── step 2: exchange the code, store the tokens ───────────────────────────

router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/?gcal=denied');

  const userId = await verifyState(state);
  if (!userId || !code) return res.redirect('/?gcal=failed');

  try {
    const res2 = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
      }),
    });
    if (!res2.ok) throw new Error(`token endpoint returned ${res2.status}`);
    const token = await res2.json();

    const expiresAt = Date.now() + (token.expires_in || 3600) * 1000;
    await db
      .prepare(`
        INSERT INTO google_calendar_tokens
          (user_id, access_token, refresh_token, expires_at, calendar_id)
        VALUES (?,?,?,?,'primary')
        ON CONFLICT(user_id) DO UPDATE SET
          access_token = excluded.access_token,
          -- Google only sends a refresh_token the first time; keep the old one
          -- rather than overwriting it with empty and breaking the connection.
          refresh_token = COALESCE(NULLIF(excluded.refresh_token,''), refresh_token),
          expires_at = excluded.expires_at
      `)
      .run(userId, token.access_token || '', token.refresh_token || '', expiresAt);

    return res.redirect('/?gcal=connected');
  } catch (err) {
    console.error('[gcal] exchange failed:', err.message);
    return res.redirect('/?gcal=failed');
  }
});

// ── pulling Google events in ──────────────────────────────────────────────

/**
 * One Google event -> the columns the app stores.
 *
 * All-day events carry { date } rather than { dateTime } and have no clock time
 * in the app, which matches how a deadline is already modelled.
 */
function toLocal(g) {
  const start = g.start?.dateTime || g.start?.date;
  const end = g.end?.dateTime || g.end?.date;
  return {
    date: localDay(start),
    title: String(g.summary || '(no title)').slice(0, 120),
    time: g.start?.dateTime ? localClock(start) : null,
    minutes: g.start?.dateTime ? spanMinutes(start, end) : 0,
  };
}

router.post('/sync', requireAuth, async (req, res) => {
  const month = String(req.body?.month || '').slice(0, 7);
  if (!MONTH_RE.test(month)) {
    return res.status(400).json({ error: 'month must look like YYYY-MM' });
  }

  const auth = await accessToken(req.user.id);
  if (!auth) {
    return res.status(409).json({ error: 'Google Calendar is not connected.' });
  }

  const { from, to } = monthBounds(month);
  const listUrl =
    `/events?singleEvents=true&orderBy=startTime` +
    `&timeMin=${encodeURIComponent(`${from}T00:00:00`)}` +
    `&timeMax=${encodeURIComponent(`${to}T23:59:59`)}`;

  const upstream = await google(auth, listUrl);
  if (!upstream.ok) {
    console.error('[gcal] list failed:', upstream.status);
    return res.status(502).json({ error: 'Google Calendar could not be read.' });
  }

  const { items = [] } = await upstream.json();
  const userId = req.user.id;
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const g of items) {
    if (!g?.id || g.status === 'cancelled') continue;

    const local = toLocal(g);
    if (!local.date) continue;

    const link = await db
      .prepare('SELECT * FROM google_event_links WHERE user_id = ? AND google_event_id = ?')
      .get(userId, g.id);

    if (link) {
      // Only overwrite the local row when Google is genuinely the newer side.
      // Without this every sync reverts edits made in the app since the last pull.
      const incoming = g.updated || '';
      const known = link.google_updated || '';
      if (known && incoming && incoming <= known) {
        skipped += 1;
        continue;
      }
      await db
        .prepare(`UPDATE events
                  SET date = ?, title = ?, time = ?, minutes = ?
                  WHERE id = ? AND user_id = ?`)
        .run(local.date, local.title, local.time, local.minutes, link.local_event_id, userId);
      await db
        .prepare('UPDATE google_event_links SET google_updated = ? WHERE user_id = ? AND local_event_id = ?')
        .run(incoming || null, userId, link.local_event_id);
      updated += 1;
      continue;
    }

    // A Google event the app has never seen. Imported as kind 'event' — a
    // Google entry is not a deadline in this app's sense, and nothing from it
    // is ever counted toward study time.
    const info = await db
      .prepare(`INSERT INTO events (user_id, date, kind, title, time, minutes)
                VALUES (?,?,?,?,?,?)`)
      .run(userId, local.date, 'event', local.title, local.time, local.minutes);

    await db
      .prepare(`INSERT INTO google_event_links
                  (user_id, local_event_id, google_event_id, google_updated)
                VALUES (?,?,?,?)`)
      .run(userId, Number(info.lastInsertRowid), g.id, g.updated || null);
    created += 1;
  }

  res.json({ created, updated, skipped });
});

// ── pushing app events out to Google ──────────────────────────────────────

router.post('/push', requireAuth, async (req, res) => {
  const id = Number(req.body?.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'id must be the event to push' });
  }

  const auth = await accessToken(req.user.id);
  if (!auth) {
    return res.status(409).json({ error: 'Google Calendar is not connected.' });
  }

  const event = await db
    .prepare('SELECT * FROM events WHERE id = ? AND user_id = ?')
    .get(id, req.user.id);
  // 404 rather than 403: another user's id should not be distinguishable here.
  if (!event) return res.status(404).json({ error: 'No such item' });

  const start = event.time ? `${event.date}T${event.time}:00` : `${event.date}T00:00:00`;
  const endMs = Date.parse(start) + (event.minutes || 0) * 60_000;
  const end = Number.isFinite(endMs)
    ? new Date(endMs).toISOString().slice(0, 19)
    : `${event.date}T23:59:59`;

  const payload = {
    summary: event.title,
    start: { dateTime: start },
    end: { dateTime: end },
  };

  const link = await db
    .prepare('SELECT * FROM google_event_links WHERE user_id = ? AND local_event_id = ?')
    .get(req.user.id, id);

  const upstream = link
    ? await google(auth, `/events/${encodeURIComponent(link.google_event_id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    })
    : await google(auth, '/events', { method: 'POST', body: JSON.stringify(payload) });

  if (!upstream.ok) {
    // The local event is deliberately left exactly as it was: a Google outage
    // must not cost the user the edit they just made.
    console.error('[gcal] push failed:', upstream.status);
    return res.status(502).json({ error: 'Google Calendar could not be updated.' });
  }

  const saved = await upstream.json().catch(() => ({}));

  if (link) {
    await db
      .prepare('UPDATE google_event_links SET google_updated = ? WHERE user_id = ? AND local_event_id = ?')
      .run(saved.updated || null, req.user.id, id);
  } else {
    await db
      .prepare(`INSERT INTO google_event_links
                  (user_id, local_event_id, google_event_id, google_updated)
                VALUES (?,?,?,?)`)
      .run(req.user.id, id, saved.id, saved.updated || null);
  }

  res.json({ pushed: true, googleEventId: saved.id ?? link?.google_event_id ?? null });
});

/**
 * Deletes a linked event from Google, then drops the link.
 *
 * Exported for server/routes/events.js rather than exposed as its own endpoint
 * because of the cascade: google_event_links.local_event_id is ON DELETE CASCADE,
 * so deleting the event row first destroys the very link needed to find the
 * Google copy. Deleting an event in this app therefore has to reach Google
 * BEFORE the local row goes, which means it belongs in the delete handler
 * rather than in a follow-up request the client might not make.
 *
 * Returns what happened, so the caller can decide whether to report a failure:
 *   'not-connected' | 'unlinked' (nothing was in Google) | 'deleted'
 */
export async function unlinkRemote(userId, eventId) {
  const auth = await accessToken(userId);
  if (!auth) return 'not-connected';

  const link = await db
    .prepare('SELECT * FROM google_event_links WHERE user_id = ? AND local_event_id = ?')
    .get(userId, eventId);
  if (!link) return 'unlinked';

  try {
    const upstream = await google(auth, `/events/${encodeURIComponent(link.google_event_id)}`, {
      method: 'DELETE',
    });
    // 410 means Google already removed it, which is the state we wanted.
    if (!upstream.ok && upstream.status !== 410) {
      console.error('[gcal] delete failed:', upstream.status);
      return 'failed';
    }
  } catch (err) {
    console.error('[gcal] delete failed:', err.message);
    return 'failed';
  }

  await db
    .prepare('DELETE FROM google_event_links WHERE user_id = ? AND local_event_id = ?')
    .run(userId, eventId);
  return 'deleted';
}

// ── disconnecting ─────────────────────────────────────────────────────────

router.post('/disconnect', requireAuth, async (req, res) => {
  await db.prepare('DELETE FROM google_calendar_tokens WHERE user_id = ?').run(req.user.id);
  // The links go so that the next push creates a fresh Google event rather than
  // patching one the user has just unhooked. The events themselves stay: they
  // are the user's own data and were not created by Google.
  await db.prepare('DELETE FROM google_event_links WHERE user_id = ?').run(req.user.id);
  res.json({ connected: false });
});

export default router;
export { monthBounds, toLocal, MONTH_RE };