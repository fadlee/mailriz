# MailRiz ✉️🔒

Self-hosted, persistent email aliases — 100% on Cloudflare.

Unlimited addresses on your own domain, one inbox to read them in, running
entirely on your own Cloudflare account. Stop giving your real address to every
newsletter: invent an alias per service, keep it forever, and cut off the one
that leaks.

**📖 Documentation: <https://rizkirmdhnnn.github.io/mailriz/>**

## Quick start

```bash
bunx mailriz-cli@latest setup
```

One command deploys the whole stack — Worker, D1, R2, DNS, and Email Routing —
to your account. See the [quick start guide][quickstart] for what the wizard
does and the [token page][token] for the scopes it needs.

## What you get

- **Catch-all by default** — any address on your domain works immediately; the
  alias appears when the first message lands.
- **Persistent aliases** — they work until you disable them, not for ten minutes.
- **A real inbox** — folders, labels, FTS5 search, keyboard shortcuts, dark mode.
- **Messages as they were sent**, with remote images withheld until you ask.
- **Live updates over SSE** — new mail appears without a refresh.
- **Your data stays yours** — raw `.eml` and attachments in your own R2 buckets.

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

The [how it works][internals] section covers the mail pipeline, the storage
split between D1 and R2, authentication, and the security model.

> **Note:** on the Workers **Free** plan each request gets 10 ms of CPU, and
> parsing large HTML mail can exceed it — inbound delivery may fail
> intermittently. **Workers Paid ($5/mo) is recommended.** See [limits][limits].

## Commands

```bash
bunx mailriz-cli setup    # deploy end-to-end
bunx mailriz-cli status   # check worker + config health
bunx mailriz-cli update   # update to the latest release (data preserved)
bunx mailriz-cli destroy  # tear down everything (double-confirm)
```

Full reference: [CLI commands][cli] · [configuration][config].

## Local development

```bash
bun install
bun run dev:app     # wrangler dev (worker on :8787)
bun run dev:web     # vite dev (dashboard on :5173, proxies /api)
bun run docs:dev    # documentation site
bun run test
```

## Releasing

One-time: `gh secret set NPM_TOKEN` with an **Automation** token from npmjs.com.
After that a release is just a tag — the tag is the source of truth for the
published version:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The tag must be `vX.Y.Z` (a `-beta.1` suffix is allowed). The workflow bundles
the Worker, publishes `mailriz-cli` to npm, and creates a GitHub Release with
the tarball the CLI downloads at setup time.

## License

MIT

[quickstart]: https://rizkirmdhnnn.github.io/mailriz/en/getting-started/quick-start/
[token]: https://rizkirmdhnnn.github.io/mailriz/en/getting-started/cloudflare-token/
[internals]: https://rizkirmdhnnn.github.io/mailriz/en/internals/architecture/
[limits]: https://rizkirmdhnnn.github.io/mailriz/en/reference/limits/
[cli]: https://rizkirmdhnnn.github.io/mailriz/en/reference/cli/
[config]: https://rizkirmdhnnn.github.io/mailriz/en/reference/configuration/
