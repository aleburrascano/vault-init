import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { confirm } from '@inquirer/prompts';
import { ConsoleLogger } from '../lib/logger.js';
import { checkNode, ensureGh, ensureGhAuth, ensureGitConfig } from '../lib/prereqs.js';
import { findOrInstallClaude, runMcpRemove } from '../lib/mcp.js';
import { getAllMcpServerNames } from '../lib/registry.js';
import { isVaultkitError } from '../lib/errors.js';
import { PROMPTS } from '../lib/messages.js';
import { MARK } from '../lib/constants.js';
import type { CommandModule, RunOptions } from '../types.js';

/**
 * Pre-2.8 vaultkit registered a separate global `vaultkit-search` MCP
 * with a byte-pinned launcher at `~/.vaultkit/search-launcher.js`.
 * Step 6 of setup tears down both as a one-time migration (per ADR-0011).
 * The legacy module they used to live in (`src/lib/search-mcp.ts`) was
 * deleted in Phase 5 of the rework — these two constants are all that
 * remains.
 */
const LEGACY_SEARCH_MCP_NAME = 'vaultkit-search';
function legacySearchLauncherPath(): string {
  return join(homedir(), '.vaultkit', 'search-launcher.js');
}

export interface SetupOptions extends RunOptions {
  /** Bypass interactive install confirmations — used by tests and `init`'s embedded preflight. */
  skipInstallCheck?: boolean;
}

/**
 * One-time post-install onboarding. Walks the user through every
 * prerequisite vaultkit needs across all of its commands, fixing what
 * it can in place. Idempotent — safe to re-run.
 *
 * Returns the number of unresolved issues (0 = ready to use vaultkit).
 *
 * Output mirrors `doctor`'s format (`+ ok` / `! warn` / `x fail`) so
 * users get the same visual vocabulary across both commands. The
 * difference is that `doctor` only reports; `setup` actively fixes.
 *
 * The `delete_repo` OAuth scope is **deliberately not** requested here.
 * Per `.claude/rules/security-invariants.md`, that scope is granted on
 * demand by `vaultkit destroy` so users aren't asked to authorise a
 * destructive permission they may never use.
 */
export async function run({ cfgPath, skipInstallCheck = false, log = new ConsoleLogger() }: SetupOptions = {}): Promise<number> {
  log.info('vaultkit setup — one-time prerequisite check');
  log.info('');

  let issues = 0;

  // 1. Node version
  const node = checkNode();
  if (node.ok) {
    log.info(`  ${MARK.OK}   ${node.message}`);
  } else {
    log.info(`  ${MARK.FAIL}  ${node.message}`);
    log.info('');
    log.info('Cannot continue without Node.js 22+. Re-run setup after upgrading.');
    return 1;
  }

  // 2. gh CLI (auto-install on supported platforms)
  let ghPath: string;
  try {
    ghPath = await ensureGh({ log, skipInstallCheck });
    log.info(`  ${MARK.OK}   gh: ${ghPath}`);
  } catch (err) {
    log.info(`  ${MARK.FAIL}  gh: ${(err as Error).message}`);
    return ++issues;
  }

  // 3. gh auth + base scopes (`repo` + `workflow` cover init / push / pull / visibility / Pages).
  try {
    await ensureGhAuth({ ghPath, log, scopes: ['repo', 'workflow'] });
    log.info(`  ${MARK.OK}   gh auth: repo, workflow scopes granted`);
  } catch (err) {
    const msg = isVaultkitError(err) ? err.message : (err as Error).message;
    log.info(`  ${MARK.FAIL}  gh auth: ${msg}`);
    issues++;
  }

  // 4. git config
  try {
    await ensureGitConfig();
    log.info(`  ${MARK.OK}   git config: user.name and user.email set`);
  } catch (err) {
    log.info(`  ${MARK.FAIL}  git config: ${(err as Error).message}`);
    issues++;
  }

  // 5. claude CLI (recommended — vault MCP registration depends on it).
  const claudePath = await findOrInstallClaude({
    log,
    promptInstall: () => skipInstallCheck
      ? Promise.resolve(true)
      : confirm({ message: PROMPTS.INSTALL_CLAUDE, default: true }),
  });
  if (claudePath) {
    log.info(`  ${MARK.OK}   claude: ${claudePath}`);
  } else {
    log.info(`  ${MARK.WARN}  claude: not installed — MCP registration will be skipped on \`vaultkit init\``);
  }

  // 6. Legacy vaultkit-search MCP cleanup (one-time migration per ADR-0011).
  //    Pre-2.8 vaultkit registered a separate global `vaultkit-search` MCP
  //    plus a byte-pinned `~/.vaultkit/search-launcher.js`. As of 2.8,
  //    search is folded into the per-vault MCP server (`vaultkit mcp-server`,
  //    spawned by the per-vault launcher), so this state is now obsolete.
  //
  //    `~/.vaultkit-search.db` STAYS — every per-vault MCP server reads it,
  //    so the index data is still load-bearing. Only the registration entry
  //    and launcher copy go.
  //
  //    Idempotent: missing state is a no-op. Best-effort throughout —
  //    cleanup failure logs a warning but doesn't block setup.
  // Use registry.ts as the sole reader of `~/.claude.json` (architecture
  // fitness function in tests/architecture.test.ts enforces no other module
  // does the path resolution). Best-effort: a corrupt registry surfaces as
  // an empty list here, and we no-op the cleanup.
  let serverNames: string[] = [];
  try {
    serverNames = await getAllMcpServerNames(cfgPath);
  } catch {
    // Best-effort — silent.
  }
  if (claudePath && serverNames.includes(LEGACY_SEARCH_MCP_NAME)) {
    try {
      await runMcpRemove(claudePath, LEGACY_SEARCH_MCP_NAME);
      log.info(`  ${MARK.OK}   ${LEGACY_SEARCH_MCP_NAME}: legacy registration removed (search is now folded into per-vault MCP)`);
    } catch (err) {
      const msg = isVaultkitError(err) ? err.message : (err as Error).message;
      log.info(`  ${MARK.WARN}  ${LEGACY_SEARCH_MCP_NAME}: legacy cleanup failed: ${msg}`);
    }
  }
  try {
    const legacyLauncher = legacySearchLauncherPath();
    if (existsSync(legacyLauncher)) {
      unlinkSync(legacyLauncher);
      log.info(`  ${MARK.OK}   removed legacy launcher at ${legacyLauncher}`);
    }
  } catch {
    // Best-effort — silent.
  }

  log.info('');
  if (issues === 0) {
    log.info('Setup complete. You can now run any vaultkit command.');
    log.info('Note: the delete_repo scope will be requested on first `vaultkit destroy` (not granted preemptively).');
  } else {
    log.info(`${issues} issue(s) above need to be resolved before vaultkit can run smoothly.`);
  }
  return issues;
}

const _module: CommandModule<[], SetupOptions, number> = { run };
void _module;
