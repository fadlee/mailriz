import { createMiddleware } from 'hono/factory';
import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';
import { Env, AppContext, AuthUser } from '../types';

/**
 * Auth modes:
 * - "access": Cloudflare Access JWT (Cf-Access-Jwt-Assertion) — default.
 * - "session": self-contained session cookie (basic login fallback when the
 *   deployer's token lacks Zero Trust permissions). The password hash is a
 *   SHA-256 hex of the session password, stored as a Worker secret.
 */

export type { AuthUser };

export type { AppContext };

export function env(c: { env: Env }): Env {
  return c.env;
}

const ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';
const SESSION_COOKIE = 'mailriz_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate a Cloudflare Access JWT against the team domain's public key
 * (JWKS) and the expected audience.
 *
 * The token is signed by Cloudflare's Access service. Its public keys are
 * served from `https://<team-domain>/cdn-cgi/access/certs`, so we verify the
 * signature (not just the claims) using jose's remote JWKS — which caches
 * the key set internally and only refetches when the kid changes.
 *
 * Env knobs:
 *   ACCESS_TEAM_DOMAIN  e.g. "my-team.cloudflareaccess.com" (no scheme)
 *   ACCESS_CERTS_URL    optional override for the certs endpoint (tests)
 */
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Test hook: drop the cached remote JWKS so a fresh key set is fetched. */
export function resetJwksCache(): void {
  jwksCache = null;
}

/** The certs endpoint itself — already the full path, nothing to append. */
function certsUrl(env: Env): string {
  return (
    env.ACCESS_CERTS_URL || `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`
  ).replace(/\/+$/, '');
}

function getJwks(env: Env) {
  // The JWKS URL is fixed for a deployment, so build the set once and reuse
  // it — jose fetches keys lazily and caches them by kid.
  if (!jwksCache) {
    jwksCache = createRemoteJWKSet(new URL(certsUrl(env)));
  }
  return jwksCache;
}

async function validateAccessJwt(token: string, env: Env): Promise<string | null> {
  const aud = env.ACCESS_AUD;
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  // Both are required: without the team domain there is no key set to verify
  // against, and an install that reaches here with it empty would reject every
  // request. `mailriz-cli status` reports this so it is diagnosable.
  if (!aud || !teamDomain) return null;

  try {
    const { payload } = await jwtVerify(token, getJwks(env), {
      audience: aud,
      // Access tokens are issued for the team domain; pin the issuer so a
      // token minted by some other Access team can't pass.
      issuer: `https://${teamDomain}`,
      // Access signs with RS256. Pinning it means a key set that ever offered
      // something weaker could not be talked into using it.
      algorithms: ['RS256'],
    });

    const email = payload.email;
    if (typeof email !== 'string' || !email.includes('@')) return null;

    return email;
  } catch {
    // Invalid signature, wrong aud/iss, or expired — all rejected the same.
    return null;
  }
}

export const jwtAuth = createMiddleware<AppContext>(async (c, next) => {
  const e = c.env as Env;

  const token = c.req.header(ACCESS_JWT_HEADER);
  if (token) {
    const email = await validateAccessJwt(token, e);
    if (email) {
      // Single-user mode: only ADMIN_EMAIL may pass.
      if (e.ADMIN_EMAIL && email !== e.ADMIN_EMAIL) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      c.set('user', { email, mode: 'access' });
      return next();
    }
  }

  // Fallback: session cookie (basic login).
  if (e.AUTH_MODE === 'session') {
    // Without a hash there is no signing key. Falling back to '' would make
    // the key a string everybody knows, so any forged cookie would verify —
    // while /api/login kept rejecting passwords, leaving the operator looking
    // at a normal login screen over an open door. Refuse instead, and say it
    // is the server's fault so the cause is diagnosable.
    if (!e.SESSION_PASSWORD_HASH) {
      return c.json({ error: 'Server misconfigured' }, 500);
    }

    const cookie = c.req.header('Cookie') || '';
    const match = cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith(SESSION_COOKIE + '='));
    if (match) {
      const raw = decodeURIComponent(match.slice(SESSION_COOKIE.length + 1));
      // The cookie is `email.sig.exp` and the email itself usually contains
      // dots, so read the two fixed fields off the end rather than splitting
      // left to right — sig is hex and exp is digits, neither has a dot.
      const parts = raw.split('.');
      const exp = parts.pop();
      const sig = parts.pop();
      const email = parts.join('.');
      if (email && sig && exp) {
        const expected = await sha256Hex(`${email}.${exp}.${e.SESSION_PASSWORD_HASH}`);
        if (sig === expected && Number(exp) * 1000 > Date.now()) {
          // Same single-user rule the Access path enforces above. login only
          // ever issues cookies for ADMIN_EMAIL, but verification has to say
          // so too — otherwise a valid signature over any address is accepted.
          if (e.ADMIN_EMAIL && email !== e.ADMIN_EMAIL) {
            return c.json({ error: 'Forbidden' }, 403);
          }
          c.set('user', { email, mode: 'session' });
          return next();
        }
      }
    }
  }

  return c.json({ error: 'Unauthorized' }, 401);
});

/**
 * Cookie attributes shared by issuing and clearing the session.
 *
 * `Secure` is conditional on purpose: a Secure cookie is not sent over
 * http://, and `wrangler dev` serves the dashboard on http://localhost:8787 —
 * so adding it unconditionally would break local login. Do not "tidy" this
 * into an unconditional flag.
 *
 * Clearing has to repeat the same attributes as issuing, or the browser keeps
 * the cookie it was given.
 */
function cookieAttrs(c: any): string {
  let host = '';
  try {
    host = new URL(c.req.url).hostname;
  } catch {
    // Unparseable URL: assume production and keep the stricter attribute.
  }
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  return `Path=/; HttpOnly; SameSite=Lax${isLoopback ? '' : '; Secure'}`;
}

/**
 * Log out of session mode by expiring the cookie.
 *
 * Access mode has no server-side session of ours to end — Cloudflare owns
 * that cookie — so the dashboard sends the browser to
 * /cdn-cgi/access/logout instead. This endpoint stays harmless there.
 */
export async function logoutHandler(c: any): Promise<Response> {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `${SESSION_COOKIE}=; ${cookieAttrs(c)}; Max-Age=0`,
    },
  });
}

/**
 * Login endpoint for session mode. POST /api/login { email, password }.
 * Verifies email === ADMIN_EMAIL and password hash matches.
 */
export async function loginHandler(c: any): Promise<Response> {
  const e = c.env as Env;
  if (e.AUTH_MODE !== 'session') {
    return c.json({ error: 'Session auth not enabled' }, 400);
  }
  // Mirror of the guard in jwtAuth: with no hash there is nothing to check a
  // password against, and issuing a cookie would sign it with an empty key.
  if (!e.SESSION_PASSWORD_HASH) {
    return c.json({ error: 'Server misconfigured' }, 500);
  }
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email || '');
  const password = String(body.password || '');
  if (!email || email !== e.ADMIN_EMAIL) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }
  const hash = await sha256Hex(password);
  if (hash !== e.SESSION_PASSWORD_HASH) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_MS / 1000;
  const sig = await sha256Hex(`${email}.${exp}.${e.SESSION_PASSWORD_HASH}`);
  const value = encodeURIComponent(`${email}.${sig}.${exp}`);
  return new Response(JSON.stringify({ ok: true, email }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `${SESSION_COOKIE}=${value}; ${cookieAttrs(c)}; Max-Age=${SESSION_TTL_MS / 1000}`,
    },
  });
}
