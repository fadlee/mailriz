---
title: Worker configuration
description: Every variable the Worker reads, and what changes when you alter it.
---

Set by `mailriz-cli setup` and `update`. You can edit them in the Cloudflare
dashboard under the Worker's settings; a redeploy through the CLI will reset
them to what its config says, so prefer changing things through the CLI where
one exists.

## Identity and routing

| Variable | Meaning |
|---|---|
| `ADMIN_EMAIL` | the single address allowed to read the mailbox |
| `MAIL_DOMAIN` | the zone apex mail arrives on — **where aliases live** |
| `DASHBOARD_HOSTNAME` | where the dashboard is served |

`MAIL_DOMAIN` and `DASHBOARD_HOSTNAME` are deliberately different values.
Aliases belong to the mail domain; the dashboard host receives no mail. If
`MAIL_DOMAIN` is unset the catch-all rejects everything rather than accepting
all mail — a missing value must not mean "accept anything".

## Authentication

| Variable | Meaning |
|---|---|
| `AUTH_MODE` | `access` or `session` |
| `ACCESS_TEAM_DOMAIN` | your Zero Trust team domain |
| `ACCESS_AUD` | the Access application's audience tag |
| `SESSION_PASSWORD_HASH` | SHA-256 of the dashboard password |

In access mode the Worker rejects every request while `ACCESS_AUD` is empty, so
it must be set before the deploy that uses it — which is why setup creates the
Access application first.

## Retention

| Variable | Default | Meaning |
|---|---|---|
| `TRASH_RETENTION_DAYS` | `30` | how long trashed mail survives the daily purge |

Only trashed mail is purged. Inbox and archived mail is kept until you delete
it.

## Live updates

| Variable | Default | Meaning |
|---|---|---|
| `UPDATES_POLL_MS` | `4000` | how often an open stream checks for new mail |
| `UPDATES_PING_MS` | `20000` | keep-alive interval |
| `UPDATES_CONNECTION_MS` | `180000` | how long a connection lives before reconnecting |

Unlike the variables above, these three are **not written by the CLI**. The
Worker falls back to the defaults when they are absent, so they only exist if
you add them yourself in the Cloudflare dashboard.

`UPDATES_POLL_MS` is the lever if live updates keep dropping on **Workers
Free**: every poll inside a connection spends from the same 10 ms CPU budget,
so a longer interval means fewer polls per connection. Raising it also raises
the delay before new mail appears.

Lowering `UPDATES_CONNECTION_MS` reconnects more often, which resets the budget
more often at the cost of more requests.

## Bindings

| Binding | Resource |
|---|---|
| `DB` | the `mailriz` D1 database |
| `RAW_BUCKET` | original `.eml` |
| `ATTACHMENTS_BUCKET` | attachments |
| `HTML_BUCKET` | sanitised HTML bodies |
| `ASSETS` | the dashboard's static files |

## Assets routing

The generated Wrangler config sets two options that matter:

- `not_found_handling: "single-page-application"` — so reloading a client-side
  route serves the app instead of 404ing.
- `run_worker_first: ["/api/*"]` — so that fallback can never answer an API
  call. Without it, a navigation request to an API path (an iframe loading a
  message body, for instance) receives the dashboard shell instead.
