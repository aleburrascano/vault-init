import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getVaultDir, getExpectedHash } from './registry.js';
import { VaultkitError } from './errors.js';
import type { VaultRecord } from '../types.js';

export function validateName(name: string): void {
  if (name.includes('/')) {
    throw new VaultkitError('INVALID_NAME', "provide the vault name only (e.g. 'MyVault'), not owner/repo.");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new VaultkitError('INVALID_NAME', 'vault name must contain only letters, numbers, hyphens, and underscores.');
  }
  if (name.length > 64) {
    throw new VaultkitError('INVALID_NAME', 'vault name must be 64 characters or less.');
  }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

export function isVaultLike(dir: string): boolean {
  if (!isDir(dir)) return false;
  if (isDir(join(dir, '.obsidian'))) return true;
  return isFile(join(dir, 'CLAUDE.md')) && isDir(join(dir, 'raw')) && isDir(join(dir, 'wiki'));
}

export async function sha256(filePath: string): Promise<string> {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Snapshot view of a registered vault. Holds name + dir + expectedHash and
 * exposes the disk/path checks commands repeatedly need. Construct via
 * `Vault.tryFromName(name, cfgPath?)` to look up by name (returns null if
 * unregistered) or `Vault.fromRecord(record)` from a registry iteration.
 *
 * Vault is a snapshot — fields are readonly. If the registry changes after
 * construction, callers must re-create the Vault to see the new state.
 */
export class Vault {
  readonly name: string;
  readonly dir: string;
  readonly expectedHash: string | null;

  private constructor(name: string, dir: string, expectedHash: string | null) {
    this.name = name;
    this.dir = dir;
    this.expectedHash = expectedHash;
  }

  /** Throws if the name is invalid; returns null if the name isn't registered. */
  static async tryFromName(name: string, cfgPath?: string): Promise<Vault | null> {
    validateName(name);
    const dir = await getVaultDir(name, cfgPath);
    if (!dir) return null;
    const hash = await getExpectedHash(name, cfgPath);
    return new Vault(name, dir, hash);
  }

  static fromRecord(record: VaultRecord): Vault {
    return new Vault(record.name, record.dir, record.hash);
  }

  get launcherPath(): string {
    return join(this.dir, '.mcp-start.js');
  }

  existsOnDisk(): boolean {
    return existsSync(this.dir);
  }

  isVaultLike(): boolean {
    return isVaultLike(this.dir);
  }

  hasGitRepo(): boolean {
    return existsSync(join(this.dir, '.git'));
  }

  hasLauncher(): boolean {
    return existsSync(this.launcherPath);
  }

  async sha256OfLauncher(): Promise<string> {
    return sha256(this.launcherPath);
  }
}
