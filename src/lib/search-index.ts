import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type DbLike, openFts5Db } from './sqlite-backend.js';

/**
 * SQLite FTS5 + BM25 search index for vaultkit-managed vaults. Owns the
 * schema, upsert/delete operations, and BM25-ranked queries. Used by:
 *
 *  - `src/lib/search-indexer.ts` — walks vaults and populates the index
 *  - `src/commands/mcp-server.ts` — the per-vault MCP server that
 *    answers `vk_search` queries by calling `query()` here
 *  - `vaultkit init`/`update`/`pull`/`destroy`/`disconnect` — wire the
 *    indexer into the lifecycle so the index stays current without
 *    user action
 *
 * Backed by Node's built-in `node:sqlite` (Node ≥22.13). Same SQLite,
 * same FTS5, same BM25 ranking as the previous `better-sqlite3` build —
 * the only difference is zero install footprint because SQLite ships
 * with Node itself. See ADR-0011 for the rationale.
 *
 * **BM25 weighting**: title 5x, tags 3x, body 1x. A query like "token
 * optimization" against a vault containing a note titled "Token
 * Efficiency" ranks the title-match high even though the body never
 * mentions "optimization" — that's the failure mode this whole module
 * exists to fix.
 *
 * **Why FTS5, not embeddings**: see ADR-0010 (kept relevant by ADR-0011).
 * tl;dr: keyword + title weighting handles ~80% of natural-language
 * queries, costs zero dependencies, and matches Obsidian's structural
 * vocabulary (titles, tags) instead of flattening notes into RAG-style
 * vector blobs.
 */

/** Default DB path: `~/.vaultkit-search.db`. Keeps it out of any vault dir. */
export function defaultSearchDbPath(): string {
  return join(homedir(), '.vaultkit-search.db');
}

/**
 * One indexed note. `vault` + `path` is the composite key — re-indexing
 * a file is an `INSERT OR REPLACE` keyed on that pair.
 */
export interface IndexRecord {
  /** Vault name (matches the registry key in `~/.claude.json`). */
  vault: string;
  /** Vault-relative path, forward-slash, e.g. `wiki/concepts/Foo.md`. */
  path: string;
  /** Title from frontmatter or first H1. Empty string if neither found. */
  title: string;
  /**
   * Space-joined tag list (frontmatter `tags`). FTS5 tokenizes on
   * whitespace by default so a single string is fine. Empty if no tags.
   */
  tags: string;
  /** Markdown body (frontmatter stripped). */
  body: string;
}

/**
 * One row of a search result, in BM25-ranked order (best first).
 * `score` is BM25's negative-log score — lower is better in SQLite,
 * but we negate it on the way out so callers can sort descending and
 * read it as "more positive = more relevant."
 */
export interface SearchHit {
  vault: string;
  path: string;
  title: string;
  /** ~120-char excerpt with the matching terms wrapped in `[…]`. */
  snippet: string;
  /** Higher is better. Multiply by 1 so callers don't need negation. */
  score: number;
}

export interface QueryOptions {
  /** Restrict to one vault. Omit (or pass `'*'`) for cross-vault search. */
  vault?: string;
  /** Max hits returned. Default 5; cap at 50 to keep payloads sane. */
  topK?: number;
}

/** A note reference returned by tag-based lookups. */
export interface NoteRef {
  vault: string;
  path: string;
  title: string;
}

/**
 * Public surface of the search index. Implemented by `SearchIndex` (the
 * SQLite-backed production class) and `FakeSearchIndex` (the in-memory
 * test double in `tests/helpers/search-index.ts`).
 *
 * MCP tools and the indexer depend on this interface so they can be
 * tested without a real SQLite database.
 */
export interface ISearchIndex {
  query(rawQuery: string, opts?: QueryOptions): SearchHit[];
  listTags(vault?: string): string[];
  notesByTag(tag: string, opts?: { vault?: string; topK?: number }): NoteRef[];
  listVaults(): string[];
  listPaths(vault: string): string[];
  count(vault?: string): number;
  upsert(record: IndexRecord): void;
  delete(vault: string, path?: string): void;
  close(): void;
}

/**
 * The index handle. Construct via `openSearchIndex()`. Always call
 * `close()` when done (especially in tests, where leaked handles can
 * lock the file on Windows).
 */
export class SearchIndex implements ISearchIndex {
  private db: DbLike;

  constructor(db: DbLike) {
    this.db = db;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    // FTS5 virtual table. Columns: vault (filterable), path (filterable),
    // title (5x weight), tags (3x weight), body (1x weight).
    //
    // `unicode61` tokenizer handles diacritics + case-folding (ASCII-aware
    // out of the box; fine for English + most European scripts). For deep
    // CJK support we'd switch to `trigram`, but the cost is irrelevant
    // here and CJK isn't a current vaultkit user need.
    //
    // We do NOT use `content=''` (external content) because we want the
    // table to own its own data — simpler, and the storage overhead is
    // a few KB per note, well within budget.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS notes USING fts5(
        vault UNINDEXED,
        path UNINDEXED,
        title,
        tags,
        body,
        tokenize = 'unicode61 remove_diacritics 1'
      );
    `);
  }

  /**
   * Insert or replace a note row. The unique key is `(vault, path)`;
   * upserting the same key replaces the row. If the file moved within
   * the vault, callers must `delete(vault, oldPath)` first — this
   * doesn't track renames.
   */
  upsert(record: IndexRecord): void {
    // FTS5 has no native UNIQUE constraint, so we delete-then-insert
    // to make `upsert` semantics explicit.
    this.db
      .prepare('DELETE FROM notes WHERE vault = ? AND path = ?')
      .run(record.vault, record.path);
    this.db
      .prepare(
        'INSERT INTO notes (vault, path, title, tags, body) VALUES (?, ?, ?, ?, ?)',
      )
      .run(record.vault, record.path, record.title, record.tags, record.body);
  }

  /**
   * Delete rows. Pass only `vault` to remove every row for that vault
   * (used by `destroy` / `disconnect`). Pass `vault` + `path` to remove
   * a single note (used by incremental indexing when a file is removed
   * upstream).
   */
  delete(vault: string, path?: string): void {
    if (path === undefined) {
      this.db.prepare('DELETE FROM notes WHERE vault = ?').run(vault);
    } else {
      this.db
        .prepare('DELETE FROM notes WHERE vault = ? AND path = ?')
        .run(vault, path);
    }
  }

  /**
   * BM25-ranked full-text search. Returns up to `topK` hits, sorted by
   * relevance (highest score first). Empty array on no match (never
   * throws on missing terms).
   *
   * The query string is passed to FTS5 as a MATCH expression. FTS5
   * accepts plain words (AND-joined by default) plus `"phrase"` and
   * `term*` prefix syntax. Special characters in the query are
   * pre-escaped so a user query like `auth (required)` doesn't fail
   * with a syntax error — see `_sanitizeQuery`.
   *
   * Pass `opts.vault === '*'` (or omit `opts.vault`) for cross-vault
   * search. Pass any other string to scope to that vault.
   */
  query(rawQuery: string, opts: QueryOptions = {}): SearchHit[] {
    const sanitized = _sanitizeQuery(rawQuery);
    if (sanitized.length === 0) return [];
    const topK = Math.min(opts.topK ?? 5, 50);
    const scoped = opts.vault !== undefined && opts.vault !== '*';
    const vaultClause = scoped ? 'AND vault = ?' : '';
    const params: unknown[] = [sanitized];
    if (scoped) params.push(opts.vault);
    params.push(topK);

    // bm25(notes, 5, 3, 1) → title 5x, tags 3x, body 1x.
    // SQLite's bm25 returns negative scores (more negative = better),
    // we flip the sign so callers see "higher = better."
    //
    // snippet(table, col, '[', ']', '…', tokens):
    //   col = -1 means "best matching column"
    //   tokens = 12 → roughly 60-90 char excerpts
    const sql = `
      SELECT
        vault,
        path,
        title,
        snippet(notes, -1, '[', ']', '…', 12) AS snippet,
        -bm25(notes, 5.0, 3.0, 1.0) AS score
      FROM notes
      WHERE notes MATCH ?
      ${vaultClause}
      ORDER BY bm25(notes, 5.0, 3.0, 1.0)
      LIMIT ?
    `;

    try {
      const rows = this.db.prepare(sql).all(...(params as never[])) as unknown as SearchHit[];
      return rows;
    } catch (err) {
      // FTS5 syntax errors surface as "fts5: syntax error near …".
      // We've already sanitized, but odd inputs (e.g. all-stopword
      // queries after sanitization) can still trip this. Fall back to
      // empty results rather than propagating an internal error to
      // the caller — search is value-add, not critical-path.
      const msg = (err as { message?: string })?.message ?? '';
      if (/fts5: syntax/i.test(msg) || /no such column/i.test(msg)) {
        return [];
      }
      throw err;
    }
  }

  /**
   * Return the distinct vault names currently indexed. Used by the
   * `vk_list_vaults` MCP tool so Claude can scope subsequent queries.
   */
  listVaults(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT vault FROM notes ORDER BY vault')
      .all() as Array<{ vault: string }>;
    return rows.map(r => r.vault);
  }

  /**
   * Return the indexed paths for a vault, sorted ascending. Used by
   * `search-indexer.ts` to compute the added/updated/removed breakdown
   * during a re-index pass. Empty array if the vault isn't indexed.
   */
  listPaths(vault: string): string[] {
    const rows = this.db
      .prepare('SELECT path FROM notes WHERE vault = ? ORDER BY path')
      .all(vault) as Array<{ path: string }>;
    return rows.map(r => r.path);
  }

  /**
   * Distinct tag values currently indexed, optionally scoped to one
   * vault. Used by the `vk_get_tags` MCP tool. Empty array if no tags
   * are present (or the index is empty). Tags are stored as a single
   * space/comma-separated string per note (`tag-a tag-b`); this method
   * splits them back out and dedupes case-insensitively.
   *
   * Pass `'*'` (or omit `vault`) for cross-vault. Otherwise scopes
   * to the named vault.
   */
  listTags(vault?: string): string[] {
    const scoped = vault !== undefined && vault !== '*';
    const sql = scoped
      ? 'SELECT tags FROM notes WHERE vault = ? AND tags <> \'\''
      : 'SELECT tags FROM notes WHERE tags <> \'\'';
    const rows = (
      scoped ? this.db.prepare(sql).all(vault) : this.db.prepare(sql).all()
    ) as Array<{ tags: string }>;
    const seen = new Map<string, string>(); // lowercase → canonical (first-seen) form
    for (const r of rows) {
      for (const tok of r.tags.split(/[\s,]+/)) {
        const trimmed = tok.trim();
        if (!trimmed) continue;
        const lower = trimmed.toLowerCase();
        if (!seen.has(lower)) seen.set(lower, trimmed);
      }
    }
    return [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }

  /**
   * Find notes carrying the given tag, scoped optionally to one vault.
   * Returns up to `topK` notes (default 50). Used by the
   * `vk_search_by_tag` MCP tool. Tag matching is case-insensitive and
   * exact-on-token (i.e. tag "ai" doesn't match a note tagged
   * "ai-research"). Empty array if no notes are tagged.
   *
   * Pass `vault: '*'` (or undefined) for cross-vault. Otherwise scopes
   * to the named vault.
   */
  notesByTag(tag: string, opts: { vault?: string; topK?: number } = {}): NoteRef[] {
    const scoped = opts.vault !== undefined && opts.vault !== '*';
    const topK = Math.min(opts.topK ?? 50, 200);
    // Use FTS5 MATCH on the `tags` column with the quoted tag — this
    // tokenizes correctly and respects the unicode61 tokenizer's
    // case-folding. Stripping the tag's special chars first (we expect
    // simple alphanumeric tags but defend against punctuation).
    const safeTag = tag.replace(/["()*+\-:^]/g, '').trim();
    if (!safeTag) return [];
    const matchExpr = `tags : "${safeTag}"`;
    const params: unknown[] = [matchExpr];
    let where = 'notes MATCH ?';
    if (scoped) {
      where += ' AND vault = ?';
      params.push(opts.vault);
    }
    params.push(topK);
    const sql = `
      SELECT vault, path, title
      FROM notes
      WHERE ${where}
      ORDER BY title
      LIMIT ?
    `;
    try {
      return this.db.prepare(sql).all(...(params as never[])) as unknown as NoteRef[];
    } catch (err) {
      // Same fallback as `query()` — surface bad-input as empty results.
      const msg = (err as { message?: string })?.message ?? '';
      if (/fts5: syntax/i.test(msg) || /no such column/i.test(msg)) {
        return [];
      }
      throw err;
    }
  }

  /**
   * Total indexed note count, optionally scoped to one vault. Used
   * mostly by tests and the `get_index_status` future tool.
   */
  count(vault?: string): number {
    if (vault === undefined) {
      const r = this.db.prepare('SELECT COUNT(*) AS c FROM notes').get() as { c: number };
      return r.c;
    }
    const r = this.db
      .prepare('SELECT COUNT(*) AS c FROM notes WHERE vault = ?')
      .get(vault) as { c: number };
    return r.c;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Open (or create) the search index at `dbPath` (default
 * `~/.vaultkit-search.db`). Creates the parent directory if missing.
 * Caller owns the returned handle and must `close()` it.
 *
 * Pass `':memory:'` for an in-memory DB (used by tests).
 */
export function openSearchIndex(dbPath?: string): SearchIndex {
  const path = dbPath ?? defaultSearchDbPath();
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = openFts5Db(path);
  // WAL mode for better concurrency between the indexer (writer) and
  // multiple per-vault MCP server processes (readers). Skipped for
  // in-memory DBs since journal modes don't apply there.
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  return new SearchIndex(db);
}

/**
 * Sanitize a user query for FTS5 MATCH. FTS5's MATCH expression
 * grammar treats `()`, `:`, `"`, `+`, `-`, `*`, `^`, and `AND/OR/NOT`
 * specially. Most user queries are plain natural language and don't
 * intend operator semantics — and crucially, FTS5's default for
 * space-separated tokens is implicit-AND, which recreates the very
 * "natural-language query finds nothing" failure mode this module
 * exists to fix (see ADR-0010).
 *
 * Strategy: strip the special characters, drop bare AND/OR/NOT
 * operators, then **OR-join** the remaining tokens. BM25's ranking
 * already prefers documents matching more terms, so OR-joining gets
 * us:
 *   - Multi-token queries find any partial-match note (the failure
 *     mode goes away).
 *   - Notes matching all terms still rank highest (BM25 sums the
 *     per-term scores).
 *   - Title/tag-weighted hits dominate body-only hits, so a query
 *     "token optimization" against a note titled "Token Efficiency"
 *     still ranks the title-bearing note first via its single
 *     "token" hit.
 *
 * Exposed (with `_` prefix per the project convention) so unit tests
 * can pin the sanitization rules.
 */
export function _sanitizeQuery(raw: string): string {
  const stripped = raw
    .replace(/[()":+\-*^]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length === 0) return '';
  const tokens = stripped
    .split(' ')
    .filter(t => t.length > 0)
    .filter(t => !/^(AND|OR|NOT)$/i.test(t));
  if (tokens.length === 0) return '';
  // Quote each token to neutralize any leftover internal punctuation,
  // then OR-join. Single-token queries reduce to `"foo"`, which FTS5
  // reads as a phrase match — equivalent to a bare term hit.
  return tokens.map(t => `"${t}"`).join(' OR ');
}
