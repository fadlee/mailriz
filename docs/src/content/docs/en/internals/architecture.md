---
title: Architecture
description: The pieces MailRiz is made of, and why there are so few of them.
---

One Worker, one database, three buckets. That is the whole system.

```
Internet mail ──► Cloudflare Email Routing (MX/SPF managed for you)
                        │  catch-all → Worker "mailriz"
                        ▼
              ┌─────────────────────┐
              │  Cloudflare Worker  │  email()  — inbound mail
              │  (Hono API + React) │  /api/*   — the dashboard's API
              └─────┬─────────┬─────┘  /*       — the dashboard itself
                    │         │
            D1 (SQLite)   R2 (raw .eml, attachments, sanitised HTML)
            FTS5 search
```

## Why one Worker does everything

The same script has three jobs:

- **`email()`** — the handler Email Routing invokes for each inbound message.
- **`/api/*`** — a Hono app behind authentication.
- **everything else** — the React dashboard, served as static assets.

Splitting them would mean more deploys, more configuration, and shared
credentials between them. One Worker with three entry points keeps the deploy a
single unit — which is what makes `mailriz-cli update` a single step.

Static assets are configured with `not_found_handling: single-page-application`
so the client-side routes survive a reload, and `run_worker_first: ["/api/*"]`
so that fallback can never swallow an API call.

## Why D1 and R2, not one or the other

- **D1** holds what you search and sort by: sender, subject, snippet, flags,
  timestamps — plus an FTS5 index kept in sync by triggers.
- **R2** holds the bulk: the raw `.eml`, attachments, and the HTML body.

Message bodies would bloat a 500 MB database quickly and are never queried,
only fetched by key. Keeping them in R2 leaves D1 small and fast, and R2 has no
egress charge. [Storage](/mailriz/en/internals/storage/) has the detail.

## Where state lives

| State | Where |
|---|---|
| Messages, aliases, labels | D1 |
| Bodies, attachments, raw mail | R2 |
| Which migrations have run | D1 (`schema_migrations`) |
| Your deployment's identifiers | `~/.mailriz/config.json` on your machine |
| Session | a cookie, or Cloudflare Access |

Nothing is kept in Worker memory between requests, because there is no
guarantee two requests reach the same instance. That single fact shapes the
live-updates design: the Worker holding an open stream is not the one that
received your mail, so arrival is found by polling the database rather than
being pushed in memory.

## Scheduled work

A cron trigger runs daily and purges trashed mail older than the retention
window (30 days by default).
