import { rmSync } from 'node:fs';
import { input } from '@inquirer/prompts';
import { execa } from 'execa';
import { Vault } from '../lib/vault.js';
import { removeFromRegistry } from '../lib/registry.js';
import { findTool } from '../lib/platform.js';
import { ConsoleLogger } from '../lib/logger.js';
import { VaultkitError, DEFAULT_MESSAGES } from '../lib/errors.js';
import { PROMPTS, LABELS } from '../lib/messages.js';
import type { CommandModule, RunOptions } from '../types.js';

export interface DisconnectOptions extends RunOptions {
  skipConfirm?: boolean;
  skipMcp?: boolean;
  confirmName?: string;
}

export async function run(
  name: string,
  { cfgPath, skipConfirm = false, skipMcp = false, confirmName, log = new ConsoleLogger() }: DisconnectOptions = {},
): Promise<void> {
  const vault = await Vault.tryFromName(name, cfgPath);
  if (!vault) {
    throw new VaultkitError('NOT_REGISTERED', `"${name}" ${DEFAULT_MESSAGES.NOT_REGISTERED}\nRun 'vaultkit status' to see what's registered.`);
  }

  if (vault.existsOnDisk() && !vault.isVaultLike()) {
    throw new VaultkitError('NOT_VAULT_LIKE', `${vault.dir} does not look like a vaultkit vault — refusing to delete.\n  If this is correct, remove the directory manually.`);
  }

  if (!skipConfirm) {
    log.info('');
    log.info('This will remove:');
    log.info(`  Local: ${vault.dir}${vault.existsOnDisk() ? '' : ' (not found — will skip)'}`);
    log.info(`  MCP:   ${name} server registration`);
    log.info('');
    log.info('The GitHub repo will NOT be deleted.');
    log.info('');
    const typed = confirmName ?? await input({ message: PROMPTS.TYPE_NAME_TO_CONFIRM });
    if (typed !== name) {
      log.info(LABELS.ABORTED);
      return;
    }
    log.info('');
  }

  if (skipMcp) {
    await removeFromRegistry(name, cfgPath);
  } else {
    const claudePath = await findTool('claude');
    if (claudePath) {
      log.info('Removing MCP server...');
      await execa(claudePath, ['mcp', 'remove', name, '--scope', 'user'], { reject: false });
    } else {
      log.info(`Warning: Claude Code not found — MCP cleanup skipped.`);
      log.info(`  If registered, run: claude mcp remove ${name} --scope user`);
    }
  }

  if (vault.existsOnDisk()) {
    log.info('Deleting local vault...');
    rmSync(vault.dir, { recursive: true, force: true });
  } else {
    log.info('Local directory not found — skipping.');
  }

  log.info('');
  log.info(`Done. ${name} disconnected.`);
  log.info(`Reconnect anytime with: vaultkit connect <owner/${name}>`);
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[string], DisconnectOptions, void> = { run };
void _module;
