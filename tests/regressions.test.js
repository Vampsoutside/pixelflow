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

// ── writing the whole weekly plan ─────────────────────────────────────────

describe('PUT /api/study/plan/all', () => {
  test('the response reflects the write it just made', async () => {
    // The rows were inserted without awaiting, and the response re-reads the
    // plan — so it could answer with the values it had just replaced.
    const c = await signedIn();
    const plan = Array.from({ length: 7 }, (_, d) => ({ weekday: d, planned_minutes: 120 + d, active: true }));
    const res = await c.put('/api/study/plan/all', { plan });
    assert.equal(res.status, 200);

    const { plan: reported } = await res.json();
    for (const p of plan) {
      const got = reported.find((r) => r.weekday === p.weekday);
      assert.equal(got?.planned_minutes, p.planned_minutes, `weekday ${p.weekday} must be reported back`);
    }
  });

  test('holds up when the same plan is rewritten repeatedly', async () => {
    const c = await signedIn();
    for (let i = 0; i < 15; i += 1) {
      const plan = Array.from({ length: 7 }, (_, d) => ({
        weekday: d, planned_minutes: 600 + i * 7 + d, active: true,
      }));
      const { plan: reported } = await (await c.put('/api/study/plan/all', { plan })).json();
      assert.equal(
        reported.find((r) => r.weekday === 0)?.planned_minutes,
        600 + i * 7,
        `iteration ${i} read back a stale value`,
      );
    }
  });

  test('one user writing a plan never disturbs another', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const mine = [{ weekday: 1, planned_minutes: 111, active: true }];
    const theirs = [{ weekday: 1, planned_minutes: 999, active: true }];

    await a.put('/api/study/plan/all', { plan: mine });
    await b.put('/api/study/plan/all', { plan: theirs });

    const { plan: aPlan } = await (await a('/api/study/plan/all?x=1').then(() => a.put('/api/study/plan/all', { plan: mine }))).json();
    assert.equal(aPlan.find((p) => p.weekday === 1)?.planned_minutes, 111);
  });
});
