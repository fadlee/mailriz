import { Hono } from 'hono';
import { AppContext } from '../types';
import { ulid } from 'ulid';

export const labelRoutes = new Hono<AppContext>();

labelRoutes.get('/', async (c) => {
  const e = c.env;
  const user = c.get('user');
  const rows = await e.DB.prepare(
    'SELECT id, name, color, created_at FROM labels WHERE user_id = ?1 ORDER BY name'
  ).bind(user.email).all();
  return c.json(rows.results);
});

labelRoutes.post('/', async (c) => {
  const e = c.env;
  const user = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; color?: string };
  const name = (body.name || '').trim();
  if (!name) return c.json({ error: 'name required' }, 400);
  const id = ulid();
  try {
    await e.DB.prepare(
      'INSERT INTO labels (id, user_id, name, color) VALUES (?1, ?2, ?3, ?4)'
    ).bind(id, user.email, name, body.color || '#6366f1').run();
  } catch (err: any) {
    if (String(err?.message || '').includes('UNIQUE')) return c.json({ error: 'Label exists' }, 409);
    throw err;
  }
  const created = await e.DB.prepare('SELECT id, name, color, created_at FROM labels WHERE id = ?1').bind(id).first();
  return c.json(created, 201);
});

labelRoutes.patch('/:id', async (c) => {
  const e = c.env;
  const user = c.get('user');
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; color?: string };
  const fields: string[] = [];
  const vals: any[] = [];
  if (body.name !== undefined) { fields.push('name = ?'); vals.push(body.name); }
  if (body.color !== undefined) { fields.push('color = ?'); vals.push(body.color); }
  if (fields.length === 0) return c.json({ error: 'Nothing to update' }, 400);
  const existing = await e.DB.prepare('SELECT id FROM labels WHERE id = ?1 AND user_id = ?2').bind(id, user.email).first();
  if (!existing) return c.json({ error: 'Not found' }, 404);
  vals.push(id);
  await e.DB.prepare(`UPDATE labels SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).bind(...vals, user.email).run();
  const updated = await e.DB.prepare('SELECT id, name, color, created_at FROM labels WHERE id = ?1').bind(id).first();
  return c.json(updated);
});

labelRoutes.delete('/:id', async (c) => {
  const e = c.env;
  const user = c.get('user');
  const id = c.req.param('id');
  await e.DB.prepare('DELETE FROM labels WHERE id = ?1 AND user_id = ?2').bind(id, user.email).run();
  await e.DB.prepare('DELETE FROM email_labels WHERE label_id = ?1').bind(id).run();
  return c.json({ ok: true });
});
