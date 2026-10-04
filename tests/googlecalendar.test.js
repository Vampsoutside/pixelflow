/**
 * Google Calendar sync.
 *
 * The product promise is that a Google Calendar connection makes events show up
 * on the right day in the app's own calendar and survive across devices, and
 * that events written in the app reach Google. Everything here runs against the
 * real server and the real database; only the calls out to googleapis.com are
 * stubbed, because the thing under test is the translation and the linkage, not
 * Google's uptime.
 *
 * Two rules this file exists to hold:
 *
 *  - A pull must never invent study time or touch a total. The events table is
 *    inert with respect to study data (see events.test.js) and a Google event
 *    must not change that.
 *  - Sync is idempotent. Pulling the same Google event twice must leave one row,
 *    not two, because a user pressing "Sync" twice is not a bug.
 */

import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pf-gcal-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.JWT_SECRET = 'test-secret';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

const { default: app } = await import('../server/app.js');
const { db } = await import('../server/db.js');

let server;
let base;

/** Everything the stubbed Google API was asked for, for assertions. */
let calls;
/** The Google event list the stub returns. */
let googleEvents;
/** What the stub answers when an event is created. */
let nextGoogleId;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  googleEvents = [];
  nextGoogleId = 'g-new-1';
  globalThis.fetch = realFetch;
});

const realFetch = globalThis.fetch;

/**
 * Routes googleapis.com to a stub and leaves the app's own traffic alone.
 * Returning a real Response keeps the caller unaware it is being faked.
 */
function stubGoogle() {
  globalThis.fetch = async (url, init = {}) => {
    const href = typeof url === 'string' ? url : url.href;
    if (!href.includes('googleapis.com')) return realFetch(url, init);

    calls.push({ url: href, method: init.method || 'GET', body: init.body });

    const json = (payload, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (href.includes('/calendars/') && href.includes('/events') && (init.method || 'GET') === 'GET') {
      return json({ items: googleEvents });
    }
    if ((init.method || 'GET') === 'POST') {
      return json({ id: nextGoogleId, htmlLink: 'https://calendar.google.com/event?eid=x' });
    }
    if ((init.method || 'GET') === 'PATCH' || (init.method || 'GET') === 'PUT') {
      return json({ id: 'updated' });
    }
    return json({});
  };
}

function client() {
  const jar = new Map();
  const call = async (path, init = {}) => {
    const headers = { ...(init.headers || {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await realFetch(`${base}${path}`, { ...init, headers, redirect: 'manual' });
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
    async signup(username, password = 'password123') {
      const res = await send('POST', '/api/auth/signup', {
        username,
        email: `${username}@example.test`,
        password,
      });
      assert.equal(res.status, 200, 'signup should succeed');
      const body = await res.json();
      this.userId = body.user.id;
      return body;
    },
    csrf: () => jar.get('pf_session_csrf'),
  };
}

/** Marks the signed-in user as having completed a Google connection. */
function connect(userId) {
  return db.prepare(`
    INSERT INTO google_calendar_tokens (user_id, access_token, refresh_token, expires_at, calendar_id)
    VALUES (?, 'access-1', 'refresh-1', ?, 'primary')
  `).run(userId, Date.now() + 3_600_000);
}

/** A Google event with a timed start, as the API returns it. */
function gEvent(id, { title, start, minutes = 60, updated = '2026-10-01T10:00:00.000Z', allDay = false } = {}) {
  // Arithmetic on the naive string on purpose. Routing through toISOString()
  // would convert to UTC while `start` stays naive, so in any zone east of
  // Greenwich the end lands before the start.
  const [d, t] = start.split('T');
  const endMs = Date.parse(`${d}T${t}:00Z`) + minutes * 60_000;
  const shifted = new Date(endMs + new Date(`${d}T${t}:00Z`).getTimezoneOffset() * 60_000);
  const end = `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}T${String(shifted.getHours()).padStart(2, '0')}:${String(shifted.getMinutes()).padStart(2, '0')}:00`;
  return {
    id,
    summary: title,
    updated,
    ...(allDay
      ? { start: { date: start.slice(0, 10) }, end: { date: start.slice(0, 10) } }
      : { start: { dateTime: `${start}:00` }, end: { dateTime: end } }),
  };
}

async function localEvents(month, c) {
  const res = await c.get(`/api/events?month=${month}`);
  assert.equal(res.status, 200);
  return (await res.json()).events;
}

describe('google calendar: connection status', () => {
  test('reports not connected before anything is linked', async () => {
    const c = client();
    await c.signup('gcstatus');
    const res = await c.get('/api/googlecalendar/status');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { connected: false });
  });

  test('status requires a signed-in user', async () => {
    const res = await realFetch(`${base}/api/googlecalendar/status`);
    assert.equal(res.status, 401);
  });
});

describe('google calendar: pulling events in', () => {
  test('a google event appears in the app calendar on the right day', async () => {
    const c = client();
    await c.signup('gcpull');
    connect(c.userId);
    stubGoogle();
    googleEvents = [gEvent('g1', { title: 'Dentist', start: '2026-10-14T09:30' })];

    const res = await c.send('POST', '/api/googlecalendar/sync', { month: '2026-10' });
    assert.equal(res.status, 200);

    const events = await localEvents('2026-10', c);
    const pulled = events.find((e) => e.title === 'Dentist');
    assert.ok(pulled, 'the google event should be in the app calendar');
    assert.equal(pulled.date, '2026-10-14');
    assert.equal(pulled.time, '09:30');
    assert.equal(pulled.minutes, 60);
  });

  test('an all-day google event lands with no clock time', async () => {
    const c = client();
    await c.signup('gcall');
    connect(c.userId);
    stubGoogle();
    googleEvents = [gEvent('g2', { title: 'Holiday', start: '2026-10-20T00:00', allDay: true })];

    await c.send('POST', '/api/googlecalendar/sync', { month: '2026-10' });

    const pulled = (await localEvents('2026-10', c)).find((e) => e.title === 'Holiday');
    assert.ok(pulled);
    assert.equal(pulled.date, '2026-10-20');
    assert.equal(pulled.time, null);
  });

  test('syncing twice does not duplicate the event', async () => {
    const c = client();
    await c.signup('gcidem');
    connect(c.userId);
    stubGoogle();
    googleEvents = [gEvent('g1', { title: 'Dentist', start: '2026-10-14T09:30' })];

    await c.send('POST', '/api/googlecalendar/sync', { month: '2026-10' });
    await c.send('POST', '/api/googlecalendar/sync', { month: '2026-10' });

    const events = await localEvents('2026-10', c);
    assert.equal(events.filter((e) => e.title === 'Dentist').length, 1, 'idempotent pull');
  });

  test('a newer google version updates the local copy in place', async () => {
    const c = client();
    await c.signup('gcnewer');
    connect(c.userId);
    stubGoogle();
    googleEvents = [gEvent('g1', { title: 'Dentist', start: '2026-10-14T09:30', updated: '2026-10-01T10:00:00.000Z' })];

    await c.send('POST', '/api/googlecalendar/sync', { month: '2026-10' });
    const firstId = (await localEvents('2026-10', c)).find((e) => e.title === 'Dentist').id;

    googleEvents = [gEvent('g1', { title: 'Dentist (moved)', start: '2026-10-15T11:00', updated: '2026-10-02T10:00:00.000Z' })];
    await c.send('POST', '/api/googlecalendar/sync', { month: '2026-10' });

    const events = await localEvents('2026-10', c);
    assert.equal(events.length, 1, 'still one event, not two');
    assert.equal(events[0].id, firstId, 'the same row was updated');
    assert.equal(events[0].title, 'Dentist (moved)');
    assert.equal(events[0].date, '2026-10-15');
  });

  test('an older google version does not overwrite a local edit', async () => {
    const c = client();
    await c.signup('gcstale');
    connect(c.userId);
    stubGoogle();
    googleEvents = [gEvent('g1', { title: 'From Google', start: '2026-10-14T09:30', updated: '2026-10-01T10:00:00.000Z' })];

    await c.send('POST', '/api/googlecalendar/sync', { month: '2026-10' });

    const before = (await localEvents('2026-10', c))[0];
    await c.send('PUT', `/api/events/${before.id}`, { title: 'Renamed locally' });

    // Google still has its old copy, last changed before the local edit.
    await c.send('POST', '/api/googlecalendar/sync', { month: '2026-10' });

    const after_ = (await localEvents('2026-10', c))[0];
    assert.equal(after_.title, 'Renamed locally', 'a stale pull must not undo a local edit');
  });

  test('a pull changes no study totals', async () => {
    const c = client();
    await c.signup('gcinert');
    connect(c.userId);
    stubGoogle();
    googleEvents = [gEvent('g1', { title: 'Dentist', start: '2026-10-14T09:30', minutes: 180 })];

    const before_ = await (await c.get('/api/study/overview')).json();
    await c.send('POST', '/api/googlecalendar/sync', { month: '2026-10' });
    const after__ = await (await c.get('/api/study/overview')).json();

    assert.equal(after__.focusMinutes, before_.focusMinutes);
    assert.equal(after__.todayMinutes, before_.todayMinutes);
  });

  test('syncing without a connection is refused', async () => {
    const c = client();
    await c.signup('gcnoconn');
    const res = await c.send('POST', '/api/googlecalendar/sync', { month: '2026-10' });
    assert.equal(res.status, 409);
  });

  test('a bad month is a 400, not a crash', async () => {
    const c = client();
    await c.signup('gcbadmonth');
    connect(c.userId);
    stubGoogle();
    const res = await c.send('POST', '/api/googlecalendar/sync', { month: 'nope' });
    assert.equal(res.status, 400);
  });

  test('another user google events never leak into this calendar', async () => {
    const c = client();
    await c.signup('gcother');
    const other = client();
    await other.signup('gcother2');
    connect(c.userId);
    stubGoogle();
    googleEvents = [gEvent('g1', { title: 'Private', start: '2026-10-14T09:30' })];

    await c.send('POST', '/api/googlecalendar/sync', { month: '2026-10' });

    assert.equal((await localEvents('2026-10', other)).length, 0, "other's calendar stays empty");
  });
});

describe('google calendar: pushing events out', () => {
  test('an event created in the app is written to google and linked', async () => {
    const c = client();
    await c.signup('gcpush');
    connect(c.userId);
    stubGoogle();

    const created = await (await c.send('POST', '/api/events', {
      date: '2026-10-14', kind: 'event', title: 'Study block', time: '14:00', minutes: 90,
    })).json();

    const res = await c.send('POST', '/api/googlecalendar/push', { id: created.id });
    assert.equal(res.status, 200);

    const post = calls.find((c2) => c2.method === 'POST');
    assert.ok(post, 'the app should have created something in google');
    assert.ok(post.url.includes('googleapis.com'), 'against the google api');
    const sent = JSON.parse(post.body);
    assert.match(sent.summary, /Study block/);

    const events = await localEvents('2026-10', c);
    assert.equal(events.length, 1, 'pushing must not duplicate the local row');
  });

  test('a second push updates google rather than creating a duplicate', async () => {
    const c = client();
    await c.signup('gcpush2');
    connect(c.userId);
    stubGoogle();

    const created = await (await c.send('POST', '/api/events', {
      date: '2026-10-14', kind: 'event', title: 'Study block', time: '14:00', minutes: 90,
    })).json();

    await c.send('POST', '/api/googlecalendar/push', { id: created.id });
    calls.length = 0;
    await c.send('POST', '/api/googlecalendar/push', { id: created.id });

    assert.equal(calls.filter((c2) => c2.method === 'POST').length, 0, 'no second create');
    assert.ok(calls.some((c2) => c2.method === 'PATCH'), 'the existing google event is patched');
  });

  test('pushing an event that is not yours is refused', async () => {
    const c = client();
    await c.signup('gcpush3');
    const other = client();
    await other.signup('gcpush4');
    connect(c.userId);

    const created = await (await other.send('POST', '/api/events', {
      date: '2026-10-14', kind: 'event', title: 'Theirs',
    })).json();
    // Push from c, for an event owned by other.

    const res = await c.send('POST', '/api/googlecalendar/push', { id: created.id });
    assert.equal(res.status, 404);
  });

  test('pushing without a connection is refused', async () => {
    const c = client();
    await c.signup('gcpush5');
    const created = await (await c.send('POST', '/api/events', {
      date: '2026-10-14', kind: 'event', title: 'Local only',
    })).json();

    const res = await c.send('POST', '/api/googlecalendar/push', { id: created.id });
    assert.equal(res.status, 409);
  });

  test('a failing google call does not lose the local event', async () => {
    const c = client();
    await c.signup('gcpushfail');
    connect(c.userId);
    globalThis.fetch = async (url, init = {}) => {
      const href = typeof url === 'string' ? url : url.href;
      if (!href.includes('googleapis.com')) return realFetch(url, init);
      return new Response('boom', { status: 500 });
    };

    const created = await (await c.send('POST', '/api/events', {
      date: '2026-10-14', kind: 'event', title: 'Survives',
    })).json();

    const res = await c.send('POST', '/api/googlecalendar/push', { id: created.id });
    assert.equal(res.status, 502, 'the app should report the upstream failure');
    assert.equal((await localEvents('2026-10', c)).length, 1, 'the local event is still there');
  });
});

describe('google calendar: removing a synced event', () => {
  test('deleting a linked event in the app deletes it in google', async () => {
    const c = client();
    await c.signup('gcremove');
    connect(c.userId);
    stubGoogle();

    const created = await (await c.send('POST', '/api/events', {
      date: '2026-10-14', kind: 'event', title: 'Short-lived', time: '09:00', minutes: 30,
    })).json();

    // Push once so the event gains a Google id, then delete it in the app.
    await c.send('POST', '/api/googlecalendar/push', { id: created.id });
    calls.length = 0;

    const res = await c.send('DELETE', `/api/events/${created.id}`);
    assert.equal(res.status, 200);

    const del = calls.find((x) => x.method === 'DELETE');
    assert.ok(del, 'the google event should have been deleted too');
    assert.equal((await localEvents('2026-10', c)).length, 0, 'and the local one is gone');
  });

  test('an event that never went to google is fine to remove', async () => {
    const c = client();
    await c.signup('gcremove2');
    connect(c.userId);
    stubGoogle();

    const created = await (await c.send('POST', '/api/events', {
      date: '2026-10-14', kind: 'event', title: 'Local only',
    })).json();

    const res = await c.send('DELETE', `/api/events/${created.id}`);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 0, 'nothing to delete upstream');
  });

  test('deleting someone else’s event is refused', async () => {
    const c = client();
    await c.signup('gcremove3');
    const other = client();
    await other.signup('gcremove4');
    connect(c.userId);
    stubGoogle();

    const created = await (await other.send('POST', '/api/events', {
      date: '2026-10-14', kind: 'event', title: 'Theirs',
    })).json();

    const res = await c.send('DELETE', `/api/events/${created.id}`);
    assert.equal(res.status, 404, 'another user’s event is not deletable');
    assert.equal(calls.length, 0, 'and nothing is touched in google');
    assert.equal((await localEvents('2026-10', other)).length, 1, 'it survives');
  });
});

describe('google calendar: disconnecting', () => {
  test('disconnect clears the tokens and the links', async () => {
    const c = client();
    await c.signup('gcdisc');
    connect(c.userId);
    stubGoogle();
    googleEvents = [gEvent('g1', { title: 'Linked', start: '2026-10-14T09:30' })];
    await c.send('POST', '/api/googlecalendar/sync', { month: '2026-10' });

    const res = await c.send('POST', '/api/googlecalendar/disconnect');
    assert.equal(res.status, 200);

    assert.deepEqual(await (await c.get('/api/googlecalendar/status')).json(), { connected: false });

    const row = await db.prepare('SELECT COUNT(*) AS n FROM google_calendar_tokens WHERE user_id = ?').get(c.userId);
    assert.equal(row.n, 0, 'tokens are gone');
    const links = await db.prepare('SELECT COUNT(*) AS n FROM google_event_links WHERE user_id = ?').get(c.userId);
    assert.equal(links.n, 0, 'links are gone');
  });

  test('disconnecting keeps the local events', async () => {
    const c = client();
    await c.signup('gcdisc2');
    connect(c.userId);
    stubGoogle();
    googleEvents = [gEvent('g1', { title: 'Keep me', start: '2026-10-14T09:30' })];
    await c.send('POST', '/api/googlecalendar/sync', { month: '2026-10' });

    await c.send('POST', '/api/googlecalendar/disconnect');

    assert.equal((await localEvents('2026-10', c)).length, 1, 'the event survives disconnection');
  });
});

describe('google calendar: the oauth handshake', () => {
  test('login redirects to google with the calendar scope and offline access', async () => {
    const c = client();
    await c.signup('gclogin');
    const res = await c.get('/api/googlecalendar/login');
    assert.equal(res.status, 302);
    const url = new URL(res.headers.get('location'));
    assert.ok(url.origin.includes('google.com'), 'redirects to google');
    assert.ok(url.searchParams.get('scope').includes('calendar'), 'asks for calendar access');
    assert.equal(url.searchParams.get('access_type'), 'offline', 'needed for a refresh token');
    assert.ok(url.searchParams.get('state'), 'carries state');
  });

  test('a callback with a state that was never issued is refused', async () => {
    const c = client();
    await c.signup('gccb');
    const res = await c.get('/api/googlecalendar/callback?code=abc&state=forged');
    assert.notEqual(res.status, 200);
  });
});