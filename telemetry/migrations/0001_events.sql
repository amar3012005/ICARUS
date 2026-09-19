-- This database intentionally stores no repository names, source, prompts, memories,
-- account identities, or IP addresses. installation_hash is a salted one-way hash of a
-- random client UUID and only supports aggregate unique-installation counts.
CREATE TABLE IF NOT EXISTS installations (
  installation_hash TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  first_version TEXT,
  last_version TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_hash TEXT NOT NULL,
  event TEXT NOT NULL,
  occurred_day TEXT NOT NULL,
  version TEXT,
  os TEXT,
  arch TEXT,
  agent TEXT,
  profile TEXT,
  received_at TEXT NOT NULL,
  FOREIGN KEY (installation_hash) REFERENCES installations(installation_hash)
);

CREATE INDEX IF NOT EXISTS events_day_event_idx ON events (occurred_day, event);
CREATE INDEX IF NOT EXISTS events_install_event_idx ON events (installation_hash, event);
