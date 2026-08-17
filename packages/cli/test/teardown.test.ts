import { describe, it, expect, afterEach } from 'bun:test';
import {
  cfDelete, deleteWorkerScript, deleteD1, deleteR2Bucket, deleteWorkerDomain,
  listWorkerDomains, clearCatchAll, disableEmailRouting,
  catchAllTargets, findAccessApp, deleteAccessApp,
} from '../src/cf';

/**
 * Teardown honesty.
 *
 * `destroy` used to send every DELETE through `fetch(...).catch(() => {})` and
 * print "deleted" unconditionally, so a revoked token, an already-removed
 * resource and a refused bucket all rendered as a clean teardown. These pin
 * the three apart.
 */

const TOKEN = 'test-token';
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Reply with a Cloudflare envelope at the given status. */
function reply(status: number, body: unknown = { success: status < 400, errors: [], result: null }) {
  const calls: { url: string; method?: string; body?: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

describe('cfDelete outcomes', () => {
  it('reports a successful delete', async () => {
    reply(200);
    expect(await cfDelete(TOKEN, '/accounts/a1/workers/scripts/mailriz')).toBe('deleted');
  });

  it('reports a 404 as already absent, not as deleted', async () => {
    // Removed in the dashboard first; "deleted" would misreport what this run did.
    reply(404, { success: false, errors: [{ message: 'workers.api.error.script_not_found' }] });
    expect(await cfDelete(TOKEN, '/accounts/a1/workers/scripts/mailriz')).toBe('absent');
  });

  it('reports a 200-with-not-found as absent', async () => {
    reply(200, { success: false, errors: [{ message: 'Database not found' }] });
    expect(await cfDelete(TOKEN, '/accounts/a1/d1/database/x')).toBe('absent');
  });

  it('throws when the token is revoked', async () => {
    reply(401, { success: false, errors: [{ message: 'Invalid API Token' }] });
    await expect(cfDelete(TOKEN, '/accounts/a1/workers/scripts/mailriz')).rejects.toThrow(/Invalid API Token/);
  });

  it('throws when the token lacks the scope', async () => {
    reply(403, { success: false, errors: [{ message: 'Authentication error' }] });
    await expect(cfDelete(TOKEN, '/accounts/a1/d1/database/x')).rejects.toThrow(/Authentication error/);
  });

  it('accepts a bare null body as a successful delete', async () => {
    // What `DELETE /workers/domains/{id}` actually replies with. It is valid
    // JSON, so it parsed fine and then threw on `body.result`, turning a
    // delete that had succeeded into "custom domain: null is not an object".
    globalThis.fetch = (async () =>
      new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    expect(await deleteWorkerDomain(TOKEN, 'a1', 'dom-1')).toBe('deleted');
  });

  it('accepts an empty body as a successful delete', async () => {
    globalThis.fetch = (async () => new Response('', { status: 204 })) as typeof fetch;
    expect(await deleteWorkerDomain(TOKEN, 'a1', 'dom-1')).toBe('deleted');
  });

  it('throws when Cloudflare refuses a non-empty bucket', async () => {
    reply(400, { success: false, errors: [{ message: 'The bucket you tried to delete is not empty' }] });
    await expect(deleteR2Bucket(TOKEN, 'a1', 'mailriz-raw')).rejects.toThrow(/not empty/);
  });
});

describe('teardown endpoints', () => {
  it('deletes the Worker script with force', async () => {
    const calls = reply(200);
    await deleteWorkerScript(TOKEN, 'a1', 'mailriz');
    expect(calls[0]!.method).toBe('DELETE');
    // Without force the delete is refused while a binding still references it.
    expect(calls[0]!.url).toEndWith('/accounts/a1/workers/scripts/mailriz?force=true');
  });

  it('deletes the D1 database by uuid', async () => {
    const calls = reply(200);
    await deleteD1(TOKEN, 'a1', 'f4ccc0ee-1111');
    expect(calls[0]!.url).toEndWith('/accounts/a1/d1/database/f4ccc0ee-1111');
  });

  it('detaches the custom domain by id', async () => {
    const calls = reply(200);
    await deleteWorkerDomain(TOKEN, 'a1', 'dom-1');
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toEndWith('/accounts/a1/workers/domains/dom-1');
  });

  it('looks the custom domain up by zone and hostname', async () => {
    globalThis.fetch = (async (url: any) => {
      expect(String(url)).toContain('zone_id=z1');
      expect(String(url)).toContain('hostname=inbox.example.com');
      return new Response(
        JSON.stringify({ success: true, result: [{ id: 'dom-1', hostname: 'inbox.example.com', zone_id: 'z1', service: 'mailriz' }] }),
        { status: 200 }
      );
    }) as typeof fetch;
    expect((await listWorkerDomains(TOKEN, 'a1', { zoneId: 'z1', hostname: 'inbox.example.com' }))[0]!.id).toBe('dom-1');
  });

  it('releases the catch-all without deleting the rule', async () => {
    // There is no DELETE for the catch-all — it always exists.
    const calls = reply(200);
    await clearCatchAll(TOKEN, 'z1');
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toEndWith('/zones/z1/email/routing/rules/catch_all');
    expect(calls[0]!.body.enabled).toBe(false);
    expect(calls[0]!.body.actions).toEqual([{ type: 'drop' }]);
  });

  it('disables Email Routing with a POST', async () => {
    const calls = reply(200);
    await disableEmailRouting(TOKEN, 'z1');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toEndWith('/zones/z1/email/routing/disable');
  });

  it('deletes the Access application by id', async () => {
    const calls = reply(200);
    await deleteAccessApp(TOKEN, 'a1', 'app-1');
    expect(calls[0]!.url).toEndWith('/accounts/a1/access/apps/app-1');
  });
});

describe('catchAllTargets', () => {
  const worker = 'mailriz';

  it('is true while the rule still delivers to the Worker', () => {
    expect(catchAllTargets(
      { enabled: true, actions: [{ type: 'worker', value: ['mailriz'] }] }, worker
    )).toBe(true);
  });

  it('is false once the rule is disabled', () => {
    expect(catchAllTargets(
      { enabled: false, actions: [{ type: 'worker', value: ['mailriz'] }] }, worker
    )).toBe(false);
  });

  it('is false when the rule forwards to an address instead', () => {
    expect(catchAllTargets(
      { enabled: true, actions: [{ type: 'forward', value: ['me@example.com'] }] }, worker
    )).toBe(false);
  });

  it('is false for a different Worker', () => {
    expect(catchAllTargets(
      { enabled: true, actions: [{ type: 'worker', value: ['something-else'] }] }, worker
    )).toBe(false);
  });

  it('tolerates a missing rule', () => {
    expect(catchAllTargets(null, worker)).toBe(false);
    expect(catchAllTargets({ enabled: true }, worker)).toBe(false);
  });
});

describe('findAccessApp', () => {
  const apps = [
    { id: 'app-1', aud: 'aud-1', domain: 'other.example.com' },
    { id: 'app-2', aud: 'aud-2', domain: 'inbox.example.com' },
  ];

  it('prefers the recorded aud tag', () => {
    expect(findAccessApp(apps, 'inbox.example.com', 'aud-1')?.id).toBe('app-1');
  });

  it('falls back to the hostname when no aud was recorded', () => {
    expect(findAccessApp(apps, 'inbox.example.com')?.id).toBe('app-2');
  });

  it('falls back to the hostname when the aud no longer matches anything', () => {
    expect(findAccessApp(apps, 'inbox.example.com', 'aud-stale')?.id).toBe('app-2');
  });

  it('ignores a trailing slash on the recorded domain', () => {
    expect(findAccessApp([{ id: 'a', aud: 'x', domain: 'inbox.example.com/' }], 'inbox.example.com')?.id).toBe('a');
  });

  it('returns nothing when the hostname is not guarded', () => {
    expect(findAccessApp(apps, 'nope.example.com')).toBeUndefined();
  });
});
