import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAllVaults } from '../registry.js';
import { Vault } from '../vault.js';
import { classifyLauncherSha, historicalVersionLabel } from './launcher-history.js';
import type { Logger } from '../logger.js';

const CACHE_PATH = join(homedir(), '.vaultkit-last-seen-version.json');

interface CacheEntry {
  lastSeenVersion: string;
}

function readCache(): CacheEntry | null {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Partial<CacheEntry>;
    if (typeof parsed.lastSeenVersion !== 'string') return null;
    return { lastSeenVersion: parsed.lastSeenVersion };
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  try { writeFileSync(CACHE_PATH, JSON.stringify(entry), 'utf8'); } catch { /* ignore */ }
}

interface VaultStaleness {
  name: string;
  classification: 'match' | 'historical' | 'unknown' | 'no-launcher' | 'no-pin';
  versionLabel: string | null;
}

async function classifyAllVaults(cfgPath?: string): Promise<VaultStaleness[]> {
  const records = await getAllVaults(cfgPath);
  const out: VaultStaleness[] = [];
  for (const record of records) {
    const vault = Vault.fromRecord(record);
    if (!vault.existsOnDisk() || !vault.hasLauncher()) {
      out.push({ name: vault.name, classification: 'no-launcher', versionLabel: null });
      continue;
    }
    if (!vault.expectedHash) {
      out.push({ name: vault.name, classification: 'no-pin', versionLabel: null });
      continue;
    }
    const onDisk = await vault.sha256OfLauncher();
    const cls = classifyLauncherSha(onDisk, vault.expectedHash);
    out.push({
      name: vault.name,
      classification: cls,
      versionLabel: cls === 'historical' ? historicalVersionLabel(onDisk) : null,
    });
  }
  return out;
}

/**
 * Fires a one-time loud notice when the running vaultkit version differs
 * from the last-seen one. Names every vault whose launcher is now stale,
 * surfaces the migration command, then updates the cache so the notice
 * does not repeat for this version.
 *
 * Best-effort: any error (registry parse, fs failure) is swallowed so a
 * background notification never blocks the user's actual command.
 *
 * Skipped when `VAULTKIT_NO_UPDATE_CHECK=1` (the same gate that disables
 * the npm-registry update notifier — both are post-action notification
 * concerns; one env var keeps the surface small).
 */
export async function checkPostUpgrade(
  currentVersion: string,
  cfgPath: string | undefined,
  log: Logger,
): Promise<void> {
  if (process.env.VAULTKIT_NO_UPDATE_CHECK === '1') return;

  const cached = readCache();

  if (!cached) {
    // First run on this machine — record the version, do not warn.
    writeCache({ lastSeenVersion: currentVersion });
    return;
  }

  if (cached.lastSeenVersion === currentVersion) {
    // Same version as last command. Nothing to announce.
    return;
  }

  // Version changed since the last command. Update cache first so the
  // notice fires exactly once even if the vault classification below
  // throws.
  writeCache({ lastSeenVersion: currentVersion });

  let vaults: VaultStaleness[];
  try {
    vaults = await classifyAllVaults(cfgPath);
  } catch {
    // Registry unreadable / corrupt — surface the version bump alone
    // and bail out of vault classification.
    log.info('');
    log.warn(`vaultkit upgraded from ${cached.lastSeenVersion} to ${currentVersion}.`);
    log.info(`  (Could not enumerate registered vaults; run 'vaultkit doctor' for details.)`);
    return;
  }

  const stale = vaults.filter(v => v.classification === 'historical');
  const tampered = vaults.filter(v => v.classification === 'unknown');

  log.info('');
  log.warn(`vaultkit upgraded from ${cached.lastSeenVersion} to ${currentVersion}.`);

  if (stale.length === 0 && tampered.length === 0) {
    log.info(`  All ${vaults.length} registered vault(s) are up to date — nothing to migrate.`);
    return;
  }

  if (stale.length > 0) {
    log.info(`  ${stale.length} vault(s) need launcher migration:`);
    for (const v of stale) {
      const labelSuffix = v.versionLabel ? ` (was ${v.versionLabel})` : '';
      log.info(`    - ${v.name}${labelSuffix}`);
    }
    log.info(`  Run: vaultkit doctor --fix --all`);
  }

  if (tampered.length > 0) {
    log.warn(`  ${tampered.length} vault(s) have launcher SHAs matching no known vaultkit version:`);
    for (const v of tampered) {
      log.warn(`    - ${v.name}`);
    }
    log.warn(`  Inspect each launcher and run: vaultkit doctor <name> --fix --force`);
  }
}

// Test-only exports.
export const _CACHE_PATH = CACHE_PATH;
