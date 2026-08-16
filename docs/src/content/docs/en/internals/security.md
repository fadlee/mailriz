---
title: Security
description: What MailRiz assumes is hostile, and what it does about it.
---

Email is attacker-controlled content that you have asked to be shown. The
design assumes every message is hostile.

## Rendering a message cannot run it

Bodies are stored **as sent** — their CSS, tables, and layout intact, because
mangling them is what makes self-hosted mail clients unpleasant. Safety comes
from constraining what the page may do, not from rewriting it.

Each body is served under:

```
Content-Security-Policy:
  default-src 'none';
  style-src 'unsafe-inline';
  img-src 'self' data:;      ← widened only when you show images
  font-src data:;
  sandbox
```

- **`sandbox`** gives the document a unique origin and disables scripting. It
  applies even if the URL is opened directly in a tab, not only inside the
  frame.
- The reading pane frames it with an **empty `sandbox` attribute**, so the
  message never shares the dashboard's origin.
- **`img-src`** is what withholds remote images. Blocking is a header concern,
  which is precisely what allows the markup to be left alone.

As a second layer, active content is stripped at ingest: `<script>` blocks,
`on*` handlers, and `javascript:`/`vbscript:` URLs. None of that affects how a
message looks, so it costs no fidelity — and it still holds if the CSP is ever
misconfigured.

## Attachments

Always served with `Content-Disposition: attachment` and
`X-Content-Type-Options: nosniff`. Nothing opens in place.

Embedded images are inlined as `data:` URIs when the body is served, capped per
file and in total. **SVG is excluded** — it can carry script, and inlining it
would hand it the document's origin.

## Spam backpressure

Unknown addresses that fail the catch-all guards are rejected with
`setReject()` at the SMTP level, so they never reach storage. The daily budget
for auto-created aliases means a spammer guessing addresses cannot mint
unlimited rows, and it counts only auto-created ones — aliases you made by hand
never consume it.

Over the limit, senders get a *temporary* failure and retry, so a real message
caught in someone else's burst is delayed rather than lost.

## Secrets

- The session password is stored only as a salted PBKDF2 hash — the plaintext
  never leaves your machine. It and the cookie signing key are Worker
  **secrets**, so neither appears in the Worker's plain-text settings.
- The two are separate values on purpose. Signing the cookie with the password
  hash, as an earlier release did, meant that reading the hash was enough to
  mint a session.
- The Cloudflare API token is **not** saved unless you opt in during setup;
  when saved it goes to `~/.mailriz/config.json` with mode `600`.
- `mailriz-cli status` reports whether a token is on disk, never its value.

## What is not protected

- **Anyone with your Cloudflare account** can read the mailbox directly through
  D1 and R2. MailRiz protects the dashboard, not your Cloudflare login — treat
  that account's security as the real perimeter.
- **Mail in transit** is subject to whatever the sender negotiated. MailRiz
  receives what Cloudflare accepts.
- **Access JWTs are signature-verified** by the Worker against the team
  domain's JWKS, plus audience, issuer, and expiry. See
  [Authentication](/mailriz/en/internals/auth/#access-jwt-verification).
