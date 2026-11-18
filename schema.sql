-- EA LUBHO database (Cloudflare D1 / SQLite). Safe to run more than once.
-- All times are unix milliseconds.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL DEFAULT '',
  pw_hash     TEXT NOT NULL,            -- PBKDF2-SHA256 hash, never the password
  pw_salt     TEXT NOT NULL,
  pw_iter     INTEGER NOT NULL,
  role        TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'super_admin')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'pending', 'rejected')),
  must_change INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  last_login  INTEGER
);

-- Login sessions. Only a hash of the cookie token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

-- Expert Advisors. status 'published' = visible in the shared catalogue (super admin decides).
CREATE TABLE IF NOT EXISTS eas (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  version     TEXT NOT NULL DEFAULT '1.0',
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eas_owner ON eas (owner_id);

-- Uploaded .ex5 files (private: only the owner and super admins can download them).
CREATE TABLE IF NOT EXISTS ea_files (
  id          TEXT PRIMARY KEY,
  ea_id       TEXT NOT NULL REFERENCES eas (id) ON DELETE CASCADE,
  owner_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  size        INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  storage     TEXT NOT NULL CHECK (storage IN ('d1', 'r2')),
  uploaded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ea_files_ea ON ea_files (ea_id);

-- File bytes when R2 is not used (base64 text chunks).
CREATE TABLE IF NOT EXISTS file_chunks (
  file_id TEXT NOT NULL REFERENCES ea_files (id) ON DELETE CASCADE,
  idx     INTEGER NOT NULL,
  data    TEXT NOT NULL,
  PRIMARY KEY (file_id, idx)
);

-- Client MT5 accounts. The password is AES-256-GCM encrypted (pw_ct + pw_iv) and is only ever
-- decrypted for a registered hosting agent. It is never returned by any user or admin API.
CREATE TABLE IF NOT EXISTS mt5_accounts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label         TEXT NOT NULL DEFAULT '',
  login         TEXT NOT NULL,
  server        TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'demo' CHECK (kind IN ('demo', 'live')),
  pw_ct         TEXT NOT NULL,
  pw_iv         TEXT NOT NULL,
  key_version   INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'connected', 'failed')),
  status_detail TEXT NOT NULL DEFAULT '',
  verified_at   INTEGER,
  info          TEXT,                    -- last read-only account snapshot reported by the agent (JSON)
  info_at       INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (user_id, login, server)
);

-- Licences. Only a hash of the key is stored.
CREATE TABLE IF NOT EXISTS licences (
  id            TEXT PRIMARY KEY,
  key_hash      TEXT NOT NULL UNIQUE,
  key_hint      TEXT NOT NULL,
  label         TEXT NOT NULL DEFAULT '',
  ea_id         TEXT REFERENCES eas (id) ON DELETE SET NULL,   -- NULL = any published EA
  user_id       TEXT REFERENCES users (id) ON DELETE SET NULL, -- set when a user redeems it
  max_accounts  INTEGER NOT NULL DEFAULT 1,
  duration_days INTEGER,                                       -- NULL = lifetime
  expires_at    INTEGER,                                       -- NULL + duration_days = starts on first use
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  redeemed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_licences_user ON licences (user_id);

-- MT5 account numbers a licence has been activated on.
CREATE TABLE IF NOT EXISTS licence_accounts (
  id         TEXT PRIMARY KEY,
  licence_id TEXT NOT NULL REFERENCES licences (id) ON DELETE CASCADE,
  mt5_login  TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  UNIQUE (licence_id, mt5_login)
);

-- Windows machines running MT5 (your laptop now, a VPS later). Only a hash of the agent token is stored.
CREATE TABLE IF NOT EXISTS hosts (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  agent_version TEXT NOT NULL DEFAULT '',
  info          TEXT,
  last_seen     INTEGER,
  created_at    INTEGER NOT NULL
);

-- Hosting sessions. 'status' only becomes 'running' when the host agent confirms it.
CREATE TABLE IF NOT EXISTS hosting_sessions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  ea_id          TEXT REFERENCES eas (id) ON DELETE SET NULL,
  file_id        TEXT REFERENCES ea_files (id) ON DELETE SET NULL,
  account_id     TEXT NOT NULL REFERENCES mt5_accounts (id) ON DELETE CASCADE,
  host_id        TEXT REFERENCES hosts (id) ON DELETE SET NULL,
  desired        TEXT NOT NULL DEFAULT 'running' CHECK (desired IN ('running', 'stopped')),
  status         TEXT NOT NULL DEFAULT 'requested'
                 CHECK (status IN ('requested', 'starting', 'running', 'stop_requested', 'stopped', 'failed')),
  status_detail  TEXT NOT NULL DEFAULT '',
  -- Client hosting configuration (what the host passes to MetaTrader when it starts the EA)
  symbol         TEXT NOT NULL DEFAULT '',
  timeframe      TEXT NOT NULL DEFAULT 'M1',
  preset_name    TEXT NOT NULL DEFAULT '',
  preset         TEXT NOT NULL DEFAULT '',   -- optional .set file text (EA input values), max 20 000 chars
  last_report_at INTEGER,
  started_at     INTEGER,
  stopped_at     INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_hosting_user ON hosting_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_hosting_host ON hosting_sessions (host_id);

-- Work for the host agent. The agent polls for tasks; nothing is pushed to the Windows machine.
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('verify_account', 'start_session', 'stop_session')),
  host_id     TEXT REFERENCES hosts (id) ON DELETE SET NULL,
  user_id     TEXT,
  account_id  TEXT,
  session_id  TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'done', 'failed', 'cancelled')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  result      TEXT,
  created_at  INTEGER NOT NULL,
  claimed_at  INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status, host_id);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users (id) ON DELETE CASCADE,
  audience   TEXT NOT NULL DEFAULT 'user' CHECK (audience IN ('user', 'admins')),
  kind       TEXT NOT NULL DEFAULT 'info',
  title      TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  read       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at);

CREATE TABLE IF NOT EXISTS activity_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    TEXT,
  actor_email TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id   TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '',
  ip          TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON activity_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_logs_actor ON activity_logs (actor_id, created_at);

-- EA Development Studio drafts (super admin only).
CREATE TABLE IF NOT EXISTS studio_projects (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  version    TEXT NOT NULL DEFAULT '1.0',
  platform   TEXT NOT NULL DEFAULT 'MT5' CHECK (platform IN ('MT5', 'MT4')),
  code       TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

-- Failed attempts, for rate limiting.
CREATE TABLE IF NOT EXISTS attempts (
  bucket TEXT NOT NULL,
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_bucket_at ON attempts (bucket, at);

-- Platform settings chosen by the Super Admin (key/value).
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Read-only account snapshots reported by the host agent while a session runs
-- (balance, equity, open positions). Used by Live Trade Monitor and Analytics.
CREATE TABLE IF NOT EXISTS account_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT NOT NULL REFERENCES mt5_accounts (id) ON DELETE CASCADE,
  session_id  TEXT,
  at          INTEGER NOT NULL,
  balance     REAL,
  equity      REAL,
  margin      REAL,
  free_margin REAL,
  currency    TEXT NOT NULL DEFAULT '',
  positions   TEXT NOT NULL DEFAULT '[]'   -- JSON, at most 100 entries
);
CREATE INDEX IF NOT EXISTS idx_snapshots_account_at ON account_snapshots (account_id, at);
