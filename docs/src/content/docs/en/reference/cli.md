---
title: CLI reference
description: Every mailriz-cli command, what it changes, and what it leaves alone.
---

```sh
bunx mailriz-cli@latest <command>
```

Running it with no command starts `setup`. An unrecognised command prints the
list rather than a bare error.

## `setup`

Deploys everything: D1, R2, the Worker, the custom domain, Email Routing, and
optionally Cloudflare Access. Interactive.

Safe to re-run — it reuses an existing `mailriz` database and buckets rather
than creating duplicates. Use it to change the auth mode, or to repair an
installation whose Access application is missing.

Writes `~/.mailriz/config.json` (mode `600`).

## `status`

Prints the installation and probes it:

```
dashboard    https://inbox.yourdomain.com
inbox        anything@yourdomain.com
admin        you@example.com
auth         Cloudflare Access
worker       mailriz
d1           f4ccc0ee
api token    not saved
installed    16/08/2026, 09:12
✔ health     responding
```

Read-only. Never prints the token's value, only whether one is stored.

## `update`

Moves the Worker to the latest release. Applies migrations first, then
redeploys, then repairs alias domains. **D1 and R2 data are untouched.**

Refuses to run on an access-mode installation with no recorded audience tag,
because redeploying would lock the dashboard out. See
[Updating](/mailriz/en/operations/updating/).

## `destroy`

Deletes the Worker, the database, the buckets, and the local config. Requires
typing the dashboard hostname to confirm. Leaves Email Routing rules and the
Access application in place. See [Removing MailRiz](/mailriz/en/operations/destroying/).

## `help`

Also `--help`, `-h`. Prints the command list.

## Authentication

`update` and `destroy` need the API token. They take it from, in order:

1. what you type at the prompt,
2. the token saved during setup, if you opted in,
3. `$CLOUDFLARE_API_TOKEN`.

Pressing Enter uses the first fallback available; the prompt names which one.
A too-short entry is rejected even when a fallback exists — a typo should not
silently deploy with a different token than the one you were typing.

## Where state lives

`~/.mailriz/config.json`, mode `600`: account and zone ids, worker name,
hostnames, database and bucket names, auth mode, and the API token only if you
chose to save it.

Deleting the file does not affect the deployment; it only makes the CLI forget
where it is. Re-running `setup` recreates it.
