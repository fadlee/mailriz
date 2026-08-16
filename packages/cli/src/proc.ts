import { spawn } from 'node:child_process';

/**
 * Run a child process and resolve when it exits.
 *
 * The subtlety here cost two attempts, so it is worth stating plainly:
 *
 * `'close'` fires when the process has exited **and** every stdio stream has
 * ended. wrangler leaves a handle on its streams after a successful deploy —
 * a grandchild inherits them — so `'close'` may never fire at all. That is
 * what left `setup` and `update` sitting at "worker redeploying…" long after
 * Cloudflare had the new Worker. `execFile` has the same problem for the same
 * reason: it waits on stdio too.
 *
 * `'exit'` fires when the process is gone, full stop. That is the signal we
 * actually want. The streams are destroyed immediately after, both to release
 * the handle and because an open pipe would otherwise keep *our* process
 * alive at the end of a command.
 *
 * stderr is still captured so a failure can say why. On a non-zero exit we
 * allow a brief moment for it to flush — bounded, never waited on.
 */
export function spawnAndWait(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; flushMs?: number }
): Promise<void> {
  const flushMs = opts.flushMs ?? 150;

  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      // stdout is discarded: piping it makes us wait on a stream that may not
      // end, and inheriting it tears through the live task list, which
      // repaints with cursor moves several times a second.
      stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', reject);

    child.on('exit', (code) => {
      const done = () => {
        child.stderr?.destroy();
        child.stdout?.destroy();
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `${args.join(' ')} exited ${code}`));
      };
      // A clean exit needs nothing from stderr, so do not wait on it at all.
      if (code === 0) done();
      else setTimeout(done, flushMs);
    });

    if (opts.stdin !== undefined) child.stdin!.end(opts.stdin);
  });
}
