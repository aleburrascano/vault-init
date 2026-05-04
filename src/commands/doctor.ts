import { getAllVaults, getAllMcpServerNames } from '../lib/registry.js';
import { Vault } from '../lib/vault.js';
import { findTool } from '../lib/platform.js';
import { isAuthenticated } from '../lib/github-auth.js';
import { getConfig } from '../lib/git.js';
import { ConsoleLogger, type Logger } from '../lib/logger.js';
import { LABELS } from '../lib/messages.js';
import type { CommandModule, RunOptions } from '../types.js';

async function checkTool(name: string, required: boolean, log: Logger): Promise<boolean> {
  const path = await findTool(name);
  if (!path) {
    const level = required ? 'x fail' : '! warn';
    log.info(`  ${level}  ${name}: not found`);
    return false;
  }
  log.info(`  + ok   ${name}: ${path}`);
  return true;
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
    log.info(`  x fail  node: v${process.versions.node} (v22+ required)`);
    issues++;
  } else {
    log.info(`  + ok   node: v${process.versions.node}`);
  }

  // gh — recommended
  const ghPath = await findTool('gh');
  if (!ghPath) {
    log.info('  ! warn  gh: not found (recommended — install from https://cli.github.com)');
  } else if (!(await isAuthenticated())) {
    log.info(`  ! warn  gh: found but not authenticated (run: gh auth login)`);
  } else {
    log.info(`  + ok   gh: authenticated`);
  }

  // claude — recommended
  const claudePath = await findTool('claude');
  if (!claudePath) {
    log.info('  ! warn  claude: not found (run: npm install -g @anthropic-ai/claude-code)');
  } else {
    log.info(`  + ok   claude: ${claudePath}`);
  }

  // git config
  const userName = await getConfig('user.name');
  const userEmail = await getConfig('user.email');
  if (!userName || !userEmail) {
    log.info('  x fail  git config: user.name or user.email not set');
    log.info('    Run: git config --global user.name "Your Name"');
    log.info('         git config --global user.email "you@example.com"');
    issues++;
  } else {
    log.info(`  + ok   git config: ${userName} <${userEmail}>`);
  }

  log.info('');

  // Vault health
  const records = await getAllVaults(cfgPath);
  if (records.length === 0) {
    log.info(LABELS.NO_VAULTS_REGISTERED);
  } else {
    log.info('Vaults:');
    for (const record of records) {
      const vault = Vault.fromRecord(record);
      if (!vault.existsOnDisk()) {
        log.info(`  x fail  ${vault.name}: directory missing (${vault.dir})`);
        log.info(`    Hint: vaultkit connect ${vault.name}`);
        issues++;
        continue;
      }

      if (!vault.hasLauncher()) {
        log.info(`  ! warn  ${vault.name}: .mcp-start.js missing`);
        log.info(`    Hint: vaultkit update ${vault.name}`);
        continue;
      }

      const onDiskHash = await vault.sha256OfLauncher();

      if (!vault.expectedHash) {
        log.info(`  ! warn  ${vault.name}: no pinned hash (legacy registration)`);
        log.info(`    Hint: vaultkit update ${vault.name}`);
        continue;
      }

      if (vault.expectedHash !== onDiskHash) {
        log.info(`  x fail  ${vault.name}: hash mismatch`);
        log.info(`    Pinned:  ${vault.expectedHash}`);
        log.info(`    On-disk: ${onDiskHash}`);
        log.info(`    Hint: vaultkit verify ${vault.name}`);
        issues++;
        continue;
      }

      if (!vault.isVaultLike()) {
        log.info(`  ! warn  ${vault.name}: vault layout incomplete`);
        log.info(`    Hint: vaultkit update ${vault.name}`);
        continue;
      }

      log.info(`  + ok   ${vault.name} (${vault.dir})`);
      log.info(`         ${vault.expectedHash}`);
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
