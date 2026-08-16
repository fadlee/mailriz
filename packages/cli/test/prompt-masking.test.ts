import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Secrets must not be typed in the clear.
 *
 * The wizard used clack's text() for the Cloudflare API token and the
 * dashboard password, so both echoed into the terminal — the token can delete
 * the Worker, the database and every stored message, and terminals get
 * recorded and shared.
 *
 * There is no way to drive an interactive prompt from a unit test, so this
 * reads the source instead. Crude, but it fails if someone swaps password()
 * back for text() while moving code around.
 */
describe('secret prompts are masked', () => {
  const src = readFileSync(join(import.meta.dir, '../src/cli.ts'), 'utf8');

  /** Every prompt call with its options object, roughly. */
  function promptsOfType(fn: 'text' | 'password'): string[] {
    const out: string[] = [];
    const re = new RegExp(`await ${fn}\\(\\{([\\s\\S]*?)\\}\\)`, 'g');
    for (const m of src.matchAll(re)) out.push(m[1]!);
    return out;
  }

  it('never asks for a token or password with an echoing prompt', () => {
    const echoing = promptsOfType('text');
    const offenders = echoing.filter((body) => /token|password/i.test(body));
    expect(offenders).toEqual([]);
  });

  it('does mask them somewhere — the check above cannot pass by deleting the prompts', () => {
    const masked = promptsOfType('password');
    expect(masked.length).toBeGreaterThanOrEqual(4);
    expect(masked.some((b) => /token/i.test(b))).toBe(true);
    expect(masked.some((b) => /password/i.test(b))).toBe(true);
  });
});
