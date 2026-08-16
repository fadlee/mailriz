---
title: Quick start
description: Deploy MailRiz to your own Cloudflare account with one command.
---

One command deploys the whole stack — Worker, database, storage, DNS, and mail
routing — to your own Cloudflare account.

```sh
bunx mailriz-cli@latest setup
```

## Before you start

You need:

- **A Cloudflare account** with a domain already added as a zone. Mail arrives
  on that domain, so it has to be one you control.
- **A Cloudflare API token.** The wizard opens the right page and tells you
  which scopes to tick — see [Cloudflare token](/mailriz/en/getting-started/cloudflare-token/)
  if you want to prepare it first.
- **Bun** ≥ 1.1, or Node ≥ 18 if you run the CLI with `npx` instead.

## What the wizard does

1. **Pre-flight** — checks wrangler, reachability, and your Bun version.
2. **Token** — you paste it; it is verified before anything is created.
3. **Account and domain** — pick which zone mail should arrive on.
4. **Configuration** — the dashboard hostname (default `inbox.yourdomain.com`)
   and your admin email address.
5. **Auth** — Cloudflare Access if your token allows it, otherwise a password
   you set here. See [Authentication](/mailriz/en/internals/auth/).
6. **Provisioning**, shown as a live task list:

   | Task | What it creates |
   |---|---|
   | `release` | downloads the Worker bundle from GitHub Releases |
   | `d1` | the `mailriz` database |
   | `migrations` | the schema |
   | `r2` | three buckets — raw mail, attachments, sanitised HTML |
   | `access` | the Access application, if you chose it |
   | `worker` | deploys the Worker and attaches the custom domain |
   | `email routing` | enables routing and points the catch-all at the Worker |
   | `health` | polls `/healthz` until the domain answers |

The last step waits for DNS and the certificate, which take a moment. That is
expected, not a hang.

## Saving the token

At the end you are asked whether to save the token:

```
? Save this token so `update` and `destroy` don't ask again?  › No / Yes
```

It defaults to **No**. This token can delete your Worker, your database, and
every stored message, so it is never written to disk unless you say so. If you
save it, it goes to `~/.mailriz/config.json` with mode `600`.

If you decline, later commands read `$CLOUDFLARE_API_TOKEN` or ask you to paste
it again.

## Then

Open the dashboard at the hostname you chose, and send yourself a message at
**any** address on your domain — you do not have to create an alias first.

```sh
# any of these work immediately
echo "hi" | mail -s "test" anything@yourdomain.com
```

It should appear in the inbox within a few seconds, without a refresh.

If nothing arrives, see [Troubleshooting](/mailriz/en/operations/troubleshooting/).
