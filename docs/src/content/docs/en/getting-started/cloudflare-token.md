---
title: Cloudflare API token
description: The scopes MailRiz needs, why each one is required, and how to create the token.
---

The setup wizard needs an API token to build the stack in your account. It
opens the token page for you with the name pre-filled, but you can create it
beforehand.

Go to **My Profile → API Tokens → Create Token → Create Custom Token** in the
Cloudflare dashboard.

## Required scopes

Seven, and each is used for exactly one thing:

| # | Scope | Used for |
|---|---|---|
| 1 | Account → Workers Scripts → Edit | deploying the Worker |
| 2 | Account → D1 → Edit | creating the database and applying migrations |
| 3 | Account → Workers R2 Storage → Edit | creating the three buckets |
| 4 | Zone → Workers Routes → Edit | attaching the dashboard's custom domain |
| 5 | Zone → Email Routing Rules → Edit | enabling routing and the catch-all |
| 6 | Zone → DNS → Edit | the MX and SPF records Email Routing needs |
| 7 | Zone → Zone Settings → Edit | reading and adjusting zone configuration |

## Optional scope

| Scope | Used for |
|---|---|
| Account → Access: Apps and Policies → Edit | creating the Cloudflare Access application |

Without it, setup detects that Access is unavailable **before deploying
anything** and offers password authentication instead. You are not left with a
half-built install — the choice is made up front.

## Zone resources

Scope the token to the zone mail will arrive on. Account-level permissions
apply to the account you pick during setup.

## After setup

The token is only needed again for `update` and `destroy`. At the end of setup
you are asked whether to save it; the default is no, because it can delete your
Worker, database, and stored mail.

If you decline, export it when you need it:

```sh
export CLOUDFLARE_API_TOKEN=...
mailriz-cli update
```

Check whether one is stored with:

```sh
mailriz-cli status
```

It reports whether a token is on disk — never its value.

## Rotating

Create a new token, then either export it as `$CLOUDFLARE_API_TOKEN` or paste
it at the prompt the next time a command asks. `update`, `reconfigure` and
`destroy` all prefer what you type over what is saved, so a rotated token
needs no other step.

If a revoked token is sitting in `~/.mailriz/config.json`, commands fail with
an authentication error. Run `reconfigure` and paste the new one to replace it.

:::caution
Do not delete `~/.mailriz/config.json` to clear a stale token. It is the only
record of which Worker, database and buckets belong to your installation, and
`setup` refuses to run while a deployment it cannot see may still exist —
removing the file leaves the deployment running with nothing pointing at it.
:::
