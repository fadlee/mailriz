import { describe, it, expect, beforeEach } from 'bun:test';
import { emailHandler } from '../src/email';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal in-memory mocks for D1 + R2 to exercise the email() handler
 * without a real Cloudflare account.
 */

function makeD1Mock() {
  const emails: any[] = [];
  const attachments: any[] = [];
  return {
    emails,
    attachments,
    prepare(sql: string) {
      return {
        bind(...params: any[]) {
          return {
            async first() {
              // SELECT ... FROM aliases WHERE local_part = ?1 AND domain = ?2
              if (sql.includes('FROM aliases')) {
                const [localPart, domain] = params;
                const a = aliases.find((x) => x.local_part === localPart && x.domain === domain);
                return a || null;
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (sql.includes('INSERT INTO emails')) {
                const row: any = {};
                for (let i = 0; i < params.length; i++) row[`p${i + 1}`] = params[i];
                emails.push(row);
              }
              if (sql.includes('INSERT INTO attachments')) {
                attachments.push(params);
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
}

const aliases = [
  { id: 'alias-1', local_part: 'newsletter', domain: 'rizpedia.com', is_enabled: 1 },
  { id: 'alias-2', local_part: 'disabled', domain: 'rizpedia.com', is_enabled: 0 },
];

function makeR2Mock() {
  const objects = new Map<string, any>();
  return {
    objects,
    async put(key: string, value: any) { objects.set(key, value); return {}; },
    async get(key: string) { return objects.get(key) || null; },
    async delete(key: string) { objects.delete(key); return {}; },
  };
}

describe('emailHandler', () => {
  let d1: any;
  let rawBucket: any;
  let attBucket: any;
  let htmlBucket: any;
  let env: any;

  beforeEach(() => {
    d1 = makeD1Mock();
    rawBucket = makeR2Mock();
    attBucket = makeR2Mock();
    htmlBucket = makeR2Mock();
    env = {
      DB: d1,
      RAW_BUCKET: rawBucket,
      ATTACHMENTS_BUCKET: attBucket,
      HTML_BUCKET: htmlBucket,
      ADMIN_EMAIL: 'me@rizpedia.com',
      ACCESS_TEAM_DOMAIN: '',
      ACCESS_AUD: '',
    };
  });

  it('stores a parsed email to D1 + R2', async () => {
    const eml = readFileSync(join(import.meta.dir, 'fixtures', 'basic.eml'));
    let rejected: string | null = null;
    const message = {
      to: 'newsletter@rizpedia.com',
      from: 'jane.doe@gmail.com',
      headers: new Headers(),
      raw: eml.buffer.slice(eml.byteOffset, eml.byteOffset + eml.byteLength),
      setReject: (r: string) => { rejected = r; },
      forward: async () => {},
      reply: async () => {},
    };

    await emailHandler(message as any, env);

    expect(rejected).toBeNull();
    expect(d1.emails.length).toBe(1);
    const row = d1.emails[0]!;
    expect(row.p2).toBe('alias-1');
    expect(row.p4).toBe('jane.doe@gmail.com'); // from_address
    expect(row.p7).toContain('Hello from Jane'); // subject
    // snippet non-empty
    expect(row.p9.length).toBeGreaterThan(0);
    // raw key stored
    expect(rawBucket.objects.has(row.p10)).toBe(true);
    // Body stored as sent, minus anything executable: the layout is the point,
    // and remote images are withheld by the CSP when it is served rather than
    // by rewriting the source.
    const htmlKey = row.p11;
    expect(htmlBucket.objects.has(htmlKey)).toBe(true);
    const html = String(htmlBucket.objects.get(htmlKey));
    expect(html).not.toContain('<script');
    expect(html).toContain('<img src="https://example.com/tracking.png"');
    expect(html).toContain('<b>test</b>');
    expect(html).not.toContain('data-blocked-src');

    // …but counted, so the reading pane can offer to show them.
    expect(row.p15).toBe(1); // blocked_images
  });

  it('rejects unknown addresses via setReject', async () => {
    let rejected: string | null = null;
    const message = {
      to: 'nobody@rizpedia.com',
      from: 'x@y.com',
      headers: new Headers(),
      raw: new ArrayBuffer(10),
      setReject: (r: string) => { rejected = r; },
      forward: async () => {},
      reply: async () => {},
    };
    await emailHandler(message as any, env);
    expect(rejected as string | null).toBe('Address not found');
    expect(d1.emails.length).toBe(0);
  });

  it('rejects disabled aliases', async () => {
    let rejected: string | null = null;
    const message = {
      to: 'disabled@rizpedia.com',
      from: 'x@y.com',
      headers: new Headers(),
      raw: new ArrayBuffer(10),
      setReject: (r: string) => { rejected = r; },
      forward: async () => {},
      reply: async () => {},
    };
    await emailHandler(message as any, env);
    expect(rejected as string | null).toBe('Address not found');
    expect(d1.emails.length).toBe(0);
  });
});
