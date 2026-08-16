import { describe, it, expect, afterEach } from 'bun:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { app } from '../src/api';
import { resetJwksCache } from '../src/middleware/auth';

/**
 * Access-mode auth: the Worker must verify the JWT *signature* against the
 * team domain's JWKS — not just read the claims. This pins:
 *  - a valid signed token with the right aud/iss passes and yields the email
 *  - a token signed by a *different* key is rejected (the old code accepted
 *    any well-formed JWT with a matching aud, regardless of who signed it)
 *  - a token with the wrong issuer is rejected
 *  - an expired token is rejected
 *  - a token for another user is rejected (single-user mode)
 */

let keyPair: Awaited<ReturnType<typeof generateKeyPair>> | null = null;
let certsUrl = '';
let jwksBody = '';
/** Every URL the Worker asked for, so the JWKS path itself can be asserted. */
let requestedUrls: string[] = [];

const TEAM = 'acme.cloudflareaccess.com';
const AUD = '7e9a1f2b3c4d5e6f7a8b9c0d';
const ISSUER = `https://${TEAM}`;

/** A fresh key pair + a mock /certs endpoint for the team domain. */
async function setupJwks() {
  keyPair = await generateKeyPair('RS256');
  const jwk = await exportJWK(keyPair.publicKey);
  jwksBody = JSON.stringify({
    keys: [{ ...jwk, kid: 'test-key-1', use: 'sig', alg: 'RS256' }],
  });
  certsUrl = `https://${TEAM}/cdn-cgi/access/certs`;

  // jose's createRemoteJWKSet fetches the certs endpoint; serve the JWKS from
  // the mock so no real network is involved.
  //
  // Matched by exact equality, deliberately. A startsWith() match here also
  // answers `.../certs/certs`, which is how a doubled path once passed the
  // whole suite while failing against real Cloudflare.
  requestedUrls = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    requestedUrls.push(url);
    if (url === certsUrl) {
      return new Response(jwksBody, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Not found', { status: 404 });
  }) as typeof fetch;
}

/** Sign a token with the test private key. */
function sign(claims: Record<string, unknown>): Promise<string> {
  const k = keyPair!.privateKey;
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUD)
    .setExpirationTime('1h')
    .sign(k);
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    AUTH_MODE: 'access',
    ADMIN_EMAIL: 'owner@example.com',
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ACCESS_CERTS_URL: certsUrl,
    TRASH_RETENTION_DAYS: '30',
    ...overrides,
  } as any;
}

function get(path: string, token: string | null, env = makeEnv()) {
  const headers: Record<string, string> = {};
  if (token) headers['Cf-Access-Jwt-Assertion'] = token;
  return app.fetch(new Request(`https://mail.example.com${path}`, { headers }), env);
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  keyPair = null;
  resetJwksCache();
});

describe('Access JWT signature verification', () => {
  it('passes a token signed by the team key', async () => {
    await setupJwks();
    const token = await sign({ email: 'owner@example.com' });
    const res = await get('/api/me', token);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.email).toBe('owner@example.com');
    expect(body.mode).toBe('access');
  });

  it('fetches the JWKS from the real certs path, not a nested one', async () => {
    await setupJwks();
    const token = await sign({ email: 'owner@example.com' });
    await get('/api/me', token);
    // A doubled `/certs` 404s against Cloudflare and would reject every
    // request in production, while a loose mock would still let it pass here.
    expect(requestedUrls).toContain(certsUrl);
    expect(requestedUrls.some((u) => u.includes('/certs/certs'))).toBe(false);
  });

  it('rejects a forged token that reuses the genuine key id', async () => {
    await setupJwks();
    // Same `kid` as the real key, signed by someone else's. jose therefore
    // finds the genuine key and the signature comparison itself must fail —
    // a different kid would only prove key lookup fails, which is weaker.
    const other = await generateKeyPair('RS256');
    const token = await new SignJWT({ email: 'owner@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setExpirationTime('1h')
      .sign(other.privateKey);
    const res = await get('/api/me', token);
    expect(res.status).toBe(401);
  });

  it('rejects a token signed by an unknown key id', async () => {
    await setupJwks();
    const other = await generateKeyPair('RS256');
    const token = await new SignJWT({ email: 'owner@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'other-key' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setExpirationTime('1h')
      .sign(other.privateKey);
    const res = await get('/api/me', token);
    expect(res.status).toBe(401);
  });

  it('rejects a token with the wrong issuer', async () => {
    await setupJwks();
    const token = await new SignJWT({ email: 'owner@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuedAt()
      .setIssuer('https://evil-team.cloudflareaccess.com')
      .setAudience(AUD)
      .setExpirationTime('1h')
      .sign(keyPair!.privateKey);
    const res = await get('/api/me', token);
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    await setupJwks();
    const token = await new SignJWT({ email: 'owner@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setExpirationTime('-1h')
      .sign(keyPair!.privateKey);
    const res = await get('/api/me', token);
    expect(res.status).toBe(401);
  });

  it('rejects a non-owner email in single-user mode', async () => {
    await setupJwks();
    const token = await sign({ email: 'other@example.com' });
    const res = await get('/api/me', token);
    expect(res.status).toBe(403);
  });

  it('rejects a token when no aud is configured', async () => {
    await setupJwks();
    const token = await sign({ email: 'owner@example.com' });
    const res = await get('/api/me', token, makeEnv({ ACCESS_AUD: '' }));
    expect(res.status).toBe(401);
  });
});
