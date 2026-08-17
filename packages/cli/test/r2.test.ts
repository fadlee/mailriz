import { describe, it, expect } from 'bun:test';
import {
  signRequest, deriveS3Credentials, parseListObjects, emptyBucket,
  createR2Client, R2Error, type R2Client, type ObjectPage,
} from '../src/r2';

/**
 * R2 teardown. Cloudflare refuses to delete a bucket that still holds
 * objects, so emptying them first is what makes the "deleted" row true — and
 * that goes through R2's S3 endpoint, which means SigV4.
 */

const CREDS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const HOST = 'abc123.r2.cloudflarestorage.com';
const AT = new Date('2026-08-17T09:30:00Z');

describe('sigv4 signing', () => {
  /**
   * Checked against the `aws4` reference implementation and pinned: a signing
   * bug surfaces only as a 403 with no hint as to which byte was wrong.
   */
  it('matches the reference signature for a listing', async () => {
    const signed = await signRequest({
      credentials: CREDS, method: 'GET', host: HOST, path: '/mailriz-raw',
      query: { 'list-type': '2', 'max-keys': '1000' }, now: AT,
    });
    expect(signed.url).toBe(`https://${HOST}/mailriz-raw?list-type=2&max-keys=1000`);
    expect(signed.headers.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260817/auto/s3/aws4_request, ' +
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
      'Signature=a68c5828177ab1222235528896ca78f1ea9c959127b412dfe9d3914310abe212'
    );
  });

  it('matches the reference signature for a key containing a space', async () => {
    const signed = await signRequest({
      credentials: CREDS, method: 'DELETE', host: HOST,
      path: '/mailriz-raw/my report.eml', now: AT,
    });
    // %20, not '+' — the other form signs to a signature R2 rejects.
    expect(signed.url).toBe(`https://${HOST}/mailriz-raw/my%20report.eml`);
    expect(signed.headers.Authorization).toEndWith(
      'Signature=e7c979e98d25ccd7cfc5f7fe149cf91b434a2ff1736de57ff93240848552e968'
    );
  });

  it('keeps slashes in object keys as path separators', async () => {
    const signed = await signRequest({
      credentials: CREDS, method: 'DELETE', host: HOST,
      path: '/mailriz-attachments/2026/08/msg-1.pdf', now: AT,
    });
    expect(signed.url).toBe(`https://${HOST}/mailriz-attachments/2026/08/msg-1.pdf`);
  });

  it('escapes the characters encodeURIComponent leaves alone', async () => {
    const signed = await signRequest({
      credentials: CREDS, method: 'DELETE', host: HOST,
      path: "/mailriz-raw/x(y)!'.eml", now: AT,
    });
    expect(signed.url).toContain('%28y%29%21%27');
  });

  it('sends the empty-body hash and the signing date', async () => {
    const signed = await signRequest({
      credentials: CREDS, method: 'GET', host: HOST, path: '/b', now: AT,
    });
    expect(signed.headers['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(signed.headers['x-amz-date']).toBe('20260817T093000Z');
  });
});

describe('credential derivation', () => {
  it('uses the token id as key and the SHA-256 of the token as secret', async () => {
    const creds = await deriveS3Credentials('token-id-1', 'super-secret-token-value');
    expect(creds.accessKeyId).toBe('token-id-1');
    expect(creds.secretAccessKey).toBe(
      Bun.SHA256.hash('super-secret-token-value', 'hex')
    );
  });
});

describe('parseListObjects', () => {
  it('reads keys and the truncation flag', () => {
    const page = parseListObjects(`
      <ListBucketResult>
        <IsTruncated>true</IsTruncated>
        <Contents><Key>a.eml</Key><Size>10</Size></Contents>
        <Contents><Key>b/c.eml</Key><Size>20</Size></Contents>
      </ListBucketResult>`);
    expect(page.keys).toEqual(['a.eml', 'b/c.eml']);
    expect(page.truncated).toBe(true);
  });

  it('decodes XML entities in keys', () => {
    // Deleting the escaped form would leave the object, and so the bucket.
    const page = parseListObjects(
      '<Contents><Key>a&amp;b.eml</Key></Contents>' +
      '<Contents><Key>x&lt;y&gt;.eml</Key></Contents>' +
      '<Contents><Key>q&quot;r&apos;s</Key></Contents>'
    );
    expect(page.keys).toEqual(['a&b.eml', 'x<y>.eml', 'q"r\'s']);
  });

  it('reads an empty bucket as no keys', () => {
    const page = parseListObjects('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>');
    expect(page.keys).toEqual([]);
    expect(page.truncated).toBe(false);
  });
});

/** A client backed by an in-memory bucket. */
function fakeBucket(keys: string[], pageSize = 1000): R2Client & { remaining: () => string[] } {
  let store = [...keys];
  return {
    remaining: () => store,
    async listObjects(): Promise<ObjectPage> {
      return { keys: store.slice(0, pageSize), truncated: store.length > pageSize };
    },
    async deleteObject(_bucket: string, key: string) {
      store = store.filter((k) => k !== key);
    },
  };
}

describe('emptyBucket', () => {
  it('deletes every object', async () => {
    const client = fakeBucket(['a', 'b', 'c']);
    expect(await emptyBucket(client, 'mailriz-raw')).toBe(3);
    expect(client.remaining()).toEqual([]);
  });

  it('pages through a bucket larger than one listing', async () => {
    // The listing caps at 1000 keys; stopping there leaves the bucket
    // non-empty and so undeletable.
    const client = fakeBucket(Array.from({ length: 2500 }, (_, i) => `msg-${i}.eml`), 1000);
    expect(await emptyBucket(client, 'mailriz-raw')).toBe(2500);
    expect(client.remaining()).toEqual([]);
  });

  it('does nothing to an already empty bucket', async () => {
    const client = fakeBucket([]);
    expect(await emptyBucket(client, 'mailriz-raw')).toBe(0);
  });

  it('reports progress as it goes', async () => {
    const seen: number[] = [];
    await emptyBucket(fakeBucket(['a', 'b']), 'mailriz-raw', (n) => seen.push(n), 1);
    expect(seen).toEqual([1, 2]);
  });

  it('propagates a delete failure instead of reporting the bucket empty', async () => {
    const client: R2Client = {
      async listObjects() { return { keys: ['locked.eml'], truncated: false }; },
      async deleteObject() { throw new R2Error(403, 'AccessDenied'); },
    };
    await expect(emptyBucket(client, 'mailriz-raw')).rejects.toThrow(/AccessDenied/);
  });

  it('gives up rather than spinning when objects will not go away', async () => {
    const client: R2Client = {
      async listObjects() { return { keys: ['ghost.eml'], truncated: false }; },
      async deleteObject() { /* silently does nothing */ },
    };
    await expect(emptyBucket(client, 'mailriz-raw')).rejects.toThrow(/not emptying/);
  });
});

describe('createR2Client', () => {
  it('signs the listing and reads back the keys', async () => {
    let seen = { url: '', auth: '', method: '' };
    const fetchImpl = (async (url: any, init: any) => {
      seen = { url: String(url), auth: init.headers.Authorization, method: init.method };
      return new Response(
        '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>a.eml</Key></Contents></ListBucketResult>',
        { status: 200 }
      );
    }) as typeof fetch;

    const client = createR2Client('abc123', CREDS, fetchImpl, () => AT);
    expect((await client.listObjects('mailriz-raw')).keys).toEqual(['a.eml']);
    expect(seen.url).toBe(`https://${HOST}/mailriz-raw?list-type=2&max-keys=1000`);
    expect(seen.auth).toStartWith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/');
  });

  it('surfaces the S3 error code and message', async () => {
    const fetchImpl = (async () =>
      new Response('<Error><Code>AccessDenied</Code><Message>no r2 scope</Message></Error>', {
        status: 403,
      })) as typeof fetch;

    const client = createR2Client('abc123', CREDS, fetchImpl, () => AT);
    // A bare "HTTP 403" leaves the operator guessing which scope is missing.
    await expect(client.listObjects('mailriz-raw')).rejects.toThrow(/AccessDenied: no r2 scope/);
  });
});
