---
title: Platform limits
description: The Cloudflare limits that actually shape how MailRiz behaves.
---

These are Cloudflare's, not MailRiz's, but they decide what the product can
promise.

## The one that matters most

**Workers Free gives 10 ms of CPU per request. Workers Paid gives 30 s.**

CPU time excludes waiting on I/O, and most requests use very little — but two
paths in MailRiz push against it:

- **Parsing inbound mail.** A large HTML message can exceed 10 ms, which makes
  delivery fail *intermittently* — the hardest kind of failure to diagnose,
  because most mail still arrives.
- **Live updates.** Every poll inside an open stream spends from that same
  per-request budget, which is why connections are deliberately short-lived and
  why `UPDATES_POLL_MS` exists.

**Workers Paid ($5/mo) is recommended** for a mailbox you rely on.

## Inbound mail

| Limit | Value |
|---|---|
| Maximum message size | 25 MB |

Larger messages are rejected by Email Routing before the Worker sees them.

## Storage

| | Free tier |
|---|---|
| D1 | 500 MB per database, 5 GB per account |
| R2 | 10 GB stored, 1M Class A ops, 10M Class B ops, **no egress charge** |

Bodies and attachments live in R2, so D1 stays small — it holds metadata, text
for search, and the FTS index. A personal mailbox will reach the R2 limit long
before the D1 one.

## Requests

Requests to **static assets are free and unlimited** and do not count toward
the Workers quota — so serving the dashboard costs nothing. Only requests that
invoke the Worker script are billable, which for MailRiz means `/api/*` and
inbound mail.

Note that `run_worker_first: ["/api/*"]` means API paths always invoke the
Worker, by design.

## Duration

There is **no wall-clock limit** on an HTTP-triggered Worker while the client
stays connected — which is what makes a long-lived SSE stream possible at all.
The constraint is CPU, not time.

Cron triggers are capped at 15 minutes; the daily retention purge is far below
that.

## Sources

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
