import { describe, it, expect } from 'bun:test';
import { app } from '../src/api';

/**
 * Serving a message body.
 *
 * The body goes out exactly as it was sent — the layout an email was designed
 * with is the point. Safety is carried by the response headers instead of by
 * editing the sender's HTML:
 *
 *  - `sandbox` gives the document a unique origin and kills scripting, and it
 *    applies even when the URL is opened directly rather than in the iframe.
 *  - `img-src` is what withholds remote images, so blocking never requires
 *    rewriting the source. ?images=1 widens it and nothing else.
 *
 * Embedded images are inlined as data: URIs, because under `sandbox` the
 * document has a null origin and an authenticated subresource request cannot
 * be relied on to carry the session cookie.
 */

const ADMIN = 'owner@example.com';
import { TEST_PASSWORD_HASH, TEST_SIGNING_KEY } from './session-credentials';

const PNG = 'image/png';
/** 1x1 transparent PNG. */
const PNG_BYTES = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='),
  (ch) => ch.charCodeAt(0)
);

interface Att {
  id: string;
  content_id: string;
  content_type: string;
  size_bytes: number;
  r2_key: string;
}

function makeEnv(html: string, attachments: Att[] = []) {
  return {
    AUTH_MODE: 'session',
    ADMIN_EMAIL: ADMIN,
    SESSION_PASSWORD_HASH: TEST_PASSWORD_HASH,
    SESSION_SIGNING_KEY: TEST_SIGNING_KEY,
    HTML_BUCKET: {
      async get() {
        return { async text() { return html; }, body: null };
      },
    },
    ATTACHMENTS_BUCKET: {
      async get(key: string) {
        if (!attachments.some((a) => a.r2_key === key)) return null;
        return { async arrayBuffer() { return PNG_BYTES.buffer; } };
      },
    },
    DB: {
      prepare(sql: string) {
        return {
          _args: [] as any[],
          bind(...args: any[]) { this._args = args; return this; },
          async first<T>() {
            if (/html_r2_key FROM emails/i.test(sql)) return { html_r2_key: 'k' } as T;
            return null as T;
          },
          async all<T>() {
            if (/FROM attachments/i.test(sql)) return { results: attachments } as any;
            return { results: [] } as any;
          },
          async run() { return { success: true }; },
        };
      },
    },
  } as any;
}

async function cookieFor(env: any): Promise<string> {
  const res = await app.fetch(
    new Request('https://inbox.example.com/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN, password: 'hunter2' }),
    }),
    env
  );
  return (res.headers.get('Set-Cookie') || '').split(';')[0]!;
}

async function get(env: any, query = ''): Promise<Response> {
  const cookie = await cookieFor(env);
  const res = await app.fetch(
    new Request(`https://inbox.example.com/api/emails/e1/html${query}`, { headers: { Cookie: cookie } }),
    env
  );
  expect(res.status).toBe(200);
  return res;
}

function csp(res: Response): string {
  return res.headers.get('Content-Security-Policy') || '';
}

/** Serve one body and return its text. */
async function bodyText(html: string): Promise<string> {
  return (await get(makeEnv(html))).text();
}

describe('response headers', () => {
  it('sandboxes the document and denies everything by default', async () => {
    const policy = csp(await get(makeEnv('<p>hi</p>')));

    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain('sandbox');
    // No allow-scripts token anywhere: the body must never execute.
    expect(policy).not.toContain('allow-scripts');
  });

  it('permits inline CSS, which is what carries an email\'s layout', async () => {
    expect(csp(await get(makeEnv('<p>hi</p>')))).toContain("style-src 'unsafe-inline'");
  });

  it('withholds remote images by default', async () => {
    const policy = csp(await get(makeEnv('<p>hi</p>')));
    expect(policy).toContain("img-src 'self' data:");
    expect(policy).not.toContain('https:');
  });

  it('widens only img-src under ?images=1', async () => {
    const blocked = csp(await get(makeEnv('<p>hi</p>')));
    const shown = csp(await get(makeEnv('<p>hi</p>'), '?images=1'));

    expect(shown).toContain('img-src');
    expect(shown).toContain('https:');
    // Everything else about the policy is unchanged.
    const strip = (p: string) => p.split('; ').filter((d) => !d.startsWith('img-src')).join('; ');
    expect(strip(shown)).toBe(strip(blocked));
  });

  it('is never cached and never sniffed', async () => {
    const res = await get(makeEnv('<p>hi</p>'));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});

describe('body fidelity', () => {
  it('serves the message exactly as stored', async () => {
    const html =
      '<style>.card{padding:24px}</style>' +
      '<table cellpadding="0" bgcolor="#fff"><tr><td style="background:url(https://x/bg.png)">hi</td></tr></table>' +
      '<img src="https://cdn.example/logo.png">';

    expect(await (await get(makeEnv(html))).text()).toBe(html);
  });

  it('leaves remote image sources untouched even when revealed', async () => {
    const html = '<img src="https://cdn.example/logo.png">';
    // Revealing is a header change, not an edit to the markup.
    expect(await (await get(makeEnv(html), '?images=1')).text()).toBe(html);
  });
});

describe('embedded images', () => {
  const att = (over: Partial<Att> = {}): Att => ({
    id: 'att1',
    content_id: 'logo@mail.local',
    content_type: PNG,
    size_bytes: PNG_BYTES.byteLength,
    r2_key: 'k/att1',
    ...over,
  });

  it('inlines a cid: reference as a data: URI', async () => {
    const env = makeEnv('<img src="cid:logo@mail.local">', [att()]);
    const html = await (await get(env)).text();

    expect(html).toContain('src="data:image/png;base64,');
    expect(html).not.toContain('cid:');
    // Not routed through the authenticated endpoint: the sandboxed document
    // has a null origin and could not be relied on to send the cookie.
    expect(html).not.toContain('/api/attachments/');
  });

  it('matches the Content-ID case-insensitively and handles bare quotes', async () => {
    const env = makeEnv("<img src='cid:LOGO@mail.local'>", [att()]);
    expect(await (await get(env)).text()).toContain('src="data:image/png;base64,');
  });

  it('renders embedded images without ?images=1 — they cost no privacy', async () => {
    const env = makeEnv('<img src="cid:logo@mail.local">', [att()]);
    const res = await get(env);
    expect(csp(res)).toContain("img-src 'self' data:");
    expect(await res.text()).toContain('data:image/png;base64,');
  });

  it('leaves a cid: with no matching attachment as written', async () => {
    const env = makeEnv('<img src="cid:missing@mail.local">', [att()]);
    const html = await (await get(env)).text();
    expect(html).toContain('src="cid:missing@mail.local"');
  });

  it('does not inline SVG, which can carry script', async () => {
    const env = makeEnv('<img src="cid:logo@mail.local">', [att({ content_type: 'image/svg+xml' })]);
    const html = await (await get(env)).text();
    expect(html).toContain('src="cid:logo@mail.local"');
    expect(html).not.toContain('data:image/svg');
  });

  it('skips images past the per-file size cap', async () => {
    const env = makeEnv('<img src="cid:logo@mail.local">', [att({ size_bytes: 2_000_000 })]);
    expect(await (await get(env)).text()).toContain('src="cid:logo@mail.local"');
  });
});

describe('bodies stored by older releases', () => {
  it('restores rewritten image sources when images are revealed', async () => {
    const html = '<img data-blocked-src="https://cdn.example/logo.png">';
    const out = await (await get(makeEnv(html), '?images=1')).text();

    expect(out).toContain('<img src="https://cdn.example/logo.png">');
    expect(out).not.toContain('data-blocked-src');
  });

  it('leaves them rewritten while images are still blocked', async () => {
    const html = '<img data-blocked-src="https://cdn.example/logo.png">';
    expect(await (await get(makeEnv(html))).text()).toContain('data-blocked-src');
  });
});

/**
 * Links in a message body.
 *
 * A sandboxed document cannot navigate its own frame, so without help every
 * link in every email silently does nothing. Rewriting them to a new tab needs
 * three things to line up, and an earlier attempt only did one of them:
 *
 *  - the iframe must grant allow-popups (App.tsx),
 *  - the response CSP must grant it too — the browser intersects the two, so a
 *    bare `sandbox` here blocks popups no matter what the iframe says,
 *  - target/rel must be *replaced*, since the sender controls them.
 */
describe('links open in a new tab', () => {
  it('grants popups in the CSP, not just on the iframe', async () => {
    const res = await get(makeEnv('<a href="https://example.com/">x</a>'));
    const policy = csp(res);
    expect(policy).toContain('allow-popups');
    expect(policy).toContain('allow-popups-to-escape-sandbox');
    // Scripts stay denied — popups are reachable only by a real click.
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain('allow-scripts');
  });

  it('adds target and rel to a plain link', async () => {
    const html = await bodyText('<a href="https://example.com/">x</a>');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('overrides a rel the sender chose', async () => {
    // rel="opener" would hand the opened page a handle on this frame; even
    // rel="nofollow" would displace ours if we only appended when absent.
    for (const rel of ['opener', 'nofollow']) {
      const html = await bodyText(`<a href="https://evil.test/" rel="${rel}">x</a>`);
      expect(html).toContain('rel="noopener noreferrer"');
      expect(html).not.toContain(`rel="${rel}"`);
    }
  });

  it('overrides a target the sender chose', async () => {
    // _self would keep the link dead, since the frame cannot navigate itself.
    const html = await bodyText('<a href="https://evil.test/" target="_self">x</a>');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('target="_self"');
  });

  it('survives a > inside an attribute value', async () => {
    const html = await bodyText('<a href="https://example.com/" title="a>b">x</a>');
    // The whole tag must stay intact — a naive regex ends the match at the
    // first > and leaves `b">` leaking into the page as text.
    expect(html).toContain('title="a>b"');
    expect(html).not.toContain('b">x');
    expect(html).toContain('target="_blank"');
  });

  it('leaves non-http links alone', async () => {
    for (const href of ['mailto:someone@example.com', '#anchor', '/relative']) {
      const html = await bodyText(`<a href="${href}">x</a>`);
      expect(html).not.toContain('target="_blank"');
    }
  });
});
