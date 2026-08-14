-- MailVault initial schema
-- D1 (SQLite) — FTS5 full-text search backed by triggers.

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS aliases (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  local_part TEXT NOT NULL,
  domain     TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (local_part, domain)
);

CREATE TABLE IF NOT EXISTS emails (
  id               TEXT PRIMARY KEY,
  alias_id         TEXT NOT NULL,
  message_id       TEXT,
  from_address     TEXT NOT NULL,
  from_name        TEXT NOT NULL DEFAULT '',
  to_address       TEXT NOT NULL DEFAULT '',
  subject          TEXT NOT NULL DEFAULT '',
  body_text        TEXT NOT NULL DEFAULT '',
  snippet          TEXT NOT NULL DEFAULT '',
  raw_r2_key       TEXT NOT NULL,
  html_r2_key      TEXT,
  is_read          INTEGER NOT NULL DEFAULT 0,
  is_starred       INTEGER NOT NULL DEFAULT 0,
  is_archived      INTEGER NOT NULL DEFAULT 0,
  is_trashed       INTEGER NOT NULL DEFAULT 0,
  trashed_at       INTEGER,
  has_attachments  INTEGER NOT NULL DEFAULT 0,
  size_bytes       INTEGER NOT NULL DEFAULT 0,
  received_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_alias_received ON emails(alias_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_state_received ON emails(is_trashed, is_archived, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_starred ON emails(is_starred, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_trashed_at ON emails(is_trashed, trashed_at);

CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,
  email_id     TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT '',
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  r2_key       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments(email_id);

CREATE TABLE IF NOT EXISTS labels (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#6366f1',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS email_labels (
  email_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (email_id, label_id)
);

-- Standalone FTS5 table (email_id column joins back to emails).
CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
  email_id UNINDEXED,
  from_address,
  from_name,
  subject,
  body_text,
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS emails_fts_ai AFTER INSERT ON emails BEGIN
  INSERT INTO emails_fts(email_id, from_address, from_name, subject, body_text)
  VALUES (new.id, new.from_address, new.from_name, new.subject, new.body_text);
END;

CREATE TRIGGER IF NOT EXISTS emails_fts_ad AFTER DELETE ON emails BEGIN
  DELETE FROM emails_fts WHERE email_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS emails_fts_au AFTER UPDATE ON emails BEGIN
  DELETE FROM emails_fts WHERE email_id = old.id;
  INSERT INTO emails_fts(email_id, from_address, from_name, subject, body_text)
  VALUES (new.id, new.from_address, new.from_name, new.subject, new.body_text);
END;
