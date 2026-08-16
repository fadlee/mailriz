---
title: How a message arrives
description: From Cloudflare Email Routing to a row in your inbox, step by step.
---

What happens between someone pressing send and the message appearing in your
dashboard.

## 1. Email Routing accepts it

Your domain's MX records point at Cloudflare. Setup enables Email Routing and
sets the **catch-all** action to the `mailriz` Worker, so every address on the
domain reaches the same handler.

The catch-all is not an ordinary routing rule — it has its own endpoint and is
updated rather than created.

## 2. The Worker resolves the alias

The recipient is split into local part and domain. A `+tag` is stripped first,
so `news+netflix@` resolves to the alias `news`.

Then, in order:

1. **Alias exists and is enabled** → accept.
2. **Alias exists but is disabled** → reject. The catch-all does not resurrect
   an address you switched off.
3. **No alias** → create one, provided the domain is yours, the local part is
   valid, and the daily budget for auto-created aliases is not spent.

Rejections happen with `setReject()`, at the SMTP level. The sender gets a
bounce and nothing is stored — spam that guesses addresses costs you no
storage.

## 3. The raw message is stored first

Before anything is parsed, the complete `.eml` goes to the raw R2 bucket. If
parsing fails afterwards, the original still exists — nothing is lost to a
malformed message.

## 4. Parsing and storage

Using `postal-mime`:

- **Attachments** → the attachments bucket. Content-ID is recorded for each,
  which is what lets embedded images resolve later.
- **HTML body** → active content stripped (`<script>`, `on*` handlers,
  `javascript:` URLs), then stored as-sent in the HTML bucket. Presentation is
  left untouched.
- **Remote images** are counted at this point, so the reading pane knows
  whether to offer "show images" without inspecting the body again.
- **Text body and snippet** → D1.

## 5. The row, and the index

One row in `emails`, with a database trigger keeping the FTS5 index in sync —
so search never needs a separate write path that could drift.

## 6. You see it

If the dashboard is open, an SSE connection notices within about four seconds
and the list reloads. See [Live updates](/mailriz/en/guides/organising/#mail-arrives-on-its-own).

## Size limits

Cloudflare Email Routing accepts messages up to **25 MB**. Larger ones are
rejected before reaching the Worker; that limit is Cloudflare's, not MailRiz's.

On **Workers Free**, the 10 ms CPU budget per request can be exceeded while
parsing a large HTML message, which makes inbound delivery fail intermittently.
This is the main reason Workers Paid is recommended.
