import { Hono } from 'hono';
import { AppContext, Env } from './types';
import { emailHandler } from './email';
import { app as apiApp } from './api';

// Entry point: HTTP (API + assets) and email() handler for Email Routing.

const app = new Hono<AppContext>();
app.route('/', apiApp);

export default {
  fetch: app.fetch.bind(app),
  email: emailHandler,
  scheduled: async (_controller: ScheduledController, env: Env, _ctx: ExecutionContext) => {
    // Daily housekeeping: purge trashed emails older than retention.
    const retentionDays = Number(env.TRASH_RETENTION_DAYS || '30');
    const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;

    const expired = await env.DB.prepare(
      'SELECT id, raw_r2_key, html_r2_key FROM emails WHERE is_trashed = 1 AND trashed_at IS NOT NULL AND trashed_at < ?1'
    ).bind(cutoff).all<{ id: string; raw_r2_key: string; html_r2_key: string | null }>();

    for (const row of expired.results) {
      const keys: string[] = [row.raw_r2_key];
      if (row.html_r2_key) keys.push(row.html_r2_key);
      const atts = await env.DB.prepare('SELECT r2_key FROM attachments WHERE email_id = ?1').bind(row.id).all<{ r2_key: string }>();
      keys.push(...atts.results.map((a) => a.r2_key));
      await Promise.all(keys.map((k) => env.RAW_BUCKET.delete(k).catch(() => {})));
      await Promise.all(keys.map((k) => env.ATTACHMENTS_BUCKET.delete(k).catch(() => {})));
      await Promise.all(keys.map((k) => env.HTML_BUCKET.delete(k).catch(() => {})));
      await env.DB.prepare('DELETE FROM attachments WHERE email_id = ?1').bind(row.id).run();
      await env.DB.prepare('DELETE FROM email_labels WHERE email_id = ?1').bind(row.id).run();
      await env.DB.prepare('DELETE FROM emails WHERE id = ?1').bind(row.id).run();
    }

    console.log(`purge: removed ${expired.results.length} expired trashed emails`);
  },
};
