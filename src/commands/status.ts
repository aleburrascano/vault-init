import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { getAllVaults, getVaultDir } from '../lib/registry.js';
import { getStatus } from '../lib/git.js';
import { validateName } from '../lib/vault.js';
import type { RunOptions } from '../types.js';

export async function run(
  name: string | undefined,
  { cfgPath, log = console.log }: RunOptions = {},
): Promise<void> {
  if (name) {
    // Single-vault detailed mode
    validateName(name);
    const dir = await getVaultDir(name, cfgPath);
    if (!dir) {
      throw new Error(`Vault "${name}" is not registered.`);
    }
    if (!existsSync(join(dir, '.git'))) {
      throw new Error(`${dir} is not a git repository.`);
    }
    log(`${name}`);
    log(`  Path: ${dir}`);
    const result = await execa('git', ['-C', dir, 'status'], { reject: false });
    log(String(result.stdout ?? ''));
    return;
  }

  // Summary mode — all vaults
  const vaults = await getAllVaults(cfgPath);
  if (vaults.length === 0) {
    log('No vaults registered.');
    return;
  }

  for (const vault of vaults) {
    log(`${vault.name}`);
    log(`  Path: ${vault.dir}`);

    if (!existsSync(vault.dir)) {
      log('  [DIR MISSING]\n');
      continue;
    }

    if (!existsSync(join(vault.dir, '.git'))) {
      log('  branch:  [not a git repo]\n');
      continue;
    }

    const status = await getStatus(vault.dir);
    const dirty = status.dirty ? 'dirty' : 'clean';
    const ahead = status.ahead > 0 ? `, ahead ${status.ahead}` : '';
    const behind = status.behind > 0 ? `, behind ${status.behind}` : '';
    const upstream = status.remote ? `[${dirty}${ahead}${behind}]` : '[no upstream]';
    log(`  branch:  ${status.branch} ${upstream}`);
    if (status.lastCommit) log(`  last:    ${status.lastCommit}`);
    if (vault.hash) log(`  pinned:  ${vault.hash}`);
    else log(`  pinned:  (none — run: vaultkit update ${vault.name})`);
    log('');
  }
}
