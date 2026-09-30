/**
 * End-to-end test for sign in with Google / Microsoft.
 *
 * The provider endpoints are the only thing that cannot run locally, so
 * `globalThis.fetch` is stubbed for them. Everything below that line — the
 * state round trip, the token exchange, the account-linking rules and the
 * session cookie — is the real code path.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// These have to be set before server/db.js is imported: it reads them at
// module load to decide where the database lives.
const dir = mkdtempSync(join(tmpdir(), 'pf-oauth-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.JWT_SECRET = 'test-secret';
process.env.GOOGLE_CLIENT_ID = 'google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
process.env.MICROSOFT_CLIENT_ID = 'ms-client-id';
process.env.MICROSOFT_CLIENT_SECRET = 'ms-client-secret';
process.env.PUBLIC_ORIGIN = 'http://127.0.0.1:9999';

const { default: app } = await import('../server/app.js');

/** What the stubbed userinfo endpoint should return next. */
let profile = { sub: 'google-sub-1', email: 'ada@example.com', name: 'Ada Lovelace' };
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes('oauth2.googleapis.com/token')) {
    return new Response(JSON.stringify({ access_token: 'stub-token', expires_in: 3600 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  if (url.includes('microsoftonline.com') && url.includes('token')) {
    return new Response(JSON.stringify({ access_token: 'stub-token', expires_in: 3600 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  if (url.includes('openidconnect.googleapis.com')
    || url.includes('graph.microsoft.com/oidc/userinfo')) {
    return new Response(JSON.stringify(profile), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(input, init);
};

let server;
let base;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

/** Minimal cookie-aware fetch that never follows redirects. */
function client() {
  const jar = new Map();

  const call = async (path, init = {}) => {
    const headers = { ...(init.headers || {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  };

  // The CSRF guard compares a header against a cookie, so POSTs need both. The
  // cookie is issued on first contact, hence the lazy fetch.
  call.post = async (path, body) => {
    if (!call.csrf()) await call('/api/auth/session');
    return call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': call.csrf() },
      body: JSON.stringify(body),
    });
  };
  call.csrf = () => jar.get('pf_session_csrf') || '';
  call.user = async () => (await (await call('/api/auth/session')).json()).user;

  return call;
}

const location = (res) => res.headers.get('location') || '';

describe('provider discovery', () => {
  test('reports configured providers', async () => {
    const res = await fetch(`${base}/api/auth/providers`);
    const { providers } = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(providers.map((p) => p.name).sort(), ['google', 'microsoft']);
    assert.ok(providers.every((p) => typeof p.label === 'string'));
  });

  test('exposes the redirect URI a provider was told about', async () => {
    const res = await fetch(`${base}/api/auth/providers/google/redirect-uri`);
    const body = await res.json();
    // Must match PUBLIC_ORIGIN or the provider console will reject the callback.
    assert.equal(body.redirectUri, 'http://127.0.0.1:9999/api/auth/google/callback');
  });

  test('rejects an unknown provider', async () => {
    const res = await fetch(`${base}/api/auth/providers/facebook/redirect-uri`);
    assert.equal(res.status, 404);
  });
});

describe('the authorization redirect', () => {
  test('sends the browser to Google with the right parameters', async () => {
    const call = client();
    const res = await call('/api/auth/google/login');
    assert.equal(res.status, 302);

    const url = new URL(location(res));
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('client_id'), 'google-client-id');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('scope'), 'openid email profile');
    assert.equal(
      url.searchParams.get('redirect_uri'),
      'http://127.0.0.1:9999/api/auth/google/callback',
    );
    // access_type=online is what makes Google return the email at all.
    assert.equal(url.searchParams.get('access_type'), 'online');
    assert.ok(url.searchParams.get('state').length >= 16);
  });

  test('sends the browser to Microsoft', async () => {
    const res = await client()('/api/auth/microsoft/login');
    const url = new URL(location(res));
    assert.match(url.hostname, /login\.microsoftonline\.com/);
    assert.equal(url.searchParams.get('client_id'), 'ms-client-id');
  });

  test('refuses an unknown provider', async () => {
    const res = await client()('/api/auth/apple/login');
    assert.equal(res.status, 404);
  });
});

describe('the callback', () => {
  test('rejects a state that was never issued', async () => {
    const res = await client()('/api/auth/google/callback?code=x&state=not-a-real-state');
    assert.equal(location(res), '/?auth=bad-state');
  });

  test('rejects a state issued for a different provider', async () => {
    const call = client();
    const start = await call('/api/auth/google/login');
    const state = new URL(location(start)).searchParams.get('state');
    // Replay Google's state to Microsoft: the provider column must not match.
    const res = await call(`/api/auth/microsoft/callback?code=x&state=${state}`);
    assert.equal(location(res), '/?auth=bad-state');
  });

  test('reports a cancelled consent screen', async () => {
    const res = await client()('/api/auth/google/callback?error=access_denied');
    assert.equal(location(res), '/?auth=denied&provider=google');
  });

  test('creates an account and signs in on first use', async () => {
    profile = { sub: 'google-sub-new', email: 'grace@example.com', name: 'Grace Hopper' };
    const call = client();

    const start = await call('/api/auth/google/login');
    const state = new URL(location(start)).searchParams.get('state');
    const res = await call(`/api/auth/google/callback?code=abc&state=${state}`);

    assert.equal(location(res), '/?auth=welcome&provider=google');
    // A session cookie is what makes the redirect actually signed in.
    const session = await call('/api/auth/session');
    const { user } = await session.json();
    assert.ok(user, 'expected a signed-in user');
    assert.equal(user.email, 'grace@example.com');
    // Derived from the email local part, since that is the friendliest handle.
    assert.equal(user.username, 'grace');
    // A new account is not an empty shell: starter plan and tags come along.
    assert.ok(user.settings.focusMins > 0);
  });

  test('a provider-only account cannot be signed into with a password', async () => {
    const call = client();
    const res = await call.post('/api/auth/login', {
      username: 'grace', password: 'password123',
    });
    assert.equal(res.status, 401);
  });

  test('the same subject returns the same account', async () => {
    profile = { sub: 'google-sub-new', email: 'grace@example.com', name: 'Grace Hopper' };
    const call = client();
    const start = await call('/api/auth/google/login');
    const state = new URL(location(start)).searchParams.get('state');
    const res = await call(`/api/auth/google/callback?code=abc&state=${state}`);

    assert.equal(location(res), '/?auth=ok&provider=google');
    const { user } = await (await call('/api/auth/session')).json();
    assert.equal(user.username, 'grace');
  });

  test('state is single-use', async () => {
    profile = { sub: 'google-sub-replay', email: 'replay@example.com' };
    const call = client();
    const start = await call('/api/auth/google/login');
    const state = new URL(location(start)).searchParams.get('state');

    const first = await call(`/api/auth/google/callback?code=abc&state=${state}`);
    assert.equal(location(first), '/?auth=welcome&provider=google');

    // The same state again must not work, or a captured URL is a permanent
    // sign-in link.
    const second = await call(`/api/auth/google/callback?code=abc&state=${state}`);
    assert.equal(location(second), '/?auth=bad-state');
  });

  test('links to an existing local account when the email matches', async () => {
    const call = client();
    await call('/api/auth/session');
    const signup = await call.post('/api/auth/signup', {
      username: 'linus', email: 'linus@example.com', password: 'password123',
    });
    assert.equal(signup.status, 200);

    // The same person, arriving through Google this time.
    profile = { sub: 'google-sub-linus', email: 'linus@example.com', name: 'Linus' };
    const fresh = client();
    const start = await fresh('/api/auth/google/login');
    const state = new URL(location(start)).searchParams.get('state');
    const res = await fresh(`/api/auth/google/callback?code=abc&state=${state}`);

    // Not a new account: the existing one is reused.
    assert.equal(location(res), '/?auth=ok&provider=google');
    const { user } = await (await fresh('/api/auth/session')).json();
    assert.equal(user.username, 'linus');

    // And the original password still works on that account.
    const byPassword = client();
    await byPassword('/api/auth/session');
    const login = await byPassword.post('/api/auth/login', {
      username: 'linus', password: 'password123',
    });
    assert.equal(login.status, 200);
  });

  test('does not merge two provider accounts that share an email', async () => {
    // A second Google identity claiming the same address must get its own
    // account rather than silently taking over the first.
    profile = { sub: 'google-sub-impostor', email: 'linus@example.com', name: 'Someone Else' };
    const call = client();
    const start = await call('/api/auth/google/login');
    const state = new URL(location(start)).searchParams.get('state');
    const res = await call(`/api/auth/google/callback?code=abc&state=${state}`);

    assert.equal(location(res), '/?auth=welcome&provider=google');
    const { user } = await (await call('/api/auth/session')).json();
    assert.notEqual(user.username, 'linus');
  });

  test('handles a provider that returns no email', async () => {
    profile = { sub: 'ms-sub-anon', email: undefined, name: 'Anon' };
    const call = client();
    const start = await call('/api/auth/microsoft/login');
    const state = new URL(location(start)).searchParams.get('state');
    const res = await call(`/api/auth/microsoft/callback?code=abc&state=${state}`);

    assert.equal(location(res), '/?auth=welcome&provider=microsoft');
    const { user } = await (await call('/api/auth/session')).json();
    // Falls back to a placeholder address so the NOT NULL column is satisfied.
    assert.equal(user.email, 'microsoft-ms-sub-anon@linked.local');
    assert.ok(user.username.length >= 3);
  });

  test('derives a username that avoids collisions', async () => {
    profile = { sub: 'google-sub-clash', email: 'grace@example.com', name: 'Grace' };
    const call = client();
    const start = await call('/api/auth/google/login');
    const state = new URL(location(start)).searchParams.get('state');
    const res = await call(`/api/auth/google/callback?code=abc&state=${state}`);

    assert.equal(location(res), '/?auth=welcome&provider=google');
    const { user } = await (await call('/api/auth/session')).json();
    // "grace" is taken, so the name must have been made unique.
    assert.notEqual(user.username, 'grace');
    assert.match(user.username, /^grace/);
  });
});

describe('linking and unlinking', () => {
  test('a signed-in visitor links the provider to their existing account', async () => {
    const call = client();
    await call('/api/auth/session');
    await call.post('/api/auth/signup', {
      username: 'maya', email: 'maya@example.com', password: 'password123',
    });

    profile = { sub: 'google-sub-maya', email: 'maya@example.com', name: 'Maya' };

    // Started while already signed in, so it should attach rather than create.
    const start = await call('/api/auth/google/login');
    const state = new URL(location(start)).searchParams.get('state');
    const res = await call(`/api/auth/google/callback?code=abc&state=${state}`);
    assert.equal(location(res), '/?auth=linked&provider=google');

    assert.equal((await call.user()).username, 'maya');
  });

  test('lists the linked providers for the signed-in account', async () => {
    const call = client();
    await call('/api/auth/session');
    await call.post('/api/auth/login', { username: 'maya', password: 'password123' });
    const { linked } = await (await call('/api/auth/providers/linked')).json();
    assert.ok(linked.some((l) => l.provider === 'google'));
    assert.ok(linked.every((l) => typeof l.label === 'string'));
  });

  test('unlinking requires a session', async () => {
    const call = client();
    // Take the CSRF cookie first, so the failure can only be the missing
    // session rather than the CSRF guard answering first.
    await call('/api/auth/session');
    assert.ok(call.csrf(), 'expected a CSRF cookie');
    const res = await call.post('/api/auth/providers/google/unlink');
    assert.equal(res.status, 401);
  });

  test('unlinking is rejected without a CSRF token', async () => {
    const call = client();
    await call('/api/auth/session');
    const res = await call('/api/auth/providers/google/unlink', { method: 'POST' });
    assert.equal(res.status, 403);
  });

  test('unlinking removes the provider but keeps the account', async () => {
    const call = client();
    await call('/api/auth/session');
    await call.post('/api/auth/login', { username: 'maya', password: 'password123' });

    const res = await call.post('/api/auth/providers/google/unlink');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(!body.linked.some((l) => l.provider === 'google'));

    // Still signed in — unlinking a provider is not signing out.
    assert.equal((await call.user()).username, 'maya');
  });
});
