import { rmSync } from 'node:fs';
import { input } from '@inquirer/prompts';
import { Vault } from '../lib/vault.js';
import { removeFromRegistry } from '../lib/registry.js';
import { findTool } from '../lib/platform.js';
import { getRepoSlug } from '../lib/git.js';
import { isAdmin, deleteRepoCapturing, repoUrl } from '../lib/github-repo.js';
import { ensureDeleteRepoScope } from '../lib/github-auth.js';
import { runMcpRemove, manualMcpRemoveCommand } from '../lib/mcp.js';
import { ConsoleLogger } from '../lib/logger.js';
import { VaultkitError, DEFAULT_MESSAGES } from '../lib/errors.js';
import { PROMPTS, LABELS } from '../lib/messages.js';
import type { CommandModule, RunOptions } from '../types.js';

export interface DestroyOptions extends RunOptions {
  skipConfirm?: boolean;
  skipMcp?: boolean;
  confirmName?: string;
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

  // Resolve GitHub repo
  const repoSlug = vault.hasGitRepo() ? await getRepoSlug(vault.dir) : null;
  let repoDeletable = false;
  let repoNote = '';

  if (repoSlug) {
    const admin = await isAdmin(repoSlug).catch(() => false);
    if (admin) {
      repoDeletable = true;
      // Throws VaultkitError('AUTH_REQUIRED') if the user declines the
      // browser prompt — destroy aborts before any destructive action so
      // the user can fix the scope and retry with state intact.
      await ensureDeleteRepoScope(log);
    } else {
      repoNote = `(you don't own this repo — only local + MCP will be removed)`;
    }
  } else {
    repoNote = '(not authenticated or remote not found — skipping GitHub step)';
  }

  if (!skipConfirm) {
    log.info('');
    log.info('This will permanently delete:');
    log.info(`  Local:  ${vault.dir}${vault.existsOnDisk() ? '' : ' (not found — will skip)'}`);
    if (repoDeletable) {
      log.info(`  GitHub: ${repoUrl(repoSlug ?? '')}`);
    } else if (repoNote) {
      log.info(`  GitHub: ${repoSlug ?? 'unknown'}  ${repoNote}`);
    }
    log.info(`  MCP:    ${name} server registration`);
    log.info('');
    const typed = confirmName ?? await input({ message: PROMPTS.TYPE_NAME_TO_CONFIRM_DELETION });
    if (typed !== name) { log.info(LABELS.ABORTED); return; }
    log.info('');
  }

  const status = { github: 'skipped', mcp: 'skipped', local: 'skipped' };

  if (repoDeletable && repoSlug) {
    log.info('Deleting GitHub repo...');
    const { ok, stderr } = await deleteRepoCapturing(repoSlug);
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

  log.info('');
  log.info('Summary:');
  log.info(`  GitHub: ${status.github}`);
  log.info(`  MCP:    ${status.mcp}`);
  log.info(`  Local:  ${status.local}`);
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[string], DestroyOptions, void> = { run };
void _module;
