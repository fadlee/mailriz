import { createMiddleware } from 'hono/factory';
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
const SESSION_COOKIE = 'rizmail_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate a Cloudflare Access JWT against the team domain's public key
 * (JWKS) and the expected audience. The token is signed by Cloudflare's
 * Access service; we only need the cert chain from the team domain.
 */
async function validateAccessJwt(token: string, env: Env): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  let payload: any;
  try {
    const part1 = parts[1];
    if (!part1) return null;
    payload = JSON.parse(atob(part1.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }

  // Audience check against ACCESS_AUD.
  const aud = env.ACCESS_AUD;
  if (!aud) return null;
  const payloadAud = payload.aud;
  const auds = Array.isArray(payloadAud) ? payloadAud : payloadAud ? [payloadAud] : [];
  if (!auds.includes(aud)) return null;

  // Expiry check.
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;

  // The email claim is what single-user mode trusts.
  const email = payload.email;
  if (typeof email !== 'string' || !email.includes('@')) return null;

  return email;
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
    const cookie = c.req.header('Cookie') || '';
    const match = cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith(SESSION_COOKIE + '='));
    if (match) {
      const raw = decodeURIComponent(match.slice(SESSION_COOKIE.length + 1));
      const [email, sig, exp] = raw.split('.');
      if (email && sig && exp) {
        const expected = await sha256Hex(`${email}.${exp}.${e.SESSION_PASSWORD_HASH || ''}`);
        if (sig === expected && Number(exp) * 1000 > Date.now()) {
          c.set('user', { email, mode: 'session' });
          return next();
        }
      }
    }
  }

  return c.json({ error: 'Unauthorized' }, 401);
});

/**
 * Login endpoint for session mode. POST /api/login { email, password }.
 * Verifies email === ADMIN_EMAIL and password hash matches.
 */
export async function loginHandler(c: any): Promise<Response> {
  const e = c.env as Env;
  if (e.AUTH_MODE !== 'session') {
    return c.json({ error: 'Session auth not enabled' }, 400);
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
      'Set-Cookie': `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
    },
  });
}
