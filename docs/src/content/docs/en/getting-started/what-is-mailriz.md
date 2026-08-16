---
title: What is MailRiz?
description: Self-hosted, persistent email aliases running entirely on Cloudflare — what it does and who it is for.
---

MailRiz gives you an unlimited supply of email addresses on a domain you own,
and one inbox to read them all in. It runs entirely on your own Cloudflare
account: your mail is stored in your D1 database and your R2 buckets, and no
one else operates any part of it.

![The MailRiz inbox: folders and aliases on the left, the message list in the
middle, the reading pane on the right](../../../../assets/screenshots/inbox.jpg)

:::note
Every screenshot on this site uses demo data — invented senders on
`example.com`. No real mailbox is shown.
:::

## The idea

Stop giving your real address to every service. Invent one as you sign up:

```
netflix@yourdomain.com
electricity-bill@yourdomain.com
that-shop-i-only-used-once@yourdomain.com
```

Every one of them lands in the same dashboard. When an address starts getting
spam, you know exactly who leaked it — and you can switch that one off without
touching any of the others.

Addresses are **permanent**. They keep working until you disable them, unlike
throwaway inboxes that expire after ten minutes.

## What you get

- **Catch-all by default.** Any address on your domain works immediately; the
  alias appears in the dashboard when the first message lands. No need to
  create it first.
- **A real inbox** — folders, stars, labels, search, and a reading pane.
- **Messages rendered as they were sent**, with remote images withheld until
  you ask for them.
- **Live updates.** New mail appears on its own, without a refresh.
- **Your data stays yours.** The raw `.eml` and every attachment are kept in
  your own R2 buckets.

## What it is not

- **Not a mail sender.** MailRiz receives; it does not send or reply. That is
  on the roadmap, not in the product.
- **Not multi-user.** One person, one mailbox. The whole auth model assumes a
  single owner.
- **Not a hosted service.** There is no MailRiz server to sign up to. You
  deploy it to your own account and you operate it.

## What it costs

Cloudflare's free tiers cover a personal mailbox comfortably — D1 gives 500 MB
per database, R2 gives 10 GB with no egress charge.

The one caveat worth knowing before you start: on the **Workers Free** plan,
each request gets 10 ms of CPU, and parsing a large HTML email can exceed that.
Inbound mail can fail intermittently as a result. **Workers Paid ($5/mo) is
recommended** for reliable delivery. See [Platform limits](/mailriz/en/reference/limits/).

## Next

[Quick start](/mailriz/en/getting-started/quick-start/) — one command, about
five minutes.
