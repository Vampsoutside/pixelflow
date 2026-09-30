import {
  randomBytes, scryptSync, timingSafeEqual, createHmac, createHash,
} from 'node:crypto';

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

const secret = () => process.env.JWT_SECRET || 'pixelflow-dev-secret-do-not-use-in-production';

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

export function setSessionCookie(res, userId) {
  res.cookie(SESSION_COOKIE, issueToken({ uid: userId }, sessionDays() * 86400), {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // loopback HTTP is fine; flip with USE_HTTPS behind a tunnel
    maxAge: sessionDays() * 86400 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

// ── CSRF ─────────────────────────────────────────────────────────────────
// SameSite=Lax already blocks cross-site POSTs from forms and iframes. This
// double-submit token additionally covers same-site subdomain tricks.

export const csrfToken = () => createHash('sha256')
  .update(`${secret()}:csrf:${randomBytes(8).toString('hex')}`)
  .digest('base64url')
  .slice(0, 32);

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
  if (!cookieToken || !timingSafeEqual(Buffer.from(sent), Buffer.from(cookieToken))) {
    return res.status(403).json({ error: 'Bad CSRF token' });
  }
  return next();
}

export function ensureCsrfCookie(req, res, next) {
  if (!req.cookies?.[`${SESSION_COOKIE}_csrf`]) {
    res.cookie(`${SESSION_COOKIE}_csrf`, csrfToken(), {
      httpOnly: false, // the client reads it to set the header
      sameSite: 'lax',
      maxAge: sessionDays() * 86400 * 1000,
      path: '/',
    });
  }
  next();
}

// ── Express middleware ───────────────────────────────────────────────────

/** Attaches `req.user` (or null). Never rejects. */
export function attachUser(req, _res, next) {
  req.user = null;
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    const payload = readToken(token);
    if (payload?.uid) req.user = { id: Number(payload.uid) };
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
