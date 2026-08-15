import { describe, it, expect, afterEach } from 'bun:test';
import {
  listAccounts, listZones, listD1, createD1, listR2Buckets, createR2Bucket,
  setCatchAllToWorker, createAccessApp,
} from '../src/cf';

/**
 * Response-shape handling for the Cloudflare client.
 *
 * Two shipped bugs came from assuming every endpoint looks the same:
 *  - D1 returns the identifier as `uuid`, not `id`, so the database id
 *    reached the query URL and the wrangler binding as `undefined`.
 *  - R2 nests its list under `result.buckets` while D1 and zones return a
 *    bare array, which blew up as "r2s.find is not a function".
 *
 * These pin both shapes, and the failure modes around them.
 */

const TOKEN = 'test-token';
const realFetch = globalThis.fetch;

/** Reply to every request with this `result` payload. */
function mockResult(result: unknown, ok = true) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ success: ok, errors: [], result }), {
      status: ok ? 200 : 400,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('list shapes', () => {
  it('reads a bare array (accounts, zones, D1)', async () => {
    mockResult([{ id: 'a1', name: 'Acme' }]);
    expect(await listAccounts(TOKEN)).toEqual([{ id: 'a1', name: 'Acme' }] as any);

    mockResult([{ id: 'z1', name: 'example.com', status: 'active' }]);
    expect((await listZones(TOKEN, 'a1'))[0]!.name).toBe('example.com');

    mockResult([{ uuid: 'd1-uuid', name: 'mailriz' }]);
    expect((await listD1(TOKEN, 'a1'))[0]!.uuid).toBe('d1-uuid');
  });

  it('unwraps the R2 list from result.buckets', async () => {
    mockResult({ buckets: [{ name: 'mailriz-raw' }, { name: 'mailriz-html' }] });
    const buckets = await listR2Buckets(TOKEN, 'a1');
    expect(buckets.map((b) => b.name)).toEqual(['mailriz-raw', 'mailriz-html']);
    // The wizard calls .find on this — a non-array would throw here.
    expect(buckets.find((b) => b.name === 'mailriz-raw')).toBeDefined();
  });

  it('still accepts a bare array from R2, in case the shape changes back', async () => {
    mockResult([{ name: 'mailriz-raw' }]);
    expect((await listR2Buckets(TOKEN, 'a1')).map((b) => b.name)).toEqual(['mailriz-raw']);
  });

  it('treats a null result as an empty list', async () => {
    mockResult(null);
    expect(await listR2Buckets(TOKEN, 'a1')).toEqual([]);
    mockResult(null);
    expect(await listD1(TOKEN, 'a1')).toEqual([]);
  });

  it('reports the payload when the result is neither shape', async () => {
    mockResult({ unexpected: true });
    await expect(listR2Buckets(TOKEN, 'a1')).rejects.toThrow(/expected a list.*unexpected/s);
  });
});

describe('D1 identifier', () => {
  it('keeps `uuid` from create', async () => {
    mockResult({ uuid: 'f4ccc0ee-1111', name: 'mailriz' });
    expect((await createD1(TOKEN, 'a1', 'mailriz')).uuid).toBe('f4ccc0ee-1111');
  });

  it('fails loudly when create returns no uuid', async () => {
    // What the API would look like if it went back to `id` — previously this
    // sailed through and surfaced as `undefined` in the D1 binding.
    mockResult({ id: 'f4ccc0ee', name: 'mailriz' });
    await expect(createD1(TOKEN, 'a1', 'mailriz')).rejects.toThrow(/no database uuid/);
  });
});

describe('email routing catch-all', () => {
  it('PUTs to the catch_all path with an all-matcher and worker action', async () => {
    let seen: { url: string; method?: string; body?: any } = { url: '' };
    globalThis.fetch = (async (url: any, init: any) => {
      seen = { url: String(url), method: init?.method, body: JSON.parse(init?.body || '{}') };
      return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
    }) as typeof fetch;

    await setCatchAllToWorker(TOKEN, 'zone1', 'mailriz');

    // Posting an all-matcher to /rules is what returned "Invalid rule
    // operation" — the catch-all has its own path and verb.
    expect(seen.url).toEndWith('/zones/zone1/email/routing/rules/catch_all');
    expect(seen.method).toBe('PUT');
    expect(seen.body.matchers).toEqual([{ type: 'all' }]);
    expect(seen.body.actions).toEqual([{ type: 'worker', value: ['mailriz'] }]);
    expect(seen.body.enabled).toBe(true);
  });
});

describe('access application', () => {
  it('returns the aud tag from create', async () => {
    mockResult({ id: 'app1', aud: 'aud-tag-1' });
    expect(await createAccessApp(TOKEN, 'a1', 'mailriz', 'inbox.example.com')).toEqual({
      id: 'app1',
      aud: 'aud-tag-1',
    } as any);
  });

  it('reads the app back when create omits the aud', async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      const result = call === 1 ? { id: 'app1' } : { id: 'app1', aud: 'aud-tag-2' };
      return new Response(JSON.stringify({ success: true, result }), { status: 200 });
    }) as typeof fetch;

    // An empty aud would deploy a Worker that rejects every request, so it is
    // fetched rather than accepted as blank.
    expect((await createAccessApp(TOKEN, 'a1', 'mailriz', 'inbox.example.com')).aud).toBe('aud-tag-2');
    expect(call).toBe(2);
  });

  it('throws when no aud can be obtained at all', async () => {
    mockResult({ id: 'app1' });
    await expect(createAccessApp(TOKEN, 'a1', 'mailriz', 'inbox.example.com')).rejects.toThrow(/aud/);
  });
});

describe('R2 create', () => {
  it('returns the created bucket name', async () => {
    mockResult({ name: 'mailriz-raw', location: 'apac' });
    expect((await createR2Bucket(TOKEN, 'a1', 'mailriz-raw')).name).toBe('mailriz-raw');
  });

  it('falls back to the requested name when the payload omits it', async () => {
    mockResult({});
    expect((await createR2Bucket(TOKEN, 'a1', 'mailriz-html')).name).toBe('mailriz-html');
  });
});
