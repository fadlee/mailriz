import { describe, it, expect } from 'bun:test';
import { resolveToken, validateToken, sourceHint, hasFallback } from '../src/token';

/**
 * Reusing the Cloudflare token on an existing install.
 *
 * `update` advertised "same one you used for setup" and then rejected a blank
 * line as "Too short". Two things were wrong: a clack `placeholder` is grey
 * hint text, never a default value — and no token was ever saved, so there
 * was nothing to reuse in the first place.
 */

const TOKEN = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

describe('validateToken', () => {
  it('accepts an empty answer when a token is saved — the reported bug', () => {
    expect(validateToken('', { stored: TOKEN })).toBeUndefined();
  });

  it('accepts an empty answer when the environment carries one', () => {
    expect(validateToken('', { env: TOKEN })).toBeUndefined();
  });

  it('rejects an empty answer only when there is nothing to fall back to', () => {
    expect(validateToken('', {})).toBe('No saved token — paste one');
  });

  it('treats whitespace as empty', () => {
    expect(validateToken('   ', { stored: TOKEN })).toBeUndefined();
    expect(validateToken('   ', {})).toBe('No saved token — paste one');
  });

  it('still rejects something too short to be a token', () => {
    expect(validateToken('abc', {})).toBe('Token looks too short');
    // Even with a fallback available: a typo shouldn't silently fall through
    // to a different token than the one being typed.
    expect(validateToken('abc', { stored: TOKEN })).toBe('Token looks too short');
  });

  it('accepts a pasted token', () => {
    expect(validateToken(TOKEN, {})).toBeUndefined();
  });
});

describe('resolveToken', () => {
  it('uses the saved token when nothing is typed', () => {
    expect(resolveToken('', { stored: TOKEN })).toBe(TOKEN);
  });

  it('uses the environment when nothing is typed and nothing is saved', () => {
    expect(resolveToken('', { env: TOKEN })).toBe(TOKEN);
  });

  it('prefers what was typed over both', () => {
    expect(resolveToken(OTHER, { stored: TOKEN, env: TOKEN })).toBe(OTHER);
  });

  it('prefers the saved token over the environment', () => {
    // The one tied to this install beats whatever happens to be exported.
    expect(resolveToken('', { stored: TOKEN, env: OTHER })).toBe(TOKEN);
  });

  it('trims what was typed', () => {
    expect(resolveToken(`  ${TOKEN}  `, {})).toBe(TOKEN);
  });

  it('returns empty when there is genuinely nothing', () => {
    expect(resolveToken('', {})).toBe('');
  });
});

describe('sourceHint', () => {
  it('names what Enter will actually do, rather than promising a reuse that does not exist', () => {
    expect(sourceHint({ stored: TOKEN })).toBe('Enter to use the saved token');
    expect(sourceHint({ env: TOKEN })).toBe('Enter to use $CLOUDFLARE_API_TOKEN');
    expect(sourceHint({})).toBe('paste your token');
  });
});

describe('hasFallback', () => {
  it('reports whether Enter can work at all', () => {
    expect(hasFallback({ stored: TOKEN })).toBe(true);
    expect(hasFallback({ env: TOKEN })).toBe(true);
    expect(hasFallback({})).toBe(false);
  });
});
