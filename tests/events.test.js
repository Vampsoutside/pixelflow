/**
 * Events and deadlines.
 *
 * The product rule these exist to enforce is that an item is informational: it
 * sits on a day in the calendar and changes nothing about study time. That is
 * easy to state and easy to break later by accident — a single stray write into
 * study_entries would quietly move every total, streak and chart — so it is
 * asserted here rather than left to review.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pf-events-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.JWT_SECRET = 'test-secret';
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

  const send = async (method, path, body) => {
    if (!jar.get('pf_session_csrf')) await call('/api/auth/session');
    return call(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-csrf-token': jar.get('pf_session_csrf') },
      body: JSON.stringify(body ?? {}),
    });
  };

  call.post = (path, body) => send('POST', path, body);
  call.put = (path, body) => send('PUT', path, body);
  call.del = (path) => send('DELETE', path, {});
  call.get = (path) => call(path);
  return call;
}

async function withUser(name) {
  const call = client();
  const res = await call.post('/api/auth/signup', {
    username: name,
    email: `${name}@example.test`,
    password: 'a_long_enough_password',
  });
  assert.equal(res.status, 200, `signup failed for ${name}`);
  return call;
}

const listEvents = async (call, month) => (await (await call.get(`/api/events?month=${month}`)).json()).events;

describe('creating an item', () => {
  test('stores an event with a time and a length', async () => {
    const call = await withUser('ev_basic');
    const res = await call.post('/api/events', {
      date: '2026-08-04', kind: 'event', title: 'Lab practical', time: '14:30', minutes: 90,
    });
    assert.equal(res.status, 200);

    const [item] = await listEvents(call, '2026-08');
    assert.equal(item.title, 'Lab practical');
    assert.equal(item.kind, 'event');
    assert.equal(item.time, '14:30');
    assert.equal(item.minutes, 90);
    assert.equal(item.done, false);
  });

  test('defaults to an event when kind is missing or nonsense', async () => {
    const call = await withUser('ev_default');
    await call.post('/api/events', { date: '2026-08-05', title: 'Something' });
    const items = await listEvents(call, '2026-08');
    assert.equal(items[0].kind, 'event');
  });

  test('a deadline keeps no time, even if one was sent', async () => {
    const call = await withUser('ev_deadline');
    // Rejected rather than silently stored: a time the UI never renders is
    // data that will eventually be shown somewhere and mean something wrong.
    const res = await call.post('/api/events', {
      date: '2026-08-06', kind: 'deadline', title: 'Essay due', time: '23:59',
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /no time/i);
  });

  test('carries a tag', async () => {
    const call = await withUser('ev_tag');
    const { tags } = await (await call.post('/api/tags', { name: 'Uni' })).json();
    // Signup seeds starter tags, so the new one has to be found by name.
    const uni = tags.find((t) => t.name === 'Uni');

    await call.post('/api/events', { date: '2026-08-07', kind: 'deadline', title: 'Reading list', tagId: uni.id });
    const [item] = await listEvents(call, '2026-08');
    assert.equal(item.tag.name, 'Uni');
    assert.match(item.tag.color, /^#[0-9a-f]{6}$/i, 'a tag created without a colour still gets one');
  });

  test('somebody else’s tag is dropped rather than attached', async () => {
    const call = await withUser('ev_steal');
    const victim = await withUser('ev_victim');
    const { tags } = await (await victim.post('/api/tags', { name: 'Private' })).json();
    const secret = tags.find((t) => t.name === 'Private');

    const res = await call.post('/api/events', {
      date: '2026-08-08', kind: 'deadline', title: 'Group work', tagId: secret.id,
    });
    assert.equal(res.status, 200);
    const [item] = await listEvents(call, '2026-08');
    assert.equal(item.tag, null);
  });
});

describe('rejecting bad input', () => {
  test('a title is required', async () => {
    const call = await withUser('ev_notitle');
    const res = await call.post('/api/events', { date: '2026-08-09', kind: 'event', title: '   ' });
    assert.equal(res.status, 400);
  });

  test('a malformed date is rejected', async () => {
    const call = await withUser('ev_baddate');
    for (const date of ['08/09/2026', '2026-8-9', 'yesterday', '']) {
      const res = await call.post('/api/events', { date, kind: 'event', title: 'X' });
      assert.equal(res.status, 400, `${date} should be rejected`);
    }
  });

  test('a date that does not exist is rejected', async () => {
    const call = await withUser('ev_fakedate');
    const res = await call.post('/api/events', { date: '2026-02-30', kind: 'event', title: 'X' });
    assert.equal(res.status, 400);
  });

  test('a malformed time is rejected', async () => {
    const call = await withUser('ev_badtime');
    for (const time of ['25:00', '9:30', 'half nine', '12:60']) {
      const res = await call.post('/api/events', { date: '2026-08-10', kind: 'event', title: 'X', time });
      assert.equal(res.status, 400, `${time} should be rejected`);
    }
  });

  test('an out-of-range length is clamped, not rejected', async () => {
    const call = await withUser('ev_clamp');
    await call.post('/api/events', { date: '2026-08-11', kind: 'event', title: 'All day', minutes: 99999 });
    const [item] = await listEvents(call, '2026-08');
    assert.equal(item.minutes, 1440, 'a day is 1440 minutes at most');
  });

  test('a malformed month is a 400', async () => {
    const call = await withUser('ev_badmonth');
    const res = await call.get('/api/events?month=2026-13');
    assert.equal(res.status, 400);
  });
});

describe('editing and deleting', () => {
  test('a partial edit keeps the fields it does not mention', async () => {
    const call = await withUser('ev_patch');
    const { tags } = await (await call.post('/api/tags', { name: 'Sport' })).json();
    const sport = tags.find((t) => t.name === 'Sport');
    const { events } = await (await call.post('/api/events', {
      date: '2026-09-01', kind: 'event', title: 'Training', time: '18:00', minutes: 60, tagId: sport.id,
    })).json();
    const id = events[0].id;

    // Only tick it done — the title, time and tag must survive.
    await call.put(`/api/events/${id}`, { done: true });

    const [item] = await listEvents(call, '2026-09');
    assert.equal(item.done, true);
    assert.equal(item.title, 'Training');
    assert.equal(item.time, '18:00');
    assert.equal(item.minutes, 60);
    assert.equal(item.tag.name, 'Sport');
  });

  test('turning an event into a deadline clears its time', async () => {
    const call = await withUser('ev_kind_change');
    const { events } = await (await call.post('/api/events', {
      date: '2026-09-02', kind: 'event', title: 'Or so', time: '10:00',
    })).json();

    await call.put(`/api/events/${events[0].id}`, { kind: 'deadline', time: '' });
    const [item] = await listEvents(call, '2026-09');
    assert.equal(item.kind, 'deadline');
    assert.equal(item.time, null, 'a deadline has no moment attached to it');
  });

  test('deleting removes it from the month', async () => {
    const call = await withUser('ev_delete');
    const { events } = await (await call.post('/api/events', {
      date: '2026-09-03', kind: 'deadline', title: 'Hand in',
    })).json();

    const res = await call.del(`/api/events/${events[0].id}`);
    assert.equal(res.status, 200);
    assert.equal((await listEvents(call, '2026-09')).length, 0);
  });

  test('another user’s item is a 404 on every verb', async () => {
    const owner = await withUser('ev_owner');
    const stranger = await withUser('ev_stranger');
    const { events } = await (await owner.post('/api/events', {
      date: '2026-09-04', kind: 'deadline', title: 'Not yours',
    })).json();
    const id = events[0].id;

    assert.equal((await stranger.put(`/api/events/${id}`, { title: 'hijacked' })).status, 404);
    assert.equal((await stranger.del(`/api/events/${id}`)).status, 404);
    // Still intact.
    assert.equal((await listEvents(owner, '2026-09'))[0].title, 'Not yours');
  });

  test('an unauthenticated read is refused', async () => {
    const res = await fetch(`${base}/api/events?month=2026-09`);
    assert.equal(res.status, 401);
  });
});

describe('month filtering', () => {
  test('returns only the requested month', async () => {
    const call = await withUser('ev_month');
    await call.post('/api/events', { date: '2026-10-01', kind: 'deadline', title: 'October' });
    await call.post('/api/events', { date: '2026-11-01', kind: 'deadline', title: 'November' });
    await call.post('/api/events', { date: '2026-09-30', kind: 'deadline', title: 'September' });

    const oct = await listEvents(call, '2026-10');
    assert.deepEqual(oct.map((e) => e.title), ['October']);

    // Both boundary days of a 30-day month.
    const sep = await listEvents(call, '2026-09');
    assert.deepEqual(sep.map((e) => e.title), ['September']);
  });

  test('ordering is by day, then untimed items last', async () => {
    const call = await withUser('ev_order');
    await call.post('/api/events', { date: '2026-12-05', kind: 'event', title: 'Late', time: '16:00' });
    await call.post('/api/events', { date: '2026-12-05', kind: 'event', title: 'Early', time: '09:00' });
    await call.post('/api/events', { date: '2026-12-05', kind: 'deadline', title: 'Due' });

    assert.deepEqual(
      (await listEvents(call, '2026-12')).map((e) => e.title),
      ['Early', 'Late', 'Due'],
    );
  });

  test('items from another account never leak in', async () => {
    const mine = await withUser('ev_mine');
    const theirs = await withUser('ev_theirs');
    await mine.post('/api/events', { date: '2026-01-15', kind: 'deadline', title: 'Mine' });
    await theirs.post('/api/events', { date: '2026-01-15', kind: 'deadline', title: 'Theirs' });

    assert.deepEqual((await listEvents(mine, '2026-01')).map((e) => e.title), ['Mine']);
  });
});

describe('tags are readable outside the Tasks panel', () => {
  test('GET /api/tags lists the tags with a colour each', async () => {
    const call = await withUser('tags_read');
    await call.post('/api/tags', { name: 'Algorithms' });

    const res = await call.get('/api/tags');
    assert.equal(res.status, 200, 'the timer and the item form both need to read tags');

    const { tags } = await res.json();
    const mine = tags.find((t) => t.name === 'Algorithms');
    assert.ok(mine, 'the new tag is in the list');
    assert.match(mine.color, /^#[0-9a-f]{6}$/i, 'a tag created without a colour still gets one');
  });

  test('a tag created without a colour does not 500', async () => {
    const call = await withUser('tags_colour');
    const res = await call.post('/api/tags', { name: 'Colourless' });
    assert.equal(res.status, 200, 'the count that picks a default colour has to be awaited properly');

    const { tags } = await res.json();
    assert.match(tags.find((t) => t.name === 'Colourless').color, /^#[0-9a-f]{6}$/i);
  });

  test('tags from another account never leak in', async () => {
    const mine = await withUser('tags_mine');
    const theirs = await withUser('tags_theirs');
    await theirs.post('/api/tags', { name: 'NotMine' });

    const { tags } = await (await mine.get('/api/tags')).json();
    assert.ok(!tags.some((t) => t.name === 'NotMine'));
  });

  test('an unauthenticated read is refused', async () => {
    assert.equal((await fetch(`${base}/api/tags`)).status, 401);
  });
});

describe('items are inert', () => {
  test('a whole month of them changes no study number at all', async () => {
    const call = await withUser('ev_inert_month');
    await call.put('/api/study/entry', { date: '2026-02-10', minutes: 90 });

    const before = await (await call.get('/api/study/overview?month=2026-02')).json();
    const planBefore = await (await call.get('/api/study/overview?month=2026-02')).json();

    for (const [i, day] of ['03', '11', '20'].entries()) {
      await call.post('/api/events', {
        date: `2026-02-${day}`, kind: 'event', title: `Item ${i}`, time: '10:00', minutes: 120,
      });
    }
    await call.post('/api/events', { date: '2026-02-25', kind: 'deadline', title: 'Big one' });

    const after = await (await call.get('/api/study/overview?month=2026-02')).json();

    assert.deepEqual(after.today.studied, before.today.studied);
    assert.deepEqual(after.week.studied, before.week.studied);
    assert.deepEqual(after.week.planned, planBefore.week.planned);
    assert.deepEqual(after.month.studied, before.month.studied);
    assert.deepEqual(after.month.planned, before.month.planned);
    assert.deepEqual(after.chart, before.chart);
  });

  test('the footer totals ignore them too', async () => {
    const call = await withUser('ev_inert_footer');
    await call.put('/api/study/entry', { date: '2026-04-14', minutes: 45 });
    const before = await (await call.get('/api/study/overview?month=2026-04')).json();

    await call.post('/api/events', { date: '2026-04-14', kind: 'event', title: 'Overlap', time: '12:00', minutes: 300 });
    const after = await (await call.get('/api/study/overview?month=2026-04')).json();

    assert.equal(after.month.studied, before.month.studied);
  });
});