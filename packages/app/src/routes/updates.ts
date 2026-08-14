import { Hono } from 'hono';
import { AppContext } from '../types';
import { EmailSummary } from '@mailvault/shared';

export const updatesRoutes = new Hono<AppContext>();

// Lightweight polling: return emails received since a timestamp (the newest
// ones, capped). MVP without SSE/WebSockets.
updatesRoutes.get('/', async (c) => {
  const e = c.env;
  const since = Number(new URL(c.req.url).searchParams.get('since') || '0');
  const limit = 50;

  const rows = await e.DB.prepare(
    `SELECT id, alias_id, from_address, from_name, subject, snippet,
            is_read, is_starred, is_archived, is_trashed, has_attachments, size_bytes, received_at
     FROM emails
     WHERE received_at > ?1
     ORDER BY received_at DESC
     LIMIT ?2`
  )
    .bind(since, limit)
    .all<EmailSummary>();

  return c.json({ updates: rows.results });
});
