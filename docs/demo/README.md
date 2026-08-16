# Screenshot demo data

The screenshots in `src/assets/screenshots/` were taken against this data, not
against anyone's real mailbox. Everything here is invented: the domain is
`example.com`, the senders do not exist, and no real address appears.

Keeping it in the repo means the screenshots can be **retaken** when the UI
changes, rather than slowly drifting out of date.

## Recreating it

From `packages/app`, with `.dev.vars` present:

```sh
bunx wrangler d1 migrations apply mailriz --local
bunx wrangler d1 execute mailriz --local --file=../../docs/demo/seed.sql

# Message bodies live in R2. Local dev binds the *preview* bucket names.
bunx wrangler r2 object put mailriz-html-preview/a_bank/e_01.html \
  --file=../../docs/demo/e_01.html --local --content-type=text/html
bunx wrangler r2 object put mailriz-html-preview/a_news/e_04.html \
  --file=../../docs/demo/e_04.html --local --content-type=text/html
```

Then build the dashboard and serve it through the Worker, so the screenshots
show the same asset routing production uses:

```sh
bun run --cwd packages/app/web build
bun run dev:app     # http://localhost:8787
```

Sign in with the dev password from `.dev.vars`.

## Gotchas met while making these

- `aliases.user_id` stores the **email**, not `users.id`. Seed it with
  `ADMIN_EMAIL` or the sidebar lists no aliases.
- Local R2 binds `preview_bucket_name`, so `mailriz-html` uploads are invisible
  to the Worker — it reads `mailriz-html-preview`.
- The reading pane's iframe caches a 404. If a body was uploaded after the page
  first loaded, reload before concluding it is broken.
