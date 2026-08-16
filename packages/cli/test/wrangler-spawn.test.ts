import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * How wrangler is spawned, pinned.
 *
 * `setup` and `update` used to hang forever at "worker redeploying…". The
 * deploy had already landed; what never finished was the wait. Anything that
 * waits for the child's stdio to end — execFile, or spawn with a piped stdout
 * — waits on a handle wrangler can leave open after a successful deploy.
 *
 * The first fix swapped stdout to 'inherit', which ends the wait but lets
 * wrangler's output tear through the task list, which repaints every 80ms with
 * cursor moves. 'ignore' avoids both.
 *
 * A child process cannot be driven from a unit test, so this reads the source.
 * Crude, but it fails if either mistake comes back.
 */
describe('wrangler is spawned without waiting on stdout', () => {
  const src = readFileSync(join(import.meta.dir, '../src/cli.ts'), 'utf8');

  /** The stdio tuple passed to each spawn() call. */
  const stdioTuples = [...src.matchAll(/stdio:\s*\[([^\]]*)\]/g)].map((m) => m[1]!);

  it('spawns wrangler at all', () => {
    expect(stdioTuples.length).toBeGreaterThan(0);
  });

  it('never inherits stdout — that is what tears the task list', () => {
    for (const tuple of stdioTuples) {
      const stdout = tuple.split(',')[1]?.trim();
      expect(stdout).not.toContain('inherit');
    }
  });

  it('never pipes stdout — that is what hung the deploy', () => {
    for (const tuple of stdioTuples) {
      const stdout = tuple.split(',')[1]?.trim();
      expect(stdout).toContain('ignore');
    }
  });

  it('still captures stderr, so a failure can say why', () => {
    for (const tuple of stdioTuples) {
      const stderr = tuple.split(',')[2]?.trim();
      expect(stderr).toContain('pipe');
    }
  });

  it('does not deploy through execFile, which waits on stdio', () => {
    expect(src).not.toMatch(/execFileP\([^)]*wranglerBin[^)]*'deploy'/);
    expect(src).toMatch(/runWrangler\(\['deploy'\]/);
  });
});
