import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getVaultRecord } from './registry.js';
import { VaultkitError, DEFAULT_MESSAGES } from './errors.js';
import { VAULT_FILES, VAULT_DIRS, VAULT_CONSTRAINTS } from './constants.js';
import type { VaultRecord } from '../types.js';

export function validateName(name: string): void {
  if (name.includes('/')) {
    throw new VaultkitError('INVALID_NAME', "provide the vault name only (e.g. 'MyVault'), not owner/repo.");
  }
  if (!VAULT_CONSTRAINTS.NAME_PATTERN.test(name)) {
    throw new VaultkitError('INVALID_NAME', 'vault name must contain only letters, numbers, hyphens, and underscores.');
  }
  if (name.length > VAULT_CONSTRAINTS.NAME_MAX_LENGTH) {
    throw new VaultkitError('INVALID_NAME', `vault name must be ${VAULT_CONSTRAINTS.NAME_MAX_LENGTH} characters or less.`);
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
  if (isDir(join(dir, VAULT_FILES.OBSIDIAN_DIR))) return true;
  return isFile(join(dir, VAULT_FILES.CLAUDE_MD)) && isDir(join(dir, VAULT_DIRS.RAW)) && isDir(join(dir, VAULT_DIRS.WIKI));
}

export async function sha256(filePath: string): Promise<string> {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Snapshot view of a registered vault. Holds name + dir + expectedHash +
 * schemaVersion and exposes the disk/path checks commands repeatedly
 * need. Construct via `Vault.tryFromName(name, cfgPath?)` to look up by
 * name (returns null if unregistered) or `Vault.fromRecord(record)` from
 * a registry iteration.
 *
 * Vault is a snapshot — fields are readonly. If the registry changes after
 * construction, callers must re-create the Vault to see the new state.
 */
export class Vault {
  readonly name: string;
  readonly dir: string;
  readonly expectedHash: string | null;
  readonly schemaVersion: number | null;

  private constructor(name: string, dir: string, expectedHash: string | null, schemaVersion: number | null) {
    this.name = name;
    this.dir = dir;
    this.expectedHash = expectedHash;
    this.schemaVersion = schemaVersion;
  }

  /** Throws if the name is invalid; returns null if the name isn't registered. */
  static async tryFromName(name: string, cfgPath?: string): Promise<Vault | null> {
    validateName(name);
    const record = await getVaultRecord(name, cfgPath);
    if (!record) return null;
    return Vault.fromRecord(record);
  }

  /**
   * Like {@link tryFromName} but throws `VaultkitError('NOT_REGISTERED', …)`
   * when the name isn't in the registry. Use this in commands that have no
   * meaningful 'unregistered' code path — they all share the canonical
   * `"${name}" ${DEFAULT_MESSAGES.NOT_REGISTERED}` phrasing this way.
   */
  static async requireFromName(name: string, cfgPath?: string): Promise<Vault> {
    const vault = await Vault.tryFromName(name, cfgPath);
    if (!vault) {
      throw new VaultkitError(
        'NOT_REGISTERED',
        `"${name}" ${DEFAULT_MESSAGES.NOT_REGISTERED}`,
      );
    }
    return vault;
  }

  static fromRecord(record: VaultRecord): Vault {
    return new Vault(record.name, record.dir, record.hash, record.schemaVersion);
  }

  get launcherPath(): string {
    return join(this.dir, VAULT_FILES.LAUNCHER);
  }

  existsOnDisk(): boolean {
    return existsSync(this.dir);
  }

  isVaultLike(): boolean {
    return isVaultLike(this.dir);
  }

  hasGitRepo(): boolean {
    return existsSync(join(this.dir, VAULT_FILES.GIT_DIR));
  }

  hasLauncher(): boolean {
    return existsSync(this.launcherPath);
  }

  async sha256OfLauncher(): Promise<string> {
    return sha256(this.launcherPath);
  }
}
