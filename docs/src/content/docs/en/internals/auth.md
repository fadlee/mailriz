---
title: Authentication
description: Cloudflare Access or a password — how each works, and which you get.
---

MailRiz is single-user. Exactly one address, `ADMIN_EMAIL`, may read the
mailbox.

## Two modes

Which one you get is decided during setup, based on whether your API token can
create a Cloudflare Access application.

### Cloudflare Access (`AUTH_MODE=access`)

Cloudflare challenges visitors at the edge, before any request reaches the
Worker. You sign in with whatever identity provider your Zero Trust
organisation uses; the Worker then validates the audience tag on the resulting
token.

Setup creates the Access application **before** deploying the Worker, because
the audience tag it produces is a Worker variable — deploying first would leave
`ACCESS_AUD` empty, and a Worker with an empty audience rejects every request.

Signing out sends you to `/cdn-cgi/access/logout`; Cloudflare owns that session,
not MailRiz.

### Session password (`AUTH_MODE=session`)

A password you set during setup. The Worker stores only its SHA-256 hash and
issues a signed cookie:

```
email.signature.expiry     HttpOnly, SameSite=Lax, 30 days
```

The signature is over the email, the expiry, and the password hash — so
changing the password invalidates every existing cookie.

Signing out expires the cookie.

## Which you will get

Setup probes Zero Trust right after you choose an account. If the token cannot
create Access applications, it says so **before deploying anything** and offers
password auth. You are never left with a half-built install that nobody can
open.

To use Access, add **Account → Access: Apps and Policies → Edit** to your token
and re-run setup.

## The API

Every `/api/*` route is behind the same guard, with two deliberate exceptions:
`login` and `logout`. Both sit outside it — logging in has no cookie yet, and
logging out has to work when the cookie is already stale.

`/healthz` is unauthenticated by design; the setup wizard and uptime checks use
it, and it reveals nothing but liveness.

## A known limitation

The Worker's own JWT check decodes the Access token and verifies the audience,
expiry, and email claim, but **does not verify the signature** against
Cloudflare's public keys.

With Access enabled this is defence in depth rather than an open door —
Cloudflare challenges the request at the edge, so a forged header never reaches
the Worker through the protected hostname. But it means the Worker's own check
would not stop a forged token if the Access application were removed or
misconfigured. Worth knowing if you operate this in access mode.
