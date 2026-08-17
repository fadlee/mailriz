---
title: Removing MailRiz
description: Tearing the deployment down — what goes, what is verified, and what survives.
---

```sh
mailriz-cli destroy
```

:::danger
This permanently deletes every stored message, including the raw copies in R2.
There is no undo, and no backup is taken.
:::

## Before it does anything

`destroy` verifies the API token, then reads your Cloudflare account and shows
what is **actually there** — not what `~/.mailriz/config.json` claims was once
created. The two drift apart whenever something is removed by hand or an
earlier teardown stopped halfway:

```
This will permanently delete

worker         mailriz
dns            inbox.yourdomain.com — custom domain and its record
d1             f4ccc0ee — every stored email
r2             mailriz-raw — 1,284 objects
r2             mailriz-attachments — 96 objects
r2             mailriz-html — 1000+ objects
access         application 8f21ab3c
state          ~/.mailriz/config.json

R2 data will be erased. Every raw message, attachment and HTML
body is deleted from the buckets before the buckets themselves go.
That is the complete archive — nothing is exported first.
```

Anything already gone is shown as such rather than counted as a deletion.

Then it asks you to **type the dashboard hostname**. Not a yes/no — a second
confirmation prompt can be dismissed on reflex, and this one cannot.

## What it deletes

In this order, which matters:

1. **The catch-all rule**, first. Once the Worker is gone, a catch-all still
   pointing at it swallows every message the domain receives — a black hole
   that looks like working mail from the outside.
2. **The custom domain**, which owns the DNS record for
   `inbox.yourdomain.com`. It is a separate resource from the Worker, so
   deleting the script does not reliably take it along.
3. **The Worker script.**
4. **The Cloudflare Access application**, if one guards the hostname. Found by
   its audience tag, or by hostname on installations from before the
   application id was recorded.
5. **Every object in the three R2 buckets, then the buckets.** Cloudflare
   refuses to delete a bucket that still holds objects, so emptying them is
   not optional — it is the only way the buckets actually go.
6. **The D1 database.**

### Email Routing

Whether Email Routing itself is turned off depends on who turned it on:

- **Setup enabled it** — it is disabled, and Cloudflare removes the MX, SPF
  and DKIM records it added to your root domain.
- **It was already on** — it stays on. Only the catch-all is released, because
  those records may be carrying mail that has nothing to do with MailRiz.
- **Unknown** — installations from before this was recorded are asked about
  directly, defaulting to leaving routing on.

## It checks its own work

After the deletes, `destroy` reads the account back and compares. If anything
survived, it says so by name and **keeps `~/.mailriz/config.json`**:

```
✘ Teardown incomplete — nothing was assumed deleted.

· r2 bucket mailriz-raw: The bucket you tried to delete is not empty
· still present: bucket mailriz-raw
```

Keeping the file is deliberate. It is the only record of which Worker,
database and buckets belong to this installation — deleting it while
leftovers remain would make them unfindable. Fix the cause, usually a token
missing a scope or one that has been revoked, and run `destroy` again.

A run only reports success when the account came back clean.

## What survives on purpose

- **The edge certificate** for the dashboard hostname. Cloudflare does not
  remove it with the custom domain, and the API scopes MailRiz asks for do not
  cover certificates. Drop it under **SSL/TLS → Edge Certificates** if you
  want it gone; leaving it costs nothing but tidiness.
- **Individual Email Routing rules** you created yourself. Only the catch-all
  MailRiz set is touched.

## Keeping your mail first

There is no export command yet. To keep messages, download them before
destroying:

- Each message's original `.eml` from the reading pane, or
- the R2 buckets directly with `wrangler r2 object get`, or the Cloudflare
  dashboard.

The raw bucket holds every message exactly as it arrived, so it is the
complete archive — and `destroy` empties it.

## Starting over

`destroy` then `setup` gives a clean installation. `setup` refuses to run while
`~/.mailriz/config.json` exists, so a full teardown is genuinely the way
through — and because destroy removes the D1 database and the buckets rather
than leaving them to be reused, it really does start empty.

If you only want to change the auth mode, the admin email, or repair a broken
Access application, use [`reconfigure`](/mailriz/en/reference/cli/#reconfigure)
instead. It keeps your mail.
