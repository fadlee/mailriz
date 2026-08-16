import { describe, it, expect } from 'bun:test';
import {
  hashPassword, verifyPassword, isSupportedPasswordHash,
  generateSigningKey, signSession, verifySession, PBKDF2_ITERATIONS,
} from '@mailriz/shared';

/**
 * The credential format is a contract between the CLI (which mints it) and the
 * Worker (which verifies it). If the two ever disagree the owner is locked out
 * of their own dashboard, so it is pinned from both sides.
 */
describe('password hashing', () => {
  it('produces the documented shape', async () => {
    const h = await hashPassword('correct-horse-battery', 1_000);
    const [scheme, iterations, salt, hash] = h.split(':');
    expect(scheme).toBe('pbkdf2');
    expect(Number(iterations)).toBe(1_000);
    expect(salt!.length).toBeGreaterThan(0);
    expect(hash!.length).toBeGreaterThan(0);
  });

  it('defaults to the production work factor', async () => {
    const h = await hashPassword('correct-horse-battery');
    expect(Number(h.split(':')[1])).toBe(PBKDF2_ITERATIONS);
  });

  it('salts, so two hashes of one password differ', async () => {
    const a = await hashPassword('same-password-twice', 1_000);
    const b = await hashPassword('same-password-twice', 1_000);
    expect(a).not.toBe(b);
  });

  it('verifies with the parameters stored in the hash', async () => {
    const h = await hashPassword('correct-horse-battery', 3_000);
    expect(await verifyPassword('correct-horse-battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });

  it('rejects the old bare SHA-256 as unsupported rather than mismatched', async () => {
    const legacy = 'f52fbd32b2b3b86ff88ef6c490628285f482af15ddcb29541f94bcf526a3f6c7';
    expect(isSupportedPasswordHash(legacy)).toBe(false);
    expect(await verifyPassword('hunter2', legacy)).toBe(false);
  });

  it('treats malformed values as unsupported without throwing', async () => {
    for (const bad of ['', 'pbkdf2:', 'pbkdf2:abc:s:h', 'pbkdf2:0:s:h', 'x:1000:s:h']) {
      expect(isSupportedPasswordHash(bad)).toBe(false);
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });
});

describe('cookie signing', () => {
  it('generates a distinct 32-byte key each time', () => {
    const a = generateSigningKey();
    const b = generateSigningKey();
    expect(a).toHaveLength(64);
    expect(a).not.toBe(b);
  });

  it('verifies only under the key that signed it', async () => {
    const key = generateSigningKey();
    const sig = await signSession('owner@example.com.1789000000', key);
    expect(await verifySession('owner@example.com.1789000000', sig, key)).toBe(true);
    expect(await verifySession('owner@example.com.1789000000', sig, generateSigningKey())).toBe(false);
    expect(await verifySession('someone.else@x.test.1789000000', sig, key)).toBe(false);
  });
});
