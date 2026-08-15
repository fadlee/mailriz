-- Render message bodies as they were sent.
--
-- content_id: HTML mail references embedded pictures as src="cid:<id>". The
-- Content-ID was never stored, so those references could not be resolved and
-- every inline image rendered broken — while the same file downloaded fine
-- from the attachment list.
ALTER TABLE attachments ADD COLUMN content_id TEXT NOT NULL DEFAULT '';

-- blocked_images: counted at ingest so the reading pane only offers "show
-- images" for mail that actually reaches off-host. Bodies are now stored
-- as-sent, and remote images are withheld by the response CSP rather than by
-- rewriting the HTML.
ALTER TABLE emails ADD COLUMN blocked_images INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_attachments_cid ON attachments (email_id, content_id);
