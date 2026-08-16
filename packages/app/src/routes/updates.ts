import { Hono } from 'hono';
import { AppContext, Env } from '../types';
import { EmailSummary } from '@mailriz/shared';

export const updatesRoutes = new Hono<AppContext>();

/**
 * Stream timings. Overridable per deployment — raising the poll interval is
 * the lever if the CPU budget ever turns out to be tight — and the tests set
 * them small so they don't have to wait out real seconds.
 */
function timings(env: Env) {
  const num = (raw: string | undefined, fallback: number) => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    /** How often the open stream asks whether anything arrived; roughly the
     *  latency you feel when mail lands. */
    poll: num(env.UPDATES_POLL_MS, 4_000),
    /** Comment frames keep proxies from closing a stream they think is idle. */
    ping: num(env.UPDATES_PING_MS, 20_000),
    /**
     * How long one connection lives before closing so the browser reconnects.
     *
     * Workers put no wall-clock limit on a streaming response, but CPU time
     * per request is capped (10 ms on Free, 30 s on Paid) and every poll in
     * the loop spends from that one budget. A connection left open for hours
     * would eventually be killed mid-stream; a short life that reconnects
     * resets it.
     */
    connection: num(env.UPDATES_CONNECTION_MS, 180_000),
  };
}

/** Identifies the newest message: "<received_at>_<id>", as used for paging. */
type Cursor = string;

async function newestCursor(env: Env): Promise<Cursor> {
  // Restricted to the inbox both because that is what "new mail arrived"
  // means, and because it lets the query ride idx_emails_state_received
  // rather than scanning.
  const row = await env.DB.prepare(
    `SELECT id, received_at FROM emails
      WHERE is_trashed = 0 AND is_archived = 0
      ORDER BY received_at DESC, id DESC
      LIMIT 1`
  ).first<{ id: string; received_at: number }>();

  return row ? `${row.received_at}_${row.id}` : '';
}

/**
 * Live notification of new mail.
 *
 * The Worker holding this stream is not the one that received the mail —
 * there is no shared memory between them — so arrival is detected by polling
 * a single indexed row rather than being pushed.
 *
 * The client is only told *that* something changed; it refetches through the
 * normal list endpoint, which already knows the active folder, alias, label
 * and search.
 */
updatesRoutes.get('/stream', async (c) => {
  const env = c.env;

  // On reconnect the browser replays the last id it saw. Using it as the
  // baseline means mail that landed in the gap between connections still
  // produces an event instead of being silently skipped.
  const resumeFrom = c.req.header('Last-Event-ID');
  const signal = c.req.raw.signal;

  const { poll, ping, connection } = timings(env);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      let closed = false;

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the runtime when the client went away.
        }
      };

      signal?.addEventListener('abort', close);

      // Tell the browser how quickly to come back after we close.
      send(`retry: 2000\n\n`);

      let known: Cursor;
      try {
        known = resumeFrom ?? (await newestCursor(env));
      } catch {
        close();
        return;
      }

      const startedAt = Date.now();
      let lastPing = startedAt;

      try {
        while (!closed && !signal?.aborted && Date.now() - startedAt < connection) {
          await new Promise((r) => setTimeout(r, poll));
          if (closed || signal?.aborted) break;

          let latest: Cursor;
          try {
            latest = await newestCursor(env);
          } catch {
            // A transient database error shouldn't kill the stream; the next
            // poll will try again.
            continue;
          }

          if (latest !== known) {
            known = latest;
            send(`id: ${latest}\nevent: mail\ndata: ${JSON.stringify({ latest })}\n\n`);
            lastPing = Date.now();
          } else if (Date.now() - lastPing >= ping) {
            send(`: ping\n\n`);
            lastPing = Date.now();
          }
        }
      } finally {
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Ask intermediaries not to buffer, which would defeat streaming.
      'X-Accel-Buffering': 'no',
    },
  });
});

// Polling fallback: emails received since a timestamp, newest first.
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
