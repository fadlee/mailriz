import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { spawnAndWait } from '../src/proc';

/**
 * The deploy hang, pinned by actually running a process.
 *
 * An earlier attempt at this bug was covered only by a test that read the
 * source and checked the stdio tuple. It passed while the hang was still
 * there, because the problem was never stdio configuration on its own — it
 * was waiting for 'close', which needs every stream to end. wrangler leaves a
 * handle open, so that wait never finishes.
 *
 * These run a child that reproduces exactly that shape.
 */
const FIXTURE = join(import.meta.dir, 'fixtures', 'lingering-child.mjs');
const opts = { cwd: import.meta.dir, env: process.env };

describe('spawnAndWait', () => {
  it('resolves once the child exits, even with a stream still held open', async () => {
    const t0 = Date.now();
    await spawnAndWait(process.execPath, [FIXTURE], opts);
    const ms = Date.now() - t0;
    // The grandchild holds stderr for 30s. Waiting on 'close' would blow past
    // this; waiting on 'exit' comes back immediately.
    expect(ms).toBeLessThan(3_000);
  });

  it('rejects with stderr when the child fails', async () => {
    await expect(
      spawnAndWait(process.execPath, [FIXTURE, '1'], opts)
    ).rejects.toThrow(/deploying/);
  });

  it('reports the exit code when there is nothing on stderr', async () => {
    await expect(
      spawnAndWait(process.execPath, ['-e', 'process.exit(3)'], { ...opts, flushMs: 10 })
    ).rejects.toThrow(/exited 3/);
  });

  it('feeds stdin when given', async () => {
    // Echoes stdin to stderr and fails, so the message proves it arrived.
    await expect(
      spawnAndWait(
        process.execPath,
        ['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{process.stderr.write(d);process.exit(1)})'],
        { ...opts, stdin: 'hello-from-stdin' }
      )
    ).rejects.toThrow(/hello-from-stdin/);
  });
});
