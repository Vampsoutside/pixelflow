-- ── PixelFlow schema ────────────────────────────────────────────────────
-- All timestamps are ISO-8601 UTC strings (e.g. 2026-09-30T14:03:05.000Z).
-- Study dates are plain local calendar days: 'YYYY-MM-DD'.
--
-- Connection PRAGMAs live in db.js, not here: journal_mode in particular is
-- rejected by some filesystems, and running it as part of this batch would
-- abort the whole schema on a host where WAL is unavailable.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  -- A guest skipped the sign-up form and has a random password nobody knows,
  -- so this row is what marks the account as worth keeping. Claiming it sets a
  -- real username, email and password.
  is_guest      INTEGER NOT NULL DEFAULT 0,
  avatar_json   TEXT    NOT NULL DEFAULT '{}',
  settings_json TEXT    NOT NULL DEFAULT '{}',
  xp            INTEGER NOT NULL DEFAULT 0,
  level         INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS friendships (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL CHECK (status IN ('pending','accepted')),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- A pair of users can only have one relationship, in either direction.
  UNIQUE (requester_id, addressee_id),
  CHECK (requester_id <> addressee_id)
);
CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id, status);

CREATE TABLE IF NOT EXISTS presence (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state        TEXT    NOT NULL DEFAULT 'offline' CHECK (state IN ('online','away','offline')),
  activity     TEXT    NOT NULL DEFAULT '',
  last_seen_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One row per user per day that they logged study minutes. This is the daily
-- rollup every chart, streak and the calendar read from.
CREATE TABLE IF NOT EXISTS study_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT    NOT NULL,
  minutes    INTEGER NOT NULL DEFAULT 0 CHECK (minutes >= 0),
  -- 'manual' = typed by the user, 'timer' = added automatically by a session.
  source     TEXT    NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','timer')),
  session_id INTEGER REFERENCES timer_sessions(id) ON DELETE SET NULL,
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_study_entries_user_date ON study_entries(user_id, date);

-- Append-only ledger of every change to a day's total, and the source of the
-- study log feed. study_entries collapses a day to one number, which is what
-- metrics need but is too lossy to show somebody what they actually did.
--
-- `minutes` is signed: negative means time was removed. The rows for a day sum
-- to that day's total, with one deliberate exception — if the user lowers a
-- day's total below what the timer already contributed, the rollup is kept
-- authoritative and the ledger can read lower. study_entries always wins for
-- every chart; this table is the journal beside it, never the source.
CREATE TABLE IF NOT EXISTS study_log_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT    NOT NULL,
  minutes    INTEGER NOT NULL,
  source     TEXT    NOT NULL CHECK (source IN ('manual','timer')),
  session_id INTEGER REFERENCES timer_sessions(id) ON DELETE SET NULL,
  tag_id     INTEGER REFERENCES tags(id) ON DELETE SET NULL,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_study_log_user_date ON study_log_entries(user_id, date);

-- The student's weekly plan. One row per weekday; `active` is the tick box.
-- The weekly planned total is always the live SUM of the active rows and is
-- never stored, so it can never drift out of sync with the ticks.
CREATE TABLE IF NOT EXISTS study_plans (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday        INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0 = Sunday
  planned_minutes INTEGER NOT NULL DEFAULT 0 CHECK (planned_minutes >= 0),
  active         INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  PRIMARY KEY (user_id, weekday)
);

CREATE TABLE IF NOT EXISTS tags (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name    TEXT    NOT NULL,
  color   TEXT    NOT NULL DEFAULT '#7c6fff',
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       TEXT    NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
  -- When the task was ticked. A completed task leaves the Tasks window and
  -- becomes an entry in the Logs archive, where Restore clears both columns.
  done_at    TEXT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, id DESC);

CREATE TABLE IF NOT EXISTS task_tags (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);

CREATE TABLE IF NOT EXISTS timer_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at     TEXT,
  focus_seconds INTEGER NOT NULL DEFAULT 0,
  topic        TEXT    NOT NULL DEFAULT '',
  kind         TEXT    NOT NULL DEFAULT 'focus' CHECK (kind IN ('focus','break'))
);

-- Events and deadlines. Deliberately inert with respect to study totals: an
-- item is a thing that happens on a day, not study time, so nothing here is
-- ever summed into study_entries, study_plans, a streak or a chart.
--
-- 'deadline' is a day with no clock time; 'event' may carry one plus a length.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('event','deadline')),
  title      TEXT    NOT NULL,
  time       TEXT,
  -- A duration for an event, a rough estimate for a deadline. Shown in the UI
  -- and never added to any total.
  minutes    INTEGER NOT NULL DEFAULT 0 CHECK (minutes >= 0),
  tag_id     INTEGER REFERENCES tags(id) ON DELETE SET NULL,
  done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_user_date ON events(user_id, date);

CREATE TABLE IF NOT EXISTS spotify_tokens (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token  TEXT,
  refresh_token TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  scope         TEXT NOT NULL DEFAULT ''
);

-- Short-lived state for the OAuth CSRF check. Rows older than 10 minutes are
-- treated as expired and ignored.
CREATE TABLE IF NOT EXISTS oauth_states (
  state     TEXT PRIMARY KEY,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

-- ── Sign in with Google / Microsoft ──────────────────────────────────────
--
-- A provider account is linked to a PixelFlow user here. `subject` is the
-- provider's own immutable user id ("sub" claim), never their email: emails
-- change and are not unique across tenants.
--
-- Keeping this separate from users means one person can sign in with a local
-- password *and* a provider, and can add a second provider later, without the
-- users table growing a column per provider.
CREATE TABLE IF NOT EXISTS oauth_identities (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider   TEXT    NOT NULL,
  subject    TEXT    NOT NULL,
  email      TEXT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- One provider identity maps to exactly one account, which is what stops a
  -- replayed callback from re-linking somebody else's account.
  UNIQUE (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_oauth_identities_user ON oauth_identities(user_id);

-- State for the sign-in round trip. Unlike oauth_states there is no user yet,
-- so this is deliberately a separate table with no foreign key.
CREATE TABLE IF NOT EXISTS oauth_login_states (
  state      TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  -- Set when someone already had a session and is deliberately adding a
  -- provider to that account instead of creating a new one.
  link_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
