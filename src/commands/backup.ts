import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { validateName } from '../lib/vault.js';
import { getVaultDir } from '../lib/registry.js';
import { archiveZip } from '../lib/git.js';
import { vaultsRoot } from '../lib/platform.js';
import type { RunOptions } from '../types.js';

export interface BackupOptions extends RunOptions {
  backupsDir?: string;
}

export async function run(
  name: string,
  { cfgPath, backupsDir, log = console.log }: BackupOptions = {},
): Promise<string> {
  validateName(name);

  const dir = await getVaultDir(name, cfgPath);
  if (!dir) throw new Error(`Vault "${name}" is not registered.`);

  if (!existsSync(join(dir, '.git'))) {
    throw new Error(`${dir} is not a git repository.`);
  }

  const statusResult = await execa('git', ['-C', dir, 'status', '--porcelain'], { reject: false });
  if (String(statusResult.stdout ?? '').trim().length > 0) {
    log(`Warning: Vault has uncommitted changes — they will NOT be in the backup.`);
    log(`  Hint: cd "${dir}" && git add . && git commit -m "wip: pre-backup snapshot"`);
  }

  const resolvedBackupsDir = backupsDir ?? join(vaultsRoot(), '.backups');
  mkdirSync(resolvedBackupsDir, { recursive: true });

  const timestamp = new Date().toISOString()
    .replace(/T/, '-').replace(/:/g, '').replace(/\..+/, '');
  const zipPath = join(resolvedBackupsDir, `${name}-${timestamp}.zip`);

  await archiveZip(dir, zipPath);

  if (!existsSync(zipPath)) {
    throw new Error(`Backup file was not created at ${zipPath}`);
  }

  const size = statSync(zipPath).size;
  const sizeKb = (size / 1024).toFixed(1);
  log(`Backup created: ${zipPath} (${sizeKb} KB)`);

  return zipPath;
}
