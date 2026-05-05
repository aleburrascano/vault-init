import { rmSync } from 'node:fs';
import { input } from '@inquirer/prompts';
import { Vault } from '../lib/vault.js';
import { removeFromRegistry } from '../lib/registry.js';
import { findTool } from '../lib/platform.js';
import { runMcpRemove, manualMcpRemoveCommand } from '../lib/mcp.js';
import { openSearchIndex } from '../lib/search-index.js';
import { removeVaultFromIndex } from '../lib/search-indexer.js';
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
      await runMcpRemove(claudePath, name);
    } else {
      log.warn(`Claude Code not found — MCP cleanup skipped.`);
      log.info(`  If registered, run: ${manualMcpRemoveCommand(name)}`);
    }
  }

  if (vault.existsOnDisk()) {
    log.info('Deleting local vault...');
    rmSync(vault.dir, { recursive: true, force: true });
  } else {
    log.info('Local directory not found — skipping.');
  }

  // Purge the vault from the search index. Best-effort — same shape
  // as `destroy.ts`. A reconnect via `vaultkit connect` will re-index
  // the vault on the next `vaultkit update` / `pull`.
  try {
    const idx = openSearchIndex();
    try {
      removeVaultFromIndex(name, idx);
    } finally {
      idx.close();
    }
  } catch {
    // Best-effort.
  }

  log.info('');
  log.info(`Done. ${name} disconnected.`);
  log.info(`Reconnect anytime with: vaultkit connect <owner/${name}>`);
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[string], DisconnectOptions, void> = { run };
void _module;
