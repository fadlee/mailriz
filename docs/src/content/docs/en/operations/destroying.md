---
title: Removing MailRiz
description: Tearing the deployment down, and what is deliberately left behind.
---

```sh
mailriz-cli destroy
```

:::danger
This permanently deletes every stored message. There is no undo, and no backup
is taken.
:::

## Before it does anything

The command lists exactly what will go:

```
worker       mailriz
d1           f4ccc0ee — every stored email
r2           mailriz-raw, mailriz-attachments, mailriz-html
state        ~/.mailriz/config.json
```

Then it asks you to **type the dashboard hostname**. Not a yes/no — a second
confirmation prompt can be dismissed on reflex, and this one cannot.

## What is left behind

On purpose:

- **Email Routing rules**, including the catch-all. Removing them would change
  how your domain handles mail beyond MailRiz, which is not a decision a
  teardown should make silently.
- **The Cloudflare Access application**, if one was created.
- **DNS records** Email Routing added (MX, SPF).

Remove those from the Cloudflare dashboard if you no longer want them. Until
you do, mail to your domain will be routed to a Worker that no longer exists
and will bounce.

## Keeping your mail first

There is no export command yet. To keep messages, download them before
destroying:

- Each message's original `.eml` from the reading pane, or
- the R2 buckets directly with `wrangler r2 object get`, or the Cloudflare
  dashboard.

The raw bucket holds every message exactly as it arrived, so it is the complete
archive.

## Starting over

`destroy` then `setup` gives a clean installation. Note that `setup` reuses an
existing `mailriz` D1 database if one is still present — destroy removes it, so
a full teardown really does start empty.
