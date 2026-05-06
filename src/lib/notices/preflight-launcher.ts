import { Vault } from '../vault.js';
import { getAllVaults } from '../registry.js';
import { classifyLauncherSha, historicalVersionLabel } from './launcher-history.js';
import type { Logger } from '../logger.js';

/**
 * Pre-flight launcher SHA check for a single named vault. Fires from
 * `bin/vaultkit.ts:wrap()` BEFORE the command body runs, so the user
 * sees a stale-launcher heads-up at the moment they're most likely to
 * act on it (right before they open Claude Code and hit a cryptic MCP
 * error).
 *
 * Best-effort and silent on every "everything is fine" path:
 * - vault not registered, name invalid, no on-disk dir, no launcher,
 *   no pinned hash, or hash matches → nothing logged
 * - historical SHA → log.warn with `vaultkit update <name>` action
 * - unknown SHA → log.warn with `vaultkit verify <name>` action
 *
 * Errors are swallowed so a notification path can never block the
 * actual command. Disabled when `VAULTKIT_NO_LAUNCHER_PREFLIGHT=1`.
 */
export async function preflightLauncherCheck(
  name: string,
  cfgPath: string | undefined,
  log: Logger,
): Promise<void> {
  if (process.env.VAULTKIT_NO_LAUNCHER_PREFLIGHT === '1') return;

  let vault: Vault | null;
  try {
    vault = await Vault.tryFromName(name, cfgPath);
  } catch {
    return;
  }
  if (!vault) return;
  if (!vault.existsOnDisk() || !vault.hasLauncher()) return;
  if (!vault.expectedHash) return;

  let onDisk: string;
  try {
    onDisk = await vault.sha256OfLauncher();
  } catch {
    return;
  }

  const classification = classifyLauncherSha(onDisk, vault.expectedHash);
  if (classification === 'match') return;

  if (classification === 'historical') {
    const label = historicalVersionLabel(onDisk) ?? 'a prior version';
    log.warn(`'${name}': launcher is outdated after a vaultkit upgrade (was ${label}).`);
    log.warn(`  Claude Code will fail to start this vault until you run: vaultkit update ${name}`);
    return;
  }

  // unknown
  log.warn(`'${name}': launcher SHA matches no known vaultkit version (possible tampering).`);
  log.warn(`  Inspect ${vault.launcherPath} and run: vaultkit verify ${name}`);
}

/**
 * Same as {@link preflightLauncherCheck} but enumerates every registered
 * vault. Used by commands that touch all vaults (e.g. `pull`, `refresh`
 * with no name, `status` with no name) where there is no single name
 * to focus on.
 *
 * Logs are aggregated into one warn-line summary plus the per-vault
 * detail lines, so a 5-vault registry with 3 stale vaults produces 4
 * lines of output (1 summary + 3 per-vault) rather than ~10.
 */
export async function preflightAllVaults(
  cfgPath: string | undefined,
  log: Logger,
): Promise<void> {
  if (process.env.VAULTKIT_NO_LAUNCHER_PREFLIGHT === '1') return;

  let records;
  try {
    records = await getAllVaults(cfgPath);
  } catch {
    return;
  }
  if (records.length === 0) return;

  const stale: Array<{ name: string; classification: 'historical' | 'unknown'; label: string | null }> = [];

  for (const record of records) {
    const vault = Vault.fromRecord(record);
    if (!vault.existsOnDisk() || !vault.hasLauncher() || !vault.expectedHash) continue;
    let onDisk: string;
    try {
      onDisk = await vault.sha256OfLauncher();
    } catch {
      continue;
    }
    const cls = classifyLauncherSha(onDisk, vault.expectedHash);
    if (cls === 'match') continue;
    stale.push({
      name: vault.name,
      classification: cls,
      label: cls === 'historical' ? historicalVersionLabel(onDisk) : null,
    });
  }

  if (stale.length === 0) return;

  const historicalCount = stale.filter(s => s.classification === 'historical').length;
  const unknownCount = stale.filter(s => s.classification === 'unknown').length;

  if (historicalCount > 0 && unknownCount === 0) {
    log.warn(`${historicalCount} vault(s) have outdated launchers after a vaultkit upgrade:`);
  } else if (unknownCount > 0 && historicalCount === 0) {
    log.warn(`${unknownCount} vault(s) have launcher SHAs matching no known vaultkit version (possible tampering):`);
  } else {
    log.warn(`${stale.length} vault(s) have launcher SHA mismatches:`);
  }

  for (const s of stale) {
    if (s.classification === 'historical') {
      const labelSuffix = s.label ? ` (was ${s.label})` : '';
      log.warn(`  - ${s.name}${labelSuffix} — outdated`);
    } else {
      log.warn(`  - ${s.name} — possible tampering`);
    }
  }

  if (historicalCount > 0) {
    log.warn(`  Run: vaultkit update --all`);
  }
  if (unknownCount > 0) {
    log.warn(`  For tampering candidates, run: vaultkit verify <name>`);
  }
}
