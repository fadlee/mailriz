<div align="center">

<img src=".github/assets/mailriz-logo.png" alt="" width="104" height="104">

# MailRiz

**A persistent email alias service on your own domain — one inbox for every address, yours forever.**

[**📖 Documentation**](https://rizkirmdhnnn.github.io/mailriz/) · [Quick start][quickstart] · [How it works][internals]

<!-- A GIF, not <video>: GitHub will not render a player from a repo path, and
     an animated image is the only thing that plays inline here. The full-
     resolution MP4, with pause and scrub, is on the docs site. -->
<img src=".github/assets/mailriz-intro.gif" alt="MailRiz in 30 seconds: the problem, the inbox, one-command setup" width="720">

*[Watch it in full quality on the docs site →](https://rizkirmdhnnn.github.io/mailriz/)*

</div>

Stop handing your real address to every newsletter, forum, and signup form. With MailRiz, you invent an alias per service — `netflix@yourdomain.com`, `banks@yourdomain.com`, `whatever@yourdomain.com` — read them all in one inbox, and cut off the one that leaks without touching anything else.

---

## 🚀 Quick start

```bash
bunx mailriz-cli@latest setup
```

One command deploys the entire stack to your Cloudflare account: Worker, database, storage, DNS, and email routing. No server to rent, nothing to maintain, no credit card for infrastructure.

> You need a Cloudflare account and a domain already on Cloudflare. The wizard walks you through the [API token][token] (7 scopes, ~2 minutes).

---

## ✨ Why you'll like it

| | |
|---|---|
| **📬 Catch-all by default** | Any address on your domain works *immediately*. The alias appears the moment the first email lands — no dashboard visit needed |
| **♾️ Persistent aliases** | They live until *you* disable them. Not 10-minute throwaways — your signups stay alive |
| **🗂️ A real inbox** | Folders, labels, full-text search, keyboard shortcuts, dark mode. Familiar, not a toy |
| **🖼️ Email as sent** | Newsletters keep their layout. Remote images stay blocked until you ask |
| **⚡ Live, not polled** | New mail appears on its own over SSE — no refresh, no reload |
| **🔒 Your data, your account** | Raw `.eml` and attachments live in *your own* R2 storage. No third party sees them |

---

## 💰 What it costs

The software is free (MIT). The Cloudflare side:

- **Free tier** — works, but large HTML mail can exceed the 10 ms CPU budget per request; delivery may be intermittent
- **Workers Paid — $5/mo** — recommended for reliable inbound

Everything else (D1 database, R2 storage, email routing) stays within Cloudflare's free allowances for personal use. [Full limits →][limits]

---

## 🛠️ Commands

```bash
bunx mailriz-cli setup        # deploy end-to-end
bunx mailriz-cli status       # check health
bunx mailriz-cli update       # update to latest (data preserved)
bunx mailriz-cli reconfigure  # change auth or admin email (data preserved)
bunx mailriz-cli destroy      # tear down everything, DNS and R2 included
```

[CLI reference →][cli] · [Configuration →][config]

---

## 🏗️ How it works (30 seconds)

```
Email ──► Cloudflare Email Routing (MX/SPF automatic)
               │ catch-all → Worker
               ▼
        Cloudflare Worker ──► D1 (SQLite + search)
               │
               └──────────► R2 (raw .eml, attachments)
```

Mail arrives, gets stored in your buckets, and shows up in the dashboard. [Deep dive →][internals]

---

## 🧑‍💻 For developers

- Bun monorepo: `packages/app` (Worker + React), `packages/cli`, `packages/shared`, `docs`
- Local dev: `bun install && bun run dev:app` (wrangler) + `bun run dev:web` (vite)
- Tests: `bun test` — 179+ tests across worker, CLI, and web
- Releases: push a tag, CI publishes to npm + GitHub Releases

Published packages carry [npm provenance][prov] — a signed attestation tying
the tarball to the workflow run and commit that built it. Verify before
installing, if you like:

```bash
npm audit signatures
```

[prov]: https://docs.npmjs.com/generating-provenance-statements

---

## 📄 License

MIT — use it, fork it, learn from it.

---

[quickstart]: https://rizkirmdhnnn.github.io/mailriz/en/getting-started/quick-start/
[token]: https://rizkirmdhnnn.github.io/mailriz/en/getting-started/cloudflare-token/
[limits]: https://rizkirmdhnnn.github.io/mailriz/en/reference/limits/
[cli]: https://rizkirmdhnnn.github.io/mailriz/en/reference/cli/
[config]: https://rizkirmdhnnn.github.io/mailriz/en/reference/configuration/
[internals]: https://rizkirmdhnnn.github.io/mailriz/en/internals/architecture/
