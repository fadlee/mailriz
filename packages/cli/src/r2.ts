/**
 * Emptying R2 buckets, so `destroy` can actually delete them: Cloudflare
 * refuses to delete a bucket that still holds objects.
 *
 * The REST API has no bulk object delete, so this goes through R2's
 * S3-compatible endpoint, which wants SigV4 rather than a Bearer token. Its
 * credentials come from the API token already in hand — no second credential
 * to ask the operator for.
 */

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ALGORITHM = 'AWS4-HMAC-SHA256';
/** R2 is single-region; SigV4 still requires the field to be present. */
const REGION = 'auto';
const SERVICE = 's3';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

const enc = new TextEncoder();

/** WebCrypto wants a BufferSource, which TextEncoder's output is not. */
type Bytes = Uint8Array<ArrayBuffer>;

function bytes(s: string): Bytes {
  return new Uint8Array(enc.encode(s));
}

function hex(b: Bytes): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(input))));
}

async function hmac(key: Bytes, data: string): Promise<Bytes> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, bytes(data)));
}

/** Cloudflare's documented derivation; `tokenId` comes from /user/tokens/verify. */
export async function deriveS3Credentials(
  tokenId: string,
  tokenValue: string
): Promise<S3Credentials> {
  return { accessKeyId: tokenId, secretAccessKey: await sha256Hex(tokenValue) };
}

/**
 * Percent-encoding as SigV4 defines it, which is not what encodeURIComponent
 * does: `!'()*` must be escaped too, and `-_.~` must not be.
 */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/** Object keys carry `/`, which stays a path separator rather than %2F. */
function encodePath(path: string): string {
  return path.split('/').map(uriEncode).join('/');
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/** Exported for the signing tests; production goes through createR2Client. */
export async function signRequest(opts: {
  credentials: S3Credentials;
  method: string;
  host: string;
  path: string;
  query?: Record<string, string>;
  /** Hex SHA-256 of the body; every call here is bodyless. */
  payloadHash?: string;
  now: Date;
}): Promise<SignedRequest> {
  const { credentials, method, host, path, now } = opts;
  const payloadHash = opts.payloadHash || EMPTY_SHA256;

  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

  // Query parameters are signed sorted by encoded key.
  const query = opts.query || {};
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k]!)}`)
    .join('&');

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    method,
    encodePath(path),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  let key = bytes(`AWS4${credentials.secretAccessKey}`);
  for (const part of [dateStamp, REGION, SERVICE, 'aws4_request']) {
    key = await hmac(key, part);
  }
  const signature = hex(await hmac(key, stringToSign));

  return {
    url: `https://${host}${encodePath(path)}${canonicalQuery ? `?${canonicalQuery}` : ''}`,
    headers: {
      Authorization:
        `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
  };
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Ampersand last, so `&amp;lt;` does not become `<`.
    .replace(/&amp;/g, '&');
}

export interface ObjectPage {
  keys: string[];
  /** More objects exist beyond this page. */
  truncated: boolean;
}

/**
 * Parse a ListObjectsV2 response. Regex rather than an XML parser: `<Key>`
 * only appears inside `<Contents>` when no delimiter is set, which is the
 * only way this lists.
 */
export function parseListObjects(xml: string): ObjectPage {
  const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) =>
    decodeXmlEntities(m[1]!)
  );
  return {
    keys,
    truncated: /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml),
  };
}

export class R2Error extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Pull the human-readable part out of an S3 XML error body. */
function s3Error(status: number, body: string): R2Error {
  const code = body.match(/<Code>([\s\S]*?)<\/Code>/)?.[1];
  const message = body.match(/<Message>([\s\S]*?)<\/Message>/)?.[1];
  const detail = [code, message].filter(Boolean).join(': ');
  return new R2Error(status, detail || `S3 request failed with HTTP ${status}`);
}

export interface R2Client {
  listObjects(bucket: string): Promise<ObjectPage>;
  deleteObject(bucket: string, key: string): Promise<void>;
}

/** `now` is injectable so a test can pin the signature. */
export function createR2Client(
  accountId: string,
  credentials: S3Credentials,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date()
): R2Client {
  const host = `${accountId}.r2.cloudflarestorage.com`;

  const send = async (method: string, path: string, query?: Record<string, string>) => {
    const signed = await signRequest({ credentials, method, host, path, query, now: now() });
    const res = await fetchImpl(signed.url, { method, headers: signed.headers });
    if (!res.ok) throw s3Error(res.status, await res.text().catch(() => ''));
    return res;
  };

  return {
    async listObjects(bucket) {
      // No continuation token: emptyBucket deletes every key it is handed, so
      // the next listing from the top returns what used to be page two.
      const res = await send('GET', `/${bucket}`, { 'list-type': '2', 'max-keys': '1000' });
      return parseListObjects(await res.text());
    },
    async deleteObject(bucket, key) {
      await send('DELETE', `/${bucket}/${key}`);
    },
  };
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function pooled<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Delete every object in a bucket, a page at a time, and return how many
 * went. `onProgress` carries the running total for the task row.
 */
export async function emptyBucket(
  client: R2Client,
  bucket: string,
  onProgress?: (deleted: number) => void,
  concurrency = 16
): Promise<number> {
  let deleted = 0;
  let previous = '';

  for (;;) {
    const page = await client.listObjects(bucket);
    if (page.keys.length === 0) return deleted;

    // A page identical to the one just deleted means the deletes are not
    // sticking; failing beats spinning forever.
    const fingerprint = `${page.keys.length}:${page.keys[0]}`;
    if (fingerprint === previous) {
      throw new R2Error(0, `${bucket}: objects still listed after deletion — bucket is not emptying`);
    }
    previous = fingerprint;

    await pooled(page.keys, concurrency, async (key) => {
      await client.deleteObject(bucket, key);
      deleted++;
      onProgress?.(deleted);
    });
  }
}
