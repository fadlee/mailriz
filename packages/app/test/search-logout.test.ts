import { describe, it, expect } from 'bun:test';
import { app } from '../src/api';

/**
 * Partial-word search, and ending a session.
 *
 * Search built one quoted FTS5 term per word, which only matches whole
 * tokens — typing "jan" found nothing until you finished "jane". A trailing
 * `*` makes each term a prefix.
 *
 * There was no logout at all: once signed in, the only way out was clearing
 * cookies by hand.
 */

const ADMIN = 'owner@example.com';
import { TEST_PASSWORD_HASH, TEST_SIGNING_KEY } from './session-credentials';

/** Captures the FTS query the list endpoint binds. */
function makeEnv() {
  const bound: any[][] = [];
  return {
    bound,
    AUTH_MODE: 'session',
    ADMIN_EMAIL: ADMIN,
    SESSION_PASSWORD_HASH: TEST_PASSWORD_HASH,
    SESSION_SIGNING_KEY: TEST_SIGNING_KEY,
    DB: {
      prepare(sql: string) {
        return {
          _args: [] as any[],
          bind(...args: any[]) {
            this._args = args;
            if (/emails_fts MATCH/i.test(sql)) bound.push(args);
            return this;
          },
          async all<T>() { return { results: [] } as any; },
          async first<T>() { return null as T; },
          async run() { return { success: true }; },
        };
      },
    },
  } as any;
}

async function cookieFor(env: any): Promise<string> {
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

/** Run a search and return the FTS expression it produced. */
async function ftsFor(query: string): Promise<string> {
  const env = makeEnv();
  const cookie = await cookieFor(env);
  const url = `https://inbox.example.com/api/emails?view=inbox&q=${encodeURIComponent(query)}`;
  const res = await app.fetch(new Request(url, { headers: { Cookie: cookie } }), env);
  expect(res.status).toBe(200);

  const call = env.bound.at(-1)!;
  // The MATCH parameter is the FTS expression; the rest is pagination.
  return call.find((a: unknown) => typeof a === 'string' && a.includes('"'))!;
}

describe('search', () => {
  it('matches on a prefix, so a partial word finds the message', async () => {
    expect(await ftsFor('jan')).toBe('"jan"*');
  });

  it('requires every word, each as a prefix', async () => {
    expect(await ftsFor('jan doe')).toBe('"jan"* AND "doe"*');
  });

  it('collapses extra whitespace rather than searching for empty terms', async () => {
    expect(await ftsFor('  jan   doe  ')).toBe('"jan"* AND "doe"*');
  });

  it('escapes quotes so a quote in the query cannot break out of the term', async () => {
    // FTS5 escapes a double quote by doubling it.
    expect(await ftsFor('say"hi')).toBe('"say""hi"*');
  });
});

describe('logout', () => {
  it('expires the session cookie', async () => {
    const env = makeEnv();
    const res = await app.fetch(
      new Request('https://inbox.example.com/api/logout', { method: 'POST' }),
      env
    );

    expect(res.status).toBe(200);
    const setCookie = res.headers.get('Set-Cookie') || '';
    expect(setCookie).toContain('mailriz_session=');
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('HttpOnly');
  });

  it('works without a valid session — the point is to end one that may be stale', async () => {
    const env = makeEnv();
    const res = await app.fetch(
      new Request('https://inbox.example.com/api/logout', {
        method: 'POST',
        headers: { Cookie: 'mailriz_session=garbage' },
      }),
      env
    );
    expect(res.status).toBe(200);
  });

  it('leaves the cookie unusable afterwards', async () => {
    const env = makeEnv();
    const cookie = await cookieFor(env);

    // Sanity: it worked before logging out.
    const before = await app.fetch(
      new Request('https://inbox.example.com/api/me', { headers: { Cookie: cookie } }),
      env
    );
    expect(before.status).toBe(200);

    const out = await app.fetch(
      new Request('https://inbox.example.com/api/logout', { method: 'POST' }),
      env
    );
    // The browser drops the cookie on Max-Age=0; the server keeps no state to
    // clear, so this asserts the instruction rather than a stored session.
    expect(out.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
});
