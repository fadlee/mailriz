import { describe, it, expect } from 'bun:test';
import { signSession, hashPassword, verifyPassword } from '@mailriz/shared';
import { app } from '../src/api';

/**
 * Session-mode auth: logging in and then being recognised by the cookie.
 *
 * Two regressions are pinned here:
 *  - POST /api/login used to sit behind the /api/* auth guard, so it answered
 *    401 before the handler ever ran and no one could obtain a cookie.
 *  - The cookie is `email.sig.exp`; parsing it left-to-right broke every
 *    address containing a dot, which is nearly all of them.
 */

import { TEST_PASSWORD, TEST_PASSWORD_HASH, TEST_SIGNING_KEY } from './session-credentials';

const PASSWORD = TEST_PASSWORD;

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    AUTH_MODE: 'session',
    ADMIN_EMAIL: 'owner@example.com',
    SESSION_PASSWORD_HASH: TEST_PASSWORD_HASH,
    SESSION_SIGNING_KEY: TEST_SIGNING_KEY,
    ACCESS_TEAM_DOMAIN: '',
    ACCESS_AUD: '',
    TRASH_RETENTION_DAYS: '30',
    ...overrides,
  } as any;
}

function login(body: unknown, env = makeEnv()) {
  return app.fetch(
    new Request('https://mail.example.com/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env
  );
}

/** Pull the session cookie out of a login response's Set-Cookie header. */
function cookieFrom(res: Response): string {
  const header = res.headers.get('Set-Cookie') || '';
  return header.split(';')[0]!;
}

/** The Workers types declare Response.json() as Promise<undefined>. */
function readJson(res: Response): Promise<any> {
  return res.json() as Promise<any>;
}

describe('session login', () => {
  it('is reachable without a cookie (not swallowed by the /api/* guard)', async () => {
    const res = await login({ email: 'owner@example.com', password: 'wrong' });

    // The guard would answer "Unauthorized"; the handler answers this.
    expect(res.status).toBe(401);
    expect(await readJson(res)).toEqual({ error: 'Invalid credentials' });
  });

  it('issues a session cookie for the admin email and password', async () => {
    const res = await login({ email: 'owner@example.com', password: PASSWORD });

    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ ok: true, email: 'owner@example.com' });

    const setCookie = res.headers.get('Set-Cookie') || '';
    expect(setCookie).toContain('mailriz_session=');
    expect(setCookie).toContain('HttpOnly');
  });

  it('rejects a non-admin email', async () => {
    const res = await login({ email: 'someone@example.com', password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it('refuses to run when the deployment is in access mode', async () => {
    const res = await login(
      { email: 'owner@example.com', password: PASSWORD },
      makeEnv({ AUTH_MODE: 'access' })
    );
    expect(res.status).toBe(400);
  });
});

describe('session cookie validation', () => {
  /** Log in, then call /api/me carrying the cookie we were handed. */
  async function meWithCookieFor(email: string) {
    const env = makeEnv({ ADMIN_EMAIL: email });
    const res = await login({ email, password: PASSWORD }, env);
    expect(res.status).toBe(200);

    return app.fetch(
      new Request('https://mail.example.com/api/me', {
        headers: { Cookie: cookieFrom(res) },
      }),
      env
    );
  }

  it('accepts a freshly issued cookie', async () => {
    const res = await meWithCookieFor('owner@example.com');
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({
      email: 'owner@example.com',
      mode: 'session',
    });
  });

  it('accepts an email whose local part and domain contain dots', async () => {
    const res = await meWithCookieFor('first.last@mail.example.co.uk');
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ email: 'first.last@mail.example.co.uk' });
  });

  it('rejects a cookie signed with a different signing key', async () => {
    const issuing = makeEnv();
    const res = await login({ email: 'owner@example.com', password: PASSWORD }, issuing);

    // The cookie key is no longer the password hash, so rotating the key is
    // what invalidates sessions — this is the separation A-02 introduced.
    const rotated = makeEnv({ SESSION_SIGNING_KEY: 'b'.repeat(64) });
    const me = await app.fetch(
      new Request('https://mail.example.com/api/me', {
        headers: { Cookie: cookieFrom(res) },
      }),
      rotated
    );

    expect(me.status).toBe(401);
  });

  it('rejects a tampered expiry', async () => {
    const env = makeEnv();
    const res = await login({ email: 'owner@example.com', password: PASSWORD }, env);
    const raw = decodeURIComponent(cookieFrom(res).split('=')[1]!);

    const parts = raw.split('.');
    parts[parts.length - 1] = String(Math.floor(Date.now() / 1000) + 999_999);

    const me = await app.fetch(
      new Request('https://mail.example.com/api/me', {
        headers: { Cookie: `mailriz_session=${encodeURIComponent(parts.join('.'))}` },
      }),
      env
    );

    expect(me.status).toBe(401);
  });

  it('rejects a request with no cookie at all', async () => {
    const me = await app.fetch(
      new Request('https://mail.example.com/api/me'),
      makeEnv()
    );
    expect(me.status).toBe(401);
  });
});

/**
 * Three findings from the pre-release audit, each reproduced before it was
 * fixed:
 *  - an empty SESSION_PASSWORD_HASH made the signing key the empty string, so
 *    a forged cookie verified while /api/login kept answering 401 — an open
 *    door behind a normal-looking login screen;
 *  - the session path never re-checked ADMIN_EMAIL, so a valid signature over
 *    *any* address was accepted;
 *  - the cookie went out without Secure.
 */
describe('session auth hardening', () => {
  /** Sign a cookie the way the Worker does, under a given signing key. */
  async function forgeCookie(email: string, signingKey: string) {
    const exp = String(Math.floor(Date.now() / 1000) + 86_400);
    const sig = await signSession(`${email}.${exp}`, signingKey);
    return `mailriz_session=${encodeURIComponent(`${email}.${sig}.${exp}`)}`;
  }

  const me = (cookie: string | null, env: any) =>
    app.fetch(
      new Request('https://mail.example.com/api/me',
        cookie ? { headers: { Cookie: cookie } } : undefined),
      env
    );

  it('refuses to verify anything when the hash is empty', async () => {
    const env = makeEnv({ SESSION_PASSWORD_HASH: '' });
    // Any cookie at all: the point is that the request is refused before the
    // signature is even considered. Under the old scheme an empty hash made
    // the signing key the empty string, and a forgery verified.
    const res = await me(await forgeCookie('attacker@evil.test', TEST_SIGNING_KEY), env);
    expect(res.status).toBe(500);
  });

  it('refuses to log in when the hash is empty', async () => {
    const res = await login(
      { email: 'owner@example.com', password: PASSWORD },
      makeEnv({ SESSION_PASSWORD_HASH: '' })
    );
    expect(res.status).toBe(500);
  });

  it('leaves access mode alone when the hash is empty', async () => {
    // The repo's own wrangler.jsonc ships AUTH_MODE=access with an empty hash;
    // that is normal and must not trip the guard.
    const res = await me(null, makeEnv({ AUTH_MODE: 'access', SESSION_PASSWORD_HASH: '' }));
    expect(res.status).toBe(401);
  });

  it('rejects a correctly signed cookie for a different address', async () => {
    const env = makeEnv();
    const res = await me(await forgeCookie('someone.else@nowhere.test', TEST_SIGNING_KEY), env);
    expect(res.status).toBe(403);
  });

  it('marks the session cookie Secure', async () => {
    const res = await login({ email: 'owner@example.com', password: PASSWORD });
    expect(res.headers.get('Set-Cookie') || '').toContain('; Secure');
  });

  it('omits Secure on loopback, so local dev can still log in', async () => {
    const res = await app.fetch(
      new Request('http://localhost:8787/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'owner@example.com', password: PASSWORD }),
      }),
      makeEnv()
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie') || '').not.toContain('Secure');
  });
});

/**
 * A-02: the credential scheme itself.
 *
 * Before this, the password was a single unsalted SHA-256 and that same hash
 * was the cookie signing key — so reading it (it was a plain Worker var) was
 * enough to mint a session without ever knowing the password.
 */
describe('session credential scheme', () => {
  const me = (cookie: string, env: any) =>
    app.fetch(new Request('https://mail.example.com/api/me', { headers: { Cookie: cookie } }), env);

  it('accepts the right password against a PBKDF2 hash', async () => {
    const res = await login({ email: 'owner@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie') || '').toContain('mailriz_session=');
  });

  it('rejects the wrong password', async () => {
    const res = await login({ email: 'owner@example.com', password: 'not-it' });
    expect(res.status).toBe(401);
  });

  it('reads iterations and salt from the stored hash, not from a constant', async () => {
    // A different work factor than the shared fixture uses. If verification
    // ignored the stored parameters this would not match.
    const hash = await hashPassword(PASSWORD, 2_500);
    const env = makeEnv({ SESSION_PASSWORD_HASH: hash });
    expect((await login({ email: 'owner@example.com', password: PASSWORD }, env)).status).toBe(200);
    expect((await login({ email: 'owner@example.com', password: 'wrong' }, env)).status).toBe(401);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword(PASSWORD, 1_000);
    const b = await hashPassword(PASSWORD, 1_000);
    expect(a).not.toBe(b);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword(PASSWORD, b)).toBe(true);
  });

  it('refuses a deployment still carrying a bare SHA-256 hash', async () => {
    // What every install before this release has. It cannot be verified, and
    // saying so beats letting it look like a wrong password forever.
    const legacy = 'f52fbd32b2b3b86ff88ef6c490628285f482af15ddcb29541f94bcf526a3f6c7';
    const env = makeEnv({ SESSION_PASSWORD_HASH: legacy });
    expect((await login({ email: 'owner@example.com', password: PASSWORD }, env)).status).toBe(500);
    expect((await me('mailriz_session=x.y.z', env)).status).toBe(500);
  });

  it('refuses when the signing key is missing', async () => {
    const env = makeEnv({ SESSION_SIGNING_KEY: '' });
    expect((await login({ email: 'owner@example.com', password: PASSWORD }, env)).status).toBe(500);
  });

  it('does not let the password hash act as the signing key', async () => {
    // The old scheme's forgery: sign with what is stored in the hash field.
    const env = makeEnv();
    const exp = String(Math.floor(Date.now() / 1000) + 86_400);
    const sig = await signSession(`owner@example.com.${exp}`, TEST_PASSWORD_HASH);
    const cookie = `mailriz_session=${encodeURIComponent(`owner@example.com.${sig}.${exp}`)}`;
    expect((await me(cookie, env)).status).toBe(401);
  });

  it('rate limits login when the binding is present', async () => {
    let calls = 0;
    const env = makeEnv({
      LOGIN_LIMITER: { limit: async () => ({ success: ++calls <= 2 }) },
    });
    expect((await login({ email: 'owner@example.com', password: 'wrong' }, env)).status).toBe(401);
    expect((await login({ email: 'owner@example.com', password: 'wrong' }, env)).status).toBe(401);
    expect((await login({ email: 'owner@example.com', password: PASSWORD }, env)).status).toBe(429);
  });

  it('still logs in when the limiter binding is absent', async () => {
    // No binding in unit tests or wrangler dev; login must not die there.
    expect((await login({ email: 'owner@example.com', password: PASSWORD })).status).toBe(200);
  });
});
