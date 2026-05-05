/**
 * Shared context passed to every MCP tool handler. Carries the
 * per-vault scoping the per-vault MCP server provides (the vault
 * the launcher spawned this server for) plus accessors for the
 * registry (cross-vault lookup) and the search index (queries).
 *
 * Tools never reach for globals — everything they need comes through
 * here. Lets tests construct in-memory contexts and exercise tool
 * handlers without spawning a real MCP server or touching the
 * real `~/.claude.json` / `~/.vaultkit-search.db`.
 */

import type { SearchIndex } from '../lib/search-index.js';

export interface VaultRef {
  /** Vault name as it appears in `~/.claude.json#mcpServers`. */
  name: string;
  /** Absolute path on disk. */
  dir: string;
}

export interface ToolContext {
  /** The vault this MCP server instance is bound to. */
  current: VaultRef;
  /**
   * Resolve a vault name to its directory. Returns `undefined` if the
   * name is unknown to the registry. Used by tools that accept a
   * `vault` argument other than `"*"` or the current vault.
   */
  getVaultDir(name: string): string | undefined;
  /**
   * Enumerate all registered vaults. Used by tools when the caller
   * passes `vault: "*"` (cross-vault).
   */
  listVaults(): VaultRef[];
  /** Shared FTS5 + BM25 search index. */
  index: SearchIndex;
}

/**
 * Resolve a tool's `vault` argument to a list of vaults to operate on.
 * Three cases:
 *   - `undefined` → the current vault only (single-element list)
 *   - `"*"` → every registered vault
 *   - any other string → that named vault, or empty if unregistered
 */
export function resolveVaults(ctx: ToolContext, requested: string | undefined): VaultRef[] {
  if (requested === undefined) return [ctx.current];
  if (requested === '*') return ctx.listVaults();
  const dir = ctx.getVaultDir(requested);
  if (dir === undefined) return [];
  return [{ name: requested, dir }];
}
