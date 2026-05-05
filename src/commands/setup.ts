import { confirm } from '@inquirer/prompts';
import { ConsoleLogger } from '../lib/logger.js';
import { checkNode, ensureGh, ensureGhAuth, ensureGitConfig } from '../lib/prereqs.js';
import { findOrInstallClaude } from '../lib/mcp.js';
import {
  runSearchMcpAdd,
  runSearchMcpRepin,
  isSearchMcpRegistered,
  installSearchLauncher,
  SEARCH_MCP_NAME,
} from '../lib/search-mcp.js';
import { isVaultkitError } from '../lib/errors.js';
import { PROMPTS } from '../lib/messages.js';
import type { CommandModule, RunOptions } from '../types.js';

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
    log.info(`  + ok   ${node.message}`);
  } else {
    log.info(`  x fail  ${node.message}`);
    log.info('');
    log.info('Cannot continue without Node.js 22+. Re-run setup after upgrading.');
    return 1;
  }

  // 2. gh CLI (auto-install on supported platforms)
  let ghPath: string;
  try {
    ghPath = await ensureGh({ log, skipInstallCheck });
    log.info(`  + ok   gh: ${ghPath}`);
  } catch (err) {
    log.info(`  x fail  gh: ${(err as Error).message}`);
    return ++issues;
  }

  // 3. gh auth + base scopes (`repo` + `workflow` cover init / push / pull / visibility / Pages).
  try {
    await ensureGhAuth({ ghPath, log, scopes: ['repo', 'workflow'] });
    log.info('  + ok   gh auth: repo, workflow scopes granted');
  } catch (err) {
    const msg = isVaultkitError(err) ? err.message : (err as Error).message;
    log.info(`  x fail  gh auth: ${msg}`);
    issues++;
  }

  // 4. git config
  try {
    await ensureGitConfig();
    log.info('  + ok   git config: user.name and user.email set');
  } catch (err) {
    log.info(`  x fail  git config: ${(err as Error).message}`);
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
    log.info(`  + ok   claude: ${claudePath}`);
  } else {
    log.info('  ! warn  claude: not installed — MCP registration will be skipped on `vaultkit init`');
  }

  // 6. vaultkit-search MCP. Registered once globally (not per-vault) so
  //    cross-vault BM25 search "just works" after setup. Idempotent on
  //    re-run: register if absent; repin if a vaultkit upgrade changed
  //    the launcher template SHA. Skip silently when claude CLI is
  //    missing — the launcher is a vaultkit-internal concern that the
  //    user can't act on without claude.
  if (claudePath) {
    try {
      if (isSearchMcpRegistered(cfgPath)) {
        // Already registered. Repin in case the launcher template SHA
        // drifted in this vaultkit upgrade (idempotent — same template
        // bytes produce the same pin, no-op for unchanged installs).
        await runSearchMcpRepin(claudePath);
        log.info(`  + ok   ${SEARCH_MCP_NAME}: registered (re-pinned)`);
      } else {
        await runSearchMcpAdd(claudePath);
        log.info(`  + ok   ${SEARCH_MCP_NAME}: registered`);
      }
    } catch (err) {
      // Best-effort. Search is value-add, not critical-path — a failure
      // here shouldn't block the rest of setup.
      const msg = isVaultkitError(err) ? err.message : (err as Error).message;
      log.info(`  ! warn  ${SEARCH_MCP_NAME}: ${msg}`);
    }
  } else {
    // Install the launcher even without claude so a future
    // `claude mcp add` (manual or post-claude-install) can pin against
    // the same bytes.
    try {
      await installSearchLauncher();
    } catch {
      // Best-effort — silent.
    }
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
