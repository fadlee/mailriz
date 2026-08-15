import { Hono } from 'hono';
import { AppContext } from '../types';

export const attachmentRoutes = new Hono<AppContext>();

attachmentRoutes.get('/:id', async (c) => {
  const e = c.env;
  const id = c.req.param('id');
  const row = await e.DB.prepare('SELECT r2_key, filename, content_type, size_bytes FROM attachments WHERE id = ?1')
    .bind(id)
    .first<{ r2_key: string; filename: string; content_type: string; size_bytes: number }>();
  if (!row) return c.json({ error: 'Not found' }, 404);

  const obj = await e.ATTACHMENTS_BUCKET.get(row.r2_key);
  if (!obj) return c.json({ error: 'Not found' }, 404);

  // Safe Content-Disposition.
  const safeName = (row.filename || 'attachment').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'attachment';
  const encoded = encodeURIComponent(safeName);
  // Always a download. Images embedded in a body are inlined as data: URIs
  // when that body is served, so nothing here needs to render in place.
  return new Response(obj.body, {
    headers: {
      'Content-Type': row.content_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${safeName}"; filename*=UTF-8''${encoded}`,
      'Content-Length': String(row.size_bytes),
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
