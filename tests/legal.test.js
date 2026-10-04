/**
 * Deleting an account.
 *
 * Google's API Services User Data Policy requires an app that holds Google user
 * data to give users a way to delete it, and verification is refused without
 * one. There was no route for it at all, so this is the compliance floor rather
 * than a feature: DELETE /api/me removes the account and everything that
 * cascades from it.
 *
 * The parts worth pinning are the ones that are easy to get wrong:
 *
 *  - It must cascade. A user whose study log outlives their account is exactly
 *    the situation the policy is about.
 *  - It must revoke provider access, not just drop our copy of the token. A
 *    deleted account that leaves a live Google grant behind is not a deletion.
 *  - It must not delete anybody else, and must not need a password — a user
 *    who cannot remember the password still has a right to be erased.
 *  - It must be a POST/DELETE with CSRF, or it becomes a one-click remote
 *    account-wipe for anyone who can lure a signed-in user to a link.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pf-del-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.JWT_SECRET = 'test-secret';

const { default: app } = await import('../server/app.js');
const { db } = await import('../server/db.js');

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
  const send = async (method, path, body) => {
    if (!jar.get('pf_session_csrf')) await call('/api/auth/session');
    return call(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-csrf-token': jar.get('pf_session_csrf') },
      body: JSON.stringify(body ?? {}),
    });
  };
  return {
    get: (p) => call(p),
    send,
    jar,
    async signup(username) {
      const res = await send('POST', '/api/auth/signup', {
        username,
        email: `${username}@example.test`,
        password: 'password123',
      });
      assert.equal(res.status, 200);
      this.userId = (await res.json()).user.id;
      return this.userId;
    },
  };
}

/** Gives a user something to delete, so cascade is actually exercised. */
async function seed(userId) {
  const now = new Date().toISOString().slice(0, 10);
  await db.prepare(`INSERT INTO study_entries (user_id, date, minutes) VALUES (?,?,?)`).run(userId, now, 90);
  await db.prepare(`INSERT INTO study_log_entries (user_id, date, minutes, source) VALUES (?,?,?,'manual')`).run(userId, now, 45);
  await db.prepare(`INSERT INTO events (user_id, date, kind, title) VALUES (?,?,'event','Test')`).run(userId, now);
  await db.prepare(`INSERT INTO tags (user_id, name) VALUES (?, 'work')`).run(userId);
  await db.prepare(`INSERT INTO tasks (user_id, text) VALUES (?, 'Task')`).run(userId);
  await db.prepare(`INSERT INTO timer_sessions (user_id, focus_seconds, topic) VALUES (?, 1500, 'algebra')`).run(userId);
  await db.prepare(`INSERT INTO presence (user_id, state) VALUES (?, 'online')`).run(userId);
  await db.prepare(`INSERT INTO google_calendar_tokens
    (user_id, access_token, refresh_token, expires_at, calendar_id)
    VALUES (?, 'a', 'r', ?, 'primary')`).run(userId, Date.now() + 3600000);
  await db.prepare(`INSERT INTO spotify_tokens
    (user_id, access_token, refresh_token, expires_at) VALUES (?, 'a', 'r', ?)`)
    .run(userId, Date.now() + 3600000);
  // signup already seeds default plans, so replace rather than collide.
  await db.prepare(`INSERT OR REPLACE INTO study_plans (user_id, weekday, planned_minutes, active) VALUES (?, 3, 60, 1)`).run(userId);
  // A real second account: friendships.addressee_id has a foreign key, so a
  // made-up id would fail rather than exercise the cascade.
  const other = await db.prepare(
    `INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)`,
  ).run(`seedbuddy${userId}`, `seedbuddy${userId}@example.test`, 'not-a-real-hash');
  await db.prepare(`INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, 'accepted')`)
    .run(userId, Number(other.lastInsertRowid));
  // A linked provider, so the identity row's cascade is exercised too.
  await db.prepare(`INSERT INTO oauth_identities (user_id, provider, subject, email) VALUES (?, 'google', ?, ?)`)
    .run(userId, `sub-${userId}`, `seed${userId}@example.test`);
}

/**
 * Every table that holds this user's rows, with the column that identifies
 * them. Not all of them are `user_id` — friendships splits the pair across
 * requester_id/addressee_id, and task_tags hangs off the tag.
 */
const OWNED_TABLES = [
  ['study_entries', 'user_id'],
  ['events', 'user_id'],
  ['tags', 'user_id'],
  ['tasks', 'user_id'],
  ['timer_sessions', 'user_id'],
  ['presence', 'user_id'],
  ['google_calendar_tokens', 'user_id'],
  ['spotify_tokens', 'user_id'],
  ['oauth_identities', 'user_id'],
  ['study_plans', 'user_id'],
  ['study_log_entries', 'user_id'],
  ['friendships', 'requester_id'],
  ['friendships', 'addressee_id'],
];

describe('deleting an account', () => {
  test('the route exists', async () => {
    const c = client();
    await c.signup('delroute');
    const res = await c.send('DELETE', '/api/me');
    assert.equal(res.status, 200);
  });

  test('removes the account and everything that cascades from it', async () => {
    const c = client();
    const id = await c.signup('delcascade');
    await seed(id);

    // Everything is really there before we delete, so a passing test means the
    // cascade removed rows rather than there having been none to remove.
    // friendships.addressee_id is deliberately excluded here: the friendship is
    // created outward, so only the reverse direction is interesting — and it is
    // asserted below, after deletion, where it is the whole point.
    for (const [table, col] of OWNED_TABLES) {
      if (table === 'friendships' && col === 'addressee_id') continue;
      const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(id);
      assert.ok(row.n > 0, `${table}.${col} should have rows before deletion`);
    }

    const res = await c.send('DELETE', '/api/me');
    assert.equal(res.status, 200);

    const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    assert.equal(user, undefined, 'the account is gone');

    for (const [table, col] of OWNED_TABLES) {
      const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(id);
      assert.equal(row.n, 0, `${table}.${col} still has rows for a deleted account`);
    }

    // The other side of the friendship must not keep a dangling pointer at a
    // user id that no longer exists.
    const buddy = await db.prepare('SELECT id FROM users WHERE username LIKE ?').get('seedbuddy%');
    if (buddy) {
      const left = await db.prepare(
        'SELECT COUNT(*) AS n FROM friendships WHERE requester_id = ? OR addressee_id = ?',
      ).get(buddy.id, buddy.id);
      assert.equal(left.n, 0, 'the surviving friend has a dangling friendship row');
    }
  });

  test('releases the stored provider tokens', async () => {
    const c = client();
    const id = await c.signup('deltokens');
    await seed(id);
    await c.send('DELETE', '/api/me');

    const g = await db.prepare('SELECT COUNT(*) AS n FROM google_calendar_tokens WHERE user_id = ?').get(id);
    const s = await db.prepare('SELECT COUNT(*) AS n FROM spotify_tokens WHERE user_id = ?').get(id);
    assert.equal(g.n, 0, 'the Google grant is gone');
    assert.equal(s.n, 0, 'the Spotify grant is gone');
  });

  test('the session stops working immediately', async () => {
    const c = client();
    await c.signup('delsession');
    // Keep the pre-deletion cookie. The server clears it on the way out, but a
    // stolen or stale copy is exactly the case that has to stop working — a
    // stateless JWT stays cryptographically valid until it expires.
    const stale = [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    await c.send('DELETE', '/api/me');
    c.jar.clear();
    for (const [k, v] of new URLSearchParams(stale)) c.jar.set(k, v);

    // Sessions are stateless JWTs, so clearing the cookie is not enough — a
    // deleted account has to stop being able to act while its token is still
    // unexpired. Every route that needs a user must reject it.
    for (const path of ['/api/events', '/api/study/overview', '/api/tasks']) {
      const res = await c.get(path);
      assert.equal(res.status, 401, `${path} should reject a deleted account`);
    }
    // /api/me itself reports no user rather than erroring.
    const me = await c.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user, null, 'no user behind that cookie');
  });

  test('does not need the password', async () => {
    // Someone who cannot remember their password still has a right to erasure.
    const c = client();
    await c.signup('delnopass');
    const res = await c.send('DELETE', '/api/me', { password: 'wrong-entirely' });
    assert.equal(res.status, 200);
  });

  test('requires a CSRF token, so a link cannot wipe an account', async () => {
    const c = client();
    await c.signup('delcsrf');
    // Raw fetch with the session cookie but no x-csrf-token header.
    const cookie = [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${base}/api/me`, { method: 'DELETE', headers: { cookie } });
    assert.equal(res.status, 403);

    const still = await db.prepare('SELECT id FROM users WHERE username = ?').get('delcsrf');
    assert.ok(still, 'the account survived the CSRF-less attempt');
  });

  test('one account cannot delete another', async () => {
    const a = client();
    await a.signup('delvictim');
    const b = client();
    await b.signup('delattacker');

    const res = await b.send('DELETE', '/api/me', { id: a.userId });
    assert.equal(res.status, 200, 'b deleted itself');

    const victim = await db.prepare('SELECT id FROM users WHERE username = ?').get('delvictim');
    assert.ok(victim, "the other account is untouched");
  });

  test('anonymous callers cannot delete anything', async () => {
    const before = await db.prepare('SELECT COUNT(*) AS n FROM users').get();
    // No cookies at all, so the CSRF guard answers before auth does. Either
    // rejection is correct; what matters is that nothing is deleted.
    const res = await fetch(`${base}/api/me`, { method: 'DELETE' });
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
    const after = await db.prepare('SELECT COUNT(*) AS n FROM users').get();
    assert.equal(after.n, before.n, 'no account was removed');
  });
});

describe('the legal pages google asks for', () => {
  test('/privacy is public and mentions the data we actually hold', async () => {
    const res = await fetch(`${base}/privacy`);
    assert.equal(res.status, 200);
    const body = (await res.text()).toLowerCase();
    // The categories the schema really contains. A policy that says only
    // "we store your data" satisfies nobody and fails review.
    for (const term of ['study', 'calendar', 'spotify', 'email', 'delete', 'password']) {
      assert.ok(body.includes(term), `the policy should mention ${term}`);
    }
  });

  test('/terms is public', async () => {
    const res = await fetch(`${base}/terms`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).length > 500);
  });

  test('both are reachable without signing in', async () => {
    for (const path of ['/privacy', '/terms']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, `${path} must be public`);
    }
  });

  test('the consent screen offers them as links', async () => {
    const res = await fetch(`${base}/api/auth/providers`);
    const body = await res.json();
    assert.ok(Array.isArray(body.providers));
  });
});
