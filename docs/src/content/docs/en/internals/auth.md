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

A password you set during setup. The Worker never sees it — only a hash, and a
separate key it uses to sign the session cookie:

```
email.signature.expiry     HttpOnly, Secure, SameSite=Lax, 30 days
```

Both are Worker **secrets**, not variables, so neither shows up in the
Cloudflare dashboard's plain-text settings.

**The password** is stored as PBKDF2-HMAC-SHA256 with a random salt:

```
pbkdf2:100000:<salt>:<hash>
```

The work factor lives inside the value, so it can be raised later without
invalidating passwords already stored.

**The cookie is signed with `SESSION_SIGNING_KEY`** — 32 random bytes, HMAC
-SHA256, generated at setup and unrelated to the password. That separation is
the point: an earlier release signed with the password hash itself, which meant
anyone who could read that value could mint a session without ever knowing the
password. Rotating the signing key ends every session; changing the password
does not, by itself.

Signature comparison is constant-time.

`Secure` is omitted only when the request came from `localhost`, since a Secure
cookie is never sent over `http://` and local development is served without TLS.

Signing out expires the cookie.

**Login is rate limited** to a handful of attempts per minute per IP, through
Cloudflare's rate-limiting binding. Online guessing goes from as fast as the
Worker answers to something a password can outlast.

**`ADMIN_EMAIL` is enforced on both paths.** A cookie is only accepted for that
address, even though login is the only thing that issues one — a valid
signature over somebody else's address is refused with 403.

**A missing or unreadable credential is refused outright.** If either secret is
empty, or the stored hash is not in the format above, the Worker answers 500 on
every request including login — rather than falling back to a key everybody
knows. A deployment from before this scheme carries a bare SHA-256 and lands
exactly here; `mailriz-cli update` asks for the password once more and fixes
it.

## Which you will get

Setup probes Zero Trust right after you choose an account. If the token cannot
create Access applications, it says so **before deploying anything** and offers
password auth. You are never left with a half-built install that nobody can
open.

To use Access, add **Account → Access: Apps and Policies → Edit** to your token
and run `mailriz-cli reconfigure`. It switches an existing installation over
without touching the database or the buckets.

## The API

Every `/api/*` route is behind the same guard, with two deliberate exceptions:
`login` and `logout`. Both sit outside it — logging in has no cookie yet, and
logging out has to work when the cookie is already stale.

`/healthz` is unauthenticated by design; the setup wizard and uptime checks use
it, and it reveals nothing but liveness.

## Access JWT verification

The Worker verifies the Access JWT **signature** against the team domain's
public keys (JWKS), fetched from `https://<team-domain>/cdn-cgi/access/certs`
and cached. It also checks the audience, issuer, expiry, and the email claim.

This means a forged token is rejected by the Worker itself, even if the Access
application were removed or misconfigured — the Worker's check does not depend
on the edge challenge.

Signature verification is done with [`jose`](https://github.com/panva/jose),
Cloudflare's recommended library. The JWKS is fetched lazily and cached by key
ID. When a token arrives signed by a key the cache does not hold, the key set
is refetched — subject to a short cooldown, so a rotation is picked up on its
own without a redeploy.

The algorithm is pinned to RS256, which is what Access signs with.

If `ACCESS_TEAM_DOMAIN` is empty there is no key set to verify against, and
every request is rejected. `mailriz-cli status` calls that out explicitly,
since a dashboard that 401s on everything otherwise gives no clue why.
