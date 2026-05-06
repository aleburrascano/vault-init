import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getAllVaults } from '../lib/registry.js';
import { getStatus, getStatusText } from '../lib/git.js';
import { Vault } from '../lib/vault.js';
import { ConsoleLogger } from '../lib/logger.js';
import { VaultkitError } from '../lib/errors.js';
import { LABELS } from '../lib/messages.js';
import { VAULT_FILES } from '../lib/constants.js';
import type { CommandModule, RunOptions } from '../types.js';

export async function run(
  name: string | undefined,
  { cfgPath, log = new ConsoleLogger() }: RunOptions = {},
): Promise<void> {
  if (name) {
    // Single-vault detailed mode
    const vault = await Vault.requireFromName(name, cfgPath);
    if (!vault.hasGitRepo()) {
      throw new VaultkitError('NOT_VAULT_LIKE', `${vault.dir} is not a git repository.`);
    }
    log.info(`${name}`);
    log.info(`  Path: ${vault.dir}`);
    log.info(await getStatusText(vault.dir));
    return;
  }

  // Summary mode — all vaults
  const vaults = await getAllVaults(cfgPath);
  if (vaults.length === 0) {
    log.info(LABELS.NO_VAULTS_REGISTERED);
    return;
  }

  for (const vault of vaults) {
    log.info(`${vault.name}`);
    log.info(`  Path: ${vault.dir}`);

    if (!existsSync(vault.dir)) {
      log.info('  [DIR MISSING]\n');
      continue;
    }

    if (!existsSync(join(vault.dir, VAULT_FILES.GIT_DIR))) {
      log.info('  branch:  [not a git repo]\n');
      continue;
    }

    const status = await getStatus(vault.dir);
    const dirty = status.dirty ? 'dirty' : 'clean';
    const ahead = status.ahead > 0 ? `, ahead ${status.ahead}` : '';
    const behind = status.behind > 0 ? `, behind ${status.behind}` : '';
    const upstream = status.remote ? `[${dirty}${ahead}${behind}]` : '[no upstream]';
    log.info(`  branch:  ${status.branch} ${upstream}`);
    if (status.lastCommit) log.info(`  last:    ${status.lastCommit}`);
    if (vault.hash) log.info(`  pinned:  ${vault.hash}`);
    else log.info(`  pinned:  (none — run: vaultkit update ${vault.name})`);
    log.info('');
  }
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[string | undefined], RunOptions, void> = { run };
void _module;
