/**
 * The study ledger, the task archive, and the insights read.
 *
 * Three properties are worth a test rather than a click-through:
 *
 *   1. A manual save records the *change*, not the total. Saving 30 then 60 on
 *      one day is two rows, and lowering the day is a negative one. Without
 *      this the feed silently becomes a list of absolute totals that cannot be
 *      summed back to what the day actually says.
 *   2. Deleting a ledger row gives its minutes back. A row removed without its
 *      effect reversed leaves the feed and the calendar permanently disagreeing
 *      about how much was studied.
 *   3. A calendar item never moves a study total. Events are decorative by
 *      design, and the only cheap way to keep that true is to assert it.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pf_studylog_'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.JWT_SECRET = 'test_secret';
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

/** A signed-in client with its own cookie jar and CSRF token. */
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

/** Registers a throwaway account so each test starts from an empty ledger. */
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

/** Creates a tag and returns its id. */
async function makeTag(call, name) {
  const res = await call.post('/api/tags', { name });
  assert.equal(res.status, 200);
  const { tags } = await res.json();
  return tags.find((t) => t.name === name);
}

const ledger = async (call) => (await (await call.get('/api/study/logs?limit=200')).json()).entries;

describe('a manual entry records the change, not the total', () => {
  test('saving 30 then 60 on one day writes two positive rows', async () => {
    const call = await withUser('ledger_two');
    const date = '2026-03-04';

    await call.put('/api/study/entry', { date, minutes: 30 });
    await call.put('/api/study/entry', { date, minutes: 60 });

    const entries = (await ledger(call)).filter((e) => e.date === date);
    assert.equal(entries.length, 2, 'each save is its own row');
    // Newest first, so the second save reads first.
    assert.deepEqual(entries.map((e) => e.minutes), [30, 30]);
    assert.ok(entries.every((e) => e.source === 'manual'));
    assert.deepEqual(entries.map((e) => e.minutes).reduce((a, b) => a + b), 60);
  });

  test('lowering a day writes a negative row', async () => {
    const call = await withUser('ledger_down');
    const date = '2026-03-05';

    await call.put('/api/study/entry', { date, minutes: 90 });
    await call.put('/api/study/entry', { date, minutes: 45 });

    const entries = (await ledger(call)).filter((e) => e.date === date);
    assert.deepEqual(entries.map((e) => e.minutes), [-45, 90]);
  });

  test('saving the same total again writes nothing', async () => {
    const call = await withUser('ledger_noop');
    const date = '2026-03-06';

    await call.put('/api/study/entry', { date, minutes: 30 });
    const before = (await ledger(call)).length;
    await call.put('/api/study/entry', { date, minutes: 30 });

    assert.equal((await ledger(call)).length, before, 'a no-op edit is not logged');
  });

  test('the rollup still holds the absolute total the charts read', async () => {
    const call = await withUser('ledger_rollup');
    const date = '2026-03-07';

    await call.put('/api/study/entry', { date, minutes: 30 });
    await call.put('/api/study/entry', { date, minutes: 60 });
    const res = await call.put('/api/study/entry', { date, minutes: 10 });

    const body = await res.json();
    assert.equal(body.studied, 10, 'the day total is the last value set, not the sum of rows');
  });
});

describe('a finished pomodoro', () => {
  test('files a timer row under the tag it was given', async () => {
    const call = await withUser('ledger_pomo');
    const tag = await makeTag(call, 'Calculus');

    const res = await call.post('/api/study/sessions', {
      focus_seconds: 1500, topic: 'Calculus', kind: 'focus', tagId: tag.id,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).loggedMinutes, 25);

    const rows = await ledger(call);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'timer');
    assert.equal(rows[0].minutes, 25);
    assert.equal(rows[0].tag?.name, 'Calculus');
  });

  test('a break files nothing', async () => {
    const call = await withUser('ledger_break');
    await call.post('/api/study/sessions', { focus_seconds: 300, kind: 'break' });
    assert.equal((await ledger(call)).length, 0, 'a break is not study time');
  });

  test('a tag belonging to somebody else is ignored, not rejected', async () => {
    const call = await withUser('ledger_steal');
    const victim = await withUser('ledger_victim');
    const foreign = await makeTag(victim, 'Private');

    const res = await call.post('/api/study/sessions', {
      focus_seconds: 1500, kind: 'focus', tagId: foreign.id,
    });
    assert.equal(res.status, 200, 'an unusable tag must not turn a valid session into a 400');

    const rows = await ledger(call);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tag, null, 'filed untagged rather than under somebody else’s tag');
  });
});

describe('deleting a ledger row', () => {
  test('gives its minutes back to that day', async () => {
    const call = await withUser('ledger_del');
    const date = '2026-03-08';

    await call.put('/api/study/entry', { date, minutes: 30 });
    await call.put('/api/study/entry', { date, minutes: 60 });
    const [latest] = (await ledger(call)).filter((e) => e.date === date);

    const res = await call.del(`/api/study/logs/${latest.id}`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.studied, 30, 'the day falls back to the first entry');
    assert.equal((await ledger(call)).filter((e) => e.date === date).length, 1);
  });

test('never drives a day negative', async () => {
    const call = await withUser('ledger_floor');
    // A finished pomodoro always files against today, not a chosen date.
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    await call.post('/api/study/sessions', { focus_seconds: 1500, kind: 'focus' });
    const [entry] = (await ledger(call)).filter((e) => e.date === date && e.source === 'timer');
    assert.ok(entry, 'the pomodoro filed a row for today');

    const body = await (await call.del(`/api/study/logs/${entry.id}`)).json();
    assert.equal(body.studied, 0, 'removing the only entry leaves zero, not 25 minutes behind');
    assert.ok(body.studied >= 0);
  });

  test('somebody else’s entry is a 404, not a delete', async () => {
    const call = await withUser('ledger_other_a');
    const other = await withUser('ledger_other_b');
    await call.put('/api/study/entry', { date: '2026-03-10', minutes: 45 });
    const [entry] = await ledger(call);

    const res = await other.del(`/api/study/logs/${entry.id}`);
    assert.equal(res.status, 404);
    assert.equal((await ledger(call)).length, 1, 'the entry survived');
  });
});

describe('the feed is scoped to one account', () => {
  test('another user’s rows never appear', async () => {
    const mine = await withUser('ledger_mine');
    const theirs = await withUser('ledger_theirs');
    await mine.put('/api/study/entry', { date: '2026-03-11', minutes: 20 });
    await theirs.put('/api/study/entry', { date: '2026-03-11', minutes: 70 });

    assert.equal((await ledger(mine)).length, 1);
    assert.equal((await ledger(mine))[0].minutes, 20);
    assert.equal((await ledger(theirs))[0].minutes, 70);
  });
});

describe('completing a task', () => {
  test('stamps done_at, which is what the archive orders by', async () => {
    const call = await withUser('task_archive');
    const { taskId } = await (await call.post('/api/tasks', { text: 'File taxes' })).json();

    const done = await (await call.put(`/api/tasks/${taskId}`, { done: true })).json();
    const [task] = done.tasks.filter((t) => t.id === taskId);
    assert.equal(task.done, true);
    assert.ok(task.doneAt, 'an archived task needs a completion time');
    assert.ok(!Number.isNaN(Date.parse(task.doneAt)));
  });

  test('restoring clears both done and done_at', async () => {
    const call = await withUser('task_restore');
    const { taskId } = await (await call.post('/api/tasks', { text: 'Water plants' })).json();
    await call.put(`/api/tasks/${taskId}`, { done: true });

    const back = await (await call.put(`/api/tasks/${taskId}`, { done: false })).json();
    const [task] = back.tasks.filter((t) => t.id === taskId);
    assert.equal(task.done, false);
    assert.equal(task.doneAt, null, 'a restored task is not still “done since”');
  });

  test('the row survives completion — it is archived, not deleted', async () => {
    const call = await withUser('task_kept');
    const { taskId } = await (await call.post('/api/tasks', { text: 'Call the dentist' })).json();
    await call.put(`/api/tasks/${taskId}`, { done: true });

    const { tasks } = await (await call.get('/api/tasks')).json();
    assert.ok(tasks.some((t) => t.id === taskId), 'still readable, so Logs can show it');
  });
});

describe('insights', () => {
  test('byTag sums only the requested month', async () => {
    const call = await withUser('insights_tags');
    const math = await makeTag(call, 'Maths');
    const code = await makeTag(call, 'Code');

    await call.put('/api/study/entry', { date: '2026-03-12', minutes: 30, tagId: math.id });
    await call.put('/api/study/entry', { date: '2026-03-13', minutes: 45, tagId: code.id });
    // Next month, and must not be counted.
    await call.put('/api/study/entry', { date: '2026-04-02', minutes: 600, tagId: math.id });

    const body = await (await call.get('/api/study/insights?month=2026-03')).json();
    const maths = body.byTag.find((t) => t.id === math.id);
    assert.equal(maths.minutes, 30, 'the 600 in April is out of range');
  });

  test('negative rows reduce a tag rather than adding to it', async () => {
    const call = await withUser('insights_neg');
    const tag = await makeTag(call, 'Reading');
    const date = '2026-05-04';

    await call.put('/api/study/entry', { date, minutes: 60, tagId: tag.id });
    await call.put('/api/study/entry', { date, minutes: 20, tagId: tag.id });

    const body = await (await call.get('/api/study/insights?month=2026-05')).json();
    // +60 then -40, so the tag nets the day's total rather than its high-water mark.
    assert.equal(body.byTag.find((t) => t.id === tag.id).minutes, 20);
  });

  test('the heatmap covers 84 consecutive days ending today', async () => {
    const call = await withUser('insights_heat');
    const body = await (await call.get('/api/study/insights?month=2026-03')).json();

    assert.equal(body.heatmap.points.length, 84);
    const keys = body.heatmap.points.map((p) => p.key);
    assert.equal(new Set(keys).size, 84, 'no duplicate days');
    // Consecutive: each key is exactly one day after the last.
    for (let i = 1; i < keys.length; i += 1) {
      const prev = new Date(`${keys[i - 1]}T00:00:00`);
      const next = new Date(`${keys[i]}T00:00:00`);
      assert.equal(Math.round((next - prev) / 86400000), 1, `gap between ${keys[i - 1]} and ${keys[i]}`);
    }
    assert.equal(keys.at(-1), body.heatmap.to);
  });

  test('the cumulative series runs monotonically upward', async () => {
    const call = await withUser('insights_cume');
    const tag = await makeTag(call, 'Focus');
    for (let d = 1; d <= 5; d += 1) {
      const date = `2026-06-0${d}`;
      await call.put('/api/study/entry', { date, minutes: 60, tagId: tag.id });
    }

    const body = await (await call.get('/api/study/insights?month=2026-06')).json();
    const { points } = body.cumulative;
    assert.ok(points.length > 0);
    let prev = -1;
    for (const point of points) {
      assert.ok(point.studied >= prev, 'a running total cannot fall');
      prev = point.studied;
    }
    assert.equal(body.cumulative.studiedTotal, 300);
  });

  test('a malformed month is a 400 rather than a crash', async () => {
    const call = await withUser('insights_bad');
    const res = await call.get('/api/study/insights?month=nonsense');
    assert.equal(res.status, 400);
  });
});

describe('a calendar item never moves a study total', () => {
  test('adding one leaves study_entries and study_plans byte-identical', async () => {
    const call = await withUser('event_inert');
    await call.put('/api/study/entry', { date: '2026-07-01', minutes: 120 });

    const before = await (await call.get('/api/study/overview?month=2026-07')).json();
    const res = await call.post('/api/events', {
      date: '2026-07-01', kind: 'event', title: 'Lecture', time: '14:00', minutes: 60,
    });
    assert.equal(res.status, 200);
    const after = await (await call.get('/api/study/overview?month=2026-07')).json();

    assert.deepEqual(after.today.studied, before.today.studied);
    assert.deepEqual(after.month.studied, before.month.studied);
    assert.deepEqual(after.chart, before.chart);
    assert.deepEqual(after.week.planned, before.week.planned);
  });
});