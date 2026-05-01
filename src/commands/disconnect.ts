import { rmSync } from 'node:fs';
import { input } from '@inquirer/prompts';
import { execa } from 'execa';
import { Vault } from '../lib/vault.js';
import { removeFromRegistry } from '../lib/registry.js';
import { findTool } from '../lib/platform.js';
import { VaultkitError } from '../lib/errors.js';
import type { CommandModule, RunOptions } from '../types.js';

export interface DisconnectOptions extends RunOptions {
  skipConfirm?: boolean;
  skipMcp?: boolean;
  confirmName?: string;
}

export async function run(
  name: string,
  { cfgPath, skipConfirm = false, skipMcp = false, confirmName, log = console.log }: DisconnectOptions = {},
): Promise<void> {
  const vault = await Vault.tryFromName(name, cfgPath);
  if (!vault) {
    throw new VaultkitError('NOT_REGISTERED', `"${name}" is not registered.\nRun 'vaultkit status' to see what's registered.`);
  }

  if (vault.existsOnDisk() && !vault.isVaultLike()) {
    throw new VaultkitError('NOT_VAULT_LIKE', `${vault.dir} does not look like a vaultkit vault — refusing to delete.\n  If this is correct, remove the directory manually.`);
  }

  if (!skipConfirm) {
    log('');
    log('This will remove:');
    log(`  Local: ${vault.dir}${vault.existsOnDisk() ? '' : ' (not found — will skip)'}`);
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

  if (vault.existsOnDisk()) {
    log('Deleting local vault...');
    rmSync(vault.dir, { recursive: true, force: true });
  } else {
    log('Local directory not found — skipping.');
  }

  log('');
  log(`Done. ${name} disconnected.`);
  log(`Reconnect anytime with: vaultkit connect <owner/${name}>`);
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[string], DisconnectOptions, void> = { run };
void _module;
