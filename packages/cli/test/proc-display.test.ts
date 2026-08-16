import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One property that a functional test cannot reach: wrangler's stdout must not
 * be inherited.
 *
 * Inheriting does not hang anything — it prints. But the task list repaints
 * with cursor-up escapes several times a second, and wrangler's own output
 * tears straight through it, leaving a smeared screen. Nothing observable from
 * inside a test, so this reads the source.
 *
 * Everything else about the spawn — that it does not wait on a held-open
 * stream, that stderr still reaches the error — is covered for real in
 * proc.test.ts.
 */
describe('wrangler output does not fight the task list', () => {
  const src = readFileSync(join(import.meta.dir, '../src/proc.ts'), 'utf8');

  it('discards stdout rather than inheriting it', () => {
    const stdio = src.match(/stdio:\s*\[([^\]]*)\]/)?.[1];
    expect(stdio).toBeDefined();
    const stdout = stdio!.split(',')[1]?.trim();
    expect(stdout).toBe("'ignore'");
  });

  it('keeps stderr so failures can be explained', () => {
    const stdio = src.match(/stdio:\s*\[([^\]]*)\]/)?.[1];
    expect(stdio!.split(',')[2]?.trim()).toContain('pipe');
  });
});
