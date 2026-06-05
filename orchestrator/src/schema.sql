-- Friday orchestrator persistent state.
-- All timestamps are stored as ISO 8601 UTC strings for human-readability.

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_active_at  TEXT NOT NULL
);

-- Conversation history (no system prompt). Roles are 'user' or 'assistant'.
-- Notes/system events are stored as user-role messages with `<note>...</note>`
-- formatting; the model is taught to recognise this by its system prompt.
-- Markers (USER_INTERRUPTED, PARTIALLY_DELIVERED) annotate truncated
-- assistant messages.
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text        TEXT NOT NULL,
  marker      TEXT,  -- NULL | 'USER_INTERRUPTED' | 'PARTIALLY_DELIVERED'
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id, id);

-- Job records — one row per `codex exec` invocation.
CREATE TABLE IF NOT EXISTS jobs (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  instruction         TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('running','finished','failed','cancelled')),
  result              TEXT,
  error               TEXT,
  started_at          TEXT NOT NULL,
  finished_at         TEXT
);
CREATE INDEX IF NOT EXISTS jobs_session_idx ON jobs(session_id, started_at);

-- Cron-like schedules. `cron` is a 5-field expression; `prompt` is the
-- instruction fired against the Primary. `timezone` is optional override;
-- when NULL the global default applies at fire time.
CREATE TABLE IF NOT EXISTS schedules (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('once','recurring')),
  cron          TEXT,        -- recurring only
  fire_at       TEXT,        -- once only (ISO 8601, UTC)
  prompt        TEXT NOT NULL,
  label         TEXT,
  timezone      TEXT,        -- NULL = inherit global
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','failed')),
  last_fired_at TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL
);

-- Proactive messages waiting for an IL to attach.
-- A row is removed only when delivered (or explicitly dropped).
CREATE TABLE IF NOT EXISTS inbox (
  id                  TEXT PRIMARY KEY,
  source              TEXT NOT NULL CHECK (source IN ('job','schedule','job_failure')),
  origin_session_id   TEXT,                -- nullable
  text                TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  delivered_at        TEXT
);
CREATE INDEX IF NOT EXISTS inbox_undelivered_idx ON inbox(delivered_at) WHERE delivered_at IS NULL;
