/**
 * Regressions.
 *
 * Every test here corresponds to a bug that reached main with the suite green,
 * so each one is written to fail against the old code. They are grouped by the
 * file that owned the fix.
 *
 * The CSRF tests matter most: the guard used to answer 500 instead of 403 for a
 * wrong-length token, and the client only retries a 403 — so a stale or
 * mangled token turned into a silently dead write rather than a visible error.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'pf-regress-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.JWT_SECRET = 'test-secret';
delete process.env.USE_HTTPS;

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
  const write = (method) => async (path, body) => {
    if (!jar.get('pf_session_csrf')) await call('/api/auth/session');
    return call(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-csrf-token': jar.get('pf_session_csrf') },
      body: JSON.stringify(body ?? {}),
    });
  };
  call.post = write('POST');
  call.put = write('PUT');
  call.del = write('DELETE');
  /** A write with an explicit token, for the CSRF tests. */
  call.withToken = (method, path, body, token) => call(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-csrf-token': token },
    body: JSON.stringify(body ?? {}),
  });
  call.user = async () => (await (await call('/api/auth/session')).json()).user;
  call.csrf = () => jar.get('pf_session_csrf');
  return call;
}

let seq = 0;
const uniq = () => `r${(seq += 1)}_${Date.now().toString(36)}`;

async function signedIn() {
  const c = client();
  await c.post('/api/auth/guest');
  return c;
}

// ── the CSRF guard ────────────────────────────────────────────────────────

describe('the CSRF guard', () => {
  test('rejects a wrong token of a different length with 403, not 500', async () => {
    // timingSafeEqual throws on a length mismatch, so the guard used to let
    // that escape into the error middleware. The client retries on 403 only,
    // so a 500 left the write dead with no way for the page to recover.
    const c = await signedIn();
    const real = c.csrf();
    const res = await c.withToken('POST', '/api/tasks', { text: 'x' }, real.slice(0, 8));
    assert.equal(res.status, 403);
  });

  test('rejects a longer wrong token the same way', async () => {
    const c = await signedIn();
    const res = await c.withToken('POST', '/api/tasks', { text: 'x' }, `${c.csrf()}extra`);
    assert.equal(res.status, 403);
  });

  test('rejects a wrong token of the same length with 403', async () => {
    const c = await signedIn();
    const res = await c.withToken('POST', '/api/tasks', { text: 'x' }, 'x'.repeat(c.csrf().length));
    assert.equal(res.status, 403);
  });

  test('rejects a missing token', async () => {
    const c = await signedIn();
    const res = await c('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    assert.equal(res.status, 403);
  });

  test('still accepts the real token', async () => {
    const c = await signedIn();
    const res = await c.withToken('POST', '/api/tasks', { text: 'works' }, c.csrf());
    assert.equal(res.status, 200);
  });
});

describe('the csrfToken in a sign-in response', () => {
  // It used to be a freshly generated value that was never stored anywhere, so
  // a client that trusted it got a 403 on its very next write.
  for (const [label, path, body] of [
    ['signup', '/api/auth/signup', () => ({ username: uniq(), email: `${uniq()}@example.com`, password: 'password123' })],
    ['login', '/api/auth/login', () => null],   // filled in per-run below
    ['guest', '/api/auth/guest', () => ({})],
  ]) {
    test(`${label} returns the token the client must send`, async () => {
      const c = client();
      await c('/api/auth/session');
      let payload = body();
      if (label === 'login') {
        const name = uniq();
        payload = { username: name, password: 'password123' };
        await c.post('/api/auth/signup', { username: name, email: `${name}@example.com`, password: 'password123' });
        // A fresh jar, so the login response is the one carrying the token.
        const fresh = client();
        await fresh('/api/auth/session');
        const res = await fresh.post('/api/auth/login', payload);
        const { csrfToken } = await res.json();
        assert.equal(csrfToken, fresh.csrf(), 'the returned token must be the cookie value');
        const write = await fresh.withToken('POST', '/api/tasks', { text: 'after login' }, csrfToken);
        assert.equal(write.status, 200);
        return;
      }
      const res = await c.post(path, payload);
      const { csrfToken } = await res.json();
      assert.equal(csrfToken, c.csrf(), 'the returned token must be the cookie value');
      const write = await c.withToken('POST', '/api/tasks', { text: 'after sign-in' }, csrfToken);
      assert.equal(write.status, 200);
    });
  }
});

// ── reading another account ───────────────────────────────────────────────

describe('reading another account by id', () => {
  test('never returns their email', async () => {
    const victim = client();
    const name = uniq();
    await victim.post('/api/auth/signup', {
      username: name, email: `${name}@secret.example.com`, password: 'password123',
    });
    const user = await victim.user();

    const stranger = await signedIn();
    const res = await stranger(`/api/auth/users/${user.id}`);
    assert.equal(res.status, 200);

    const seen = await res.json();
    assert.equal(seen.user.email, undefined, 'another account must not expose an email');
    assert.equal(seen.user.settings, undefined, 'nor their settings');
    assert.equal(seen.user.isGuest, undefined, 'nor their guest flag');
    // The public half is still there — this is a projection, not a 403.
    assert.equal(seen.user.username, name);
    assert.equal(seen.user.id, user.id);
    assert.ok(seen.user.avatar);
  });

  test('never exposes a password hash', async () => {
    const a = client();
    const name = uniq();
    await a.post('/api/auth/signup', { username: name, email: `${name}@e.com`, password: 'password123' });
    const user = await a.user();
    const b = await signedIn();
    const seen = await (await b(`/api/auth/users/${user.id}`)).json();
    assert.equal(JSON.stringify(seen).includes('scrypt$'), false);
  });

  test('still answers 404 for an id that does not exist', async () => {
    const c = await signedIn();
    assert.equal((await c('/api/auth/users/999999')).status, 404);
  });

  test('still requires a session', async () => {
    const c = client();
    assert.equal((await c('/api/auth/users/1')).status, 401);
  });
});

// ── the timer and the ledger ──────────────────────────────────────────────

describe('a pomodoro that is not a whole number of minutes', () => {
  // 90 seconds is 1.5 minutes. The rollup stored the fraction while the ledger
  // rounded, so every chart and the Logs feed disagreed about the same day.
  test('the day total and the log feed agree', async () => {
    const c = await signedIn();
    const user = await c.user();

    const res = await c.post('/api/study/sessions', { focus_seconds: 90, kind: 'focus' });
    const { loggedMinutes } = await res.json();
    assert.equal(loggedMinutes, 2, 'reported minutes should be a whole number');

    const rollup = await db.prepare('SELECT minutes FROM study_entries WHERE user_id = ?').get(user.id);
    const logs = await (await c('/api/study/logs')).json();
    const ledgerSum = logs.entries.reduce((s, e) => s + e.minutes, 0);

    assert.equal(rollup.minutes, ledgerSum, 'the day and the ledger must not drift apart');
    assert.equal(rollup.minutes, 2);
  });

  test('no fractional minutes reach the database', async () => {
    const c = await signedIn();
    const user = await c.user();
    for (const seconds of [30, 90, 100, 150]) {
      await c.post('/api/study/sessions', { focus_seconds: seconds, kind: 'focus' });
    }
    const rows = await db.prepare('SELECT minutes FROM study_entries WHERE user_id = ?').all(user.id);
    for (const row of rows) {
      assert.equal(row.minutes, Math.round(row.minutes), 'study_entries.minutes must be an integer');
    }
    const ledger = await db.prepare('SELECT minutes FROM study_log_entries WHERE user_id = ?').all(user.id);
    for (const row of ledger) {
      assert.equal(row.minutes, Math.round(row.minutes));
    }
  });

  test('a sub-30-second pomodoro logs nothing rather than a rounded zero', async () => {
    const c = await signedIn();
    const user = await c.user();
    const res = await c.post('/api/study/sessions', { focus_seconds: 10, kind: 'focus' });
    const body = await res.json();
    assert.equal(body.loggedMinutes, 0);
    assert.equal(body.autoLogged, false);

    const rollup = await db.prepare('SELECT minutes FROM study_entries WHERE user_id = ?').get(user.id);
    const ledger = await db.prepare('SELECT COUNT(*) AS n FROM study_log_entries WHERE user_id = ?').get(user.id);
    assert.ok(!rollup || rollup.minutes === 0, 'nothing under a minute should be logged');
    assert.equal(ledger.n, 0, 'and no ledger row either');
  });

  test('undoing the pomodoro returns the day to zero', async () => {
    const c = await signedIn();
    await c.post('/api/study/sessions', { focus_seconds: 90, kind: 'focus' });
    const logs = await (await c('/api/study/logs')).json();
    const res = await c.del(`/api/study/logs/${logs.entries[0].id}`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).studied, 0);

    const after = await (await c('/api/study/logs')).json();
    assert.equal(after.entries.length, 0);
  });
});

// ── editing a calendar item ───────────────────────────────────────────────

describe('turning a timed event into a deadline', () => {
  // The one edit the UI has to be able to make. It used to 400, because the
  // old time was carried into the conversion and a deadline may not have one.
  async function timedEvent() {
    const c = await signedIn();
    const created = await (await c.post('/api/events', {
      title: 'Standup', date: '2026-10-05', kind: 'event', time: '09:30',
    })).json();
    return { c, id: created.id };
  }

  const find = (body, id) => body.events.find((e) => e.id === id);

  test('sending only the new kind works', async () => {
    const { c, id } = await timedEvent();
    const res = await c.put(`/api/events/${id}`, { kind: 'deadline' });
    assert.equal(res.status, 200);
    const item = find(await res.json(), id);
    assert.equal(item.kind, 'deadline');
    assert.equal(item.time, null, 'the old time must not survive the conversion');
  });

  test('an explicit null time works too', async () => {
    const { c, id } = await timedEvent();
    const res = await c.put(`/api/events/${id}`, { kind: 'deadline', time: null });
    assert.equal(res.status, 200);
    assert.equal(find(await res.json(), id).time, null);
  });

  test('a deadline still refuses a time', async () => {
    const { c, id } = await timedEvent();
    const res = await c.put(`/api/events/${id}`, { kind: 'deadline', time: '09:30' });
    assert.equal(res.status, 400);
  });

  test('an event keeps its time when the kind is not touched', async () => {
    const { c, id } = await timedEvent();
    const res = await c.put(`/api/events/${id}`, { title: 'Renamed' });
    assert.equal(res.status, 200);
    const item = find(await res.json(), id);
    assert.equal(item.time, '09:30', 'a rename must not drop the time');
    assert.equal(item.title, 'Renamed');
  });

  test('an event can be given a time after having none', async () => {
    const c = await signedIn();
    const created = await (await c.post('/api/events', {
      title: 'All day', date: '2026-10-07', kind: 'event',
    })).json();
    const res = await c.put(`/api/events/${created.id}`, { time: '14:00' });
    assert.equal(res.status, 200);
    assert.equal(find(await res.json(), created.id).time, '14:00');
  });
});

// ── the overview date parameter ──────────────────────────────────────────

describe('GET /api/study/overview?date=', () => {
  // Lets the Analytics date picker move one box without refetching the week.
  // monthInputs only loads the requested month, so answering a cross-month date
  // from those rows would silently report zero and overwrite a real figure —
  // that is the case these tests exist to prevent.

  test('an absent date still means today', async () => {
    const c = await signedIn();
    const body = await (await c('/api/study/overview')).json();
    const now = new Date();
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    assert.equal(body.today.date, key);
  });

  test('asks about a specific day in the current month', async () => {
    const c = await signedIn();
    const now = new Date();
    // Yesterday, staying inside this month so the read is answerable.
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const key = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
    const month = key.slice(0, 7);

    await c.put('/api/study/entry', { date: key, minutes: 95 });

    const body = await (await c(`/api/study/overview?month=${month}&date=${key}`)).json();
    assert.equal(body.today.date, key, 'the response must describe the day that was asked for');
    assert.equal(body.today.studied, 95);
    assert.equal(body.today.studiedText, '1h 35m');
  });

  test('still reports the current week, not the week of the asked-for day', async () => {
    // The weekly plan is a recurring template on the current week; moving the
    // `today` box must not drag the week with it.
    const c = await signedIn();
    const body = await (await c('/api/study/overview')).json();
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (body.today.date !== todayKey) return; // only meaningful for today itself
    assert.equal(body.week.start.length, 10);
    assert.ok(body.planGrid.length === 7, 'the plan grid is always seven days');
  });

  test('a day in another month is refused, not answered from this month', async () => {
    const c = await signedIn();
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    // Walk back until we leave this month, then back up to a day that is real.
    const probe = new Date(now.getFullYear(), now.getMonth(), 1);
    probe.setMonth(probe.getMonth() - 1);
    const lastPrev = new Date(now.getFullYear(), now.getMonth(), 0);
    const key = `${lastPrev.getFullYear()}-${String(lastPrev.getMonth() + 1).padStart(2, '0')}-${String(lastPrev.getDate()).padStart(2, '0')}`;
    assert.notEqual(key.slice(0, 7), thisMonth);

    const res = await c(`/api/study/overview?month=${thisMonth}&date=${key}`);
    assert.equal(res.status, 409, 'a cross-month date must not be answered from the wrong rows');
    assert.equal((await res.json()).month, key.slice(0, 7), 'the error says which month to use');
  });

  test('a future day is refused', async () => {
    const c = await signedIn();
    const now = new Date();
    const future = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
    const key = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;
    const res = await c(`/api/study/overview?month=${key.slice(0, 7)}&date=${key}`);
    assert.ok([400, 409].includes(res.status), `a future day must be refused, got ${res.status}`);
  });

  test('a date that is not a real calendar day is refused', async () => {
    const c = await signedIn();
    for (const bad of ['2026-02-30', '2026-13-01', 'not-a-date', '2026-1-1', '']) {
      const res = await c(`/api/study/overview?date=${encodeURIComponent(bad)}`);
      assert.ok(res.status === 400 || res.status === 200 && !bad,
        `${JSON.stringify(bad)} must not be accepted as a date (got ${res.status})`);
    }
  });

  test('another account cannot be affected by it', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const key = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
    await a.put('/api/study/entry', { date: key, minutes: 300 });

    const month = key.slice(0, 7);
    const bodyB = await (await b(`/api/study/overview?month=${month}&date=${key}`)).json();
    assert.equal(bodyB.today.studied, 0, "one account's entry must not appear for another");
  });
});

// ── the session secret ──────────────────────────────────────────────────

describe('the session signing secret', () => {
  // It used to be `process.env.JWT_SECRET || 'pixelflow-dev-secret-…'`, so a
  // deployment that forgot the variable still booted and signed real sessions
  // with a constant that is published in this repository. Anyone who had read
  // the source could mint a token for any user id and be accepted.
  const bootWith = (env) => spawnSync(process.execPath, ['-e', "import('./server/auth.js')"], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, JWT_SECRET: '', NODE_ENV: 'development', ...env },
    encoding: 'utf8',
  });

  test('production refuses to start without one', () => {
    const res = bootWith({ NODE_ENV: 'production' });
    assert.notEqual(res.status, 0, 'the process must fail, not serve');
    assert.match(res.stderr, /JWT_SECRET is not set/);
  });

  test('the failure happens at boot, not on the first login', () => {
    // secret() is only called when a token is signed or read, so a lazy check
    // would let the server answer /api/health and then throw mid-session —
    // which reads as an outage rather than a misconfiguration.
    const res = bootWith({ NODE_ENV: 'production' });
    assert.match(res.stderr, /Refusing to start/);
    assert.doesNotMatch(res.stderr, /Cannot find module/, 'it must be the secret, not an import failure');
  });

  test('a non-production run still boots, on a random per-process key', () => {
    // A laptop with no .env has to work. The key is generated rather than
    // hardcoded, so it is not a shared constant either.
    const res = bootWith({ NODE_ENV: 'development' });
    assert.equal(res.status, 0, `dev boot must succeed: ${res.stderr}`);
  });

  test('a configured secret is used as given', () => {
    const res = bootWith({ NODE_ENV: 'production', JWT_SECRET: 'a-real-secret' });
    assert.equal(res.status, 0, `a configured secret must boot: ${res.stderr}`);
  });

  // Every deployment marker, not just NODE_ENV. The first version of this guard
  // checked NODE_ENV and VERCEL=1 only, so a deploy that identified itself by
  // VERCEL_ENV booted with the development fallback — the exact failure the
  // guard exists to prevent, one variable away.
  for (const [label, env] of [
    ['NODE_ENV=production', { NODE_ENV: 'production' }],
    ['VERCEL=1', { VERCEL: '1' }],
    ['VERCEL_ENV=production', { VERCEL_ENV: 'production' }],
  ]) {
    test(`${label} is refused without a secret`, () => {
      const res = bootWith(env);
      assert.notEqual(res.status, 0, `${label} must not boot without JWT_SECRET`);
      assert.match(res.stderr, /JWT_SECRET is not set/);
    });
  }

  test('no session is accepted that was signed with the old constant', async () => {
    // Belt and braces: even if the fallback came back, a token carrying it must
    // not be honoured.
    const c = await signedIn();
    assert.ok(await c.user(), 'the real session works');
  });
});

// ── friends search wildcards ────────────────────────────────────────────

describe('friends search', () => {
  // `WHERE username LIKE '%' || q || '%'` with no ESCAPE meant q='%' matched
  // every row. The 2-character floor did not help: '%%' is two characters.
  const search = async (c, q) => (await c(`/api/friends/search?q=${encodeURIComponent(q)}`)).json();

  /**
   * Creates an account the searcher is NOT.
   *
   * signup signs the caller in as the new account, and search deliberately
   * excludes whoever is asking — so using one client for both means searching
   * for yourself and finding nothing. A separate client per account is the only
   * way to build the situation the route is actually for.
   */
  const someoneElse = async (username) => {
    const other = client();
    await other('/api/auth/session');
    await other.post('/api/auth/signup', {
      username, email: `${username}@e.com`, password: 'password123',
    });
    return other;
  };

  test('a per-cent is a literal, not a wildcard', async () => {
    const c = await signedIn();
    await someoneElse('alpha');
    await someoneElse('beta');
    await someoneElse('gamma');

    const viaPercent = await search(c, '%%');
    assert.equal(viaPercent.users.length, 0, "'%%' must not return the whole user table");
    assert.equal((await search(c, '%')).users.length, 0, "a bare '%' must match nothing");
  });

  test('an underscore is a literal, not a single-character wildcard', async () => {
    const c = await signedIn();
    await someoneElse('zebra');
    // 'a_a' as a wildcard would match 'zebra'; as a literal it matches nothing.
    assert.equal((await search(c, 'a_a')).users.length, 0, "'a_a' must not match 'zebra'");
  });

  test('a real substring still matches', async () => {
    // The fix must not break ordinary search.
    const c = await signedIn();
    await someoneElse('searchable');
    const found = await search(c, 'searchab');
    assert.ok(
      found.users.some((u) => u.username === 'searchable'),
      'a genuine substring must still find the account',
    );
  });

  test('the searcher never appears in their own results', async () => {
    const me = await signedIn();
    const { id, username } = await me.user();
    // Both a common letter and the account's own name.
    for (const q of ['a', username]) {
      const { users } = await search(me, q);
      assert.equal(users.some((u) => u.id === id), false, 'you must not be able to find yourself');
    }
  });

  test('a search result carries no private fields', async () => {
    const c = await signedIn();
    await someoneElse('privateone');
    const { users } = await search(c, 'private');
    assert.ok(users.length > 0, 'the account should be findable');
    for (const u of users) {
      assert.equal(u.email, undefined, 'a search result must not expose an email');
      assert.equal(u.password_hash, undefined, 'nor a hash');
      assert.equal(u.is_guest, undefined, 'nor the guest flag');
      assert.equal(u.settings, undefined, 'nor their settings');
    }
  });
});

// ── secret values must not reach the logs ───────────────────────────────

describe('a failed query', () => {
  // The error path appended the bound arguments to the message, and the error
  // middleware console.error's it. A failed INSERT into spotify_tokens therefore
  // printed the OAuth access and refresh tokens in the clear.
  test('does not print secret arguments', async () => {
    const { db } = await import('../server/db.js');
    const SECRET = 'SECRET_ACCESS_TOKEN_do_not_log_me';
    await assert.rejects(
      () => db.prepare(`
        INSERT INTO spotify_tokens (user_id, access_token, refresh_token, expires_at, scope)
        VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET access_token=excluded.access_token
      `).run(999999, SECRET, 'REFRESH_also_secret', 1, 'test'),
      (err) => {
        assert.doesNotMatch(err.message, new RegExp(SECRET), 'the access token must not be in the message');
        assert.doesNotMatch(err.message, /REFRESH_also_secret/, 'nor the refresh token');
        // The diagnostic has to survive, or the log is useless.
        assert.match(err.message, /INSERT INTO spotify_tokens/, 'the statement should still be named');
        assert.match(err.message, /redacted/, 'and the value reported as redacted');
        return true;
      },
    );
  });

  test('an ordinary value is still printed, or the log is useless', async () => {
    const { db } = await import('../server/db.js');
    await assert.rejects(
      () => db.prepare('INSERT INTO tags (user_id, name, color) VALUES (?,?,?)')
        .run(999999, 'a perfectly ordinary tag', '#fff'),
      (err) => {
        assert.match(err.message, /a perfectly ordinary tag/, 'non-secret args must remain readable');
        return true;
      },
    );
  });
});

// ── input validation on the plan routes ────────────────────────────────

describe('rejecting an impossible weekday', () => {
  // The bound lived in the route and nothing tested it. The schema's CHECK
  // constraint would still stop the write, but it answers 500 rather than 400 —
  // so removing the guard turns a clear client error into an unhandled one.
  test('the plan endpoint refuses a weekday outside 0–6', async () => {
    const c = await signedIn();
    for (const bad of [7, 8, -1, 99]) {
      const res = await c.put('/api/study/plan', { weekday: bad, planned_minutes: 60, active: true });
      assert.equal(res.status, 400, `weekday ${bad} must be a 400, not a crash`);
      assert.match((await res.json()).error, /weekday/);
    }
  });

  test('it refuses a non-integer weekday', async () => {
    const c = await signedIn();
    for (const bad of [1.5, 'two', null, undefined, {}]) {
      const res = await c.put('/api/study/plan', { weekday: bad, planned_minutes: 60, active: true });
      assert.equal(res.status, 400, `${JSON.stringify(bad)} must be a 400`);
    }
  });

  test('plan/all skips an impossible weekday instead of crashing', async () => {
    const c = await signedIn();
    const res = await c.put('/api/study/plan/all', {
      plan: [
        { weekday: 1, planned_minutes: 90, active: true },
        { weekday: 7, planned_minutes: 900, active: true },
      ],
    });
    assert.equal(res.status, 200, 'a bad row is skipped, not fatal');
    const { plan } = await res.json();
    assert.ok(plan.every((p) => p.weekday >= 0 && p.weekday <= 6), 'no out-of-range weekday may be stored');
    assert.equal(plan.find((p) => p.weekday === 1)?.planned_minutes, 90, 'the valid row still lands');
  });

  test('planned minutes are bounded to a real day', async () => {
    const c = await signedIn();
    await c.put('/api/study/plan/all', { plan: Array.from({ length: 7 }, (_, d) => ({ weekday: d, planned_minutes: 0, active: false })) });
    const res = await c.put('/api/study/plan', { weekday: 2, planned_minutes: 99999, active: true });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).minutes, 1440, 'clamped to 24 hours, not stored verbatim');
  });

  test('a negative figure is not stored', async () => {
    const c = await signedIn();
    const res = await c.put('/api/study/plan', { weekday: 2, planned_minutes: -90, active: true });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).minutes, 0, 'a negative plan is zero, not a credit');
  });
});

// ── friendship consent ─────────────────────────────────────────────────

describe('asking someone to be friends', () => {
  // findFriendship matches the pair in EITHER direction, so the branch that
  // accepts an existing pending request used to fire on your own outstanding
  // request: replaying /request befriended someone who never agreed, and emptied
  // their pending list so they never even saw the ask.
  const pair = async () => {
    const A = client();
    await A.post('/api/auth/signup', { username: uniq(), email: `${uniq()}@a.example.com`, password: 'password123' });
    const B = client();
    await B.post('/api/auth/signup', { username: uniq(), email: `${uniq()}@b.example.com`, password: 'password123' });
    return { A, B, ida: (await A.user()).id, idb: (await B.user()).id };
  };
  const friendsOf = async (c) => (await (await c('/api/friends')).json()).friends.map((f) => f.username);
  const requestsOf = async (c) => (await (await c('/api/friends')).json()).requests.map((r) => r.username);

  test('replaying your own request does not befriend them', async () => {
    const { A, B, idb } = await pair();
    const before = await friendsOf(B);

    const first = await A.post('/api/friends/request', { userId: idb });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).status, 'outgoing');

    const replay = await A.post('/api/friends/request', { userId: idb });
    assert.notEqual(replay.status, 200, 'a replay must not report success');
    assert.equal((await replay.json()).status, undefined);

    assert.deepEqual(await friendsOf(B), before, 'B must not gain a friend who never accepted');
  });

  test('the pending request is still there for B to answer', async () => {
    // The bypass also emptied the addressee's pending list, so they never saw
    // the ask at all.
    const { A, B, idb } = await pair();
    const name = (await A.user()).username;
    await A.post('/api/friends/request', { userId: idb });
    await A.post('/api/friends/request', { userId: idb });
    assert.ok(
      (await requestsOf(B)).includes(name),
      'B must still be able to see and answer the request',
    );
  });

  test('answering somebody who asked YOU still works', async () => {
    // The fix must not break the legitimate path this branch was written for.
    const { A, B, ida, idb } = await pair();
    const name = (await B.user()).username;
    await B.post('/api/friends/request', { userId: ida });
    // A now sends its own request, which is really an acceptance of B's.
    const res = await A.post('/api/friends/request', { userId: idb });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'friends');
    assert.ok((await friendsOf(A)).includes(name));
  });

  test('asking someone already accepted is a conflict', async () => {
    const { A, B, ida, idb } = await pair();
    await B.post('/api/friends/request', { userId: ida });
    await A.post('/api/friends/request', { userId: idb });
    // They are friends now; a further request must not create a second row.
    const again = await A.post('/api/friends/request', { userId: idb });
    assert.equal(again.status, 409, 'an existing friendship is a conflict');
  });
});

// ── unbounded and mistyped input ────────────────────────────────────────

describe('a finished pomodoro', () => {
  // focus_seconds had no upper bound, while /entry already caps at 1440
  // minutes. A client sending 999999 logged 16,666,666 minutes.
  test('cannot exceed a day', async () => {
    const c = await signedIn();
    const res = await c.post('/api/study/sessions', { focus_seconds: 999999, kind: 'focus' });
    assert.equal(res.status, 200);
    assert.ok(
      (await res.json()).loggedMinutes <= 1440,
      'a session may not log more than a day of study',
    );
  });

  test('a negative figure logs nothing rather than a credit', async () => {
    const c = await signedIn();
    const res = await c.post('/api/study/sessions', { focus_seconds: -500, kind: 'focus' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).loggedMinutes, 0);
  });
});

describe('the ledger page size', () => {
  // A fractional limit reached SQLite as `LIMIT 2.5` -> SQLITE_MISMATCH -> 500.
  test('a fractional limit does not crash the route', async () => {
    const c = await signedIn();
    for (const bad of ['2.5', '1e3', '-5', 'abc']) {
      const res = await c(`/api/study/logs?limit=${encodeURIComponent(bad)}`);
      assert.notEqual(res.status, 500, `limit=${bad} must not be a 500`);
      assert.ok(res.status === 200, `limit=${bad} should answer 200, got ${res.status}`);
    }
  });

  test('hasMore is false on the last page, not true forever', async () => {
    // rows.length === limit is also true when the count is an exact multiple
    // of the limit, so the feed offered to page forever.
    const c = await signedIn();
    for (let i = 0; i < 3; i += 1) {
      await c.post('/api/study/sessions', { focus_seconds: 600, kind: 'focus' });
    }
    const exact = await (await c('/api/study/logs?limit=3')).json();
    assert.equal(exact.entries.length, 3);
    assert.equal(exact.hasMore, false, 'three rows with limit=3 is the whole feed');

    const under = await (await c('/api/study/logs?limit=10')).json();
    assert.equal(under.hasMore, false);
    const over = await (await c('/api/study/logs?limit=2')).json();
    assert.equal(over.hasMore, true, 'a genuine partial page does report more');
  });
});

describe('a boolean sent as a string', () => {
  // Boolean('false') is true, so a form-encoded or JSON-stringified boolean
  // silently inverted the tick.
  test('"false" does not become true', async () => {
    const c = await signedIn();
    await c.put('/api/study/plan', { weekday: 2, active: true, planned_minutes: 60 });
    const res = await c.put('/api/study/plan', { weekday: 2, active: 'false' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).active, false, '"false" must mean false');
  });

  test('the real booleans still work', async () => {
    const c = await signedIn();
    const off = await c.put('/api/study/plan', { weekday: 3, active: false, planned_minutes: 60 });
    assert.equal((await off.json()).active, false);
    const on = await c.put('/api/study/plan', { weekday: 3, active: true, planned_minutes: 60 });
    assert.equal((await on.json()).active, true);
  });
});

// ── session cookie attributes ────────────────────────────────────────────

describe('the session cookie', () => {
  // The cookie is how the app knows who you are, so its attributes are what
  // stand between a stolen session and a working login. These assert the
  // Set-Cookie header verbatim rather than the parsed result, because the
  // failure mode is a missing attribute and a cookie jar hides that.
  const cookieFor = async (c) => {
    // Goes through the jar's POST helper, which fetches a CSRF token first —
    // a bare POST is rejected 403 and never reaches the cookie.
    const res = await c.post('/api/auth/guest');
    return res.headers.getSetCookie().find((x) => x.startsWith('pf_session=')) || '';
  };

  test('is httpOnly, so script cannot read the session', async () => {
    const c = client();
    const raw = await cookieFor(c);
    assert.match(raw, /HttpOnly/i, 'the session cookie must be httpOnly');
  });

  test('is SameSite=Lax, so cross-site POSTs cannot forge a write', async () => {
    const c = client();
    const raw = await cookieFor(c);
    assert.match(raw, /SameSite=Lax/i);
  });

  test('carries an expiry, so the session can outlive the browser session', async () => {
    const c = client();
    const raw = await cookieFor(c);
    assert.match(raw, /Max-Age=\d+|Expires=/i, 'the cookie must persist to keep the user signed in');
  });

  test('the CSRF cookie is readable by the client but never HttpOnly', async () => {
    // The reverse of the session cookie, and for the same reason: the client
    // has to read this one to echo it back as a header. Asserted on a fresh
    // jar, where the cookie is actually being minted.
    const c = client();
    const res = await c('/api/auth/session');
    const raw = res.headers.getSetCookie().find((x) => x.startsWith('pf_session_csrf='));
    assert.ok(raw, 'the first session request must mint a CSRF cookie');
    assert.doesNotMatch(raw, /HttpOnly/i, 'the client must be able to read the CSRF token');
  });

  test('signing out clears it, rather than leaving a usable cookie behind', async () => {
    const c = client();
    await c.post('/api/auth/guest');
    assert.ok(await c.user(), 'a guest session exists');

    const out = await c.post('/api/auth/logout');
    const cleared = out.headers.getSetCookie().find((x) => x.startsWith('pf_session='));
    assert.ok(cleared, 'logout must send a Set-Cookie that clears the session');
    // An expired, emptied value is how a cookie is cleared.
    assert.match(cleared, /pf_session=;|pf_session=""/, 'the session must be emptied');
    assert.match(cleared, /Expires=Thu, 01 Jan 1970|Max-Age=0/i, 'and expired');

    const after = await c('/api/auth/session');
    assert.equal((await after.json()).user, null, 'the session must not survive logout');
  });

  // The real gap: over HTTPS the session cookie was marked Secure while the
  // CSRF token was not, so a downgrade to plain http carried the write token in
  // the clear. Asserted by re-reading the flag with USE_HTTPS on.
  test('over HTTPS the CSRF cookie is marked Secure too', async () => {
    // A brand-new jar has no CSRF cookie, so this request is the one that
    // mints it — and the only point at which the attribute can be asserted.
    const c = client();
    const before = process.env.USE_HTTPS;
    process.env.USE_HTTPS = '1';
    try {
      const res = await c('/api/auth/session');
      const raw = res.headers.getSetCookie().find((x) => x.startsWith('pf_session_csrf='));
      assert.ok(raw, 'the first session request must mint a CSRF cookie');
      assert.match(raw, /Secure/i, 'the CSRF cookie must be Secure when the session cookie is');
    } finally {
      if (before === undefined) delete process.env.USE_HTTPS;
      else process.env.USE_HTTPS = before;
    }
  });
});

// ── writing a single day of the weekly plan ────────────────────

describe('PUT /api/study/plan', () => {
  // The in-place stepper sends rapid single-day writes and reads the
  // weekly total from the response to update the UI without a full
  // page reload. The old code had no weekly total in the response,
  // so every click triggered a reload that wiped the pane.
  test('the response includes the updated weekly total', async () => {
    const c = await signedIn();
    // Clear the default Mon–Fri seed so the weekly total reflects
    // only the write this test makes.
    await c.put('/api/study/plan/all', { plan: Array.from({ length: 7 }, (_, d) => ({ weekday: d, planned_minutes: 0, active: false })) });
    const res = await c.put('/api/study/plan', { weekday: 0, planned_minutes: 120, active: true });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.weekly?.plannedText, '2h 00m', 'weekly.plannedText must be present');
    assert.ok(body.weekly?.met !== undefined, 'weekly.met must be present');
  });

  // Hammering + rapid-fire must accumulate: the server must honour
  // every write in order, even when they arrive back-to-back.
  test('consecutive writes to the same day accumulate correctly', async () => {
    const c = await signedIn();
    await c.put('/api/study/plan/all', { plan: Array.from({ length: 7 }, (_, d) => ({ weekday: d, planned_minutes: 0, active: false })) });
    let total = 0;
    for (let i = 0; i < 5; i += 1) {
      total += 30;
      const res = await c.put('/api/study/plan', { weekday: 1, planned_minutes: total, active: true });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.weekly?.planned, total, `iteration ${i}: weekly total must reflect the write`);
    }
  });

  // A second user writing their own day must not see the first user's
  // plan, just as PUT /plan/all is already tested to be isolated.
  test('plan updates are isolated per user', async () => {
    const a = await signedIn();
    const b = await signedIn();
    await a.put('/api/study/plan/all', { plan: Array.from({ length: 7 }, (_, d) => ({ weekday: d, planned_minutes: 0, active: false })) });
    await b.put('/api/study/plan/all', { plan: Array.from({ length: 7 }, (_, d) => ({ weekday: d, planned_minutes: 0, active: false })) });
    await a.put('/api/study/plan', { weekday: 3, planned_minutes: 200, active: true });
    await b.put('/api/study/plan', { weekday: 3, planned_minutes: 50, active: true });
    const aRes = await a.put('/api/study/plan', { weekday: 3, planned_minutes: 200, active: true });
    const bRes = await b.put('/api/study/plan', { weekday: 3, planned_minutes: 50, active: true });
    assert.equal((await aRes.json()).weekly?.planned, 200);
    assert.equal((await bRes.json()).weekly?.planned, 50);
  });
});
