import { describe, it, expect } from 'bun:test';
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

// sha256("hunter2")
const PASSWORD = 'hunter2';
const PASSWORD_HASH = 'f52fbd32b2b3b86ff88ef6c490628285f482af15ddcb29541f94bcf526a3f6c7';

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    AUTH_MODE: 'session',
    ADMIN_EMAIL: 'owner@example.com',
    SESSION_PASSWORD_HASH: PASSWORD_HASH,
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

  it('rejects a cookie signed with a different password', async () => {
    const issuing = makeEnv();
    const res = await login({ email: 'owner@example.com', password: PASSWORD }, issuing);

    const rotated = makeEnv({ SESSION_PASSWORD_HASH: 'a'.repeat(64) });
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
  async function sha256Hex(s: string) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  /** Sign a cookie the way the Worker does, for a given secret. */
  async function forgeCookie(email: string, secret: string) {
    const exp = String(Math.floor(Date.now() / 1000) + 86_400);
    const sig = await sha256Hex(`${email}.${exp}.${secret}`);
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
    // Signed with the empty key — this returned 200 before the fix.
    const res = await me(await forgeCookie('attacker@evil.test', ''), env);
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
    const res = await me(await forgeCookie('someone.else@nowhere.test', PASSWORD_HASH), env);
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
