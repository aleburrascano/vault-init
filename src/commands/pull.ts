import { existsSync } from 'node:fs';
import { getAllVaults } from '../lib/registry.js';
import { pull } from '../lib/git.js';
import { ConsoleLogger } from '../lib/logger.js';
import { LABELS } from '../lib/messages.js';
import type { CommandModule, RunOptions } from '../types.js';

export async function run({ cfgPath, log = new ConsoleLogger() }: RunOptions = {}): Promise<void> {
  const vaults = await getAllVaults(cfgPath);

  if (vaults.length === 0) {
    log.info(LABELS.NO_VAULTS_REGISTERED);
    return;
  }

  let synced = 0;
  let skipped = 0;

  for (const vault of vaults) {
    if (!existsSync(vault.dir)) {
      log.info(`  ${vault.name}: skipped — directory missing (${vault.dir})`);
      skipped++;
      continue;
    }

    const timeout = parseInt(process.env.VAULTKIT_PULL_TIMEOUT ?? '30000', 10);
    const result = await pull(vault.dir, { timeout });

    if (result.timedOut) {
      log.info(`  ${vault.name}: pull timed out`);
      skipped++;
    } else if (!result.success) {
      const firstLine = result.stderr ? result.stderr.trim().split('\n')[0] ?? '' : '';
      const hint = firstLine ? `: ${firstLine}` : '';
      log.info(`  ${vault.name}: pull failed${hint}`);
      log.info(`    Hint: cd "${vault.dir}" && git status`);
      skipped++;
    } else if (result.upToDate) {
      log.info(`  ${vault.name}: already up to date`);
      synced++;
    } else {
      log.info(`  ${vault.name}: synced`);
      synced++;
    }
  }

  log.info(`\n${synced} vault(s) synced, ${skipped} skipped`);
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[], RunOptions, void> = { run };
void _module;
