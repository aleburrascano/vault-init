import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { input } from '@inquirer/prompts';
import { execa } from 'execa';
import { validateName, isVaultLike } from '../lib/vault.js';
import { getVaultDir, removeFromRegistry } from '../lib/registry.js';
import { findTool } from '../lib/platform.js';
import { isAdmin, ensureDeleteRepoScope } from '../lib/github.js';

async function resolveRepoSlug(dir) {
  const result = await execa('git', ['-C', dir, 'remote', 'get-url', 'origin'], { reject: false });
  if (result.exitCode !== 0) return null;
  const url = result.stdout.trim();
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(\.git)?\/?$/);
  return m ? m[1] : null;
}

export async function run(name, { cfgPath, skipConfirm = false, skipMcp = false, confirmName, log = console.log } = {}) {
  validateName(name);

  const dir = await getVaultDir(name, cfgPath);
  if (!dir) {
    throw new Error(`"${name}" is not a registered vault.\nRun 'vaultkit status' to see what's registered.\nIf you have an orphaned directory, remove it manually.`);
  }

  if (existsSync(dir) && !isVaultLike(dir)) {
    throw new Error(`${dir} does not look like an Obsidian vault — aborting.`);
  }

  // Resolve GitHub repo
  let repoSlug = existsSync(join(dir, '.git')) ? await resolveRepoSlug(dir) : null;
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
    log(`  Local:  ${dir}${existsSync(dir) ? '' : ' (not found — will skip)'}`);
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

  if (repoDeletable) {
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

  if (existsSync(dir)) {
    log('Deleting local vault...');
    rmSync(dir, { recursive: true, force: true });
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
