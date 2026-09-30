import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, '..', 'data');
const SCHEMA = readFileSync(join(here, 'schema.sql'), 'utf8');

/**
 * Opens the database, falling back until one of the candidates works.
 *
 * The first choice is the local data directory, so development and a normal
 * host behave exactly as before. Serverless hosts ship the project as a
 * read-only bundle with only /tmp writable, and a bundled function also has
 * no disk that outlives it, so those platforms land on a temporary file and
 * then on memory. That keeps the app booting and serving instead of crashing
 * on startup; see DEPLOYMENT.md for how to get real persistence.
 */
function openDatabase() {
  const candidates = process.env.DB_PATH
    ? [process.env.DB_PATH]
    : [
      join(DATA_DIR, 'pixelflow.db'),
      join(tmpdir(), 'pixelflow.db'),
      ':memory:',
    ];

  const failures = [];
  for (const path of candidates) {
    try {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
      const handle = new DatabaseSync(path);
      handle.exec(SCHEMA);
      // Keep the connection from holding a read snapshot open across
      // requests, which would stop the WAL from checkpointing.
      handle.exec('PRAGMA busy_timeout = 5000');
      return { handle, path };
    } catch (err) {
      failures.push(`${path}: ${err.message}`);
    }
  }
  throw new Error(`Could not open a SQLite database.\n  ${failures.join('\n  ')}`);
}

const opened = openDatabase();

export const db = opened.handle;

/** Where the database actually ended up — surfaced by /api/health. */
export const dbPath = opened.path;

/** False when storage is per-instance only, so the UI can warn. */
export const dbIsEphemeral = opened.path === ':memory:'
  || opened.path.startsWith(tmpdir());

/** Runs `fn` inside a transaction, rolling back if it throws. */
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();

/** Local calendar day as 'YYYY-MM-DD' (not UTC — this is a study log). */
export function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
