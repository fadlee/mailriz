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

**Refuses to run when `~/.mailriz/config.json` already exists.** Setup
provisions from scratch and then rewrites that file wholesale, so a second run
against a different zone or hostname would strand the first installation's
Worker, custom domain and Access application with nothing left on disk
pointing at them. To change something, use [`reconfigure`](#reconfigure); to
start over, [`destroy`](#destroy) first.

It also refuses when the file exists but cannot be parsed, rather than
overwriting a record of an installation that is probably still running.

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
because redeploying would lock the dashboard out. Run `reconfigure` instead.
See [Updating](/mailriz/en/operations/updating/).

## `reconfigure`

Changes an existing installation without reprovisioning it. Use it to switch
between Cloudflare Access and password auth, change the admin email, repair a
missing or mismatched Access application, or put a catch-all back after it was
edited in the dashboard.

Reuses the recorded account, zone, database and buckets — **D1 and R2 data are
untouched**, and the zone and hostname are fixed. Changing either of those
means `destroy` then `setup`.

If an Access application already guards the hostname it is reused rather than
duplicated. When the admin email changed, the existing policy is left alone
and the command says so: update it under Zero Trust → Access → Applications.

## `destroy`

Deletes everything MailRiz created, in an order that never leaves mail pointed
at something that is gone: the catch-all rule, the custom domain and its DNS
record, the Worker, the Access application, every object in the three R2
buckets and then the buckets, and finally the D1 database.

Before asking for confirmation it reads the account and shows what is actually
there, including how many objects each bucket holds. Afterwards it reads the
account back and refuses to call the teardown clean if anything survived — and
in that case keeps `~/.mailriz/config.json`, so the leftovers stay findable and
the command can be run again.

Requires typing the dashboard hostname to confirm. See
[Removing MailRiz](/mailriz/en/operations/destroying/).

## `help`

Also `--help`, `-h`. Prints the command list.

## Authentication

`update`, `reconfigure` and `destroy` need the API token. They take it from,
in order:

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

It also records whether setup was the thing that enabled Email Routing on the
zone, which is what lets `destroy` decide whether the zone's MX records are
MailRiz's to remove.

Deleting the file does not affect the deployment, but it does make the CLI
forget where the deployment is — and because `setup` now refuses to run over an
existing installation, that leaves the Worker, database and buckets with
nothing pointing at them. Keep it, or delete the deployment with `destroy`
first.
