import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Schema migrations, applied once each.
 *
 * Every file used to be replayed on each setup and update. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so the second run of any migration containing an
 * ALTER failed with "duplicate column name" and aborted the whole command.
 *
 * Lives in its own module so it can be tested: cli.ts dispatches a command on
 * import and cannot be pulled into a test.
 */

/** Runs one SQL script against the database. */
export type RunSql = (sql: string) => Promise<unknown>;

/** Errors meaning the migration's effect is already present in the schema. */
export function alreadyApplied(message: string): boolean {
  return /duplicate column name|already exists/i.test(message);
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Pull rows out of a D1 response, which nests them differently per driver. */
function resultRows(res: unknown): { name: string }[] {
  const any = res as any;
  return any?.[0]?.results ?? any?.results ?? [];
}

/**
 * Apply the migrations that haven't run yet; return the names executed.
 *
 * Installations predating the tracking table have their schema already
 * changed but nothing recorded, so a migration that fails as already-applied
 * is adopted rather than treated as an error. Anything else propagates.
 */
export async function applyMigrations(
  run: RunSql,
  dir: string,
  files: string[]
): Promise<string[]> {
  await run(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at INTEGER NOT NULL DEFAULT (unixepoch())
     );`
  );

  const done = new Set(resultRows(await run('SELECT name FROM schema_migrations;')).map((r) => r.name));
  const applied: string[] = [];

  for (const name of files) {
    if (done.has(name)) continue;

    const sql = await readFile(join(dir, name), 'utf8');
    try {
      await run(sql);
      applied.push(name);
    } catch (e: any) {
      if (!alreadyApplied(String(e?.message || ''))) throw e;
      // Schema already carries this change from a pre-tracking install.
    }
    await run(`INSERT OR IGNORE INTO schema_migrations (name) VALUES (${sqlString(name)});`);
  }

  return applied;
}
