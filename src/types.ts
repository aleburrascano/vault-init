/**
 * Shared type definitions for vaultkit.
 * Adopted file-by-file as each module migrates from .js to .ts.
 */

// ─── Claude config / MCP registry ───────────────────────────────────────

/** Single entry in `~/.claude.json#mcpServers`. */
export interface McpServerEntry {
  command: string;
  args?: unknown[];
}

/** Top-level `~/.claude.json` shape — only fields vaultkit reads. */
export interface ClaudeConfig {
  mcpServers?: Record<string, McpServerEntry>;
}

/** Registry's logical view of a vault. */
export interface VaultRecord {
  name: string;
  dir: string;
  hash: string | null;
  /**
   * Schema version pinned at registration time. `null` for legacy
   * entries written before the schema-version mechanism shipped — those
   * vaults are treated as version 0 by `migrationsNeeded` (so every
   * recorded migration applies, surfacing them as needing an update).
   */
  schemaVersion: number | null;
}

// ─── Command runtime options ────────────────────────────────────────────

import type { Logger } from './lib/logger.js';

/** Common options accepted by every command's `run` function. */
export interface RunOptions {
  cfgPath?: string;
  log?: Logger;
}

/**
 * The contract every src/commands/<name>.ts module satisfies. Each command
 * file exports an `async function run(...)` whose shape matches this
 * interface; declaring a `_module: CommandModule<...> = { run }` sentinel
 * at the bottom of each command file type-checks the contract at compile
 * time so a future command can't drift from the lifecycle without the
 * type checker noticing.
 *
 * Three type parameters cover the variance across commands:
 *  - `TParams`: a tuple of positional arguments — `[string]` for the
 *    name-taking commands, `[]` for the no-arg `pull` and `doctor`,
 *    `[string, string]` for `visibility`.
 *  - `TOptions`: the per-command options interface (extends `RunOptions`).
 *  - `TResult`: the return value (`void` for most, `number` for `doctor`,
 *    `string` for `backup`).
 *
 * The variadic shape `[...TParams, opts?: TOptions]` packs positional
 * params with the trailing optional-options arg into a single rest tuple,
 * so the same interface fits all three signature shapes.
 */
export interface CommandModule<
  TParams extends unknown[] = [],
  TOptions extends RunOptions = RunOptions,
  TResult = void,
> {
  run(...args: [...TParams, opts?: TOptions]): Promise<TResult>;
}

// ─── Git operation results (src/lib/git) ────────────────────────────────

export interface GitPushResult {
  success: boolean;
  stderr: string;
}

export interface GitPullResult {
  success: boolean;
  upToDate: boolean;
  timedOut: boolean;
  stderr: string;
}

export interface GitStatus {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  lastCommit: string | null;
  remote: string | null;
}

export type GitPushOrPrResult =
  | { mode: 'direct' }
  | { mode: 'pr'; branch: string };

// ─── GitHub API response narrowings (src/lib/github) ────────────────────

/** Subset of `gh api user` response that vaultkit reads. */
export interface GhUserResponse {
  login?: string;
  plan?: { name?: string };
}

/** Subset of `gh api repos/:slug` response that vaultkit reads. */
export interface GhRepoResponse {
  visibility?: string;
  permissions?: { admin?: boolean };
}

/** Subset of `gh api repos/:slug/pages` response that vaultkit reads. */
export interface GhPagesResponse {
  public?: boolean;
  visibility?: string;
}

/** Repo info distilled by `_parseRepoJson`. */
export interface GhRepoInfo {
  visibility: string;
  isAdmin: boolean;
}

/** Visibility values vaultkit accepts as input. */
export type Visibility = 'public' | 'private';
