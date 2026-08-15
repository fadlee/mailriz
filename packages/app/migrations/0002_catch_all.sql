-- Catch-all: addresses that were never created by hand are accepted and the
-- alias is materialised on first delivery. Flagging those rows lets the UI
-- distinguish them and gives the handler something to rate-limit on, so a
-- spammer guessing addresses can't mint unbounded aliases.
ALTER TABLE aliases ADD COLUMN is_auto INTEGER NOT NULL DEFAULT 0;

-- The handler counts recent auto-created aliases on every unknown address.
CREATE INDEX IF NOT EXISTS idx_aliases_auto_created
  ON aliases (is_auto, created_at);
