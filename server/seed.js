/**
 * Seeds the database with two demo accounts who are friends, a week of study
 * history, tags, tasks and plan rows, so the Friends list, leaderboard, chart
 * and per-week rows all have real data on the very first run.
 *
 *   npm run seed            add sample data (keeps existing rows)
 *   npm run seed -- --reset wipe the database first
 */

import { db, localDate, nowIso, migrate } from './db.js';
import { hashPassword } from './auth.js';
import { DEFAULT_AVATAR, DEFAULT_SETTINGS } from './store.js';

export async function seed({ reset = false, quiet = false } = {}) {
  const log = quiet ? () => {} : console.log;

  await migrate();

  if (reset) {
    db.exec(`
    DELETE FROM task_tags; DELETE FROM tasks; DELETE FROM tags;
    DELETE FROM study_entries; DELETE FROM study_plans;
    DELETE FROM timer_sessions; DELETE FROM study_log_entries; DELETE FROM events;
    DELETE FROM friendships; DELETE FROM presence;
    DELETE FROM oauth_states; DELETE FROM spotify_tokens; DELETE FROM users;
    DELETE FROM sqlite_sequence;
  `);
    log('· wiped existing rows');
  }

  const PASSWORD = 'pixelflow';
  const people = [
    { username: 'kira', email: 'kira@pixelflow.test', outfit: '#7c6fff', hair: '#4a2c2a' },
    { username: 'milo', email: 'milo@pixelflow.test', outfit: '#6bffda', hair: '#f4c542' },
  ];

  const insertUser = await db.prepare(`
    INSERT INTO users (username, email, password_hash, avatar_json, settings_json, xp, level)
    VALUES (?,?,?,?,?,?,?)
  `);

  const ids = [];
  for (const p of people) {
    const existing = await db.prepare('SELECT id FROM users WHERE username = ?').get(p.username);
    if (existing) {
      ids.push(existing.id);
      log(`· ${p.username} already exists (id ${existing.id})`);
      continue;
    }
    const info = await insertUser.run(
      p.username, p.email, hashPassword(PASSWORD),
      JSON.stringify({ ...DEFAULT_AVATAR, outfit: p.outfit, hair: p.hair }),
      JSON.stringify(DEFAULT_SETTINGS),
      1240, 12,
    );
    ids.push(Number(info.lastInsertRowid));
    log(`· created ${p.username} (id ${info.lastInsertRowid})`);
  }

  const [kiraId, miloId] = ids;

  // ── friends ──────────────────────────────────────────────────────────────

  if (!await db.prepare('SELECT id FROM friendships').get()) {
    await db.prepare(
      "INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?,?,'accepted')",
    ).run(kiraId, miloId);
    // One inbound request so the Requests tab has something in it.
    await db.prepare(`
      INSERT INTO users (username, email, password_hash, avatar_json, settings_json, xp, level)
      VALUES ('zara','zara@pixelflow.test',?,?,?,2100,15)
    `).run(
      hashPassword(PASSWORD),
      JSON.stringify({ ...DEFAULT_AVATAR, gender: 'female', outfit: '#ff6b9d' }),
      JSON.stringify(DEFAULT_SETTINGS),
    );
    const zara = await db.prepare('SELECT id FROM users WHERE username = ?').get('zara');
    await db.prepare(
      "INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?,?,'pending')",
    ).run(zara.id, kiraId);
    log('· kira ⇄ milo are friends; zara has a pending request to kira');
  }

  // ── weekly plan: Mon–Fri plus Saturday, mirroring the tick/stepper UI ─────

  const planStmt = await db.prepare(`
    INSERT INTO study_plans (user_id, weekday, planned_minutes, active) VALUES (?,?,?,?)
    ON CONFLICT(user_id, weekday) DO UPDATE SET planned_minutes = excluded.planned_minutes, active = excluded.active
  `);
  const PLANS = [[1, 8, 1], [2, 6, 1], [3, 8, 1], [4, 5, 1], [5, 7, 1], [6, 3, 1], [0, 0, 0]];
  for (const id of ids) {
    for (const [weekday, hours, active] of PLANS) {
      await planStmt.run(id, weekday, hours * 60, active);
    }
  }

  // ── a month of study history ─────────────────────────────────────────────

  const entryStmt = await db.prepare(`
    INSERT INTO study_entries (user_id, date, minutes, source, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id, date) DO UPDATE SET minutes = excluded.minutes
  `);

  // Deterministic pseudo-random so repeated seeds give the same demo numbers.
  function lcg(seed) {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
  }

  const profiles = [
    { id: kiraId, base: 6.0, spread: 2.2 },
    { id: miloId, base: 4.2, spread: 1.6 },
  ];

  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  let added = 0;
  for (const [index, profile] of profiles.entries()) {
    const rand = lcg(42 + index * 7);
    const cursor = new Date(start);
    while (cursor <= today) {
      const weekday = cursor.getDay();
      const planned = PLANS.find(([d]) => d === weekday);
      if (planned && planned[2]) {
        // Land near the plan, sometimes over it, occasionally a rest day.
        const hours = Math.max(0, Math.round((profile.base + (rand() - 0.5) * profile.spread) * 4) / 4);
        if (hours > 0) {
          await entryStmt.run(profile.id, localDate(cursor), Math.round(hours * 60), 'manual', nowIso());
          added += 1;
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  log(`· logged ${added} study days`);

  // ── finished timer sessions, so streaks and pomodoro counts are real ─────

  if (!await db.prepare('SELECT id FROM timer_sessions LIMIT 1').get()) {
    const sessionStmt = await db.prepare(`
      INSERT INTO timer_sessions (user_id, started_at, ended_at, focus_seconds, topic, kind)
      VALUES (?,?,?,?,?,?)
    `);
    for (const [index, profile] of profiles.entries()) {
      const rand = lcg(9 + index * 3);
      for (let i = 0; i < 18; i += 1) {
        const minutes = [25, 25, 30, 45, 50][Math.floor(rand() * 5)];
        const day = new Date(today);
        day.setDate(day.getDate() - Math.floor(rand() * 20));
        await sessionStmt.run(
          profile.id,
          new Date(day.setHours(9, 0, 0, 0)).toISOString(),
          new Date(day.setHours(9, minutes, 0, 0)).toISOString(),
          minutes * 60,
          ['Study', 'Work', 'Assignment'][Math.floor(rand() * 3)],
          'focus',
        );
      }
    }
    log('· created 36 finished focus sessions');
  }

  // ── tags and tasks ───────────────────────────────────────────────────────

  if (!await db.prepare('SELECT id FROM tags LIMIT 1').get()) {
    const tags = [
      ['Study', '#7c6fff'], ['Work', '#6bffda'], ['Assignment', '#ffb347'],
      ['Exam prep', '#ff6b9d'], ['Reading', '#44aaff'],
    ];
    const tagIds = [];
    for (const [name, color] of tags) {
      const info = await db.prepare('INSERT INTO tags (user_id, name, color) VALUES (?,?,?)')
        .run(kiraId, name, color);
      tagIds.push({ name, id: Number(info.lastInsertRowid) });
    }
    const tasks = [
      ['Review calculus lecture notes', ['Study'], 1],
      ['Complete linear algebra problem set', ['Study', 'Assignment'], 0],
      ['Read research paper on ML', ['Study', 'Reading'], 0],
      ['Draft Q2 project proposal', ['Work'], 0],
      ['Prepare standup notes', ['Work'], 1],
      ['Physics exam — chapter 4 review', ['Exam prep', 'Study'], 0],
      ['Summarise last week’s seminar', ['Reading'], 0],
    ];
    const taskStmt = await db.prepare('INSERT INTO tasks (user_id, text, done, done_at) VALUES (?,?,?,?)');
    const linkStmt = await db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?,?)');
    for (const [text, tagNames, done] of tasks) {
      // done_at is what the Logs archive orders by, so a seeded completed task
      // needs one or it would sort as if it had never happened.
      const doneAt = done
        ? new Date(Date.now() - Math.floor(Math.random() * 4) * 86400000).toISOString()
        : null;
      const info = await taskStmt.run(kiraId, text, done, doneAt);
      const taskId = Number(info.lastInsertRowid);
      for (const name of tagNames) {
        const tag = tagIds.find((t) => t.name === name);
        if (tag) await linkStmt.run(taskId, tag.id);
      }
    }
    log('· created 5 tags and 7 tasks (2 already completed)');
  }

  // ── the study ledger ─────────────────────────────────────────────────────

  // The daily rollup above is one number per day, which is all the charts need
  // but nothing the Logs feed can show. Split each seeded day into a pomodoro
  // chunk and a manual chunk under a tag, so the feed is populated on a fresh
  // database without hand-crafting entries.
  if (!await db.prepare('SELECT id FROM study_log_entries LIMIT 1').get()) {
    const owned = await db.prepare('SELECT id, name FROM tags WHERE user_id = ?').all(kiraId);
    if (owned.length > 0) {
      const ledgerStmt = await db.prepare(`
        INSERT INTO study_log_entries (user_id, date, minutes, source, tag_id, created_at)
        VALUES (?,?,?,?,?,?)
      `);
      let rows = 0;
      const rand = lcg(2024);
      const days = await db.prepare(
        'SELECT date, minutes FROM study_entries WHERE user_id = ? ORDER BY date',
      ).all(kiraId);
      for (const day of days) {
        const minutes = Number(day.minutes);
        if (minutes <= 0) continue;
        const tag = owned[Math.floor(rand() * owned.length)];
        // Roughly two thirds from the timer, the rest typed in by hand.
        const fromTimer = Math.round((minutes * (0.4 + rand() * 0.4)) / 5) * 5;
        const manual = minutes - fromTimer;
        if (fromTimer > 0) {
          await ledgerStmt.run(kiraId, day.date, fromTimer, 'timer', tag.id, nowIso());
          rows += 1;
        }
        if (manual > 0) {
          await ledgerStmt.run(kiraId, day.date, manual, 'manual', tag.id, nowIso());
          rows += 1;
        }
      }
      log(`· wrote ${rows} study log entries`);
    }
  }

  // ── presence ─────────────────────────────────────────────────────────────

  await db.prepare(`
    INSERT INTO presence (user_id, state, activity, last_seen_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, activity = excluded.activity, last_seen_at = excluded.last_seen_at
  `).run(miloId, 'online', 'Laptop coding', nowIso());
  await db.prepare(`
    INSERT INTO presence (user_id, state, activity, last_seen_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, last_seen_at = excluded.last_seen_at
  `).run(kiraId, 'online', 'Studying', nowIso());


  log(`\n  Sign in with  username: kira   or   milo        password: ${PASSWORD}\n`);

  return { seeded: true };
}

// Run directly (`npm run seed`) rather than only being imported.
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  await seed({ reset: process.argv.includes('--reset') });
}
