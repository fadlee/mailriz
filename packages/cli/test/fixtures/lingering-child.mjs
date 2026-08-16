/**
 * Stands in for wrangler: does its work, exits cleanly, but leaves a
 * grandchild holding stderr open. That lingering handle is why 'close' never
 * fires and why the CLI used to sit at "worker redeploying…" indefinitely.
 */
import { spawn } from 'node:child_process';
process.stderr.write('deploying\n');
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
  stdio: ['ignore', 'ignore', 'inherit'],
  detached: true,
}).unref();
process.exit(Number(process.argv[2] ?? 0));
