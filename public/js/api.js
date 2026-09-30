/**
 * API client.
 *
 * Every mutating request carries the double-submit CSRF token that the server
 * set in a readable cookie at boot. `csrf()` reads it lazily and refetches the
 * session only if the cookie is somehow missing.
 */

const CSRF_COOKIE = 'pf_session_csrf';

function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

let token = readCookie(CSRF_COOKIE);
let retrying = false;

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = token || readCookie(CSRF_COOKIE);
    if (csrf) headers['x-csrf-token'] = csrf;
  }

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // Keep the in-memory token in sync with whatever the server just set.
  const fresh = readCookie(CSRF_COOKIE);
  if (fresh) token = fresh;

  let payload = null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    payload = await res.json().catch(() => null);
  }

  if (!res.ok) {
    // One automatic retry covers the case where the cookie was rotated.
    if (res.status === 403 && !retrying && method !== 'GET') {
      retrying = true;
      token = readCookie(CSRF_COOKIE);
      const result = await request(method, path, body);
      retrying = false;
      return result;
    }
    throw new ApiError(payload?.error || `Request failed (${res.status})`, res.status, payload);
  }
  return payload;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  put: (path, body) => request('PUT', path, body ?? {}),
  del: (path) => request('DELETE', path),
};
