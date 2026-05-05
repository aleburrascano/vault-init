import { createRequire } from 'node:module';

const _req = createRequire(import.meta.url);

export interface StatementLike {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface DbLike {
  exec(sql: string): unknown;
  prepare(sql: string): StatementLike;
  close(): void;
}

/**
 * Returns true if node:sqlite's bundled SQLite was compiled with FTS5.
 * Uses a throw-away :memory: database — never touches any real file.
 *
 * On Linux and Mac, Node.js compiles SQLite with SQLITE_ENABLE_FTS5.
 * On Windows (Node 22.x), the MSVC build omits FTS5, so this returns
 * false and openFts5Db() falls back to better-sqlite3.
 */
export function hasFts5(): boolean {
  try {
    const { DatabaseSync } = _req('node:sqlite') as typeof import('node:sqlite');
    const probe = new DatabaseSync(':memory:');
    probe.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
    probe.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a SQLite database with FTS5 support.
 *
 * Strategy:
 *  1. If node:sqlite has FTS5 (Linux, Mac) use it — zero extra dependency.
 *  2. Otherwise fall back to better-sqlite3 (optionalDependency), which
 *     ships prebuilt binaries with FTS5 enabled on all platforms including
 *     Windows.
 *
 * Throws a plain Error (not VaultkitError — this is infrastructure, not
 * a user-facing command) if neither backend provides FTS5, telling the
 * user exactly how to fix it.
 */
export function openFts5Db(path: string): DbLike {
  if (hasFts5()) {
    const { DatabaseSync } = _req('node:sqlite') as typeof import('node:sqlite');
    return new DatabaseSync(path) as unknown as DbLike;
  }
  try {
    const Database = _req('better-sqlite3') as unknown as new (path: string) => DbLike;
    return new Database(path);
  } catch {
    throw new Error(
      'FTS5 is not available in node:sqlite on this platform and ' +
        'better-sqlite3 is not installed.\n' +
        'Run: npm install better-sqlite3',
    );
  }
}
