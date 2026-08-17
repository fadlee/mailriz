# mailriz-cli

Deployment wizard for [MailRiz](https://github.com/rizkirmdhnnn/mailriz) — self-hosted,
persistent email aliases running entirely on Cloudflare.

```bash
bunx mailriz-cli setup
```

## Commands

```bash
mailriz-cli setup        # deploy end-to-end (refuses if already installed)
mailriz-cli status       # check worker + config health
mailriz-cli update       # update worker to the latest release (data preserved)
mailriz-cli reconfigure  # change auth, admin email, repair Access (data preserved)
mailriz-cli destroy      # tear down everything, DNS and R2 included
```

## What `setup` does

1. Asks for a Cloudflare API token and validates it.
2. Lets you pick the account and zone, then the dashboard hostname and admin email.
3. Provisions the stack: D1 database + migrations, R2 buckets (raw `.eml`,
   attachments, sanitized HTML), Worker deployment, custom domain binding,
   Email Routing with a catch-all rule, and a Cloudflare Access app (or a
   session-password fallback if the token lacks Zero Trust scope).
4. Verifies the result: `/healthz` ping, MX check, summary.

The Worker bundle is downloaded from the latest GitHub Release at setup time;
the CLI itself only orchestrates.

## Requirements

- Node.js 18+ (or Bun).
- A Cloudflare account with a zone you control.
- An API token with: Account Read, Zone Read, Zone DNS Edit, Workers Scripts Edit,
  D1 Edit, Workers R2 Storage Edit, Email Routing Rules Edit, and optionally
  Zero Trust for automatic Access setup.

Config is written to `~/.mailriz/config.json` (mode 600).

## Notes

`wrangler` is the only runtime dependency — it's resolved from `node_modules` and
spawned as a child process to deploy. Everything else is bundled into the
published `dist/cli.js`.

See the [main README](https://github.com/rizkirmdhnnn/mailriz#readme) for
architecture, platform limits, and security notes.
