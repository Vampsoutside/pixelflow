/**
 * Guest mode.
 *
 * The point of a guest is that the whole app works without a login, so these
 * tests check that a guest is a real account — plans, tags, tasks and a
 * persistent session — and that claiming it keeps the data.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pf-guest-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.JWT_SECRET = 'test-secret';
// OAuth is irrelevant here, and a leftover real .env must not leak in.
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.MICROSOFT_CLIENT_ID;
delete process.env.MICROSOFT_CLIENT_SECRET;

const { default: app } = await import('../server/app.js');

let server;
let base;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

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
  call.post = async (path, body) => {
    if (!jar.get('pf_session_csrf')) await call('/api/auth/session');
    return call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': jar.get('pf_session_csrf') },
      body: JSON.stringify(body ?? {}),
    });
  };
  call.user = async () => (await (await call('/api/auth/session')).json()).user;
  call.keep = () => jar.get('pf_session');
  return call;
}

describe('starting a guest session', () => {
  test('needs no credentials at all', async () => {
    const call = client();
    const res = await call.post('/api/auth/guest');
    assert.equal(res.status, 200);

    const { user, csrfToken } = await res.json();
    assert.ok(user.id);
    assert.equal(user.isGuest, true);
    assert.ok(typeof csrfToken === 'string' && csrfToken.length > 10);
    assert.match(user.username, /^guest_/);
  });

  test('is already signed in afterwards', async () => {
    const call = client();
    await call.post('/api/auth/guest');
    const user = await call.user();
    assert.ok(user, 'the guest should have a session with no login step');
  });

  test('gives the guest real, usable data', async () => {
    const call = client();
    await call.post('/api/auth/guest');

    // The starter plan and tags a normal sign-up gets, so no screen is empty.
    const tasks = await (await call('/api/tasks')).json();
    assert.ok(Array.isArray(tasks.tasks));
    assert.ok(tasks.tags.length >= 2, 'expected the starter tags');

    const overview = await (await call('/api/study/overview?month=2026-09')).json();
    assert.ok(overview, 'the tracker should load for a guest');

    // And the guest can write, not just read.
    const created = await call.post('/api/tasks', { text: 'Guest task' });
    assert.equal(created.status, 200);
    const { taskId } = await created.json();
    assert.ok(taskId);

    const after = await (await call('/api/tasks')).json();
    assert.ok(after.tasks.some((t) => t.text === 'Guest task'));
  });

  test('each guest is a separate account', async () => {
    const a = client();
    const b = client();
    const ua = (await (await a.post('/api/auth/guest')).json()).user;
    const ub = (await (await b.post('/api/auth/guest')).json()).user;
    assert.notEqual(ua.id, ub.id);
    assert.notEqual(ua.username, ub.username);
  });

  test('cannot be signed into with a password', async () => {
    const call = client();
    const { user } = await (await call.post('/api/auth/guest')).json();

    const attempt = client();
    const res = await attempt.post('/api/auth/login', {
      username: user.username, password: 'password123',
    });
    assert.equal(res.status, 401);
  });

  test('the session survives a new request', async () => {
    const call = client();
    await call.post('/api/auth/guest');
    assert.ok(call.keep(), 'expected a session cookie');
    // A fresh request on the same jar is what a page reload does.
    assert.ok(await call.user());
  });
});

describe('claiming a guest account', () => {
  test('turns it into a normal account and keeps the data', async () => {
    const call = client();
    await call.post('/api/auth/guest');
    await call.post('/api/tasks', { text: 'Work worth keeping' });

    const res = await call.post('/api/auth/claim', {
      username: 'claimed_user',
      email: 'claimed@example.com',
      password: 'password123',
    });
    assert.equal(res.status, 200);

    const { user } = await res.json();
    assert.equal(user.isGuest, false);
    assert.equal(user.username, 'claimed_user');
    assert.equal(user.email, 'claimed@example.com');

    // The whole point: nothing logged while a guest is lost.
    const tasks = await (await call('/api/tasks')).json();
    assert.ok(tasks.tasks.some((t) => t.text === 'Work worth keeping'));
  });

  test('the new password really works', async () => {
    const fresh = client();
    const res = await fresh.post('/api/auth/login', {
      username: 'claimed_user', password: 'password123',
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.username, 'claimed_user');
  });

  test('rejects a weak password', async () => {
    const call = client();
    await call.post('/api/auth/guest');
    const res = await call.post('/api/auth/claim', {
      username: 'shorty', email: 'shorty@example.com', password: 'abc',
    });
    assert.equal(res.status, 400);
  });

  test('rejects a username someone else already has', async () => {
    const call = client();
    await call.post('/api/auth/guest');
    const res = await call.post('/api/auth/claim', {
      username: 'claimed_user', email: 'different@example.com', password: 'password123',
    });
    assert.equal(res.status, 409);
    // Still a guest, so the account is not half-migrated.
    assert.equal((await call.user()).isGuest, true);
  });

  test('rejects an email someone else already has', async () => {
    const call = client();
    await call.post('/api/auth/guest');
    const res = await call.post('/api/auth/claim', {
      username: 'brandnew', email: 'claimed@example.com', password: 'password123',
    });
    assert.equal(res.status, 409);
  });

  test('cannot be claimed twice', async () => {
    const call = client();
    await call.post('/api/auth/guest');
    await call.post('/api/auth/claim', {
      username: 'once_only', email: 'once@example.com', password: 'password123',
    });
    const again = await call.post('/api/auth/claim', {
      username: 'twice', email: 'twice@example.com', password: 'password123',
    });
    assert.equal(again.status, 409);
  });

  test('requires a session', async () => {
    const res = await client().post('/api/auth/claim', {
      username: 'nobody', email: 'nobody@example.com', password: 'password123',
    });
    assert.equal(res.status, 401);
  });
});

describe('existing accounts', () => {
  test('are not reported as guests', async () => {
    const call = client();
    const res = await call.post('/api/auth/signup', {
      username: 'regular_user', email: 'regular@example.com', password: 'password123',
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.isGuest, false);
  });

  test('cannot be claimed', async () => {
    const call = client();
    await call.post('/api/auth/signup', {
      username: 'regular_two', email: 'regular2@example.com', password: 'password123',
    });
    const res = await call.post('/api/auth/claim', {
      username: 'renamed', email: 'renamed@example.com', password: 'password123',
    });
    assert.equal(res.status, 409);
    assert.equal((await call.user()).username, 'regular_two');
  });
});
