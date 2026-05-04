import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Vault } from '../lib/vault.js';
import { archiveZip, isWorktreeDirty } from '../lib/git.js';
import { vaultsRoot } from '../lib/platform.js';
import { ConsoleLogger } from '../lib/logger.js';
import { VaultkitError } from '../lib/errors.js';
import type { CommandModule, RunOptions } from '../types.js';

export interface BackupOptions extends RunOptions {
  backupsDir?: string;
}

export async function run(
  name: string,
  { cfgPath, backupsDir, log = new ConsoleLogger() }: BackupOptions = {},
): Promise<string> {
  const vault = await Vault.requireFromName(name, cfgPath);

  if (!vault.hasGitRepo()) {
    throw new VaultkitError('NOT_VAULT_LIKE', `${vault.dir} is not a git repository.`);
  }

  if (await isWorktreeDirty(vault.dir)) {
    log.warn(`Vault has uncommitted changes — they will NOT be in the backup.`);
    log.info(`  Hint: cd "${vault.dir}" && git add . && git commit -m "wip: pre-backup snapshot"`);
  }

  const resolvedBackupsDir = backupsDir ?? join(vaultsRoot(), '.backups');
  mkdirSync(resolvedBackupsDir, { recursive: true });

  const timestamp = new Date().toISOString()
    .replace(/T/, '-').replace(/:/g, '').replace(/\..+/, '');
  const zipPath = join(resolvedBackupsDir, `${name}-${timestamp}.zip`);

  await archiveZip(vault.dir, zipPath);

  if (!existsSync(zipPath)) {
    throw new Error(`Backup file was not created at ${zipPath}`);
  }

  const size = statSync(zipPath).size;
  const sizeKb = (size / 1024).toFixed(1);
  log.info(`Backup created: ${zipPath} (${sizeKb} KB)`);

  return zipPath;
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[string], BackupOptions, string> = { run };
void _module;
