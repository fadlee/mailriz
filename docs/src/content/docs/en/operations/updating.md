---
title: Updating
description: Moving to a new release without touching your mail.
---

```sh
mailriz-cli update
```

Replaces the Worker with the latest release. **D1 and R2 are untouched** —
every message, alias, and attachment survives.

## What it does

| Task | |
|---|---|
| `release` | downloads the latest Worker bundle from GitHub Releases |
| `migrations` | applies any schema changes the release brings |
| `worker` | redeploys, keeping your existing configuration |
| `aliases` | repairs alias domains left wrong by older builds |
| `health` | polls `/healthz` until the dashboard answers |

Schema first, then the code that depends on it — a release carrying new columns
would otherwise deploy code querying columns that do not exist.

## The token

You are asked for the API token unless you saved it during setup, in which case
pressing Enter reuses it. Otherwise export it first:

```sh
export CLOUDFLARE_API_TOKEN=...
mailriz-cli update
```

There is deliberately no offer to save it here; that decision belongs where the
token is first handed over.

## Migrations run once

Each is recorded in `schema_migrations`. Running `update` twice in a row is
safe — the second reports `migrations up to date`.

If your installation predates that table, the first `update` adopts the
migrations it finds already applied instead of failing on them.

## Access installations

If your deployment uses Cloudflare Access, `update` refuses to run when no
audience tag is recorded for it. Redeploying without one would leave the Worker
rejecting every request and lock you out of the dashboard. Run `reconfigure`
instead — it reads the Access application back, records its audience tag, and
keeps your mail. The message says so.

## Checking what you have

```sh
mailriz-cli status
```

Shows the dashboard hostname, mail domain, auth mode, Worker name, database,
whether a token is stored, and whether `/healthz` answers.

## Rolling back

There is no downgrade command. Releases are tagged on GitHub, so pinning an
older CLI is possible, but **migrations do not roll back** — a newer schema
stays. Treat forward as the only supported direction.
