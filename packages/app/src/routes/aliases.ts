import { Hono } from 'hono';
import { AppContext } from '../types';
import { Alias, CreateAliasInput, UpdateAliasInput, ALIAS_LOCAL_PART_RE, VAULT_DOMAIN_RE } from '@mailriz/shared';
import { ulid } from 'ulid';

export const aliasRoutes = new Hono<AppContext>();

// List aliases with email count + last received timestamp.
aliasRoutes.get('/', async (c) => {
  const e = c.env;
  const user = c.get('user');

  const rows = await e.DB.prepare(
    `SELECT a.id, a.local_part, a.domain, a.label, a.note, a.is_enabled, a.created_at,
            (SELECT COUNT(*) FROM emails em WHERE em.alias_id = a.id) AS email_count,
            (SELECT MAX(received_at) FROM emails em WHERE em.alias_id = a.id) AS last_received_at
     FROM aliases a
     WHERE a.user_id = ?1
     ORDER BY a.created_at DESC`
  )
    .bind(user.email)
    .all<Alias>();

  return c.json(rows.results);
});

// Create alias — random slug + 4 hex, or custom prefix.
aliasRoutes.post('/', async (c) => {
  const e = c.env;
  const user = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as CreateAliasInput;

  let localPart: string;
  if (body.mode === 'custom') {
    const prefix = (body.customPrefix || '').toLowerCase().trim();
    if (!ALIAS_LOCAL_PART_RE.test(prefix)) {
      return c.json({ error: 'local_part must match [a-z0-9._-]{1,64}' }, 400);
    }
    localPart = prefix;
  } else {
    const slug = (body.customPrefix || 'alias').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'alias';
    const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
    localPart = `${slug}-${hex}`;
  }

  // Validate the local part again (random path too).
  if (!ALIAS_LOCAL_PART_RE.test(localPart)) {
    return c.json({ error: 'local_part must match [a-z0-9._-]{1,64}' }, 400);
  }

  // Domain comes from the request Host header (the dashboard hostname),
  // falling back to a configured domain env.
  const host = c.req.header('Host') || '';
  let domain = host.split(':')[0] || '';
  if (!VAULT_DOMAIN_RE.test(domain)) domain = e.DASHBOARD_HOSTNAME || '';

  const id = ulid();
  try {
    await e.DB.prepare(
      `INSERT INTO aliases (id, user_id, local_part, domain, label, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
      .bind(id, user.email, localPart, domain, body.label || '', body.note || '')
      .run();
  } catch (err: any) {
    if (String(err?.message || '').includes('UNIQUE constraint')) {
      return c.json({ error: 'Alias already exists' }, 409);
    }
    throw err;
  }

  const created = await e.DB.prepare(
    `SELECT id, local_part, domain, label, note, is_enabled, created_at,
            (SELECT COUNT(*) FROM emails em WHERE em.alias_id = a.id) AS email_count,
            (SELECT MAX(received_at) FROM emails em WHERE em.alias_id = a.id) AS last_received_at
     FROM aliases a WHERE a.id = ?1`
  )
    .bind(id)
    .first<Alias>();

  return c.json(created, 201);
});

// Update label/note/is_enabled.
aliasRoutes.patch('/:id', async (c) => {
  const e = c.env;
  const user = c.get('user');
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as UpdateAliasInput;

  const existing = await e.DB.prepare('SELECT id FROM aliases WHERE id = ?1 AND user_id = ?2')
    .bind(id, user.email)
    .first();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const fields: string[] = [];
  const vals: any[] = [];
  if (body.label !== undefined) { fields.push('label = ?'); vals.push(body.label); }
  if (body.note !== undefined) { fields.push('note = ?'); vals.push(body.note); }
  if (body.is_enabled !== undefined) { fields.push('is_enabled = ?'); vals.push(body.is_enabled); }
  if (fields.length === 0) return c.json({ error: 'Nothing to update' }, 400);

  vals.push(id);
  await e.DB.prepare(`UPDATE aliases SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`)
    .bind(...vals, user.email)
    .run();

  const updated = await e.DB.prepare(
    `SELECT id, local_part, domain, label, note, is_enabled, created_at,
            (SELECT COUNT(*) FROM emails em WHERE em.alias_id = a.id) AS email_count,
            (SELECT MAX(received_at) FROM emails em WHERE em.alias_id = a.id) AS last_received_at
     FROM aliases a WHERE a.id = ?1`
  )
    .bind(id)
    .first<Alias>();
  return c.json(updated);
});

// Soft delete alias (disable + keep data).
aliasRoutes.delete('/:id', async (c) => {
  const e = c.env;
  const user = c.get('user');
  const id = c.req.param('id');
  await e.DB.prepare('UPDATE aliases SET is_enabled = 0 WHERE id = ?1 AND user_id = ?2')
    .bind(id, user.email)
    .run();
  return c.json({ ok: true });
});
