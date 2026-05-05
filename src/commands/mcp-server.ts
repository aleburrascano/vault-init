import { resolve, basename } from 'node:path';
import { isVaultLike } from '../lib/vault.js';
import { getAllVaults } from '../lib/registry.js';
import { openSearchIndex } from '../lib/search-index.js';
import { McpStdioServer, stderrLog, silentLog, type DiagnosticLog } from '../lib/mcp-stdio.js';
import { buildToolList, type ToolContext, type VaultRef } from '../mcp-tools/index.js';
import { VaultkitError } from '../lib/errors.js';
import type { CommandModule, RunOptions } from '../types.js';

/**
 * `vaultkit mcp-server` — the long-running per-vault MCP server. Spawned
 * by the byte-immutable per-vault launcher (`lib/mcp-start.js.tmpl`)
 * after that launcher self-verifies its SHA-256. Speaks newline-delimited
 * JSON-RPC 2.0 over stdio (the MCP transport Claude Code uses).
 *
 * Replaces `npx obsidian-mcp-pro <vault-dir>` as the launcher's spawn
 * target. See ADR-0011 for the cost-benefit accounting (bit-for-bit
 * identical SQLite FTS5 + BM25 search via `node:sqlite`, six tools tuned
 * for Claude, ~22 MB lighter user install).
 *
 * Lifecycle:
 *   1. Launcher invokes `vaultkit mcp-server --vault-dir <abs path>`.
 *   2. We resolve the vault's name from the registry (reverse-lookup
 *      by dir) so cross-vault tools (`vault: "*"` or `vault: "<other>"`)
 *      can resolve neighbour vaults.
 *   3. Open the shared search index at `~/.vaultkit-search.db`.
 *   4. Build a tool context, register the six tools, serve stdio.
 *   5. Block until stdin closes (the launcher's process exits → we exit).
 */

export interface McpServerOptions extends RunOptions {
  /** Absolute path of the vault this server is bound to. Required. */
  vaultDir: string;
  /** Suppress diagnostic stderr output (used by tests). */
  silent?: boolean;
  /**
   * Override stdio streams (used by tests to drive the server
   * programmatically without spawning a child process).
   */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export async function run(options: McpServerOptions): Promise<void> {
  if (!options.vaultDir) {
    throw new VaultkitError('UNRECOGNIZED_INPUT', 'mcp-server requires --vault-dir <path>');
  }
  const vaultDir = resolve(options.vaultDir);
  if (!isVaultLike(vaultDir)) {
    throw new VaultkitError(
      'NOT_VAULT_LIKE',
      `--vault-dir ${vaultDir} is not a vaultkit vault directory.`,
    );
  }

  const log: DiagnosticLog = options.silent === true ? silentLog : stderrLog;

  const vaults = await getAllVaults();
  const current = resolveCurrentVault(vaults, vaultDir);
  log.debug(`bound to vault "${current.name}" at ${current.dir}`);

  const index = openSearchIndex();

  const ctx: ToolContext = {
    current,
    getVaultDir: (name) => vaults.find((v) => v.name === name)?.dir,
    listVaults: () => vaults.map((v) => ({ name: v.name, dir: v.dir })),
    index,
  };

  const server = new McpStdioServer(
    {
      name: `vaultkit-${current.name}`,
      version: process.env.npm_package_version ?? 'dev',
      title: `vaultkit vault: ${current.name}`,
    },
    log,
  );
  for (const tool of buildToolList(ctx)) {
    server.registerTool(tool);
  }

  try {
    await server.serve(options.input, options.output);
  } finally {
    index.close();
  }
}

/**
 * Reverse-lookup the vault that lives at `vaultDir`. The registry maps
 * name → dir; we want name from dir so cross-vault tools can refer to
 * "this vault" by name.
 *
 * Path comparison is case-insensitive on Windows (where filesystem path
 * casing isn't load-bearing) and case-sensitive elsewhere. Trailing
 * separators are normalized away.
 *
 * Falls back to the dir's basename when no registry match exists — this
 * lets the server start in dev (`vaultkit mcp-server --vault-dir <path>`
 * before `vaultkit init` finishes registering) without crashing. The
 * fallback is benign: the vault name is informational, used to scope
 * search and label tool output.
 */
function resolveCurrentVault(
  vaults: Array<{ name: string; dir: string }>,
  vaultDir: string,
): VaultRef {
  const normalized = normalizePath(vaultDir);
  for (const v of vaults) {
    if (normalizePath(v.dir) === normalized) {
      return { name: v.name, dir: vaultDir };
    }
  }
  return { name: basename(vaultDir), dir: vaultDir };
}

function normalizePath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

const _module: CommandModule<[McpServerOptions], McpServerOptions, void> = { run };
void _module;
