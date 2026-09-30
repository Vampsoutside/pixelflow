/**
 * Database access.
 *
 * Speaks to libSQL/Turso over HTTP when TURSO_DATABASE_URL is set, and to a
 * local file otherwise, so the same code runs on a serverless host (which has
 * no disk that outlives a request) and on a laptop with no setup at all.
 *
 * The surface deliberately mirrors the old node:sqlite handle —
 *   db.prepare(sql).get(...a) / .all(...a) / .run(...a)
 * — but every method is async, because a network database cannot be read
 * synchronously. Callers await, and the async-safe router in ./http.js keeps
 * a rejected handler from becoming a hung request.
 */

import { createClient } from '@libsql/client';
import { readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, '..', 'data');
const SCHEMA = readFileSync(join(here, 'schema.sql'), 'utf8');

/** A remote Turso database when configured, else a local file. */
function resolveTarget() {
  if (process.env.TURSO_DATABASE_URL) {
    return {
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
      remote: true,
    };
  }
  // Honour an explicit override, then fall back to the project directory. A
  // read-only bundle (serverless) or a missing data/ directory pushes us to a
  // temp file, which is per-instance but at least boots.
  const candidates = [
    process.env.DB_PATH,
    join(DATA_DIR, 'pixelflow.db'),
    join(tmpdir(), 'pixelflow.db'),
  ].filter(Boolean);

  for (const path of candidates) {
    try {
      // Resolve to an absolute path: the ephemeral check below compares against
      // absolute roots, so a relative DB_PATH would look per-instance.
      const full = resolve(path);
      mkdirSync(dirname(full), { recursive: true });
      return { url: `file:${full}`, remote: false };
    } catch {
      /* try the next candidate */
    }
  }
  return { url: 'file::memory:', remote: false };
}

const target = resolveTarget();

export const client = createClient({
  url: target.url,
  ...(target.authToken ? { authToken: target.authToken } : {}),
});

/** True when reads and writes go over the network to a real database. */
export const isRemote = target.remote;

export const dbPath = target.remote ? target.url : target.url.replace(/^file:/, '');

/** False when storage is per-instance only, so the UI can warn. */
export const dbIsEphemeral = !target.remote
  && !dbPath.startsWith(DATA_DIR)
  && !dbPath.startsWith(process.cwd());

/**
 * A prepared statement.
 *
 * libSQL exposes one entry point — execute({ sql, args }) — so this holds the
 * SQL and derives get/all/run from the returned result set. Rows come back as
 * plain objects, so the shape callers already expect is unchanged; only the
 * awaiting is new.
 */
class Statement {
  constructor(sql, runner = client) {
    this.sql = sql;
    this.runner = runner;
  }

  async #run(params) {
    const args = params.map(normalise);
    try {
      return await this.runner.execute({ sql: this.sql, args });
    } catch (err) {
      // node:sqlite accepted odd bindings silently; libSQL throws. Naming the
      // statement and its arguments turns "some query failed" into a fix.
      err.message = `${err.message}\n  SQL: ${this.sql.replace(/\s+/g, ' ').trim()}\n  args: ${JSON.stringify(args)}`;
      throw err;
    }
  }

  async get(...params) {
    const res = await this.#run(params);
    const row = res.rows[0];
    return row ? { ...row } : undefined;
  }

  async all(...params) {
    const res = await this.#run(params);
    return res.rows.map((row) => ({ ...row }));
  }

  async run(...params) {
    const res = await this.#run(params);
    return {
      changes: Number(res.rowsAffected ?? 0),
      lastInsertRowid: Number(res.lastInsertRowid ?? 0),
    };
  }
}

/**
 * The handle passed around as `db`.
 *
 * Only prepare/exec/batch are needed; everything else goes through a
 * Statement.
 */
export const db = {
  prepare(sql) {
    return new Statement(sql);
  },

  async exec(sql) {
    // executeMultiple runs a whole script, so the schema does not have to be
    // hand-split — which is what broke on an apostrophe inside a comment.
    await client.executeMultiple(sql);
  },

  /** Runs many statements in one round trip. */
  async batch(statements) {
    if (!statements.length) return;
    await client.batch(
      statements.map((s) => ({ sql: s.sql, args: (s.args ?? []).map(normalise) })),
      'write',
    );
  },
};

/**
 * Runs `fn` inside a transaction, rolling back if it throws.
 *
 * `fn` receives a handle with the same shape as `db`, so a call site reads:
 *
 *   await tx((t) => {
 *     t.prepare('DELETE FROM x WHERE id = ?').run(id);
 *     t.prepare('INSERT INTO x VALUES (?)').run(id);
 *   });
 *
 * Reads inside the transaction see its own writes, which is what makes the
 * "insert, check it exists, then link it" pattern in the task routes work.
 */
export async function tx(fn) {
  const handle = await client.transaction('write');
  const scoped = {
    prepare(sql) {
      return new Statement(sql, handle);
    },
  };

  try {
    const out = await fn(scoped);
    await handle.commit();
    return out;
  } catch (err) {
    try { await handle.rollback(); } catch { /* already rolled back */ }
    throw err;
  }
}

/** libSQL only binds null/number/bigint/string/Uint8Array. */
function normalise(value) {
  if (value === undefined || value === null) return null;
  // node:sqlite bound a non-finite number as NULL, so a malformed path id
  // quietly matched no rows and the route answered 404. libSQL throws, which
  // would turn a junk URL into a 500, so keep the old behaviour on purpose.
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && !(value instanceof Uint8Array)) return JSON.stringify(value);
  return value;
}

export const nowIso = () => new Date().toISOString();

/** Local calendar day as 'YYYY-MM-DD' (not UTC — this is a study log). */
export function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Monday-based week start, matching how the planner partitions weeks. */
export function weekStart(d = new Date()) {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const shift = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - shift);
  return localDate(copy);
}

/** Inclusive list of 'YYYY-MM-DD' from `from` to `to`. */
export function dateRange(from, to) {
  const out = [];
  const cur = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (cur <= end) {
    out.push(localDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/** Applies the schema. Safe to run on every boot. */
export async function migrate() {
  await db.exec(SCHEMA);

  // CREATE TABLE IF NOT EXISTS cannot add a column to a table that already
  // exists, so anything introduced after a database was first created has to
  // be added explicitly. SQLite has no "ADD COLUMN IF NOT EXISTS", hence the
  // pragma check.
  const columns = async (table) => new Set(
    (await db.prepare(`PRAGMA table_info(${table})`).all()).map((c) => c.name),
  );

  const userColumns = await columns('users');
  if (!userColumns.has('is_guest')) {
    await db.exec('ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0');
  }
}
