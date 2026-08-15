import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations, alreadyApplied } from '../src/migrate';

/**
 * Migrations must be applied once each.
 *
 * Every file used to be replayed on each setup and update. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so the second run of any migration containing
 * an ALTER failed with "duplicate column name" and aborted the command — a
 * deployed installation could never be updated again.
 */

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mailriz-migrations-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeMigrations(files: Record<string, string>): Promise<string[]> {
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(join(dir, name), sql);
  }
  return Object.keys(files).sort();
}

/**
 * Minimal SQLite stand-in: tracks the migrations table and fails ALTERs that
 * would add a column twice, which is the behaviour that caused the bug.
 */
function makeDb(preExistingColumns: string[] = []) {
  const recorded = new Set<string>();
  const columns = new Set(preExistingColumns);
  const executed: string[] = [];
  let tableExists = false;

  const run = async (sql: string): Promise<unknown> => {
    if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) {
      tableExists = true;
      return {};
    }
    if (/SELECT name FROM schema_migrations/i.test(sql)) {
      if (!tableExists) throw new Error('no such table: schema_migrations');
      return { results: [...recorded].map((name) => ({ name })) };
    }
    const insert = sql.match(/INSERT OR IGNORE INTO schema_migrations \(name\) VALUES \('(.+)'\);/i);
    if (insert) {
      recorded.add(insert[1]!.replace(/''/g, "'"));
      return {};
    }

    executed.push(sql);
    const alter = sql.match(/ADD COLUMN (\w+)/i);
    if (alter) {
      const col = alter[1]!;
      if (columns.has(col)) throw new Error(`duplicate column name: ${col}`);
      columns.add(col);
    }
    return {};
  };

  return { run, recorded, executed, columns };
}

describe('applyMigrations', () => {
  it('applies each file once', async () => {
    const files = await writeMigrations({
      '0001_init.sql': 'CREATE TABLE IF NOT EXISTS a (id TEXT);',
      '0002_alter.sql': 'ALTER TABLE a ADD COLUMN is_auto INTEGER;',
    });
    const db = makeDb();

    expect(await applyMigrations(db.run, dir, files)).toEqual(files);
    expect(db.recorded).toEqual(new Set(files));
  });

  it('is a no-op on the second run — the bug that blocked every update', async () => {
    const files = await writeMigrations({
      '0001_init.sql': 'CREATE TABLE IF NOT EXISTS a (id TEXT);',
      '0002_alter.sql': 'ALTER TABLE a ADD COLUMN is_auto INTEGER;',
    });
    const db = makeDb();

    await applyMigrations(db.run, dir, files);
    const second = await applyMigrations(db.run, dir, files);

    expect(second).toEqual([]);
    // The ALTER is never sent again, so it cannot fail as a duplicate.
    expect(db.executed.filter((s) => /ADD COLUMN/i.test(s))).toHaveLength(1);
  });

  it('applies only what is new when a release adds a migration', async () => {
    const first = await writeMigrations({ '0001_init.sql': 'CREATE TABLE IF NOT EXISTS a (id TEXT);' });
    const db = makeDb();
    await applyMigrations(db.run, dir, first);

    const all = await writeMigrations({
      '0001_init.sql': 'CREATE TABLE IF NOT EXISTS a (id TEXT);',
      '0002_alter.sql': 'ALTER TABLE a ADD COLUMN is_auto INTEGER;',
    });

    expect(await applyMigrations(db.run, dir, all)).toEqual(['0002_alter.sql']);
  });

  it('adopts migrations already present in a pre-tracking install', async () => {
    const files = await writeMigrations({
      '0002_alter.sql': 'ALTER TABLE a ADD COLUMN is_auto INTEGER;',
      '0003_next.sql': 'ALTER TABLE a ADD COLUMN content_id TEXT;',
    });
    // is_auto exists already: this installation ran 0002 before tracking did.
    const db = makeDb(['is_auto']);

    const applied = await applyMigrations(db.run, dir, files);

    // 0002 is adopted rather than reported as applied, and does not abort.
    expect(applied).toEqual(['0003_next.sql']);
    expect(db.recorded).toEqual(new Set(files));
    expect(db.columns.has('content_id')).toBe(true);
  });

  it('propagates a genuine failure instead of swallowing it', async () => {
    const files = await writeMigrations({ '0001_broken.sql': 'THIS IS NOT SQL;' });
    const db = makeDb();
    const run = async (sql: string) => {
      if (/THIS IS NOT SQL/.test(sql)) throw new Error('near "THIS": syntax error');
      return db.run(sql);
    };

    await expect(applyMigrations(run, dir, files)).rejects.toThrow(/syntax error/);
    expect(db.recorded.size).toBe(0);
  });
});

describe('alreadyApplied', () => {
  it('recognises the errors that mean the change is present', () => {
    expect(alreadyApplied('duplicate column name: is_auto')).toBe(true);
    expect(alreadyApplied('index idx_x already exists')).toBe(true);
  });

  it('does not swallow anything else', () => {
    expect(alreadyApplied('near "THIS": syntax error')).toBe(false);
    expect(alreadyApplied('no such table: aliases')).toBe(false);
  });
});
