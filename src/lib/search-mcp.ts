import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { sha256 } from './vault.js';
import { getSearchLauncherTemplate } from './template-paths.js';
import {
  runMcpAdd,
  runMcpRemove,
  runMcpRepin,
  manualMcpAddCommand,
} from './mcp.js';

/**
 * Search MCP registration: copies the byte-immutable search launcher
 * template into a stable user-local path and registers it via
 * `claude mcp add` with a SHA-256 pin. Mirrors the shape of `mcp.ts`
 * for the per-vault launcher (per ADR-0001 / ADR-0010 — same threat
 * model, same defense).
 *
 * The launcher binary lives at `~/.vaultkit/search-launcher.js`.
 * Keeping it under the user's home dir (not under the npm install
 * dir) means a `vaultkit` upgrade doesn't accidentally invalidate
 * the SHA pin — the launcher is byte-immutable, just like the
 * per-vault launcher (ADR-0001).
 */

/** Directory where the search launcher copy is stored. */
export function searchLauncherDir(): string {
  return join(homedir(), '.vaultkit');
}

/** Absolute path to the on-disk search launcher copy. */
export function searchLauncherPath(): string {
  return join(searchLauncherDir(), 'search-launcher.js');
}

/** Default MCP server name used in `~/.claude.json#mcpServers`. */
export const SEARCH_MCP_NAME = 'vaultkit-search';

/**
 * Install the byte-immutable search launcher to the user-local copy
 * path. Idempotent — re-installing overwrites with the same bytes,
 * yielding the same SHA. Returns `{ launcherPath, hash }` so callers
 * can proceed to register or repin.
 */
export async function installSearchLauncher(): Promise<{ launcherPath: string; hash: string }> {
  const dir = searchLauncherDir();
  mkdirSync(dir, { recursive: true });
  const dest = searchLauncherPath();
  copyFileSync(getSearchLauncherTemplate(), dest);
  const hash = await sha256(dest);
  return { launcherPath: dest, hash };
}

/**
 * Single source of truth for `claude mcp add vaultkit-search …`.
 * Delegates to `runMcpAdd` in `mcp.ts` so the security-critical argv
 * shape (`--expected-sha256` pin, scope flag) is owned by one helper
 * across both the per-vault launcher and the global search launcher.
 *
 * Routing through `mcp.ts` is what keeps the architecture fitness
 * function in `tests/architecture.test.ts` happy: only `src/lib/mcp.ts`
 * is permitted to spawn the claude CLI's mcp subcommand directly.
 */
export async function runSearchMcpAdd(claudePath: string): Promise<void> {
  const { launcherPath, hash } = await installSearchLauncher();
  await runMcpAdd(claudePath, SEARCH_MCP_NAME, launcherPath, hash);
}

/**
 * `claude mcp remove vaultkit-search`. Delegates to `runMcpRemove` in
 * `mcp.ts` (same ACL rule as `runSearchMcpAdd`). Tolerates a missing
 * entry — caller may be cleaning up an already-stale registry — so
 * `setup` re-runs are idempotent.
 */
export async function runSearchMcpRemove(claudePath: string): Promise<{ removed: boolean }> {
  return runMcpRemove(claudePath, SEARCH_MCP_NAME);
}

/**
 * Re-pin the search MCP after a launcher template update — delegates
 * to `runMcpRepin` in `mcp.ts`. Called by `vaultkit setup` re-runs
 * after a vaultkit upgrade that changed the search launcher's bytes.
 */
export async function runSearchMcpRepin(claudePath: string): Promise<void> {
  const { launcherPath, hash } = await installSearchLauncher();
  await runMcpRepin(claudePath, SEARCH_MCP_NAME, launcherPath, hash);
}

/**
 * Manual `claude mcp add` command shown to the user when the Claude
 * CLI is missing. Delegates to `manualMcpAddCommand` in `mcp.ts` so
 * the printed argv stays in lock-step with `runSearchMcpAdd`'s real
 * argv.
 */
export function manualSearchMcpAddCommand(launcherPath: string, hash: string): string {
  return manualMcpAddCommand(SEARCH_MCP_NAME, launcherPath, hash);
}

/**
 * Check whether the search MCP is currently registered. Reads
 * `~/.claude.json#mcpServers` directly to avoid spawning `claude mcp
 * list` (slow, requires Claude CLI). Used by `setup` to decide
 * whether to register (idempotent) or repin (when the template SHA
 * has drifted).
 */
export function isSearchMcpRegistered(cfgPath?: string): boolean {
  const path = cfgPath ?? join(homedir(), '.claude.json');
  if (!existsSync(path)) return false;
  try {
    // Read just enough to check membership — no need for the full
    // ClaudeConfig type round-trip.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const raw = require('node:fs').readFileSync(path, 'utf8') as string;
    const cfg = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    return cfg.mcpServers !== undefined && SEARCH_MCP_NAME in cfg.mcpServers;
  } catch {
    return false;
  }
}

// Re-export so test files that need to verify the launcher's parent
// directory don't need to import `node:os` separately.
export { dirname };
