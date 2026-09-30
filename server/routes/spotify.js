import { asyncRouter } from '../http.js';
import { db } from '../db.js';
import { requireAuth, newState, verifyState } from '../auth.js';
import { log } from '../store.js';

const router = asyncRouter();

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';

/**
 * Spotify rejects the bare host "localhost" — the redirect URI has to be an
 * explicit IPv4/IPv6 loopback such as http://127.0.0.1:5173. Plain HTTP is
 * only tolerated on loopback, which is where this server runs by default.
 */
export const PORT = Number(process.env.PORT) || 5173;
export const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI
  || `http://127.0.0.1:${PORT}/api/spotify/callback`;

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SCOPES = ['streaming', 'user-read-email', 'user-read-private'].join(' ');

export const spotifyConfigured = () => Boolean(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET);

router.get('/config', async (_req, res) => {
  res.json({
    configured: spotifyConfigured(),
    clientId: SPOTIFY_CLIENT_ID || null,
    redirectUri: REDIRECT_URI,
    // Playback inside the app needs Premium; the API calls do not.
    requiresPremium: true,
  });
});

// ── step 1: bounce the user to Spotify's consent screen ──────────────────

router.get('/login', requireAuth, async (req, res) => {
  if (!spotifyConfigured()) {
    return res.redirect('/?spotify=unconfigured');
  }
  const state = newState();
  await db.prepare('INSERT INTO oauth_states (state, user_id, created_at) VALUES (?,?,?)')
    .run(state, req.user.id, Date.now());

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
  });
  return res.redirect(`${AUTHORIZE_URL}?${params}`);
});

// ── step 2: exchange the code for tokens ─────────────────────────────────

async function exchangeToken(form) {
  const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form),
  });
  if (!res.ok) throw new Error(`Spotify token endpoint returned ${res.status}`);
  return res.json();
}

router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.redirect(`/?spotify=denied`);

  // Single-use state, expired after 10 minutes.
  const row = await db.prepare('DELETE FROM oauth_states WHERE state = ?').get(String(state || ''));
  if (!row || !verifyState(state) || Date.now() - row.created_at > 10 * 60 * 1000) {
    return res.redirect('/?spotify=bad-state');
  }

  try {
    const token = await exchangeToken({
      code: String(code || ''),
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    });
    await db.prepare(`
      INSERT INTO spotify_tokens (user_id, access_token, refresh_token, expires_at, scope)
      VALUES (?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET
        access_token = excluded.access_token,
        -- Spotify only sends a new refresh token sometimes; keep the old one.
        refresh_token = COALESCE(NULLIF(excluded.refresh_token,''), spotify_tokens.refresh_token),
        expires_at = excluded.expires_at,
        scope = excluded.scope
    `).run(
      row.user_id,
      token.access_token || '',
      token.refresh_token || '',
      Date.now() + (token.expires_in || 3600) * 1000,
      token.scope || SCOPES,
    );
    await log(row.user_id, 'account', 'Connected your Spotify account');
    return res.redirect('/?spotify=connected');
  } catch (err) {
    console.error('[spotify] token exchange failed:', err.message);
    return res.redirect('/?spotify=exchange-failed');
  }
});

// ── step 3: hand the SDK a currently-valid access token ──────────────────
//
// The SDK calls getOAuthToken on every connect and whenever its token looks
// stale. Spotify access tokens last one hour, so this endpoint transparently
// refreshes when the stored one is within 60 seconds of expiring — without it
// playback dies every hour.

router.get('/token', requireAuth, async (req, res) => {
  const row = await db.prepare('SELECT * FROM spotify_tokens WHERE user_id = ?').get(req.user.id);
  if (!row) return res.status(404).json({ error: 'Spotify is not connected.' });

  if (row.access_token && Date.now() < row.expires_at - 60_000) {
    return res.json({ access_token: row.access_token, expiresAt: row.expires_at });
  }

  try {
    const token = await exchangeToken({
      refresh_token: row.refresh_token,
      grant_type: 'refresh_token',
    });
    const expiresAt = Date.now() + (token.expires_in || 3600) * 1000;
    await db.prepare(`
      UPDATE spotify_tokens SET
        access_token = ?,
        refresh_token = COALESCE(NULLIF(?,''), refresh_token),
        expires_at = ?
      WHERE user_id = ?
    `).run(token.access_token || '', token.refresh_token || '', expiresAt, req.user.id);
    return res.json({ access_token: token.access_token, expiresAt });
  } catch (err) {
    console.error('[spotify] refresh failed:', err.message);
    await db.prepare('DELETE FROM spotify_tokens WHERE user_id = ?').run(req.user.id);
    return res.status(401).json({ error: 'Spotify session expired — reconnect your account.' });
  }
});

router.post('/disconnect', requireAuth, async (req, res) => {
  await db.prepare('DELETE FROM spotify_tokens WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

router.get('/status', requireAuth, async (req, res) => {
  const row = await db.prepare('SELECT expires_at FROM spotify_tokens WHERE user_id = ?').get(req.user.id);
  res.json({ connected: Boolean(row) });
});

export default router;
