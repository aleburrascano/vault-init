import { existsSync, rmSync } from 'node:fs';
import { input } from '@inquirer/prompts';
import { validateName, isVaultLike } from '../lib/vault.js';
import { getVaultDir, removeFromRegistry } from '../lib/registry.js';
import { findTool } from '../lib/platform.js';
import { execa } from 'execa';

export async function run(name, { cfgPath, skipConfirm = false, skipMcp = false, confirmName, log = console.log } = {}) {
  validateName(name);

  const dir = await getVaultDir(name, cfgPath);
  if (!dir) {
    throw new Error(`"${name}" is not registered.\nRun 'vaultkit status' to see what's registered.`);
  }

  if (existsSync(dir) && !isVaultLike(dir)) {
    throw new Error(`${dir} does not look like a vaultkit vault — refusing to delete.\n  If this is correct, remove the directory manually.`);
  }

  if (!skipConfirm) {
    log('');
    log('This will remove:');
    log(`  Local: ${dir}${existsSync(dir) ? '' : ' (not found — will skip)'}`);
    log(`  MCP:   ${name} server registration`);
    log('');
    log('The GitHub repo will NOT be deleted.');
    log('');
    const typed = confirmName ?? await input({ message: 'Type the vault name to confirm:' });
    if (typed !== name) {
      log('Aborted.');
      return;
    }
    log('');
  }

  if (skipMcp) {
    await removeFromRegistry(name, cfgPath);
  } else {
    const claudePath = await findTool('claude');
    if (claudePath) {
      log('Removing MCP server...');
      await execa(claudePath, ['mcp', 'remove', name, '--scope', 'user'], { reject: false });
    } else {
      log(`Warning: Claude Code not found — MCP cleanup skipped.`);
      log(`  If registered, run: claude mcp remove ${name} --scope user`);
    }
  }

  if (existsSync(dir)) {
    log('Deleting local vault...');
    rmSync(dir, { recursive: true, force: true });
  } else {
    log('Local directory not found — skipping.');
  }

  log('');
  log(`Done. ${name} disconnected.`);
  log(`Reconnect anytime with: vaultkit connect <owner/${name}>`);
}
