import { existsSync } from 'node:fs';
import { getAllVaults } from '../lib/registry.js';
import { pull } from '../lib/git.js';
import { openSearchIndex, type SearchIndex } from '../lib/search-index.js';
import { indexVault } from '../lib/search-indexer.js';
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

  // Open the search index once for the whole pull pass. Re-indexing
  // every successfully-pulled vault keeps `~/.vaultkit-search.db`
  // current with upstream changes (new notes, edits to existing
  // notes, removed notes). Best-effort: a missing/corrupt index file
  // skips the re-index but doesn't block the pull.
  let searchIndex: SearchIndex | null = null;
  try {
    searchIndex = openSearchIndex();
  } catch {
    // Search is value-add — proceed without it.
  }

  try {
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

      // Re-index successful pulls (synced or already-up-to-date) so
      // a fresh-clone first-pull picks up content that wasn't on
      // disk during init. Skip on failures — disk state is unknown.
      if (searchIndex && (result.success || result.upToDate)) {
        try {
          await indexVault(vault.name, vault.dir, searchIndex);
        } catch {
          // Best-effort — silent; don't bloat the per-vault log.
        }
      }
    }
  } finally {
    searchIndex?.close();
  }

  log.info(`\n${synced} vault(s) synced, ${skipped} skipped`);
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[], RunOptions, void> = { run };
void _module;
