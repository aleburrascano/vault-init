import { readFileSync } from 'node:fs';
import { posix, basename, extname } from 'node:path';
import { parseFrontmatter } from './freshness/sources.js';
import type { ISearchIndex, IndexRecord } from './search-index.js';
import { walkMarkdown } from './vault-walk.js';

/**
 * Walks a vaultkit-managed vault directory and (re-)populates the
 * `SearchIndex` with one row per markdown file. Used by the lifecycle
 * hooks in `init` / `update` / `pull` to keep the index current
 * without requiring user action.
 *
 * Strategy: full re-index per vault. For each call we:
 *   1. Read the existing set of paths under this vault from the index.
 *   2. Walk the vault dir, collect one `IndexRecord` per `.md` file.
 *   3. Upsert all current records (BM25 storage rewrites cleanly).
 *   4. Delete any rows whose path no longer exists on disk.
 *
 * Vaults are small (typically <500 notes), so full re-index is fast
 * (<100 ms). Incremental-by-mtime would shave ms but adds a column
 * and complexity — defer until a real perf signal appears.
 */


export interface IndexResult {
  /** Records added: present in the new walk but not in the previous index. */
  added: number;
  /** Records updated: present in both (same path, possibly different content). */
  updated: number;
  /** Records removed: present in the previous index but no longer on disk. */
  removed: number;
}

/**
 * Re-index a single vault. Idempotent. Returns a counts breakdown so
 * callers can `log.info('Indexed X notes (Y added, Z removed)')` if
 * they care.
 *
 * Errors reading individual files (permission, mid-write race) are
 * swallowed silently — search is value-add, not critical-path. The
 * call as a whole only throws on a fatal index-side error (DB closed,
 * disk full, etc.).
 */
export async function indexVault(
  vaultName: string,
  vaultDir: string,
  index: ISearchIndex,
): Promise<IndexResult> {
  // Snapshot the previous set of paths for this vault so we can
  // distinguish added / updated / removed at the end.
  const previousPaths = new Set<string>(_listVaultPaths(vaultName, index));

  let added = 0;
  let updated = 0;
  const seenPaths = new Set<string>();

  for (const file of walkMarkdown(vaultDir)) {
    let content: string;
    try {
      content = readFileSync(file.full, 'utf8');
    } catch {
      continue;
    }
    const record = _buildRecord(vaultName, file.rel, content);
    index.upsert(record);
    seenPaths.add(record.path);
    if (previousPaths.has(record.path)) {
      updated++;
    } else {
      added++;
    }
  }

  // Anything in the previous snapshot that wasn't seen this walk has
  // been removed from disk — purge it.
  let removed = 0;
  for (const path of previousPaths) {
    if (!seenPaths.has(path)) {
      index.delete(vaultName, path);
      removed++;
    }
  }

  return { added, updated, removed };
}

/**
 * Remove every row for a vault from the index. Used by `destroy` and
 * `disconnect` after the vault is unregistered. Returns the number of
 * rows deleted.
 */
export function removeVaultFromIndex(vaultName: string, index: ISearchIndex): number {
  const before = index.count(vaultName);
  index.delete(vaultName);
  return before;
}

/**
 * Re-exported from `vault-walk.ts` under the `_` prefix for backward
 * compatibility with `tests/lib/search-indexer.test.ts`. New code should
 * import `walkMarkdown` directly from `../lib/vault-walk.js`.
 */
export { walkMarkdown as _walkMarkdown } from './vault-walk.js';

/**
 * Build an `IndexRecord` from a markdown file's content. Title comes
 * from frontmatter `title:`, then the first H1 in the body, then the
 * filename (without `.md`). Tags come from frontmatter `tags:` (which
 * may be a YAML list-as-string or a comma-separated value), normalized
 * to a space-joined string for FTS5.
 *
 * Exposed for tests; not part of the public API.
 */
export function _buildRecord(vaultName: string, relPath: string, content: string): IndexRecord {
  const { fm, body } = parseFrontmatter(content);
  const title = _extractTitle(fm, body, relPath);
  const tags = _extractTags(fm);
  return {
    vault: vaultName,
    path: posix.normalize(relPath.split(/[\\/]/).join('/')),
    title,
    tags,
    body,
  };
}

function _extractTitle(
  fm: Record<string, string>,
  body: string,
  relPath: string,
): string {
  if (fm.title && fm.title.length > 0) return fm.title;
  // First H1 in the body, e.g. `# Some Title`
  const h1 = body.match(/^#\s+(.+?)\s*$/m);
  if (h1?.[1]) return h1[1];
  // Filename fallback (without extension)
  return basename(relPath, extname(relPath));
}

function _extractTags(fm: Record<string, string>): string {
  const raw = fm.tags ?? '';
  if (raw.length === 0) return '';
  // Handle both YAML list-as-string (`[a, b, c]`) and comma- or
  // whitespace-separated values. Strip brackets, split on
  // commas/whitespace, drop quotes, filter empty.
  const tokens = raw
    .replace(/^[\[]|[\]]$/g, '')
    .split(/[,\s]+/)
    .map(t => t.replace(/^["']|["']$/g, '').trim())
    .filter(t => t.length > 0);
  return tokens.join(' ');
}

/**
 * Read the existing set of paths for a vault. Used by `indexVault` to
 * compute the added/updated/removed breakdown. Exposed via the `_`
 * prefix for tests; the SearchIndex doesn't yet expose a path-listing
 * API directly because nothing else needs it.
 */
export function _listVaultPaths(vaultName: string, index: ISearchIndex): string[] {
  // Reach into the index via its query mechanism — we want every row
  // for the vault. A wildcard match would need FTS5's column filter,
  // but the simpler path is to use a raw SQL via a method we add.
  // For now: query a no-op FTS expression scoped to the vault.
  //
  // Implementation detail: we use the underlying DB through a tiny
  // exported helper. To avoid widening SearchIndex's public API for
  // a single use case, we just count via a dedicated method.
  return index.listPaths(vaultName);
}
