import { describe, it, expect, afterEach } from 'bun:test';
import {
  takeInventory, leftovers, routingChoice, describeBucket, bucketsOf,
  destroySummary, UNREADABLE,
  type InstallRef, type Inventory, type TeardownResult,
} from '../src/teardown';
import type { R2Client } from '../src/r2';

/**
 * Reading the installation before tearing it down. The reported bug was that
 * `destroy` never asked Cloudflare anything — it replayed config.json. These
 * pin the opposite: the summary comes from the account, not the file.
 */

const CFG: InstallRef = {
  account_id: 'acct1',
  zone_id: 'zone1',
  zone_name: 'example.com',
  worker_name: 'mailriz',
  dashboard_hostname: 'inbox.example.com',
  d1_database_id: 'f4ccc0ee-1111',
  r2_raw_bucket: 'mailriz-raw',
  r2_attachments_bucket: 'mailriz-attachments',
  r2_html_bucket: 'mailriz-html',
  auth_mode: 'access',
  access_aud: 'aud-1',
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

interface Account {
  scripts?: string[];
  domains?: { id: string; hostname: string }[];
  d1?: string[];
  buckets?: string[];
  accessApps?: { id: string; aud: string; domain: string }[];
  routingEnabled?: boolean;
  catchAllWorker?: string | null;
  /** Paths matching this fragment answer with the given status. */
  deny?: { match: string; status: number; message: string };
}

/** Serve a Cloudflare account out of a plain object. */
function serve(account: Account) {
  const ok = (result: unknown) =>
    new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });

  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (account.deny && u.includes(account.deny.match)) {
      return new Response(
        JSON.stringify({ success: false, errors: [{ message: account.deny.message }] }),
        { status: account.deny.status }
      );
    }
    if (u.includes('/workers/scripts')) return ok((account.scripts ?? []).map((id) => ({ id })));
    if (u.includes('/workers/domains')) return ok(account.domains ?? []);
    if (u.includes('/d1/database')) return ok((account.d1 ?? []).map((uuid) => ({ uuid, name: 'mailriz' })));
    if (u.includes('/r2/buckets')) return ok({ buckets: (account.buckets ?? []).map((name) => ({ name })) });
    if (u.includes('/access/apps')) return ok(account.accessApps ?? []);
    if (u.includes('/email/routing/rules/catch_all')) {
      return ok(
        account.catchAllWorker
          ? { enabled: true, actions: [{ type: 'worker', value: [account.catchAllWorker] }] }
          : { enabled: false, actions: [{ type: 'drop' }] }
      );
    }
    if (u.includes('/email/routing')) return ok({ enabled: account.routingEnabled ?? false, id: 'r1' });
    throw new Error(`unexpected request: ${u}`);
  }) as typeof fetch;
}

/** An R2 client over fixed bucket contents. */
function r2With(contents: Record<string, string[]>, failing: string[] = []): R2Client {
  return {
    async listObjects(bucket) {
      if (failing.includes(bucket)) throw new Error('AccessDenied: no object read scope');
      const keys = contents[bucket] ?? [];
      return { keys: keys.slice(0, 1000), truncated: keys.length > 1000 };
    },
    async deleteObject() {},
  };
}

const FULL: Account = {
  scripts: ['mailriz', 'something-else'],
  domains: [{ id: 'dom-1', hostname: 'inbox.example.com' }],
  d1: ['f4ccc0ee-1111'],
  buckets: ['mailriz-raw', 'mailriz-attachments', 'mailriz-html'],
  accessApps: [{ id: 'app-1', aud: 'aud-1', domain: 'inbox.example.com' }],
  routingEnabled: true,
  catchAllWorker: 'mailriz',
};

describe('takeInventory', () => {
  it('finds a fully deployed installation', async () => {
    serve(FULL);
    const inv = await takeInventory(CFG, 't', r2With({ 'mailriz-raw': ['a.eml', 'b.eml'] }), () => {});

    expect(inv.workerExists).toBe(true);
    expect(inv.domains).toEqual([{ id: 'dom-1', hostname: 'inbox.example.com' }]);
    expect(inv.d1Exists).toBe(true);
    expect(inv.buckets.get('mailriz-raw')).toBe(2);
    expect(inv.buckets.get('mailriz-html')).toBe(0);
    expect(inv.accessAppId).toBe('app-1');
    expect(inv.routingEnabled).toBe(true);
    expect(inv.catchAllPointsAtWorker).toBe(true);
  });

  it('sees a Worker that was deleted by hand', async () => {
    serve({ ...FULL, scripts: ['something-else'] });
    const inv = await takeInventory(CFG, 't', r2With({}), () => {});
    expect(inv.workerExists).toBe(false);
    // Everything else is still there and must still be torn down.
    expect(inv.d1Exists).toBe(true);
    expect(inv.buckets.get('mailriz-raw')).toBe(0);
  });

  it('reports buckets that are already gone as null, not as empty', async () => {
    // The two lead to different teardown steps.
    serve({ ...FULL, buckets: ['mailriz-raw'] });
    const inv = await takeInventory(CFG, 't', r2With({ 'mailriz-raw': ['a.eml'] }), () => {});
    expect(inv.buckets.get('mailriz-raw')).toBe(1);
    expect(inv.buckets.get('mailriz-attachments')).toBeNull();
    expect(inv.buckets.get('mailriz-html')).toBeNull();
  });

  it('flags a bucket holding more than one listing', async () => {
    serve(FULL);
    const many = Array.from({ length: 1500 }, (_, i) => `m${i}`);
    const inv = await takeInventory(CFG, 't', r2With({ 'mailriz-raw': many }), () => {});
    expect(inv.bucketsTruncated.has('mailriz-raw')).toBe(true);
    expect(describeBucket(inv.buckets.get('mailriz-raw'), true)).toBe('1000+ objects');
  });

  it('marks contents unreadable rather than empty when R2 refuses', async () => {
    // "empty" would tell the operator there is no mail to lose, on a bucket
    // whose contents were never seen.
    serve(FULL);
    const warnings: string[] = [];
    const inv = await takeInventory(CFG, 't', r2With({}, ['mailriz-raw']), (m) => warnings.push(m));
    expect(inv.buckets.get('mailriz-raw')).toBe(UNREADABLE);
    expect(warnings.join()).toMatch(/cannot read mailriz-raw.*AccessDenied/);
  });

  it('marks every bucket unreadable when there is no R2 client at all', async () => {
    serve(FULL);
    const inv = await takeInventory(CFG, 't', null, () => {});
    for (const name of bucketsOf(CFG)) expect(inv.buckets.get(name)).toBe(UNREADABLE);
  });

  it('warns but continues when the custom domain cannot be listed', async () => {
    serve({ ...FULL, deny: { match: '/workers/domains', status: 403, message: 'Authentication error' } });
    const warnings: string[] = [];
    const inv = await takeInventory(CFG, 't', r2With({}), (m) => warnings.push(m));
    expect(inv.domains).toEqual([]);
    expect(warnings.join()).toMatch(/custom domain lookup failed.*Authentication error/);
    // An empty list here means "not read", not "not there".
    expect(inv.unreadable).toContain('custom domain');
    expect(inv.workerExists).toBe(true);
  });

  it('records an unreadable Email Routing state instead of calling it off', async () => {
    // A denied lookup leaves routingEnabled false, which reads identically to
    // routing genuinely being off.
    serve({ ...FULL, deny: { match: '/email/routing', status: 403, message: 'Authentication error' } });
    const inv = await takeInventory(CFG, 't', r2With({}), () => {});
    expect(inv.routingEnabled).toBe(false);
    expect(inv.unreadable).toContain('email routing');
  });

  it('records an unreadable Access application', async () => {
    serve({ ...FULL, deny: { match: '/access/apps', status: 403, message: 'Authentication error' } });
    const inv = await takeInventory(CFG, 't', r2With({}), () => {});
    expect(inv.accessAppId).toBeUndefined();
    expect(inv.unreadable).toContain('access application');
  });

  it('reads everything cleanly when nothing is denied', async () => {
    serve(FULL);
    const inv = await takeInventory(CFG, 't', r2With({}), () => {});
    expect(inv.unreadable).toEqual([]);
  });

  it('throws when Workers cannot be listed at all', async () => {
    // A revoked token must stop the run, not produce an empty inventory that
    // reads as "nothing to delete".
    serve({ ...FULL, deny: { match: '/workers/scripts', status: 401, message: 'Invalid API Token' } });
    await expect(takeInventory(CFG, 't', r2With({}), () => {})).rejects.toThrow(/could not list Workers/);
  });

  it('throws when D1 cannot be listed', async () => {
    serve({ ...FULL, deny: { match: '/d1/database', status: 403, message: 'Authentication error' } });
    await expect(takeInventory(CFG, 't', r2With({}), () => {})).rejects.toThrow(/could not list D1/);
  });

  it('skips the Access lookup for password installs', async () => {
    serve({ ...FULL, accessApps: [{ id: 'app-1', aud: 'aud-1', domain: 'inbox.example.com' }] });
    const inv = await takeInventory({ ...CFG, auth_mode: 'session' }, 't', r2With({}), () => {});
    expect(inv.accessAppId).toBeUndefined();
  });

  it('does not look at the catch-all when routing is off', async () => {
    serve({ ...FULL, routingEnabled: false, catchAllWorker: 'mailriz' });
    const inv = await takeInventory(CFG, 't', r2With({}), () => {});
    expect(inv.routingEnabled).toBe(false);
    expect(inv.catchAllPointsAtWorker).toBe(false);
  });

  it('notices a catch-all pointing somewhere else', async () => {
    serve({ ...FULL, catchAllWorker: 'a-different-worker' });
    const inv = await takeInventory(CFG, 't', r2With({}), () => {});
    expect(inv.catchAllPointsAtWorker).toBe(false);
  });
});

describe('leftovers', () => {
  const clean: Inventory = {
    workerExists: false,
    domains: [],
    d1Exists: false,
    buckets: new Map([['mailriz-raw', null], ['mailriz-attachments', null], ['mailriz-html', null]]),
    bucketsTruncated: new Set(),
    routingEnabled: false,
    catchAllPointsAtWorker: false,
    unreadable: [],
  };

  it('is empty when the account really is clean', () => {
    expect(leftovers(clean, CFG)).toEqual([]);
  });

  it('refuses to call an unverified aspect clean', () => {
    expect(leftovers({ ...clean, unreadable: ['email routing'] }, CFG))
      .toEqual(['could not verify email routing']);
  });

  it('names a Worker that survived the delete', () => {
    expect(leftovers({ ...clean, workerExists: true }, CFG)).toEqual(['worker mailriz']);
  });

  it('names a bucket Cloudflare refused to drop', () => {
    const inv = { ...clean, buckets: new Map([['mailriz-raw', 12], ['mailriz-html', null]]) };
    expect(leftovers(inv as Inventory, CFG)).toEqual(['bucket mailriz-raw']);
  });

  it('names a catch-all still aimed at the deleted Worker', () => {
    expect(leftovers({ ...clean, catchAllPointsAtWorker: true }, CFG))
      .toEqual(['catch-all still points at the Worker']);
  });

  it('names the DNS record and the Access application', () => {
    const inv = { ...clean, domains: [{ id: 'd', hostname: 'inbox.example.com' }], accessAppId: 'app-1' };
    expect(leftovers(inv, CFG)).toEqual(['custom domain inbox.example.com', 'access application']);
  });
});

describe('routingChoice', () => {
  it('disables routing that setup turned on', () => {
    expect(routingChoice(true, true)).toBe('disable');
  });

  it('keeps routing the zone already had', () => {
    // Disabling would strip MX, SPF and DKIM the zone had before MailRiz.
    expect(routingChoice(true, false)).toBe('keep');
  });

  it('asks when the installation predates the flag', () => {
    expect(routingChoice(true, undefined)).toBe('ask');
  });

  it('has nothing to do when routing is already off', () => {
    expect(routingChoice(false, true)).toBe('keep');
    expect(routingChoice(false, undefined)).toBe('keep');
  });
});

describe('destroySummary', () => {
  const full: TeardownResult = {
    hostname: 'inbox.example.com',
    zoneName: 'example.com',
    purged: 2,
    bucketsRemoved: 3,
    workerWasPresent: true,
    domainWasPresent: true,
    d1WasPresent: true,
    routingWasEnabled: true,
    routingDisabled: true,
    catchAllWasPointing: true,
  };
  const asMap = (r: TeardownResult) => Object.fromEntries(destroySummary(r));

  it('describes a run that deleted a live installation', () => {
    expect(asMap(full)).toEqual({
      worker: 'deleted',
      dns: 'inbox.example.com removed',
      d1: 'deleted',
      r2: '3 buckets deleted · 2 objects erased',
      'email routing': 'disabled on example.com · MX and SPF removed',
    });
  });

  it('does not claim deletions on a second run over an empty account', () => {
    // The shipped bug: this summary was hardcoded, so a teardown that found
    // everything already gone still reported "deleted" and "routing left on"
    // for a zone whose routing had been switched off by the previous run.
    expect(asMap({
      ...full,
      purged: 0,
      bucketsRemoved: 0,
      workerWasPresent: false,
      domainWasPresent: false,
      d1WasPresent: false,
      routingWasEnabled: false,
      routingDisabled: false,
      catchAllWasPointing: false,
    })).toEqual({
      worker: 'was already gone',
      dns: 'no custom domain to remove',
      d1: 'was already gone',
      r2: 'buckets already gone · no objects to erase',
      'email routing': 'was already off',
    });
  });

  it('says routing stayed on when it was left alone', () => {
    const s = asMap({ ...full, routingDisabled: false });
    expect(s['email routing']).toBe('catch-all released · routing left on');
  });

  it('distinguishes a catch-all that never pointed here', () => {
    const s = asMap({ ...full, routingDisabled: false, catchAllWasPointing: false });
    expect(s['email routing']).toBe('nothing pointed here · routing left on');
  });

  it('singularises one bucket and one object', () => {
    expect(asMap({ ...full, purged: 1, bucketsRemoved: 1 })['r2'])
      .toBe('1 bucket deleted · 1 object erased');
  });
});

describe('describeBucket', () => {
  it('distinguishes gone, empty, counted and unreadable', () => {
    expect(describeBucket(null, false)).toBe('already gone');
    expect(describeBucket(undefined, false)).toBe('already gone');
    expect(describeBucket(0, false)).toBe('empty');
    expect(describeBucket(1, false)).toBe('1 object');
    expect(describeBucket(42, false)).toBe('42 objects');
    expect(describeBucket(1000, true)).toBe('1000+ objects');
    expect(describeBucket(UNREADABLE, false)).toBe('present · contents unreadable');
  });
});
