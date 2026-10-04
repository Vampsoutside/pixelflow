import {
  randomBytes, scryptSync, timingSafeEqual, createHmac, createHash,
} from 'node:crypto';
import { db } from './db.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_COOKIE = 'pf_session';

// ── password hashing ─────────────────────────────────────────────────────

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ── JWT (HS256) ──────────────────────────────────────────────────────────
// Hand-rolled on node:crypto so the app keeps a single runtime dependency.

/**
 * Whether this process is a real deployment.
 *
 * Vercel sets VERCEL=1 on every function, and VERCEL_ENV to 'production' or
 * 'preview'. The original guard here only looked at NODE_ENV and VERCEL=1, so a
 * deploy relying on VERCEL_ENV — and preview deployments, which are not
 * production but are still the internet — booted with the development fallback.
 * One predicate, used by both the check and the eager boot test below, so the
 * two cannot drift apart again.
 */
const isProduction = () => process.env.NODE_ENV === 'production'
  || process.env.VERCEL === '1'
  || process.env.VERCEL === 'true'
  || process.env.VERCEL_ENV === 'production';

/**
 * The HMAC key sessions are signed with.
 *
 * There used to be a literal fallback here — 'pixelflow-dev-secret-…' — so a
 * deployment that forgot JWT_SECRET still booted, and served happily: anyone
 * who had read the source could mint a token for any user id and be accepted.
 * The name says "do not use in production", which is not a control.
 *
 * So the fallback now exists only when running outside a deployment, where a
 * laptop with no .env still works. Under a deployment an unset JWT_SECRET is
 * fatal at boot rather than quietly insecure. The generated value is per-process
 * and random, so even a local run does not share a key with anything else.
 */
function secret() {
  const configured = process.env.JWT_SECRET;
  if (configured) return configured;

  if (isProduction()) {
    throw new Error(
      'JWT_SECRET is not set. Refusing to start: without it every session could '
      + 'be forged. Set a long random value in the environment (see .env.example).',
    );
  }
  // Local development only. Random per process so two dev servers cannot mint
  // each other's tokens, and so nothing here is a known constant.
  return randomBytes(32).toString('hex');
}

// Checked at import time, not lazily. secret() is only called when a token is
// signed or read, so a deployment with no JWT_SECRET would otherwise start,
// answer /api/health, and serve static assets happily — then throw on the first
// login, by which point the failure looks like an outage rather than a
// misconfiguration. Importing this module is part of booting the app, so the
// throw lands before the listener is up.
if (isProduction()) {
  secret();
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(data, key) {
  return createHmac('sha256', key).update(data).digest('base64url');
}

export function issueToken(payload, ttlSeconds) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  return `${header}.${body}.${sign(`${header}.${body}`, secret())}`;
}

export function readToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, mac] = parts;
  const expected = sign(`${header}.${body}`, secret());
  // Compare as buffers so the check does not leak length via early return.
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export const sessionDays = () => Math.max(1, Number(process.env.SESSION_DAYS) || 30);

/**
 * Whether cookies may carry the Secure attribute.
 *
 * .env.example documents USE_HTTPS=0/1 for exactly this, and setSessionCookie's
 * comment pointed at it, but nothing read it — so the deployed app over HTTPS
 * was still handing out a session cookie without Secure. Loopback HTTP stays
 * the default so a laptop with no setup keeps working.
 */
const useHttps = () => /^(1|true|yes|on)$/i.test(String(process.env.USE_HTTPS || ''));

export function setSessionCookie(res, userId) {
  res.cookie(SESSION_COOKIE, issueToken({ uid: userId }, sessionDays() * 86400), {
    httpOnly: true,
    sameSite: 'lax',
    secure: useHttps(),
    maxAge: sessionDays() * 86400 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  // Express matches a cleared cookie on name, domain and path only — the other
  // attributes do not have to match for the deletion to take. They are passed
  // anyway so the two sites cannot drift apart and start describing different
  // cookies.
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: useHttps(),
    path: '/',
  });
}

// ── CSRF ─────────────────────────────────────────────────────────────────
// SameSite=Lax already blocks cross-site POSTs from forms and iframes. This
// double-submit token additionally covers same-site subdomain tricks.

export const csrfToken = () => createHash('sha256')
  .update(`${secret()}:csrf:${randomBytes(8).toString('hex')}`)
  .digest('base64url')
  .slice(0, 32);

/**
 * The CSRF token this request must answer with, as a JSON body field.
 *
 * Sign-in routes return this so a client that keeps the token in memory — the
 * way public/js/api.js does, reading the cookie — has something to read on the
 * very response that creates the session. It has to be the *cookie's* value:
 * a freshly generated token would never match, and every write that used it
 * would be rejected.
 */
export const csrfTokenFor = (req) => req.cookies?.[`${SESSION_COOKIE}_csrf`] ?? null;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  // Requests the browser cannot attach a header to (sendBeacon, some img tags)
  // are rejected outright rather than trusted.
  const sent = req.get('x-csrf-token');
  if (!sent) {
    return res.status(403).json({ error: 'Missing CSRF token' });
  }
  const cookieToken = req.cookies?.[`${SESSION_COOKIE}_csrf`];
  // timingSafeEqual throws when the two buffers differ in length, so the
  // lengths have to be compared first. Without this a wrong-length token
  // escaped as a 500 from the error middleware instead of a 403 — and the
  // client retries on 403, not 500, so it surfaced as a dead write.
  const sentBuf = Buffer.from(sent);
  const cookieBuf = Buffer.from(String(cookieToken || ''));
  if (!cookieToken || sentBuf.length !== cookieBuf.length
      || !timingSafeEqual(sentBuf, cookieBuf)) {
    return res.status(403).json({ error: 'Bad CSRF token' });
  }
  return next();
}

export function ensureCsrfCookie(req, res, next) {
  if (!req.cookies?.[`${SESSION_COOKIE}_csrf`]) {
    res.cookie(`${SESSION_COOKIE}_csrf`, csrfToken(), {
      httpOnly: false, // the client reads it to set the header
      sameSite: 'lax',
      // The session cookie carries Secure over HTTPS; leaving this one without
      // it let a downgrade to http carry the CSRF token in the clear.
      secure: useHttps(),
      maxAge: sessionDays() * 86400 * 1000,
      path: '/',
    });
  }
  next();
}

// ── Express middleware ───────────────────────────────────────────────────

/** Attaches `req.user` (or null). Never rejects. */
/**
 * Resolve the session cookie to a user.
 *
 * The database check is not redundant with the signature. A JWT stays
 * cryptographically valid until it expires, so without it a deleted account —
 * or a session revoked in any other way — keeps full access for the rest of
 * the token's life, which would make account deletion meaningless. One indexed
 * primary-key lookup is a fair price for deletion actually deleting.
 *
 * Failures resolve to signed out rather than throwing: a database blip should
 * not read to the user as an error on their own account.
 */
export async function attachUser(req, _res, next) {
  req.user = null;
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    const payload = readToken(token);
    const id = Number(payload?.uid);
    if (Number.isInteger(id) && id > 0) {
      let row;
      try {
        row = await db.prepare('SELECT id FROM users WHERE id = ?').get(id);
      } catch (err) {
        // Only a database failure should degrade to "signed out". Swallowing
        // everything here once hid a ReferenceError and made every request
        // look anonymous, so the failure is logged rather than absorbed.
        console.error('[auth] session lookup failed:', err.message);
        req.user = null;
      }
      if (row) req.user = { id: Number(row.id) };
    }
  }
  next();
}

/** Rejects unauthenticated requests with 401. */
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  return next();
}

// ── Spotify OAuth state ──────────────────────────────────────────────────

export const newState = () => randomBytes(24).toString('base64url');

export function verifyState(state) {
  return typeof state === 'string' && state.length >= 16 && /^[A-Za-z0-9_-]+$/.test(state);
}
