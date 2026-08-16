import { Hono } from 'hono';
import { AppContext } from '../types';
import { EmailSummary, EmailDetail, EmailListResponse, EmailView, BulkInput, UpdateEmailInput } from '@mailriz/shared';

export const emailRoutes = new Hono<AppContext>();

// ---- SELECT helpers -------------------------------------------------------

const SUMMARY_COLS = `
  e.id, e.alias_id, e.from_address, e.from_name, e.subject, e.snippet,
  e.is_read, e.is_starred, e.is_archived, e.is_trashed,
  e.has_attachments, e.size_bytes, e.received_at
`;

interface SummaryRow {
  id: string;
  alias_id: string;
  from_address: string;
  from_name: string;
  subject: string;
  snippet: string;
  is_read: number;
  is_starred: number;
  is_archived: number;
  is_trashed: number;
  has_attachments: number;
  size_bytes: number;
  received_at: number;
  label_name?: string;
  label_color?: string;
  label_id?: string;
  label_csv?: string;
}

function rowsToSummaries(rows: SummaryRow[]): EmailSummary[] {
  const map = new Map<string, EmailSummary>();
  for (const r of rows) {
    let s = map.get(r.id);
    if (!s) {
      s = {
        id: r.id,
        alias_id: r.alias_id,
        from_address: r.from_address,
        from_name: r.from_name,
        subject: r.subject,
        snippet: r.snippet,
        is_read: r.is_read,
        is_starred: r.is_starred,
        is_archived: r.is_archived,
        is_trashed: r.is_trashed,
        has_attachments: r.has_attachments,
        size_bytes: r.size_bytes,
        received_at: r.received_at,
        labels: [],
      };
      map.set(r.id, s);
    }
    if (r.label_id) {
      s.labels.push({ id: r.label_id, name: r.label_name || '', color: r.label_color || '#6366f1' });
    }
  }
  return [...map.values()];
}

// ---- GET / (list, cursor pagination) --------------------------------------

emailRoutes.get('/', async (c) => {
  const e = c.env;
  const url = new URL(c.req.url);
  const view = (url.searchParams.get('view') as EmailView) || 'inbox';
  const aliasId = url.searchParams.get('alias_id');
  const labelId = url.searchParams.get('label_id');
  const q = url.searchParams.get('q');
  const cursor = url.searchParams.get('cursor');
  const limitRaw = Number(url.searchParams.get('limit') || '25');
  const limit = Math.min(Math.max(limitRaw, 1), 100);

  let where: string[] = [];
  let params: any[] = [];

  if (view === 'inbox') {
    where.push('e.is_trashed = 0 AND e.is_archived = 0');
  } else if (view === 'starred') {
    where.push('e.is_starred = 1 AND e.is_trashed = 0');
  } else if (view === 'archived') {
    where.push('e.is_archived = 1 AND e.is_trashed = 0');
  } else if (view === 'trash') {
    where.push('e.is_trashed = 1');
  }

  if (aliasId) {
    where.push('e.alias_id = ?');
    params.push(aliasId);
  }

  // FTS5 search via MATCH.
  let fromFts = false;
  if (q) {
    // Trailing * makes each term a prefix match, so "jan" finds "jane" —
    // searching used to require whole words, which meant typing a partial
    // term returned nothing at all.
    const ftsQuery = q
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"*`)
      .join(' AND ');
    where.push(`e.id IN (SELECT email_id FROM emails_fts WHERE emails_fts MATCH ?)`);
    params.push(ftsQuery);
  }

  // Cursor pagination: (received_at, id) descending.
  if (cursor) {
    const [ts, id] = cursor.split('_');
    const tsNum = Number(ts);
    if (!Number.isNaN(tsNum) && id) {
      where.push('(e.received_at < ? OR (e.received_at = ? AND e.id < ?))');
      params.push(tsNum, tsNum, id);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql = 'ORDER BY e.received_at DESC, e.id DESC';

  let sql: string;
  if (labelId) {
    sql = `
      SELECT ${SUMMARY_COLS}, l.id AS label_id, l.name AS label_name, l.color AS label_color
      FROM emails e
      JOIN email_labels el ON el.email_id = e.id AND el.label_id = ?
      LEFT JOIN labels l ON l.id = el.label_id
      ${whereSql}
      ${orderSql}
      LIMIT ? OFFSET 0
    `;
    params = [labelId, ...params];
  } else {
    sql = `
      SELECT ${SUMMARY_COLS},
             (SELECT GROUP_CONCAT(l2.id || '|' || l2.name || '|' || l2.color) FROM email_labels el2 JOIN labels l2 ON l2.id = el2.label_id WHERE el2.email_id = e.id) AS label_csv
      FROM emails e
      ${whereSql}
      ${orderSql}
      LIMIT ? OFFSET 0
    `;
  }

  params.push(limit + 1); // +1 to detect next page
  const rows = await e.DB.prepare(sql).bind(...params).all<SummaryRow>();
  const hasMore = rows.results.length > limit;
  const pageRows = rows.results.slice(0, limit);

  let summaries = rowsToSummaries(pageRows);

  // If we used label_csv (no label filter), parse it.
  if (!labelId) {
    summaries = pageRows.map((r) => {
      const labels = (r.label_csv || '').split(',').filter(Boolean).map((part) => {
        const [id, name, color] = part.split('|');
        return { id: id || '', name: name || '', color: color || '#6366f1' };
      });
      return {
        id: r.id,
        alias_id: r.alias_id,
        from_address: r.from_address,
        from_name: r.from_name,
        subject: r.subject,
        snippet: r.snippet,
        is_read: r.is_read,
        is_starred: r.is_starred,
        is_archived: r.is_archived,
        is_trashed: r.is_trashed,
        has_attachments: r.has_attachments,
        size_bytes: r.size_bytes,
        received_at: r.received_at,
        labels,
      };
    });
  }

  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1]!;
    nextCursor = `${last.received_at}_${last.id}`;
  }

  const body: EmailListResponse = { emails: summaries, next_cursor: nextCursor };
  return c.json(body);
});

// ---- GET /:id (detail, auto-mark-read) ------------------------------------

emailRoutes.get('/:id', async (c) => {
  const e = c.env;
  const id = c.req.param('id');

  const row = await e.DB.prepare(
    `SELECT ${SUMMARY_COLS}, e.to_address, e.message_id, e.body_text, e.raw_r2_key, e.html_r2_key, e.blocked_images
     FROM emails e WHERE e.id = ?1`
  )
    .bind(id)
    .first<SummaryRow & { to_address: string; message_id: string | null; body_text: string; raw_r2_key: string; html_r2_key: string | null; blocked_images: number }>();

  if (!row) return c.json({ error: 'Not found' }, 404);

  await e.DB.prepare('UPDATE emails SET is_read = 1 WHERE id = ?1').bind(id).run();

  const atts = await e.DB.prepare(
    'SELECT id, filename, content_type, size_bytes FROM attachments WHERE email_id = ?1 ORDER BY filename'
  )
    .bind(id)
    .all<{ id: string; filename: string; content_type: string; size_bytes: number }>();

  const labels = await e.DB.prepare(
    `SELECT l.id, l.name, l.color FROM email_labels el JOIN labels l ON l.id = el.label_id WHERE el.email_id = ?1`
  )
    .bind(id)
    .all<{ id: string; name: string; color: string }>();

  const body: EmailDetail = {
    id: row.id,
    alias_id: row.alias_id,
    from_address: row.from_address,
    from_name: row.from_name,
    to_address: row.to_address,
    message_id: row.message_id,
    subject: row.subject,
    snippet: row.snippet,
    body_text: row.body_text,
    is_read: 1,
    is_starred: row.is_starred,
    is_archived: row.is_archived,
    is_trashed: row.is_trashed,
    has_attachments: row.has_attachments,
    size_bytes: row.size_bytes,
    received_at: row.received_at,
    html_r2_key: row.html_r2_key,
    blocked_images: row.blocked_images ?? 0,
    attachments: atts.results,
    labels: labels.results,
  };
  return c.json(body);
});

// ---- PATCH /:id (update state) --------------------------------------------

emailRoutes.patch('/:id', async (c) => {
  const e = c.env;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as UpdateEmailInput;

  const existing = await e.DB.prepare('SELECT id FROM emails WHERE id = ?1').bind(id).first();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const fields: string[] = [];
  const vals: any[] = [];
  if (body.is_read !== undefined) { fields.push('is_read = ?'); vals.push(body.is_read); }
  if (body.is_starred !== undefined) { fields.push('is_starred = ?'); vals.push(body.is_starred); }
  if (body.is_archived !== undefined) { fields.push('is_archived = ?'); vals.push(body.is_archived); }
  if (body.is_trashed !== undefined) {
    fields.push('is_trashed = ?'); vals.push(body.is_trashed);
    fields.push('trashed_at = ?'); vals.push(body.is_trashed ? Math.floor(Date.now() / 1000) : null);
  }
  if (fields.length === 0) return c.json({ error: 'Nothing to update' }, 400);

  vals.push(id);
  await e.DB.prepare(`UPDATE emails SET ${fields.join(', ')} WHERE id = ?`).bind(...vals).run();

  // Label sync.
  if (body.label_ids) {
    await e.DB.prepare('DELETE FROM email_labels WHERE email_id = ?1').bind(id).run();
    for (const lid of body.label_ids) {
      await e.DB.prepare('INSERT OR IGNORE INTO email_labels (email_id, label_id) VALUES (?1, ?2)').bind(id, lid).run();
    }
  }

  return c.json({ ok: true });
});

// ---- POST /bulk (mass actions) --------------------------------------------

emailRoutes.post('/bulk', async (c) => {
  const e = c.env;
  const body = (await c.req.json().catch(() => ({}))) as BulkInput;
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
  if (ids.length === 0) return c.json({ error: 'No ids' }, 400);

  const action = body.action;
  const placeholders = ids.map(() => '?').join(',');
  let sql: string;

  switch (action) {
    case 'read': sql = `UPDATE emails SET is_read = 1 WHERE id IN (${placeholders})`; break;
    case 'unread': sql = `UPDATE emails SET is_read = 0 WHERE id IN (${placeholders})`; break;
    case 'archive': sql = `UPDATE emails SET is_archived = 1, is_trashed = 0, trashed_at = NULL WHERE id IN (${placeholders})`; break;
    case 'unarchive': sql = `UPDATE emails SET is_archived = 0 WHERE id IN (${placeholders})`; break;
    case 'trash': sql = `UPDATE emails SET is_trashed = 1, trashed_at = ${Math.floor(Date.now() / 1000)} WHERE id IN (${placeholders})`; break;
    case 'untrash': sql = `UPDATE emails SET is_trashed = 0, trashed_at = NULL WHERE id IN (${placeholders})`; break;
    case 'delete': sql = `DELETE FROM emails WHERE id IN (${placeholders}) AND is_trashed = 1`; break;
    default: return c.json({ error: 'Unknown action' }, 400);
  }

  await e.DB.prepare(sql).bind(...ids).run();

  // For delete, also purge R2 objects (raw + html + attachments).
  if (action === 'delete') {
    for (const id of ids) {
      const row = await e.DB.prepare('SELECT raw_r2_key, html_r2_key FROM emails WHERE id = ?1').bind(id).first<{ raw_r2_key: string; html_r2_key: string | null }>();
      if (row) {
        const keys: string[] = [row.raw_r2_key];
        if (row.html_r2_key) keys.push(row.html_r2_key);
        const atts = await e.DB.prepare('SELECT r2_key FROM attachments WHERE email_id = ?1').bind(id).all<{ r2_key: string }>();
        keys.push(...atts.results.map((a) => a.r2_key));
        await Promise.all(keys.map((k) => e.RAW_BUCKET.delete(k).catch(() => {})));
        await Promise.all(keys.map((k) => e.ATTACHMENTS_BUCKET.delete(k).catch(() => {})));
        await Promise.all(keys.map((k) => e.HTML_BUCKET.delete(k).catch(() => {})));
        await e.DB.prepare('DELETE FROM attachments WHERE email_id = ?1').bind(id).run();
      }
    }
  }

  return c.json({ ok: true });
});

// ---- DELETE /:id (permanent, only if trashed) -----------------------------

emailRoutes.delete('/:id', async (c) => {
  const e = c.env;
  const id = c.req.param('id');
  const row = await e.DB.prepare('SELECT is_trashed, raw_r2_key, html_r2_key FROM emails WHERE id = ?1').bind(id).first<{ is_trashed: number; raw_r2_key: string; html_r2_key: string | null }>();
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (!row.is_trashed) return c.json({ error: 'Must trash first' }, 400);

  const keys: string[] = [row.raw_r2_key];
  if (row.html_r2_key) keys.push(row.html_r2_key);
  const atts = await e.DB.prepare('SELECT r2_key FROM attachments WHERE email_id = ?1').bind(id).all<{ r2_key: string }>();
  keys.push(...atts.results.map((a) => a.r2_key));
  await Promise.all(keys.map((k) => e.RAW_BUCKET.delete(k).catch(() => {})));
  await Promise.all(keys.map((k) => e.ATTACHMENTS_BUCKET.delete(k).catch(() => {})));
  await Promise.all(keys.map((k) => e.HTML_BUCKET.delete(k).catch(() => {})));

  await e.DB.prepare('DELETE FROM attachments WHERE email_id = ?1').bind(id).run();
  await e.DB.prepare('DELETE FROM email_labels WHERE email_id = ?1').bind(id).run();
  await e.DB.prepare('DELETE FROM emails WHERE id = ?1').bind(id).run();

  return c.json({ ok: true });
});

// ---- GET /:id/raw (stream .eml) -------------------------------------------

emailRoutes.get('/:id/raw', async (c) => {
  const e = c.env;
  const id = c.req.param('id');
  const row = await e.DB.prepare('SELECT raw_r2_key, subject FROM emails WHERE id = ?1').bind(id).first<{ raw_r2_key: string; subject: string }>();
  if (!row) return c.json({ error: 'Not found' }, 404);

  const obj = await e.RAW_BUCKET.get(row.raw_r2_key);
  if (!obj) return c.json({ error: 'Raw not found' }, 404);

  const safeSubject = (row.subject || 'email').replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_').slice(0, 60) || 'email';
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'message/rfc822',
      'Content-Disposition': `attachment; filename="${safeSubject}.eml"`,
    },
  });
});

// ---- GET /:id/html (stream sanitized HTML) --------------------------------

/** Raster types safe to embed. SVG is excluded — it can carry script. */
const INLINEABLE = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif',
  'image/webp', 'image/bmp', 'image/avif',
]);

/** Caps on embedding: a body is built in memory and sent in one response. */
const MAX_INLINE_BYTES = 1_000_000;
const MAX_INLINE_TOTAL = 5_000_000;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000; // avoid blowing the argument limit on large images
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Serve the message body as it was sent.
 *
 * Nothing is stripped for presentation — the layout an email was designed
 * with is the point. Safety comes from the response headers instead:
 *
 * - `sandbox` gives the document a unique origin and kills scripting, and it
 *   applies even if the URL is opened directly rather than in the iframe.
 * - `img-src` is what withholds remote images. Blocking is therefore a header
 *   concern, not a reason to rewrite the sender's HTML; `?images=1` simply
 *   widens it, which is what the reading pane's button requests.
 *
 * Embedded images (`src="cid:…"`) are inlined as data: URIs rather than
 * pointed at /api/attachments: under `sandbox` the document has a null origin,
 * so an authenticated subresource request cannot be relied on to carry the
 * session cookie.
 */
emailRoutes.get('/:id/html', async (c) => {
  const e = c.env;
  const id = c.req.param('id');
  const showRemote = c.req.query('images') === '1';

  const row = await e.DB.prepare('SELECT html_r2_key FROM emails WHERE id = ?1').bind(id).first<{ html_r2_key: string | null }>();
  if (!row || !row.html_r2_key) return c.json({ error: 'Not found' }, 404);
  const obj = await e.HTML_BUCKET.get(row.html_r2_key);
  if (!obj) return c.json({ error: 'Not found' }, 404);

  let html = await obj.text();

  // Bodies stored by older releases had their image sources rewritten. Put
  // them back so those messages still show pictures when asked.
  if (showRemote) html = html.replace(/data-blocked-src=/gi, 'src=');

  const cidRefs = /src\s*=\s*(?:"cid:([^"]+)"|'cid:([^']+)'|cid:([^\s>]+))/gi;
  if (cidRefs.test(html)) {
    cidRefs.lastIndex = 0;
    const atts = await e.DB.prepare(
      `SELECT id, content_id, content_type, size_bytes, r2_key
         FROM attachments WHERE email_id = ?1 AND content_id <> ''`
    ).bind(id).all<{ id: string; content_id: string; content_type: string; size_bytes: number; r2_key: string }>();

    const byCid = new Map<string, typeof atts.results[number]>();
    for (const a of atts.results || []) byCid.set(a.content_id.toLowerCase(), a);

    let budget = MAX_INLINE_TOTAL;
    const resolved = new Map<string, string>();

    for (const [, a] of byCid) {
      const type = (a.content_type || '').toLowerCase().split(';')[0]!.trim();
      if (!INLINEABLE.has(type)) continue;
      if (a.size_bytes > MAX_INLINE_BYTES || a.size_bytes > budget) continue;
      const blob = await e.ATTACHMENTS_BUCKET.get(a.r2_key);
      if (!blob) continue;
      const buf = await blob.arrayBuffer();
      budget -= buf.byteLength;
      resolved.set(a.content_id.toLowerCase(), `data:${type};base64,${toBase64(buf)}`);
    }

    html = html.replace(cidRefs, (whole, d, s, bare) => {
      const cid = String(d || s || bare || '').trim().toLowerCase();
      const dataUri = resolved.get(cid);
      // Anything unresolved stays as written rather than becoming a bad request.
      return dataUri ? `src="${dataUri}"` : whole;
    });
  }

  const imgSrc = showRemote ? "img-src 'self' data: https: http:" : "img-src 'self' data:";

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        imgSrc,
        'font-src data:',
        'sandbox',
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
});
