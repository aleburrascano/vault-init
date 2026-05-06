import { rmSync } from 'node:fs';
import { input } from '@inquirer/prompts';
import { Vault } from '../lib/vault.js';
import { removeFromRegistry } from '../lib/registry.js';
import { findTool } from '../lib/platform.js';
import { getRepoSlug } from '../lib/git.js';
import { isAdmin, deleteRepoCapturing, repoUrl } from '../lib/github/github-repo.js';
import { ensureDeleteRepoScope } from '../lib/github/github-auth.js';
import { runMcpRemove, manualMcpRemoveCommand } from '../lib/mcp/mcp.js';
import { removeVaultFromIndex, withSearchIndex } from '../lib/search/search-indexer.js';
import { ConsoleLogger, type Logger } from '../lib/logger.js';
import { VaultkitError, DEFAULT_MESSAGES } from '../lib/errors.js';
import { PROMPTS, LABELS } from '../lib/messages.js';
import type { CommandModule, RunOptions } from '../types.js';

const DESTROY_STATUSES = ['skipped', 'deleted', 'failed', 'removed', 'not-registered'] as const;
type DestroyStatus = typeof DESTROY_STATUSES[number];

export interface DestroyOptions extends RunOptions {
  skipConfirm?: boolean;
  skipMcp?: boolean;
  confirmName?: string;
}

interface RepoDeletionPlan {
  repoSlug: string | null;
  repoDeletable: boolean;
  repoNote: string;
}

/**
 * Discover the GitHub repo backing a vault and decide whether `destroy`
 * may delete it. May trigger an interactive `gh auth refresh -s
 * delete_repo` if the caller owns the repo and lacks the scope —
 * that throws `VaultkitError('AUTH_REQUIRED')` if the user declines, so
 * `destroy` aborts before any destructive action and the user can retry
 * with state intact.
 */
async function resolveRepoForDeletion(
  vault: Vault,
  log: Logger,
): Promise<RepoDeletionPlan> {
  const repoSlug = vault.hasGitRepo() ? await getRepoSlug(vault.dir) : null;
  if (!repoSlug) {
    return { repoSlug: null, repoDeletable: false, repoNote: '(not authenticated or remote not found — skipping GitHub step)' };
  }
  const admin = await isAdmin(repoSlug).catch(() => false);
  if (!admin) {
    return { repoSlug, repoDeletable: false, repoNote: `(you don't own this repo — only local + MCP will be removed)` };
  }
  await ensureDeleteRepoScope(log);
  return { repoSlug, repoDeletable: true, repoNote: '' };
}

/**
 * Print the destruction summary, prompt for the typed confirmation, and
 * return whether the caller should proceed. Returns `true` on confirm
 * (or `skipConfirm`), `false` if the user typed something other than
 * the vault name (caller logs ABORTED + returns).
 */
async function confirmDestruction(
  vault: Vault,
  plan: RepoDeletionPlan,
  name: string,
  confirmName: string | undefined,
  log: Logger,
): Promise<boolean> {
  log.info('');
  log.info('This will permanently delete:');
  log.info(`  Local:  ${vault.dir}${vault.existsOnDisk() ? '' : ' (not found — will skip)'}`);
  if (plan.repoDeletable) {
    log.info(`  GitHub: ${repoUrl(plan.repoSlug ?? '')}`);
  } else if (plan.repoNote) {
    log.info(`  GitHub: ${plan.repoSlug ?? 'unknown'}  ${plan.repoNote}`);
  }
  log.info(`  MCP:    ${name} server registration`);
  log.info('');
  const typed = confirmName ?? await input({ message: PROMPTS.TYPE_NAME_TO_CONFIRM_DELETION });
  if (typed !== name) {
    log.info(LABELS.ABORTED);
    return false;
  }
  log.info('');
  return true;
}

export async function run(
  name: string,
  { cfgPath, skipConfirm = false, skipMcp = false, confirmName, log = new ConsoleLogger() }: DestroyOptions = {},
): Promise<void> {
  const vault = await Vault.tryFromName(name, cfgPath);
  if (!vault) {
    throw new VaultkitError('NOT_REGISTERED', `"${name}" ${DEFAULT_MESSAGES.NOT_REGISTERED}\nRun 'vaultkit status' to see what's registered.\nIf you have an orphaned directory, remove it manually.`);
  }

  if (vault.existsOnDisk() && !vault.isVaultLike()) {
    throw new VaultkitError('NOT_VAULT_LIKE', `${vault.dir} does not look like an Obsidian vault — aborting.`);
  }

  const plan = await resolveRepoForDeletion(vault, log);

  if (!skipConfirm && !await confirmDestruction(vault, plan, name, confirmName, log)) {
    return;
  }

  const status: { github: DestroyStatus; mcp: DestroyStatus; local: DestroyStatus } = {
    github: 'skipped',
    mcp: 'skipped',
    local: 'skipped',
  };

  if (plan.repoDeletable && plan.repoSlug) {
    log.info('Deleting GitHub repo...');
    const { ok, stderr } = await deleteRepoCapturing(plan.repoSlug);
    status.github = ok ? 'deleted' : 'failed';
    if (!ok) {
      log.warn(`GitHub repo deletion failed — continuing with local + MCP cleanup.`);
      const detail = stderr.trim();
      if (detail) log.warn(`  ${detail}`);
    }
  }

  if (skipMcp) {
    await removeFromRegistry(name, cfgPath);
    status.mcp = 'removed';
  } else {
    const claudePath = await findTool('claude');
    if (claudePath) {
      log.info('Removing MCP server...');
      const { removed } = await runMcpRemove(claudePath, name);
      status.mcp = removed ? 'removed' : 'not-registered';
      if (!removed) log.info('  (not registered — skipping)');
    } else {
      log.warn('Claude Code not found — MCP cleanup skipped.');
      log.info(`  If registered, run: ${manualMcpRemoveCommand(name)}`);
    }
  }

  if (vault.existsOnDisk()) {
    log.info('Deleting local vault...');
    rmSync(vault.dir, { recursive: true, force: true });
    status.local = 'deleted';
  } else {
    log.info('Local directory not found — skipping.');
  }

  // Purge the vault from the search index. Best-effort — failures
  // here don't matter to the user-visible destroy result. If the
  // index doesn't exist (search MCP never registered), this is a
  // silent no-op.
  await withSearchIndex(idx => removeVaultFromIndex(name, idx));

  log.info('');
  log.info('Summary:');
  log.info(`  GitHub: ${status.github}`);
  log.info(`  MCP:    ${status.mcp}`);
  log.info(`  Local:  ${status.local}`);
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[string], DestroyOptions, void> = { run };
void _module;
