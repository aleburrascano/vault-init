import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Vault subdirectories that are never walked during indexing or listing. */
export const SKIP_DIRS = new Set([
  '.git',
  '.obsidian',
  '.github',
  'node_modules',
  '.vaultkit',       // reserved for future vaultkit-local state
  '.smart-env',      // Smart Connections plugin's embedding cache
  'wiki/_freshness', // freshness reports — stale by design, not search content
]);

/**
 * Walk the vault tree, yielding every `.md` file's absolute and
 * vault-relative path. Skips directories in `SKIP_DIRS` (case-sensitive
 * match against the directory name or relative path). Path components use
 * forward slashes in the relative path so results are portable across
 * Windows and Unix.
 *
 * Used by `search-indexer.ts` (to populate the FTS5 index) and by the
 * `vk_list_notes` / `vk_recent_notes` MCP tools (to enumerate notes without
 * a search query). Extracted here per the SRP framing: the indexer has one
 * reason to change (indexing logic) and the walk has another (exclusion rules).
 */
export function* walkMarkdown(
  rootDir: string,
  currentRel: string = '',
): Generator<{ rel: string; full: string }> {
  let entries;
  try {
    entries = readdirSync(currentRel ? join(rootDir, currentRel) : rootDir, {
      withFileTypes: true,
    });
  } catch {
    return;
  }
  for (const entry of entries) {
    const childRelNative = currentRel ? join(currentRel, entry.name) : entry.name;
    const childRel = childRelNative.split(/[\\/]/).join('/'); // normalize to forward slash
    if (entry.isDirectory()) {
      // Match against either the bare directory name OR the rel path
      // (so 'wiki/_freshness' is filterable as a compound path).
      if (SKIP_DIRS.has(entry.name) || SKIP_DIRS.has(childRel)) continue;
      yield* walkMarkdown(rootDir, childRelNative);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield { rel: childRel, full: join(rootDir, childRelNative) };
    }
  }
}
