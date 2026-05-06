import { getAllVaults, getAllMcpServerNames } from '../lib/registry.js';
import { Vault } from '../lib/vault.js';
import { findTool } from '../lib/platform.js';
import { isAuthenticated } from '../lib/github/github-auth.js';
import { getConfig } from '../lib/git.js';
import { ConsoleLogger, type Logger } from '../lib/logger.js';
import { LABELS } from '../lib/messages.js';
import { classifyLauncherSha, historicalVersionLabel } from '../lib/notices/launcher-history.js';
import { MARK } from '../lib/constants.js';
import type { CommandModule, RunOptions, VaultRecord } from '../types.js';

async function checkTool(name: string, required: boolean, log: Logger): Promise<boolean> {
  const path = await findTool(name);
  if (!path) {
    const level = required ? MARK.FAIL : MARK.WARN;
    log.info(`  ${level}  ${name}: not found`);
    return false;
  }
  log.info(`  ${MARK.OK}   ${name}: ${path}`);
  return true;
}

/**
 * Health-check one registered vault. Returns the count to add to the
 * outer `issues` total — 1 if a fatal-level finding fired (`x fail`),
 * 0 for `! warn` or `+ ok`. The helper owns its own logging so the
 * caller stays a one-line `for` loop.
 */
async function checkVaultRecord(record: VaultRecord, log: Logger): Promise<number> {
  const vault = Vault.fromRecord(record);
  if (!vault.existsOnDisk()) {
    log.info(`  ${MARK.FAIL}  ${vault.name}: directory missing (${vault.dir})`);
    log.info(`    Hint: vaultkit connect ${vault.name}`);
    return 1;
  }
  if (!vault.hasLauncher()) {
    log.info(`  ${MARK.WARN}  ${vault.name}: .mcp-start.js missing`);
    log.info(`    Hint: vaultkit update ${vault.name}`);
    return 0;
  }
  const onDiskHash = await vault.sha256OfLauncher();
  if (!vault.expectedHash) {
    log.info(`  ${MARK.WARN}  ${vault.name}: no pinned hash (legacy registration)`);
    log.info(`    Hint: vaultkit update ${vault.name}`);
    return 0;
  }
  if (vault.expectedHash !== onDiskHash) {
    const classification = classifyLauncherSha(onDiskHash, vault.expectedHash);
    if (classification === 'historical') {
      const label = historicalVersionLabel(onDiskHash) ?? 'a prior version';
      log.info(`  ${MARK.WARN}  ${vault.name}: hash mismatch — outdated after upgrade (was ${label})`);
      log.info(`    Pinned:  ${vault.expectedHash}`);
      log.info(`    On-disk: ${onDiskHash}`);
      log.info(`    Hint: vaultkit update --all`);
      return 0;
    }
    log.info(`  ${MARK.FAIL}  ${vault.name}: hash mismatch — SHA matches no known vaultkit version (possible tampering)`);
    log.info(`    Pinned:  ${vault.expectedHash}`);
    log.info(`    On-disk: ${onDiskHash}`);
    log.info(`    Inspect: ${vault.launcherPath}`);
    log.info(`    Re-trust: vaultkit verify ${vault.name}`);
    return 1;
  }
  if (!vault.isVaultLike()) {
    log.info(`  ${MARK.WARN}  ${vault.name}: vault layout incomplete`);
    log.info(`    Hint: vaultkit update ${vault.name}`);
    return 0;
  }
  log.info(`  ${MARK.OK}   ${vault.name} (${vault.dir})`);
  log.info(`         ${vault.expectedHash}`);
  const schemaSuffix = vault.schemaVersion === null ? '(legacy — re-run vaultkit update to backfill)' : `v${vault.schemaVersion}`;
  log.info(`         schema: ${schemaSuffix}`);
  return 0;
}

export async function run({ cfgPath, log = new ConsoleLogger() }: RunOptions = {}): Promise<number> {
  let issues = 0;

  log.info('Prerequisites:');

  // git — required
  const gitOk = await checkTool('git', true, log);
  if (!gitOk) issues++;

  // node version — required >= 22
  const nodeMajor = parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (nodeMajor < 22) {
    log.info(`  ${MARK.FAIL}  node: v${process.versions.node} (v22+ required)`);
    issues++;
  } else {
    log.info(`  ${MARK.OK}   node: v${process.versions.node}`);
  }

  // gh — recommended
  const ghPath = await findTool('gh');
  if (!ghPath) {
    log.info(`  ${MARK.WARN}  gh: not found (recommended — install from https://cli.github.com)`);
  } else if (!(await isAuthenticated())) {
    log.info(`  ${MARK.WARN}  gh: found but not authenticated (run: gh auth login)`);
  } else {
    log.info(`  ${MARK.OK}   gh: authenticated`);
  }

  // claude — recommended
  const claudePath = await findTool('claude');
  if (!claudePath) {
    log.info(`  ${MARK.WARN}  claude: not found (run: npm install -g @anthropic-ai/claude-code)`);
  } else {
    log.info(`  ${MARK.OK}   claude: ${claudePath}`);
  }

  // git config
  const userName = await getConfig('user.name');
  const userEmail = await getConfig('user.email');
  if (!userName || !userEmail) {
    log.info(`  ${MARK.FAIL}  git config: user.name or user.email not set`);
    log.info('    Run: git config --global user.name "Your Name"');
    log.info('         git config --global user.email "you@example.com"');
    issues++;
  } else {
    log.info(`  ${MARK.OK}   git config: ${userName} <${userEmail}>`);
  }

  log.info('');

  // Vault health
  const records = await getAllVaults(cfgPath);
  if (records.length === 0) {
    log.info(LABELS.NO_VAULTS_REGISTERED);
  } else {
    log.info('Vaults:');
    for (const record of records) {
      issues += await checkVaultRecord(record, log);
    }

    // Show non-vault MCP servers (other tools the user has registered,
    // e.g. a different MCP server pointed at a non-vault directory).
    // Best-effort — a corrupt registry surfaces from getAllVaults
    // above, so getAllMcpServerNames here only fails on race against
    // a concurrent edit; safe to silence.
    try {
      const allServers = await getAllMcpServerNames(cfgPath);
      const vaultNames = new Set(records.map(v => v.name));
      const others = allServers.filter(n => !vaultNames.has(n));
      if (others.length > 0) {
        log.info(`\n  Other MCP servers (not managed by vaultkit): ${others.join(', ')}`);
      }
    } catch { /* ignore */ }
  }

  log.info('');
  if (issues === 0) {
    log.info('Everything looks good.');
  } else {
    log.info(`${issues} issue(s) found — address the items marked with x above.`);
  }

  return issues;
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[], RunOptions, number> = { run };
void _module;
