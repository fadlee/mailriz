/**
 * Reading what a MailRiz installation actually looks like on Cloudflare.
 *
 * Outside cli.ts on purpose: that module dispatches a command on import, so
 * nothing in it can be pulled into a test — and the teardown is precisely the
 * code that must not be taken on trust.
 */

import {
  listWorkerScripts, listWorkerDomains, listD1, listR2Buckets,
  listAccessApps, findAccessApp, getEmailRoutingSettings, getCatchAllRule,
  catchAllTargets,
} from './cf';
import type { R2Client } from './r2';

/** The parts of the installation record a teardown needs. */
export interface InstallRef {
  account_id: string;
  zone_id: string;
  zone_name: string;
  worker_name: string;
  dashboard_hostname: string;
  d1_database_id: string;
  r2_raw_bucket: string;
  r2_attachments_bucket: string;
  r2_html_bucket: string;
  auth_mode: 'access' | 'session';
  access_aud?: string;
}

/** Bucket contents could not be listed, so their size is unknown. */
export const UNREADABLE = -1;

export interface Inventory {
  workerExists: boolean;
  domains: { id: string; hostname: string }[];
  d1Exists: boolean;
  /** name → object count, `null` when the bucket itself is gone. */
  buckets: Map<string, number | null>;
  /** Buckets holding more objects than one listing returned. */
  bucketsTruncated: Set<string>;
  accessAppId?: string;
  routingEnabled: boolean;
  catchAllPointsAtWorker: boolean;
  /**
   * Aspects that could not be read at all. A failed lookup leaves its field
   * at the empty default, which is indistinguishable from "nothing there";
   * naming the gap keeps it out of the success path.
   */
  unreadable: string[];
}

/** Buckets in the order the summary and the teardown walk them. */
export function bucketsOf(cfg: InstallRef): string[] {
  return [cfg.r2_raw_bucket, cfg.r2_attachments_bucket, cfg.r2_html_bucket];
}

/**
 * What is on Cloudflare right now, read before anything is deleted: config
 * .json describes what setup *made*, not what survives.
 *
 * `warn` collects lookups that failed without being fatal. Failures that
 * would make the whole report meaningless — Workers and D1 — throw instead.
 */
export async function takeInventory(
  cfg: InstallRef,
  token: string,
  r2: R2Client | null,
  warn: (msg: string) => void
): Promise<Inventory> {
  const inv: Inventory = {
    workerExists: false,
    domains: [],
    d1Exists: false,
    buckets: new Map(),
    bucketsTruncated: new Set(),
    routingEnabled: false,
    catchAllPointsAtWorker: false,
    unreadable: [],
  };

  try {
    const scripts = await listWorkerScripts(token, cfg.account_id);
    inv.workerExists = scripts.some((s) => s.id === cfg.worker_name);
  } catch (e: any) {
    throw new Error(`could not list Workers: ${e.message}`);
  }

  try {
    const domains = await listWorkerDomains(token, cfg.account_id, {
      zoneId: cfg.zone_id,
      hostname: cfg.dashboard_hostname,
    });
    inv.domains = domains.map((d) => ({ id: d.id, hostname: d.hostname }));
  } catch (e: any) {
    warn(`custom domain lookup failed: ${e.message}`);
    inv.unreadable.push('custom domain');
  }

  try {
    const dbs = await listD1(token, cfg.account_id);
    inv.d1Exists = dbs.some((d) => d.uuid === cfg.d1_database_id);
  } catch (e: any) {
    throw new Error(`could not list D1 databases: ${e.message}`);
  }

  const live = await listR2Buckets(token, cfg.account_id);
  for (const name of bucketsOf(cfg)) {
    if (!live.some((b) => b.name === name)) {
      inv.buckets.set(name, null);
      continue;
    }
    if (!r2) {
      inv.buckets.set(name, UNREADABLE);
      continue;
    }
    try {
      const page = await r2.listObjects(name);
      inv.buckets.set(name, page.keys.length);
      if (page.truncated) inv.bucketsTruncated.add(name);
    } catch (e: any) {
      // Contents that cannot be read cannot be deleted either, and the bucket
      // delete will then be refused.
      warn(`cannot read ${name}: ${e.message}`);
      inv.buckets.set(name, UNREADABLE);
    }
  }

  if (cfg.auth_mode === 'access') {
    try {
      const apps = await listAccessApps(token, cfg.account_id);
      inv.accessAppId = findAccessApp(apps, cfg.dashboard_hostname, cfg.access_aud)?.id;
    } catch (e: any) {
      warn(`access application lookup failed: ${e.message}`);
      inv.unreadable.push('access application');
    }
  }

  try {
    inv.routingEnabled = (await getEmailRoutingSettings(token, cfg.zone_id)).enabled;
    if (inv.routingEnabled) {
      inv.catchAllPointsAtWorker = catchAllTargets(
        await getCatchAllRule(token, cfg.zone_id),
        cfg.worker_name
      );
    }
  } catch (e: any) {
    warn(`email routing lookup failed: ${e.message}`);
    inv.unreadable.push('email routing');
  }

  return inv;
}

/** How a bucket's contents read in the confirmation summary. */
export function describeBucket(count: number | null | undefined, truncated: boolean): string {
  if (count === null || count === undefined) return 'already gone';
  if (count === UNREADABLE) return 'present · contents unreadable';
  if (count === 0) return 'empty';
  return truncated ? `${count}+ objects` : `${count} object${count === 1 ? '' : 's'}`;
}

/**
 * Everything an inventory taken *after* the teardown says is still there.
 * Non-empty is what keeps config.json on disk, so the leftovers stay findable.
 */
export function leftovers(inv: Inventory, cfg: InstallRef): string[] {
  const out: string[] = [];
  if (inv.workerExists) out.push(`worker ${cfg.worker_name}`);
  if (inv.domains.length) out.push(`custom domain ${cfg.dashboard_hostname}`);
  if (inv.d1Exists) out.push(`d1 ${cfg.d1_database_id.slice(0, 8)}`);
  for (const [name, count] of inv.buckets) if (count !== null) out.push(`bucket ${name}`);
  if (inv.accessAppId) out.push('access application');
  if (inv.catchAllPointsAtWorker) out.push('catch-all still points at the Worker');
  // An unread aspect is not an absent one.
  for (const what of inv.unreadable) out.push(`could not verify ${what}`);
  return out;
}

/**
 * Whether disabling Email Routing is ours to do. `undefined` means the
 * installation predates the flag, and neither answer is safe to assume.
 */
export type RoutingChoice = 'disable' | 'keep' | 'ask';

export interface TeardownResult {
  hostname: string;
  zoneName: string;
  /** Objects deleted from R2 by this run. */
  purged: number;
  /** Buckets this run deleted. */
  bucketsRemoved: number;
  workerWasPresent: boolean;
  domainWasPresent: boolean;
  d1WasPresent: boolean;
  routingWasEnabled: boolean;
  routingDisabled: boolean;
  catchAllWasPointing: boolean;
}

/**
 * The closing summary, describing what this run did rather than what a
 * teardown does in general — a second run over an account that is already
 * empty deletes nothing, and saying "deleted" there is exactly the kind of
 * claim the rest of destroy stopped making.
 *
 * Every line is reached only after verification found the account clean, so
 * "gone" is always true; what varies is who made it so.
 */
export function destroySummary(r: TeardownResult): [string, string][] {
  const buckets =
    r.bucketsRemoved > 0
      ? `${r.bucketsRemoved} bucket${r.bucketsRemoved === 1 ? '' : 's'} deleted`
      : 'buckets already gone';
  const objects =
    r.purged > 0 ? `${r.purged} object${r.purged === 1 ? '' : 's'} erased` : 'no objects to erase';

  let routing: string;
  if (!r.routingWasEnabled) routing = 'was already off';
  else if (r.routingDisabled) routing = `disabled on ${r.zoneName} · MX and SPF removed`;
  else if (r.catchAllWasPointing) routing = 'catch-all released · routing left on';
  else routing = 'nothing pointed here · routing left on';

  return [
    ['worker', r.workerWasPresent ? 'deleted' : 'was already gone'],
    ['dns', r.domainWasPresent ? `${r.hostname} removed` : 'no custom domain to remove'],
    ['d1', r.d1WasPresent ? 'deleted' : 'was already gone'],
    ['r2', `${buckets} · ${objects}`],
    ['email routing', routing],
  ];
}

export function routingChoice(
  routingEnabled: boolean,
  enabledBySetup: boolean | undefined
): RoutingChoice {
  if (!routingEnabled) return 'keep';
  if (enabledBySetup === true) return 'disable';
  if (enabledBySetup === false) return 'keep';
  return 'ask';
}
