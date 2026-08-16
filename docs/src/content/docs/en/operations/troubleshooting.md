---
title: Troubleshooting
description: Symptoms seen in practice, what causes them, and what to do.
---

## Mail bounces, nothing appears

The sender gets `Address not found`.

**First, check the address is on the right domain.** Aliases live on your
**mail domain** — the zone apex, `yourdomain.com` — not the dashboard hostname
`inbox.yourdomain.com`. Email Routing's catch-all is bound to the apex.

If the dashboard shows addresses ending in `inbox.…`, that install predates the
fix. Run `mailriz-cli update`: it moves them and reports how many.

Then check, in order:

1. **MX records** — `dig +short MX yourdomain.com` should return
   `route1/2/3.mx.cloudflare.net`.
2. **Email Routing is enabled** and its catch-all action is the `mailriz`
   Worker — Email → Email Routing → Routing Rules in the dashboard.
3. **The alias is not disabled.** A disabled alias is rejected on purpose and
   the catch-all will not recreate it.
4. **The daily budget.** Past 50 auto-created addresses in 24 hours, new ones
   get a temporary failure. Senders retry; it clears itself.

## The dashboard will not open

- **In access mode**, an empty audience tag makes the Worker reject every
  request. `mailriz-cli status` shows the auth mode; if it is `access` and the
  install has no aud recorded, re-run `setup`.
- **In session mode**, a 401 should show the login screen. If it does not, the
  Worker may not be answering at all — check `/healthz`.

## `update` fails with `duplicate column name`

An older CLI replayed every migration on each run. Update the CLI itself:

```sh
bunx mailriz-cli@latest update
```

Newer versions record applied migrations and adopt what is already present.

## New mail does not appear on its own

The dot on the refresh button is grey.

A brief grey moment every few minutes is normal — connections are short-lived
by design and the browser reconnects. Persistent grey means the stream is not
staying up.

On **Workers Free**, the 10 ms CPU budget per request is the usual cause:
each poll inside a connection spends from the same budget. Raise the poll
interval to spend fewer:

```
UPDATES_POLL_MS = 8000
```

Set it as a Worker variable and redeploy. Refresh still works meanwhile.

## Images in a message are broken

- **Embedded images in older messages** stay broken. Content-ID is recorded at
  ingest, so messages received before that shipped have nothing to resolve
  against. Mail arriving after the update renders normally; the files remain
  downloadable from the attachment list.
- **SVG never renders inline.** It can carry script, so it is always a
  download.
- **Remote images** need the *Show images* prompt — that is deliberate.

## Setup fails binding the custom domain

Cloudflare refuses to attach a Custom Domain over an existing DNS record.
Delete any existing record for the dashboard hostname, then re-run setup.

## Inbound mail fails intermittently

Large HTML messages can exceed the 10 ms CPU limit on **Workers Free** while
parsing. Workers Paid raises it to 30 s and is the recommended fix.

## Reading the logs

```sh
npx wrangler tail --name mailriz
```

Shows live Worker output, including the email handler.
