import { rmSync } from 'node:fs';
import { input } from '@inquirer/prompts';
import { execa } from 'execa';
import { Vault } from '../lib/vault.js';
import { removeFromRegistry } from '../lib/registry.js';
import { findTool } from '../lib/platform.js';
import { isAdmin, ensureDeleteRepoScope } from '../lib/github.js';
import { VaultkitError } from '../lib/errors.js';
import type { CommandModule, RunOptions } from '../types.js';

export interface DestroyOptions extends RunOptions {
  skipConfirm?: boolean;
  skipMcp?: boolean;
  confirmName?: string;
}

async function resolveRepoSlug(dir: string): Promise<string | null> {
  const result = await execa('git', ['-C', dir, 'remote', 'get-url', 'origin'], { reject: false });
  if (result.exitCode !== 0) return null;
  const url = String(result.stdout ?? '').trim();
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(\.git)?\/?$/);
  return m?.[1] ?? null;
}

export async function run(
  name: string,
  { cfgPath, skipConfirm = false, skipMcp = false, confirmName, log = console.log }: DestroyOptions = {},
): Promise<void> {
  const vault = await Vault.tryFromName(name, cfgPath);
  if (!vault) {
    throw new VaultkitError('NOT_REGISTERED', `"${name}" is not a registered vault.\nRun 'vaultkit status' to see what's registered.\nIf you have an orphaned directory, remove it manually.`);
  }

  if (vault.existsOnDisk() && !vault.isVaultLike()) {
    throw new VaultkitError('NOT_VAULT_LIKE', `${vault.dir} does not look like an Obsidian vault — aborting.`);
  }

  // Resolve GitHub repo
  const repoSlug = vault.hasGitRepo() ? await resolveRepoSlug(vault.dir) : null;
  let repoDeletable = false;
  let repoNote = '';

  if (repoSlug) {
    const admin = await isAdmin(repoSlug).catch(() => false);
    if (admin) {
      repoDeletable = true;
      await ensureDeleteRepoScope().catch(() => {});
    } else {
      repoNote = `(you don't own this repo — only local + MCP will be removed)`;
    }
  } else {
    repoNote = '(not authenticated or remote not found — skipping GitHub step)';
  }

  if (!skipConfirm) {
    log('');
    log('This will permanently delete:');
    log(`  Local:  ${vault.dir}${vault.existsOnDisk() ? '' : ' (not found — will skip)'}`);
    if (repoDeletable) {
      log(`  GitHub: https://github.com/${repoSlug}`);
    } else if (repoNote) {
      log(`  GitHub: ${repoSlug ?? 'unknown'}  ${repoNote}`);
    }
    log(`  MCP:    ${name} server registration`);
    log('');
    const typed = confirmName ?? await input({ message: 'Type the vault name to confirm deletion:' });
    if (typed !== name) { log('Aborted.'); return; }
    log('');
  }

  const status = { github: 'skipped', mcp: 'skipped', local: 'skipped' };

  if (repoDeletable && repoSlug) {
    log('Deleting GitHub repo...');
    const gh = await findTool('gh');
    if (gh) {
      const result = await execa(gh, ['repo', 'delete', repoSlug, '--yes'], { reject: false });
      status.github = result.exitCode === 0 ? 'deleted' : 'failed';
      if (status.github === 'failed') {
        log(`Warning: GitHub repo deletion failed — continuing with local + MCP cleanup.`);
      }
    }
  }

  if (skipMcp) {
    await removeFromRegistry(name, cfgPath);
    status.mcp = 'removed';
  } else {
    const claudePath = await findTool('claude');
    if (claudePath) {
      log('Removing MCP server...');
      const result = await execa(claudePath, ['mcp', 'remove', name, '--scope', 'user'], { reject: false });
      status.mcp = result.exitCode === 0 ? 'removed' : 'not-registered';
      if (status.mcp === 'not-registered') log('  (not registered — skipping)');
    } else {
      log('Warning: Claude Code not found — MCP cleanup skipped.');
      log(`  If registered, run: claude mcp remove ${name} --scope user`);
    }
  }

  if (vault.existsOnDisk()) {
    log('Deleting local vault...');
    rmSync(vault.dir, { recursive: true, force: true });
    status.local = 'deleted';
  } else {
    log('Local directory not found — skipping.');
  }

  log('');
  log('Summary:');
  log(`  GitHub: ${status.github}`);
  log(`  MCP:    ${status.mcp}`);
  log(`  Local:  ${status.local}`);
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[string], DestroyOptions, void> = { run };
void _module;
