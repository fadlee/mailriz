/**
 * Session credential format — the contract between the CLI (which mints it)
 * and the Worker (which verifies it). It lives here so the two cannot drift:
 * a mismatch locks the owner out of their own dashboard.
 *
 * Everything below runs on WebCrypto only, because it has to work in both
 * Workers and Node without a polyfill.
 */

/**
 * `pbkdf2:<iterations>:<salt-b64>:<hash-b64>`
 *
 * Colon-separated, not the `$` of modular crypt format. `.dev.vars` and
 * `.env` files treat `$` as variable expansion — quoting does not save it —
 * so a `$`-delimited hash arrives at the Worker truncated and unverifiable.
 * Base64 never produces a colon, so it is unambiguous.
 */
export const PASSWORD_PREFIX = 'pbkdf2';

/**
 * OWASP's floor for PBKDF2-HMAC-SHA256 at the time of writing. Stored inside
 * each hash rather than read from here at verify time, so raising it later
 * does not invalidate existing passwords.
 */
export const PBKDF2_ITERATIONS = 100_000;

const SEP = ':';
const SALT_BYTES = 16;
const HASH_BITS = 256;

/**
 * Hand a byte array to WebCrypto.
 *
 * This file compiles twice — with the DOM lib for the Worker, without it for
 * the CLI — and the two disagree on how to type binary arguments: one wants
 * `BufferSource`, which the other has never heard of, and TypeScript's generic
 * `Uint8Array` will not narrow to it because it could be backed by a
 * SharedArrayBuffer. Rather than widen either package's lib for a type that
 * does not exist at runtime, the mismatch is confined to this one function.
 */
function bin(bytes: Uint8Array): any {
  return bytes;
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: bin(salt), iterations, hash: 'SHA-256' },
    key,
    HASH_BITS
  );
  return new Uint8Array(bits);
}

/** Hash a password for storage. A fresh salt every call. */
export async function hashPassword(
  password: string,
  iterations = PBKDF2_ITERATIONS
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations);
  return [PASSWORD_PREFIX, iterations, b64(salt), b64(hash)].join(SEP);
}

/**
 * Does this string look like something we can verify at all?
 *
 * Used to tell "wrong password" apart from "this deployment still carries a
 * bare SHA-256 from an older release" — the latter is a misconfiguration the
 * owner has to fix, not a failed login.
 */
export function isSupportedPasswordHash(stored: string): boolean {
  const parts = (stored || '').split(SEP);
  if (parts.length !== 4 || parts[0] !== PASSWORD_PREFIX) return false;
  const iterations = Number(parts[1]);
  return Number.isInteger(iterations) && iterations > 0 && !!parts[2] && !!parts[3];
}

/**
 * Verify a password against a stored hash, reading salt and iterations from
 * the hash itself. Returns false for anything unparseable rather than
 * throwing — callers decide what an unusable hash means.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!isSupportedPasswordHash(stored)) return false;
  const [, iterStr, saltB64, hashB64] = stored.split(SEP);
  let expected: Uint8Array;
  let actual: Uint8Array;
  try {
    expected = unb64(hashB64!);
    actual = await derive(password, unb64(saltB64!), Number(iterStr));
  } catch {
    return false;
  }
  return timingSafeEqualBytes(actual, expected);
}

/**
 * Constant-time comparison.
 *
 * Workers exposes crypto.subtle.timingSafeEqual; Node's WebCrypto does not, so
 * the CLI and the test runner fall back to a manual loop. The fallback still
 * compares every byte — returning early on the first mismatch is exactly the
 * leak this function exists to avoid.
 */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  const subtle = crypto.subtle as unknown as {
    timingSafeEqual?: (x: any, y: any) => boolean;
  };
  if (a.byteLength !== b.byteLength) {
    // Comparing against itself keeps the work constant; the differing length
    // is the answer, and returning it directly would leak nothing more.
    if (subtle.timingSafeEqual) subtle.timingSafeEqual(bin(a), bin(a));
    return false;
  }
  if (subtle.timingSafeEqual) {
    return subtle.timingSafeEqual(bin(a), bin(b));
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** A fresh cookie signing key, hex-encoded. Never derived from the password. */
export function generateSigningKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Sign the session cookie payload with HMAC-SHA256 under a dedicated key.
 *
 * The old scheme signed with the password hash itself, which meant anyone who
 * could read that value — it was a plain Worker var — could mint a session
 * without ever knowing the password.
 */
export async function signSession(payload: string, signingKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compare a presented signature against a freshly computed one. */
export async function verifySession(
  payload: string,
  signature: string,
  signingKey: string
): Promise<boolean> {
  const expected = await signSession(payload, signingKey);
  const enc = new TextEncoder();
  return timingSafeEqualBytes(enc.encode(signature), enc.encode(expected));
}
