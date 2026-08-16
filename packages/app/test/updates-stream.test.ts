import { describe, it, expect } from 'bun:test';
import { app } from '../src/api';

/**
 * Live new-mail notifications over SSE.
 *
 * The Worker holding the stream is not the one that received the mail, so
 * arrival is detected by polling one indexed row rather than being pushed.
 * The stream reports only *that* something changed — the client reloads
 * through the normal list query, which already knows the active folder,
 * alias, label and search.
 */

const ADMIN = 'owner@example.com';
import { TEST_PASSWORD_HASH, TEST_SIGNING_KEY } from './session-credentials';

interface Row {
  id: string;
  received_at: number;
}

/**
 * Serves a scripted sequence of "newest message" rows, one per poll, so a
 * test can make mail arrive at a chosen moment.
 */
function makeEnv(sequence: (Row | null)[]) {
  let polls = 0;
  return {
    get polls() {
      return polls;
    },
    AUTH_MODE: 'session',
    ADMIN_EMAIL: ADMIN,
    SESSION_PASSWORD_HASH: TEST_PASSWORD_HASH,
    SESSION_SIGNING_KEY: TEST_SIGNING_KEY,
    // Real timings are seconds and minutes; these keep the suite quick while
    // exercising the same loop.
    UPDATES_POLL_MS: '15',
    UPDATES_PING_MS: '40',
    UPDATES_CONNECTION_MS: '400',
    DB: {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async first<T>() {
            if (/FROM emails/i.test(sql)) {
              const row = sequence[Math.min(polls, sequence.length - 1)] ?? null;
              polls++;
              return row as T;
            }
            return null as T;
          },
          async all() { return { results: [] } as any; },
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

function open(env: any, cookie: string, lastEventId?: string) {
  const headers: Record<string, string> = { Cookie: cookie, Accept: 'text/event-stream' };
  if (lastEventId) headers['Last-Event-ID'] = lastEventId;
  return app.fetch(new Request('https://inbox.example.com/api/updates/stream', { headers }), env);
}

/** Drain the stream to completion; connections are short-lived in tests. */
async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

describe('stream headers', () => {
  it('is an unbuffered, uncached event stream', async () => {
    const env = makeEnv([{ id: 'a', received_at: 100 }]);
    const res = await open(env, await cookieFor(env));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    expect(res.headers.get('Cache-Control')).toContain('no-cache');
    // Buffering here would hold events until the connection ended.
    expect(res.headers.get('X-Accel-Buffering')).toBe('no');

    await res.body!.cancel();
  });

  it('requires authentication like every other /api route', async () => {
    const env = makeEnv([null]);
    const res = await app.fetch(
      new Request('https://inbox.example.com/api/updates/stream'),
      env
    );
    expect(res.status).toBe(401);
  });

  it('tells the browser how soon to reconnect', async () => {
    const env = makeEnv([{ id: 'a', received_at: 100 }]);
    const res = await open(env, await cookieFor(env));
    expect(await readAll(res)).toContain('retry:');
  });
});

describe('change detection', () => {
  it('stays quiet while nothing arrives', async () => {
    // Same row on every poll.
    const env = makeEnv([{ id: 'a', received_at: 100 }]);
    const res = await open(env, await cookieFor(env));

    const text = await readAll(res);
    expect(text).not.toContain('event: mail');
  });

  it('emits one event when a newer message appears', async () => {
    const env = makeEnv([
      { id: 'a', received_at: 100 }, // baseline
      { id: 'a', received_at: 100 },
      { id: 'b', received_at: 200 }, // arrival
    ]);
    const res = await open(env, await cookieFor(env));

    const text = await readAll(res);
    expect(text).toContain('event: mail');
    expect(text).toContain('"latest":"200_b"');
  });

  it('carries the cursor as the event id, so a reconnect can resume', async () => {
    const env = makeEnv([
      { id: 'a', received_at: 100 },
      { id: 'b', received_at: 200 },
    ]);
    const res = await open(env, await cookieFor(env));

    expect(await readAll(res)).toContain('id: 200_b');
  });

  it('treats two messages in the same second as distinct', async () => {
    // received_at alone would look unchanged here; the id disambiguates.
    const env = makeEnv([
      { id: 'a', received_at: 100 },
      { id: 'b', received_at: 100 },
    ]);
    const res = await open(env, await cookieFor(env));

    expect(await readAll(res)).toContain('"latest":"100_b"');
  });
});

describe('resuming after a reconnect', () => {
  it('uses Last-Event-ID as the baseline, so mail in the gap is not missed', async () => {
    // The newest row already differs from what the client last saw, which is
    // exactly the state after mail lands between two connections.
    const env = makeEnv([{ id: 'b', received_at: 200 }]);
    const res = await open(env, await cookieFor(env), '100_a');

    const text = await readAll(res);
    expect(text).toContain('event: mail');
    expect(text).toContain('"latest":"200_b"');
  });

  it('says nothing when the client is already up to date', async () => {
    const env = makeEnv([{ id: 'b', received_at: 200 }]);
    const res = await open(env, await cookieFor(env), '200_b');

    expect(await readAll(res)).not.toContain('event: mail');
  });
});

describe('an empty mailbox', () => {
  it('opens without error and reports the first arrival', async () => {
    const env = makeEnv([null, null, { id: 'a', received_at: 100 }]);
    const res = await open(env, await cookieFor(env));

    expect(await readAll(res)).toContain('"latest":"100_a"');
  });
});
