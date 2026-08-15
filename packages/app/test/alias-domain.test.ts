import { describe, it, expect } from 'bun:test';
import { app } from '../src/api';
import { emailHandler } from '../src/email';

/**
 * Aliases must be created on the domain that receives mail.
 *
 * Email Routing's catch-all is bound to the zone apex, so an alias stored
 * against the dashboard host (inbox.example.com) can never be matched by an
 * incoming message to example.com — the handler rejects it as "Address not
 * found" and the sender gets a bounce, with nothing shown in the dashboard.
 *
 * These pin that creation uses MAIL_DOMAIN, and that the handler's lookup
 * lines up with it.
 */

const ADMIN = 'owner@example.com';
// sha256("hunter2")
const HASH = 'f52fbd32b2b3b86ff88ef6c490628285f482af15ddcb29541f94bcf526a3f6c7';

/** Captures the rows an INSERT would write, so we can assert on the domain. */
function makeDb() {
  const inserted: any[] = [];
  const aliases: any[] = [];
  const db = {
    inserted,
    aliases,
    prepare(sql: string) {
      return {
        _args: [] as any[],
        bind(...args: any[]) { this._args = args; return this; },
        async run() {
          if (/INSERT INTO aliases/i.test(sql)) inserted.push(this._args);
          return { success: true };
        },
        async first<T>() {
          if (/FROM aliases WHERE local_part/i.test(sql)) {
            const [local, domain] = this._args;
            return (aliases.find((a) => a.local_part === local && a.domain === domain) ?? null) as T;
          }
          return null as T;
        },
        async all() { return { results: [] }; },
      };
    },
  };
  return db;
}

/** Just enough R2 for the handler to get past storage. */
function makeBucket() {
  const objects = new Map<string, unknown>();
  return { objects, async put(k: string, v: unknown) { objects.set(k, v); }, async get() { return null; } };
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: makeDb(),
    RAW_BUCKET: makeBucket(),
    ATTACHMENTS_BUCKET: makeBucket(),
    HTML_BUCKET: makeBucket(),
    AUTH_MODE: 'session',
    ADMIN_EMAIL: ADMIN,
    SESSION_PASSWORD_HASH: HASH,
    DASHBOARD_HOSTNAME: 'inbox.example.com',
    MAIL_DOMAIN: 'example.com',
    ...overrides,
  } as any;
}

/** Log in and return the cookie, so alias calls are authenticated. */
async function sessionCookie(env: any): Promise<string> {
  const res = await app.fetch(
    new Request('https://inbox.example.com/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN, password: 'hunter2' }),
    }),
    env
  );
  expect(res.status).toBe(200);
  return (res.headers.get('Set-Cookie') || '').split(';')[0]!;
}

describe('alias creation domain', () => {
  it('stores the mail domain, not the dashboard host the request arrived on', async () => {
    const env = makeEnv();
    const cookie = await sessionCookie(env);

    const res = await app.fetch(
      new Request('https://inbox.example.com/api/aliases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ mode: 'custom', customPrefix: 'newsletter' }),
      }),
      env
    );
    expect(res.status).toBeLessThan(400);

    // INSERT binds (id, user_id, local_part, domain, label, note).
    const [row] = env.DB.inserted;
    expect(row).toBeDefined();
    expect(row[3]).toBe('example.com');
    expect(row[3]).not.toBe('inbox.example.com');
  });

  it('falls back to the request host when MAIL_DOMAIN is unset (local dev)', async () => {
    const env = makeEnv({ MAIL_DOMAIN: undefined });
    const cookie = await sessionCookie(env);

    await app.fetch(
      new Request('https://inbox.example.com/api/aliases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ mode: 'custom', customPrefix: 'devalias' }),
      }),
      env
    );
    expect(env.DB.inserted[0][3]).toBe('inbox.example.com');
  });

  it('reports the mail domain from /api/me', async () => {
    const env = makeEnv();
    const cookie = await sessionCookie(env);
    const res = await app.fetch(
      new Request('https://inbox.example.com/api/me', { headers: { Cookie: cookie } }),
      env
    );
    expect(await (res.json() as Promise<any>)).toMatchObject({ domain: 'example.com' });
  });
});

describe('incoming mail lookup', () => {
  /** Minimal ForwardableEmailMessage stand-in. */
  function message(to: string, onReject: (r: string) => void) {
    return {
      to,
      from: 'sender@elsewhere.com',
      headers: new Headers(),
      raw: new TextEncoder().encode('Subject: hi\r\n\r\nbody').buffer,
      setReject: onReject,
      forward: async () => {},
      reply: async () => {},
    } as any;
  }

  it('does not match an alias stored on the dashboard host', async () => {
    // MAIL_DOMAIN unset disables the catch-all, isolating the lookup: with it
    // on, this address would simply be created fresh (see catch-all.test.ts).
    const env = makeEnv({ MAIL_DOMAIN: undefined });
    // The shape earlier builds produced.
    env.DB.aliases.push({ local_part: 'news', domain: 'inbox.example.com', is_enabled: 1, id: 'a1' });

    let rejected: string | null = null as string | null;
    await emailHandler(message('news@example.com', (r) => { rejected = r; }), env);

    expect(rejected).toBe('Address not found');
  });

  it('accepts mail once the alias is on the mail domain', async () => {
    const env = makeEnv();
    env.DB.aliases.push({ local_part: 'news', domain: 'example.com', is_enabled: 1, id: 'a1' });

    let rejected: string | null = null as string | null;
    await emailHandler(message('news@example.com', (r) => { rejected = r; }), env).catch(() => {
      // Storage isn't mocked past the lookup; only the accept/reject decision
      // is under test here.
    });

    expect(rejected).toBeNull();
  });
});
