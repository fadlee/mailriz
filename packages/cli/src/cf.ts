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
  return cfFetch<Account[]>(token, '/accounts?per_page=50');
}

export interface Zone {
  id: string;
  name: string;
  status: string;
}

export async function listZones(token: string, accountId: string): Promise<Zone[]> {
  return cfFetch<Zone[]>(token, `/zones?account.id=${accountId}&per_page=50`);
}

// --- D1 ---

export interface D1Database {
  id: string;
  name: string;
}

export async function listD1(token: string, accountId: string): Promise<D1Database[]> {
  return cfFetch<D1Database[]>(token, `/accounts/${accountId}/d1/database?per_page=100`);
}

export async function createD1(token: string, accountId: string, name: string): Promise<D1Database> {
  return cfFetch<D1Database>(token, `/accounts/${accountId}/d1/database`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
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

export async function listR2Buckets(token: string, accountId: string): Promise<{ name: string }[]> {
  return cfFetch<{ name: string }[]>(token, `/accounts/${accountId}/r2/buckets?per_page=100`);
}

export async function createR2Bucket(token: string, accountId: string, name: string): Promise<{ name: string }> {
  return cfFetch<{ name: string }>(token, `/accounts/${accountId}/r2/buckets`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
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

export async function createEmailRoutingRule(
  token: string,
  zoneId: string,
  matcher: { type: 'all' | 'custom'; field?: string; value?: string },
  action: { type: 'forward' | 'worker'; value: string[] }
): Promise<unknown> {
  const body = {
    matchers: [matcher.type === 'all' ? { type: 'all' } : { type: 'custom', field: matcher.field, value: matcher.value }],
    actions: [action.type === 'worker' ? { type: 'worker', value: action.value } : { type: 'forward', value: action.value }],
    enabled: true,
  };
  return cfFetch(token, `/zones/${zoneId}/email/routing/rules`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// --- Custom domain (Worker route) ---

export async function createWorkerRoute(token: string, zoneId: string, pattern: string, scriptName: string): Promise<{ id: string }> {
  return cfFetch<{ id: string }>(token, `/zones/${zoneId}/workers/routes`, {
    method: 'POST',
    body: JSON.stringify({ pattern, script: scriptName }),
  });
}
