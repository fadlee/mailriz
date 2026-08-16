# MailRiz ✉️🔒

**A persistent email alias service on your own domain — one inbox for every address, yours forever.**

Stop handing your real address to every newsletter, forum, and signup form. With MailRiz, you invent an alias per service — `netflix@yourdomain.com`, `banks@yourdomain.com`, `whatever@yourdomain.com` — read them all in one inbox, and cut off the one that leaks without touching anything else.

**📖 Docs: <https://rizkirmdhnnn.github.io/mailriz/>**

---

## 🚀 Quick start

```bash
bunx mailriz-cli@latest setup
```

One command deploys the entire stack to your Cloudflare account: Worker, database, storage, DNS, and email routing. No server to rent, nothing to maintain, no credit card for infrastructure.

> You need a Cloudflare account and a domain already on Cloudflare. The wizard walks you through the API token (7 scopes, ~2 minutes).

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
bunx mailriz-cli setup    # deploy end-to-end
bunx mailriz-cli status   # check health
bunx mailriz-cli update   # update to latest (data preserved)
bunx mailriz-cli destroy  # tear down (asks twice)
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
- Tests: `bun test` — 127+ tests across worker, CLI, and web
- Releases: push a tag, CI publishes to npm + GitHub Releases

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
