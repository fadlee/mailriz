/**
 * Cloudflare REST API client for the CLI.
 * Only needs the handful of endpoints the wizard touches.
 */

const CF_API = 'https://api.cloudflare.com/client/v4';

export class CfError extends Error {
  status: number;
  errors: unknown[];
  constructor(status: number, errors: unknown[], message?: string) {
    super(message || `Cloudflare API error ${status}`);
    this.status = status;
    this.errors = errors;
  }
}

interface ApiEnvelope {
  success?: boolean;
  errors?: { message?: string }[];
  result?: unknown;
}

async function parseEnvelope(res: Response): Promise<ApiEnvelope> {
  try {
    return (await res.json()) as ApiEnvelope;
  } catch {
    return {};
  }
}

export async function cfFetch<T>(
  token: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const body = await parseEnvelope(res);
  if (!res.ok || body?.success === false) {
    throw new CfError(res.status, body?.errors || [], body?.errors?.[0]?.message || res.statusText);
  }
  return body.result as T;
}

/**
 * Cloudflare is not consistent about list shapes: most endpoints put a bare
 * array in `result`, but R2 nests it under `result.buckets`. `cfFetch` casts
 * `result` blindly, so a mismatch used to surface as "x.find is not a
 * function" several lines away from the call that caused it.
 *
 * Accept either shape, and otherwise fail with the payload we actually got.
 */
function asList<T>(value: unknown, nestedKey: string, context: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    const nested = (value as Record<string, unknown>)[nestedKey];
    if (Array.isArray(nested)) return nested as T[];
  }
  if (value == null) return [];
  throw new Error(`${context}: expected a list, got ${JSON.stringify(value).slice(0, 160)}`);
}

export interface VerifyToken {
  id: string;
  status: string;
}

export async function verifyToken(token: string): Promise<VerifyToken> {
  return cfFetch<VerifyToken>(token, '/user/tokens/verify');
}

export interface Account {
  id: string;
  name: string;
}

export async function listAccounts(token: string): Promise<Account[]> {
  const res = await cfFetch<unknown>(token, '/accounts?per_page=50');
  return asList<Account>(res, 'accounts', 'list accounts');
}

export interface Zone {
  id: string;
  name: string;
  status: string;
}

export async function listZones(token: string, accountId: string): Promise<Zone[]> {
  const res = await cfFetch<unknown>(token, `/zones?account.id=${accountId}&per_page=50`);
  return asList<Zone>(res, 'zones', 'list zones');
}

// --- D1 ---

export interface D1Database {
  /**
   * Cloudflare returns the D1 identifier as `uuid` — there is no `id` field.
   * Reading `id` yields undefined, which then silently reaches the query URL
   * and the wrangler binding, so the identifier is asserted on the way out.
   */
  uuid: string;
  name: string;
}

function assertD1(db: D1Database | undefined, context: string): D1Database {
  if (!db?.uuid) {
    throw new Error(`D1 ${context} returned no database uuid (got ${JSON.stringify(db)})`);
  }
  return db;
}

export async function listD1(token: string, accountId: string): Promise<D1Database[]> {
  const res = await cfFetch<unknown>(token, `/accounts/${accountId}/d1/database?per_page=100`);
  return asList<D1Database>(res, 'databases', 'list D1 databases');
}

export async function createD1(token: string, accountId: string, name: string): Promise<D1Database> {
  const db = await cfFetch<D1Database>(token, `/accounts/${accountId}/d1/database`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return assertD1(db, 'create');
}

export async function d1Query(token: string, accountId: string, dbId: string, sql: string): Promise<{ success: boolean; results?: unknown[] }> {
  return cfFetch<{ success: boolean; results?: unknown[] }>(
    token,
    `/accounts/${accountId}/d1/database/${dbId}/query`,
    {
      method: 'POST',
      body: JSON.stringify({ sql }),
    }
  );
}

// --- R2 ---

export interface R2Bucket {
  name: string;
}

/** R2 returns `result: { buckets: [...] }`, unlike D1 and zones. */
export async function listR2Buckets(token: string, accountId: string): Promise<R2Bucket[]> {
  const res = await cfFetch<unknown>(token, `/accounts/${accountId}/r2/buckets?per_page=100`);
  return asList<R2Bucket>(res, 'buckets', 'list R2 buckets');
}

export async function createR2Bucket(token: string, accountId: string, name: string): Promise<R2Bucket> {
  const bucket = await cfFetch<R2Bucket>(token, `/accounts/${accountId}/r2/buckets`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  // The bucket name is what ends up in the wrangler binding; fall back to the
  // requested one rather than binding `undefined` if the payload omits it.
  return { name: bucket?.name || name };
}

// --- Workers ---

export interface WorkerScript {
  id: string;
  modified_on: string;
}

// --- Email Routing ---

export async function getEmailRoutingSettings(token: string, zoneId: string): Promise<{ enabled: boolean; id: string }> {
  return cfFetch<{ enabled: boolean; id: string }>(token, `/zones/${zoneId}/email/routing`);
}

export async function enableEmailRouting(token: string, zoneId: string): Promise<{ enabled: boolean }> {
  return cfFetch<{ enabled: boolean }>(token, `/zones/${zoneId}/email/routing/enable`, { method: 'POST' });
}

/**
 * Point the catch-all at a Worker.
 *
 * The catch-all is not an ordinary rule: it lives at its own path and is
 * updated with PUT. Posting a `{type:"all"}` matcher to /rules is rejected
 * with "Invalid rule operation", which is what used to surface here.
 */
export async function setCatchAllToWorker(
  token: string,
  zoneId: string,
  workerName: string
): Promise<unknown> {
  return cfFetch(token, `/zones/${zoneId}/email/routing/rules/catch_all`, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'mailriz catch-all',
      enabled: true,
      matchers: [{ type: 'all' }],
      actions: [{ type: 'worker', value: [workerName] }],
    }),
  });
}

// --- Zero Trust / Access ---

export interface AccessOrganization {
  /** `<team>.cloudflareaccess.com` — the Zero Trust team domain. */
  auth_domain: string;
}

/**
 * Doubles as the probe for whether this token can do Access at all: a token
 * without Zero Trust scope answers 403 here, which lets the wizard ask about
 * auth *before* deploying rather than failing at the end.
 */
export async function getAccessOrganization(
  token: string,
  accountId: string
): Promise<AccessOrganization> {
  return cfFetch<AccessOrganization>(token, `/accounts/${accountId}/access/organizations`);
}

export interface AccessApp {
  id: string;
  /** Audience tag the Worker checks incoming Access JWTs against. */
  aud: string;
}

export async function createAccessApp(
  token: string,
  accountId: string,
  name: string,
  hostname: string
): Promise<AccessApp> {
  const app = await cfFetch<AccessApp>(token, `/accounts/${accountId}/access/apps`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      domain: hostname,
      type: 'self_hosted',
      session_duration: '24h',
    }),
  });
  if (!app?.id) throw new Error('Access app was created but returned no id');
  if (app.aud) return app;
  // The audience tag is what the Worker validates against, so if the create
  // payload omitted it, read it back rather than deploying a blank one.
  const fetched = await cfFetch<AccessApp>(token, `/accounts/${accountId}/access/apps/${app.id}`);
  if (!fetched?.aud) throw new Error('Access app has no aud tag');
  return fetched;
}

export async function createAccessPolicy(
  token: string,
  accountId: string,
  appId: string,
  adminEmail: string
): Promise<unknown> {
  return cfFetch(token, `/accounts/${accountId}/access/apps/${appId}/policies`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'mailriz admin',
      decision: 'allow',
      include: [{ email: { email: adminEmail } }],
    }),
  });
}

