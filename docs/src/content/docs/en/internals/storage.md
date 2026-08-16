---
title: Storage
description: What lives in D1, what lives in R2, and why the split falls where it does.
---

## The split

**D1** holds what you query. **R2** holds what you fetch by key.

Message bodies are never searched by the database — the text used for search is
extracted at ingest and stored separately — and they are large. Keeping them in
R2 leaves D1 small enough to stay fast inside a 500 MB free tier, and R2 charges
nothing for egress.

## D1 tables

| Table | Holds |
|---|---|
| `aliases` | local part, domain, label, note, enabled, `is_auto` |
| `emails` | sender, subject, snippet, flags, timestamps, R2 keys, `blocked_images` |
| `attachments` | filename, content type, size, R2 key, `content_id` |
| `labels`, `email_labels` | labels and their assignments |
| `emails_fts` | FTS5 index, trigger-synced |
| `schema_migrations` | which migrations have been applied |

`emails` stores `body_text` for search and preview, but the rendered body lives
in R2.

### Indexes that matter

- `(alias_id, received_at DESC)` — one alias's mail
- `(is_trashed, is_archived, received_at DESC)` — the inbox, and the query the
  live-update stream polls
- `(is_trashed, trashed_at)` — the retention sweep

## R2 buckets

| Bucket | Contents |
|---|---|
| `mailriz-raw` | the complete original `.eml` |
| `mailriz-attachments` | each attachment as received |
| `mailriz-html` | the HTML body, active content stripped |

Keys are `<alias-id>/<email-id>…`, so everything for one message shares a
prefix.

### Why keep the raw `.eml`

It is the source of truth. Parsing is lossy and parser behaviour changes; the
original lets you re-derive anything later, forward a message intact, or verify
a signature. It is downloadable per message from the reading pane.

## Retention

A daily cron purges trashed mail older than `TRASH_RETENTION_DAYS` (30 by
default). Nothing else is deleted automatically — archived and inbox mail is
kept until you remove it.

## Migrations

Applied by the CLI on `setup` and `update`, and recorded in
`schema_migrations` so each runs once. Installations created before that table
existed are adopted automatically: a migration that fails because its change is
already present is recorded rather than treated as an error.

That matters because SQLite has no `ADD COLUMN IF NOT EXISTS` — replaying an
`ALTER` fails with `duplicate column name`, which is exactly what used to break
the second `update` on any deployment.
