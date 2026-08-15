import { describe, it, expect } from 'bun:test';
import { emailHandler } from '../src/email';

/**
 * Catch-all delivery.
 *
 * Any address on MAIL_DOMAIN is accepted and its alias is created on first
 * delivery, so an address can be invented at signup time without visiting
 * the dashboard first. The guards matter as much as the feature: Email
 * Routing hands the Worker every address a spammer cares to guess, and each
 * one would otherwise become a permanent alias row.
 */

const MAIL_DOMAIN = 'example.com';

/** In-memory aliases table with the UNIQUE(local_part, domain) constraint. */
function makeDb(seed: any[] = []) {
  const aliases = [...seed];
  return {
    aliases,
    prepare(sql: string) {
      return {
        _args: [] as any[],
        bind(...args: any[]) { this._args = args; return this; },
        async run() {
          if (/INSERT INTO aliases/i.test(sql)) {
            const [id, user_id, local_part, domain] = this._args;
            if (aliases.some((a) => a.local_part === local_part && a.domain === domain)) {
              throw new Error('UNIQUE constraint failed: aliases.local_part, aliases.domain');
            }
            aliases.push({
              id, user_id, local_part, domain,
              is_enabled: 1, is_auto: 1,
              created_at: Math.floor(Date.now() / 1000),
            });
          }
          return { success: true };
        },
        async first<T>() {
          if (/COUNT\(\*\) AS n FROM aliases/i.test(sql)) {
            const [since] = this._args;
            return { n: aliases.filter((a) => a.is_auto === 1 && a.created_at > since).length } as T;
          }
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
}

function makeBucket() {
  const objects = new Map<string, unknown>();
  return { objects, async put(k: string, v: unknown) { objects.set(k, v); }, async get() { return null; } };
}

function makeEnv(db = makeDb(), overrides: Record<string, unknown> = {}) {
  return {
    DB: db,
    RAW_BUCKET: makeBucket(),
    ATTACHMENTS_BUCKET: makeBucket(),
    HTML_BUCKET: makeBucket(),
    ADMIN_EMAIL: 'owner@example.com',
    MAIL_DOMAIN,
    ...overrides,
  } as any;
}

/** Deliver one message and report the rejection reason, if any. */
async function deliver(env: any, to: string): Promise<string | null> {
  let rejected: string | null = null as string | null;
  const message = {
    to,
    from: 'sender@elsewhere.com',
    headers: new Headers(),
    raw: new TextEncoder().encode('Subject: hi\r\n\r\nhello').buffer,
    setReject: (r: string) => { rejected = r; },
    forward: async () => {},
    reply: async () => {},
  } as any;
  await emailHandler(message, env);
  return rejected;
}

describe('catch-all', () => {
  it('accepts an address that was never created and materialises the alias', async () => {
    const db = makeDb();
    const env = makeEnv(db);

    expect(await deliver(env, 'netflix@example.com')).toBeNull();

    const created = db.aliases.find((a) => a.local_part === 'netflix');
    expect(created).toBeDefined();
    expect(created.domain).toBe(MAIL_DOMAIN);
    expect(created.is_auto).toBe(1);
    expect(created.user_id).toBe('owner@example.com');
  });

  it('reuses the alias on the second message rather than duplicating it', async () => {
    const db = makeDb();
    const env = makeEnv(db);

    await deliver(env, 'shop@example.com');
    await deliver(env, 'shop@example.com');

    expect(db.aliases.filter((a) => a.local_part === 'shop')).toHaveLength(1);
  });

  it('delivers subaddressed mail to the base alias', async () => {
    const db = makeDb();
    const env = makeEnv(db);

    expect(await deliver(env, 'news+netflix@example.com')).toBeNull();

    // One alias called `news`, not one per tag.
    expect(db.aliases.map((a) => a.local_part)).toEqual(['news']);
  });

  it('still rejects an alias the owner disabled', async () => {
    const db = makeDb([
      { id: 'a1', local_part: 'old', domain: MAIL_DOMAIN, is_enabled: 0, is_auto: 0, created_at: 0 },
    ]);
    const env = makeEnv(db);

    expect(await deliver(env, 'old@example.com')).toBe('Address not found');
    // Not resurrected by the catch-all.
    expect(db.aliases.find((a) => a.local_part === 'old').is_enabled).toBe(0);
  });

  it('rejects addresses on a domain that is not ours', async () => {
    const db = makeDb();
    const env = makeEnv(db);

    expect(await deliver(env, 'anything@somewhere-else.com')).toBe('Address not found');
    expect(db.aliases).toHaveLength(0);
  });

  it('rejects a local part that could never be a valid alias', async () => {
    const db = makeDb();
    const env = makeEnv(db);

    expect(await deliver(env, '"weird name"@example.com')).toBe('Address not found');
    expect(db.aliases).toHaveLength(0);
  });

  it('stops minting aliases past the daily budget, with a retryable reason', async () => {
    const now = Math.floor(Date.now() / 1000);
    const flood = Array.from({ length: 50 }, (_, i) => ({
      id: `a${i}`, local_part: `spam${i}`, domain: MAIL_DOMAIN,
      is_enabled: 1, is_auto: 1, created_at: now,
    }));
    const db = makeDb(flood);
    const env = makeEnv(db);

    const reason = await deliver(env, 'another@example.com');
    // A temporary failure, so a legitimate sender caught in the burst retries
    // instead of losing the message.
    expect(reason).toMatch(/try again later/);
    expect(db.aliases).toHaveLength(50);
  });

  it('does not count aliases the owner created by hand against the budget', async () => {
    const now = Math.floor(Date.now() / 1000);
    const manual = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`, local_part: `manual${i}`, domain: MAIL_DOMAIN,
      is_enabled: 1, is_auto: 0, created_at: now,
    }));
    const db = makeDb(manual);
    const env = makeEnv(db);

    expect(await deliver(env, 'fresh@example.com')).toBeNull();
  });

  it('rejects everything when MAIL_DOMAIN is unset rather than accepting all mail', async () => {
    const db = makeDb();
    const env = makeEnv(db, { MAIL_DOMAIN: undefined });

    expect(await deliver(env, 'anything@example.com')).toBe('Address not found');
    expect(db.aliases).toHaveLength(0);
  });
});
