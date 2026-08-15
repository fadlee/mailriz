# MailRiz ✉️🔒

Self-hosted, persistent email aliases — 100% on Cloudflare.

MailRiz is a persistent, self-hosted email alias service running entirely on the
Cloudflare ecosystem. It gives you a Gmail-style dashboard to manage permanent
throwaway aliases, backed by a one-shot CLI wizard for instant deployment.

**Why:** stop giving your real address to every newsletter. Spin up a disposable
alias per service, keep them forever, and read everything in one dashboard.

---

## What you get

- **Catch-all by default** — any address on your domain works immediately. Invent
  `netflix@your.domain` at signup; the alias appears in the dashboard when the first
  mail lands. Up to 50 new addresses a day, so a spammer guessing addresses can't
  mint unlimited aliases; beyond that the sender gets a retryable temporary failure.
- **Persistent aliases** — every alias works forever (or until you disable it).
  Disabling one keeps it rejected — the catch-all will not resurrect it.
- **Gmail-like dashboard** — inbox/starred/archived/trash, labels, search, keyboard
  shortcuts, dark mode, infinite scroll, bulk actions.
- **Catch-all email routing** — everything to `*@your.domain` flows into the Worker.
- **Raw `.eml` + attachments** stored in R2 (you keep the originals).
- **External image blocking** by default — no tracking pixels fire until you allow them.
- **Full-text search** via D1 FTS5 (instant, no external search service).
- **One-command deploy**: `bunx mailriz-cli setup`.

## Quick Start

```bash
bunx mailriz-cli setup
```

The wizard walks you through:

1. **Cloudflare API Token** (paste) — validated immediately.
2. **Account + zone** selection.
3. **Dashboard hostname** (e.g. `inbox.yourdomain.com`) + admin email.
4. Automatic provisioning:
   - D1 database + migrations
   - R2 buckets (raw `.eml`, attachments, sanitized HTML)
   - Worker deployment (bundle + assets)
   - Custom domain binding (TLS auto)
   - Email Routing enable + catch-all rule → Worker
   - Cloudflare Access app + policy (or session-password fallback)
5. Verification: `/healthz` ping, MX check, summary.

## Architecture

```
Internet email ──► Cloudflare Email Routing (MX/SPF auto)
                        │  catch-all → Worker "mailriz"
                        ▼
              ┌─────────────────────┐
              │  Cloudflare Worker  │  email() handler
              │  (Hono API + React) │  /api/* (JWT Access)
              └─────┬─────────┬─────┘
                    │         │
            D1 (SQLite)   R2 (raw .eml, attachments, html)
            FTS5 search
```

- **Email Routing** — catch-all → Worker. A new address on your mail domain is accepted
  and its alias created on first delivery. Disabled aliases, other domains, malformed
  local parts, and bursts past the daily budget are rejected at SMTP level
  (`setReject`), so spam bounces before storage.
- **Subaddressing** — `news+netflix@` delivers to the alias `news`, rather than creating
  one alias per tag.
- **Worker** — single Worker with three roles: `email()` handler, Hono API, static assets.
- **D1** — SQLite database with FTS5 virtual table (trigger-synced) for search.
- **R2** — raw `.eml`, attachment blobs, and sanitized HTML bodies (keeps D1 rows small).
- **Cron** — daily purge of trashed emails older than retention (default 30 days).
- **Auth** — Cloudflare Access JWT validated in-worker (single-user: `ADMIN_EMAIL`),
  or session-password fallback if your token lacks Zero Trust scope.

## Token permissions

| Scope | Why |
|---|---|
| Account Read | list accounts |
| Zone Read | list zones |
| Zone DNS Edit | Email Routing MX/SPF injection |
| Workers Scripts Edit | deploy worker + custom domain routes |
| D1 Edit | create DB + migrations |
| Workers R2 Storage Edit | create buckets |
| Email Routing Rules Edit | enable routing + catch-all rule |
| (optional) Zero Trust | automatic Access app/policy |

## Platform limits (know them)

- **Inbound message size**: 25 MB max (Cloudflare Email Routing).
- **Workers Free plan**: 10 ms CPU/request — **email parsing on Free can intermittently
  fail** on heavy HTML mail. **Recommend Workers Paid ($5/mo)** for reliable inbound.
- **D1 Free**: 500 MB per DB, 5 GB/account. HTML bodies live in R2, so D1 stays small.
- **R2 Free**: 10 GB storage, 1M Class A / 10M Class B ops, free egress.

## Commands

```bash
bunx mailriz-cli setup    # deploy end-to-end
bunx mailriz-cli status   # check worker + config health
bunx mailriz-cli update   # update worker to latest release (data preserved)
bunx mailriz-cli destroy  # tear down everything (double-confirm)
```

## Local development

```bash
bun install
bun run dev:app     # wrangler dev (worker on :8787)
bun run dev:web     # vite dev (dashboard on :5173, proxies /api)
```

Seed test data:

```bash
cd packages/app
# wrangler dev running; use the D1 shell or a fixture:
bun run --cwd packages/app test   # runs sanitizer + handler tests
```

There's a `test/fixtures/basic.eml` you can push through `wrangler dev` with the
email simulator: `wrangler dev --test-scheduled` and the devtools "Email" panel.

## Release pipeline

- `main` → CI (lint, typecheck, web build, tests).
- Tag `v*` → Release workflow:
  - bundles the Worker (`bun build --target workerd`) into `worker/index.js`
  - copies migrations
  - tarballs to `mailriz-worker.tar.gz`
  - publishes `mailriz-cli` to npm
  - creates a GitHub Release with the tarball attached

The CLI downloads the tarball from the latest GitHub Release at setup time.

### Cutting a release

One-time setup: create an **Automation** token on npmjs.com and add it to the
repo, otherwise the publish step fails.

```bash
gh secret set NPM_TOKEN
```

After that a release is just a tag — the tag is the source of truth for the
published version, so `packages/cli/package.json`'s version is only a
placeholder and doesn't need bumping:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The tag must be `vX.Y.Z` (a `-beta.1`-style suffix is allowed); anything else
fails the workflow before it publishes.

`wrangler` is deliberately the CLI's only runtime dependency — it's resolved
from `node_modules` and spawned to deploy. Everything else is bundled into
`dist/cli.js`, so it must stay in `devDependencies`; a `workspace:*` entry in
`dependencies` would be published verbatim and break `npm install`.

## Security notes

- HTML sanitization strips `<script>`, `<form>`, `<iframe>`, `<object>`, `<embed>`,
  `on*` handlers, `javascript:` URLs, and CSS `url()`/`expression()`.
- External images become `data-blocked-src` — never fetched unless you click "Show images".
- Session fallback stores a SHA-256 password hash as a Worker secret; config lives in
  `~/.mailriz/config.json` (mode 600).
- All `/api/*` routes validate Cloudflare Access JWT (or session cookie) — except
  `/healthz` (used by the wizard).

## Phase 2 (planned)

- Reply via Cloudflare Email Sending (Beta) or Resend
- Multi-user
- Durable Objects for CPU-heavy parsing
- WebSockets/SSE for live updates

---

*MailRiz — self-hosted email aliases on Cloudflare. No servers to manage, no data
leaves your Cloudflare account.*
