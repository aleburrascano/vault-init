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

const REMOVE_STATUSES = ['skipped', 'deleted', 'failed', 'removed', 'not-registered'] as const;
type RemoveStatus = typeof REMOVE_STATUSES[number];

export interface RemoveOptions extends RunOptions {
  /**
   * If true, also delete the GitHub repo (after admin check + on-demand
   * `delete_repo` scope grant). If false (default), the local clone +
   * MCP registration go but the GitHub repo stays — useful when
   * disconnecting from a vault you don't own or want to keep online.
   */
  deleteRepo?: boolean;
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
 * Discover the GitHub repo backing a vault and decide whether `remove`
 * may delete it. May trigger an interactive `gh auth refresh -s
 * delete_repo` if the caller owns the repo and lacks the scope —
 * that throws `VaultkitError('AUTH_REQUIRED')` if the user declines, so
 * `remove` aborts before any destructive action and the user can retry
 * with state intact.
 *
 * Only invoked when `--delete-repo` is passed; the local-only path
 * (without the flag) skips this entirely so the `delete_repo` scope is
 * never requested when not needed (security invariant per
 * `.claude/rules/security-invariants.md`).
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
 * Print the removal summary, prompt for typed confirmation, and return
 * whether the caller should proceed. Returns `true` on confirm (or
 * `skipConfirm`), `false` if the user typed something other than the
 * vault name.
 *
 * The destructive variant (`deleteRepo: true`) uses the stronger
 * `TYPE_NAME_TO_CONFIRM_DELETION` prompt and lists the GitHub repo as
 * an additional target. The local-only variant uses the milder
 * `TYPE_NAME_TO_CONFIRM` prompt.
 */
async function confirmRemoval(
  vault: Vault,
  plan: RepoDeletionPlan,
  name: string,
  deleteRepo: boolean,
  confirmName: string | undefined,
  log: Logger,
): Promise<boolean> {
  log.info('');
  if (deleteRepo) {
    log.info('This will permanently delete:');
  } else {
    log.info('This will remove:');
  }
  log.info(`  Local: ${vault.dir}${vault.existsOnDisk() ? '' : ' (not found — will skip)'}`);
  if (deleteRepo) {
    if (plan.repoDeletable) {
      log.info(`  GitHub: ${repoUrl(plan.repoSlug ?? '')}`);
    } else if (plan.repoNote) {
      log.info(`  GitHub: ${plan.repoSlug ?? 'unknown'}  ${plan.repoNote}`);
    }
  } else {
    log.info('');
    log.info('The GitHub repo will NOT be deleted.');
  }
  log.info(`  MCP:    ${name} server registration`);
  log.info('');
  const promptMsg = deleteRepo ? PROMPTS.TYPE_NAME_TO_CONFIRM_DELETION : PROMPTS.TYPE_NAME_TO_CONFIRM;
  const typed = confirmName ?? await input({ message: promptMsg });
  if (typed !== name) {
    log.info(LABELS.ABORTED);
    return false;
  }
  log.info('');
  return true;
}

/**
 * Remove a vault from the local machine + MCP registration. With
 * `--delete-repo`, also deletes the GitHub repo (if you own it).
 *
 * Merges the prior `disconnect` (local + MCP only) and `destroy` (local
 * + MCP + GitHub) commands into a single command with a flag, since
 * `destroy` was a strict superset of `disconnect`. The `delete_repo`
 * OAuth scope is still only requested when `--delete-repo` is set
 * (security invariant — never request a destructive scope the user
 * isn't about to use).
 */
export async function run(
  name: string,
  {
    cfgPath,
    deleteRepo = false,
    skipConfirm = false,
    skipMcp = false,
    confirmName,
    log = new ConsoleLogger(),
  }: RemoveOptions = {},
): Promise<void> {
  const vault = await Vault.tryFromName(name, cfgPath);
  if (!vault) {
    const trailingHint = deleteRepo
      ? `\nIf you have an orphaned directory, remove it manually.`
      : '';
    throw new VaultkitError(
      'NOT_REGISTERED',
      `"${name}" ${DEFAULT_MESSAGES.NOT_REGISTERED}\nRun 'vaultkit list' to see what's registered.${trailingHint}`,
    );
  }

  if (vault.existsOnDisk() && !vault.isVaultLike()) {
    const detail = deleteRepo
      ? `${vault.dir} does not look like an Obsidian vault — aborting.`
      : `${vault.dir} does not look like a vaultkit vault — refusing to delete.\n  If this is correct, remove the directory manually.`;
    throw new VaultkitError('NOT_VAULT_LIKE', detail);
  }

  // Only resolve repo (and possibly request delete_repo scope) when the
  // caller actually intends to delete it. Skipping this for the
  // local-only path keeps the security invariant intact.
  const plan: RepoDeletionPlan = deleteRepo
    ? await resolveRepoForDeletion(vault, log)
    : { repoSlug: null, repoDeletable: false, repoNote: '' };

  if (!skipConfirm && !await confirmRemoval(vault, plan, name, deleteRepo, confirmName, log)) {
    return;
  }

  const status: { github: RemoveStatus; mcp: RemoveStatus; local: RemoveStatus } = {
    github: 'skipped',
    mcp: 'skipped',
    local: 'skipped',
  };

  if (deleteRepo && plan.repoDeletable && plan.repoSlug) {
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

  // Best-effort search-index purge. Reconnecting with `vaultkit
  // connect` re-indexes on the next sync/doctor cycle.
  await withSearchIndex(idx => removeVaultFromIndex(name, idx));

  log.info('');
  if (deleteRepo) {
    log.info('Summary:');
    log.info(`  GitHub: ${status.github}`);
    log.info(`  MCP:    ${status.mcp}`);
    log.info(`  Local:  ${status.local}`);
  } else {
    log.info(`Done. ${name} removed.`);
    log.info(`Reconnect anytime with: vaultkit connect <owner/${name}>`);
  }
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[string], RemoveOptions, void> = { run };
void _module;
