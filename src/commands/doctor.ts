import { confirm } from '@inquirer/prompts';
import { getAllVaults, getAllMcpServerNames, getVaultRecord } from '../lib/registry.js';
import { Vault } from '../lib/vault.js';
import { findTool } from '../lib/platform.js';
import { isAuthenticated } from '../lib/github/github-auth.js';
import { getConfig } from '../lib/git.js';
import { ConsoleLogger, type Logger } from '../lib/logger.js';
import { LABELS } from '../lib/messages.js';
import { classifyLauncherSha, historicalVersionLabel } from '../lib/notices/launcher-history.js';
import { MARK } from '../lib/constants.js';
import { VaultkitError } from '../lib/errors.js';
import type { CommandModule, RunOptions, VaultRecord } from '../types.js';

export interface DoctorOptions extends RunOptions {
  /**
   * Run the repair path. `true` = fix without prompting, `false` =
   * diagnose only (no prompt either, even on TTY). Omitted = interactive
   * prompt when issues are found on a TTY; diagnose-only on a non-TTY
   * (CI/script).
   */
  fix?: boolean;
  /**
   * Override the suspect-tampering refusal on unknown launcher SHA.
   * Only meaningful with `fix: true`. Without `--force`, doctor refuses
   * to auto-fix a vault whose launcher SHA matches no known vaultkit
   * version (the conservative default — could be tampering).
   */
  force?: boolean;
  /**
   * Marker for "iterate every registered vault" — implicit when no
   * `name` is passed; explicit `--all` is documented for clarity.
   */
  all?: boolean;
}

/** What can go wrong with a vault, paired with which fix path applies. */
type RepairPlan =
  | { kind: 'ok'; name: string }
  | { kind: 'dir-missing'; name: string }     // can't auto-fix (no source)
  | { kind: 'no-launcher'; name: string }     // can't auto-fix (no source)
  | { kind: 'no-pin'; name: string }          // call update (re-pin)
  | { kind: 'historical-drift'; name: string } // call update (re-template)
  | { kind: 'layout-gap'; name: string }      // call update (write missing)
  | { kind: 'unknown-drift'; name: string };  // refuse without --force

function isRepairable(p: RepairPlan): boolean {
  return p.kind === 'no-pin' || p.kind === 'historical-drift'
    || p.kind === 'layout-gap' || p.kind === 'unknown-drift';
}

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
 * Health-check one registered vault. Logs its status (`+ ok` / `! warn` /
 * `x fail`) and returns the structured `RepairPlan` so the outer fix
 * dispatcher knows what to do without re-classifying.
 *
 * Hints to "run vaultkit X" are deliberately omitted from the failure
 * messages — doctor's interactive prompt at the end is the offer to
 * fix, replacing the old per-line `Hint: vaultkit verify <name>` UX
 * that forced the user to run a second command.
 */
async function checkVaultRecord(record: VaultRecord, log: Logger): Promise<RepairPlan> {
  const vault = Vault.fromRecord(record);
  if (!vault.existsOnDisk()) {
    log.info(`  ${MARK.FAIL}  ${vault.name}: directory missing (${vault.dir})`);
    log.info(`    Cannot auto-fix — run: vaultkit connect ${vault.name}`);
    return { kind: 'dir-missing', name: vault.name };
  }
  if (!vault.hasLauncher()) {
    log.info(`  ${MARK.WARN}  ${vault.name}: .mcp-start.js missing`);
    log.info(`    Cannot auto-fix — the upstream vault may be older; ask the owner to push a current launcher.`);
    return { kind: 'no-launcher', name: vault.name };
  }
  const onDiskHash = await vault.sha256OfLauncher();
  if (!vault.expectedHash) {
    log.info(`  ${MARK.WARN}  ${vault.name}: no pinned hash (legacy registration)`);
    return { kind: 'no-pin', name: vault.name };
  }
  if (vault.expectedHash !== onDiskHash) {
    const classification = classifyLauncherSha(onDiskHash, vault.expectedHash);
    if (classification === 'historical') {
      const label = historicalVersionLabel(onDiskHash) ?? 'a prior version';
      log.info(`  ${MARK.WARN}  ${vault.name}: hash mismatch — outdated after upgrade (was ${label})`);
      log.info(`    Pinned:  ${vault.expectedHash}`);
      log.info(`    On-disk: ${onDiskHash}`);
      return { kind: 'historical-drift', name: vault.name };
    }
    log.info(`  ${MARK.FAIL}  ${vault.name}: hash mismatch — SHA matches no known vaultkit version (possible tampering)`);
    log.info(`    Pinned:  ${vault.expectedHash}`);
    log.info(`    On-disk: ${onDiskHash}`);
    log.info(`    Inspect: ${vault.launcherPath}`);
    log.info(`    Auto-fix refused without --force (suspect tampering).`);
    return { kind: 'unknown-drift', name: vault.name };
  }
  if (!vault.isVaultLike()) {
    log.info(`  ${MARK.WARN}  ${vault.name}: vault layout incomplete`);
    return { kind: 'layout-gap', name: vault.name };
  }
  log.info(`  ${MARK.OK}   ${vault.name} (${vault.dir})`);
  log.info(`         ${vault.expectedHash}`);
  const schemaSuffix = vault.schemaVersion === null ? '(legacy — re-run vaultkit doctor --fix to backfill)' : `v${vault.schemaVersion}`;
  log.info(`         schema: ${schemaSuffix}`);
  return { kind: 'ok', name: vault.name };
}

/**
 * Dispatch a single vault's repair to the right code path:
 *
 *   - `historical-drift` / `no-pin` / `layout-gap` → update.run (re-template,
 *     write missing files, commit + push, re-pin MCP)
 *   - `unknown-drift` (with `--force`) → verify.run (re-pin to on-disk SHA)
 *   - `unknown-drift` (without `--force`) → refuse (security posture)
 *   - `dir-missing` / `no-launcher` → can't auto-fix; logged at diagnose time
 *
 * Returns true if the fix ran (and presumably succeeded — exceptions
 * propagate). False means "nothing to do" or "refused".
 */
async function fixVault(
  plan: RepairPlan,
  opts: { force: boolean; cfgPath: string | undefined; log: Logger },
): Promise<boolean> {
  switch (plan.kind) {
    case 'ok':
    case 'dir-missing':
    case 'no-launcher':
      return false;
    case 'no-pin':
    case 'historical-drift':
    case 'layout-gap': {
      // update.run() handles re-template + missing-file write + commit/push + re-pin.
      // skipConfirm bypasses the PROCEED prompt so a single doctor invocation
      // covers every flagged vault without per-vault confirmation.
      const { run: updateRun } = await import('./update.js');
      await updateRun(plan.name, { skipConfirm: true, ...(opts.cfgPath !== undefined && { cfgPath: opts.cfgPath }), log: opts.log });
      return true;
    }
    case 'unknown-drift': {
      if (!opts.force) {
        opts.log.warn(`  ${plan.name}: skipped (unknown launcher SHA — re-run with --force to accept on-disk and re-pin)`);
        return false;
      }
      // verify.run() with yes:true re-pins to whatever's on disk. Acceptable
      // when the user has explicitly opted in via --force.
      const { run: verifyRun } = await import('./verify.js');
      await verifyRun(plan.name, { yes: true, ...(opts.cfgPath !== undefined && { cfgPath: opts.cfgPath }), log: opts.log });
      return true;
    }
  }
}

async function diagnoseAndPlan(
  name: string | undefined,
  cfgPath: string | undefined,
  log: Logger,
): Promise<{ plans: RepairPlan[]; envIssues: number }> {
  let envIssues = 0;
  log.info('Prerequisites:');

  const gitOk = await checkTool('git', true, log);
  if (!gitOk) envIssues++;

  const nodeMajor = parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (nodeMajor < 22) {
    log.info(`  ${MARK.FAIL}  node: v${process.versions.node} (v22+ required)`);
    envIssues++;
  } else {
    log.info(`  ${MARK.OK}   node: v${process.versions.node}`);
  }

  const ghPath = await findTool('gh');
  if (!ghPath) {
    log.info(`  ${MARK.WARN}  gh: not found (recommended — install from https://cli.github.com)`);
  } else if (!(await isAuthenticated())) {
    log.info(`  ${MARK.WARN}  gh: found but not authenticated (run: gh auth login)`);
  } else {
    log.info(`  ${MARK.OK}   gh: authenticated`);
  }

  const claudePath = await findTool('claude');
  if (!claudePath) {
    log.info(`  ${MARK.WARN}  claude: not found (run: npm install -g @anthropic-ai/claude-code)`);
  } else {
    log.info(`  ${MARK.OK}   claude: ${claudePath}`);
  }

  const userName = await getConfig('user.name');
  const userEmail = await getConfig('user.email');
  if (!userName || !userEmail) {
    log.info(`  ${MARK.FAIL}  git config: user.name or user.email not set`);
    log.info('    Run: git config --global user.name "Your Name"');
    log.info('         git config --global user.email "you@example.com"');
    envIssues++;
  } else {
    log.info(`  ${MARK.OK}   git config: ${userName} <${userEmail}>`);
  }

  log.info('');

  // Scope: single vault if name passed, else every registered vault.
  let records: VaultRecord[];
  if (name) {
    const r = await getVaultRecord(name, cfgPath);
    if (!r) throw new VaultkitError('NOT_REGISTERED', `"${name}" is not registered. Run 'vaultkit list' to see what's registered.`);
    records = [r];
  } else {
    records = await getAllVaults(cfgPath);
  }

  const plans: RepairPlan[] = [];
  if (records.length === 0) {
    log.info(LABELS.NO_VAULTS_REGISTERED);
  } else {
    log.info(name ? 'Vault:' : 'Vaults:');
    for (const record of records) {
      plans.push(await checkVaultRecord(record, log));
    }

    if (!name) {
      // Best-effort surfacing of unrelated MCP servers in the same registry.
      try {
        const allServers = await getAllMcpServerNames(cfgPath);
        const vaultNames = new Set(records.map(v => v.name));
        const others = allServers.filter(n => !vaultNames.has(n));
        if (others.length > 0) {
          log.info(`\n  Other MCP servers (not managed by vaultkit): ${others.join(', ')}`);
        }
      } catch { /* ignore */ }
    }
  }

  return { plans, envIssues };
}

/**
 * `vaultkit doctor [name]` — diagnose vault + environment health, and
 * (optionally) repair what's repairable.
 *
 * Behavior:
 *   - No `--fix` / `--no-fix`: prompts `Fix N issues now? (y/N)` on a
 *     TTY when repairable issues are found. Non-TTY (CI/script) =
 *     diagnose only.
 *   - `--fix`: skip the prompt; repair every repairable vault.
 *   - `--no-fix`: skip the prompt; diagnose only (useful for CI
 *     "check that nothing is broken" gates).
 *   - With a `name` arg: scope to one vault. Without: every registered
 *     vault.
 *   - `--force`: accept on-disk launcher SHA when it matches no known
 *     vaultkit version (suspect-tampering case). Without `--force`,
 *     these vaults are skipped during fix.
 *
 * Returns the count of issues that are still un-repaired after the run
 * (used by `bin/vaultkit.ts:wrap()` to set a non-zero exit code when
 * appropriate).
 */
export async function run(
  name?: string,
  { cfgPath, fix, force = false, log = new ConsoleLogger() }: DoctorOptions = {},
): Promise<number> {
  const { plans, envIssues } = await diagnoseAndPlan(name, cfgPath, log);
  const repairable = plans.filter(isRepairable);
  const blockers = plans.filter(p => p.kind === 'dir-missing'); // actually-broken, not auto-fixable
  const totalIssues = envIssues + repairable.length + blockers.length;

  log.info('');
  if (totalIssues === 0) {
    log.info('Everything looks good.');
    return 0;
  }

  // Decide whether to run the fix path.
  let shouldFix = fix;
  if (shouldFix === undefined && repairable.length > 0) {
    if (process.stdin.isTTY) {
      shouldFix = await confirm({
        message: `Found ${repairable.length} repairable issue${repairable.length === 1 ? '' : 's'}. Fix ${repairable.length === 1 ? 'it' : 'them'} now?`,
        default: false,
      });
    } else {
      shouldFix = false;
    }
  }

  if (!shouldFix) {
    log.info(`${totalIssues} issue(s) found. Re-run with --fix to repair the ${repairable.length} repairable item(s).`);
    return totalIssues;
  }

  log.info('');
  log.info(`Repairing ${repairable.length} vault${repairable.length === 1 ? '' : 's'}...`);
  log.info('');
  let unfixed = envIssues + blockers.length;
  for (const plan of repairable) {
    log.info(`--- ${plan.name} ---`);
    try {
      const fixed = await fixVault(plan, { force, cfgPath, log });
      if (!fixed) unfixed++;
    } catch (err) {
      log.warn(`  Fix failed: ${(err as Error).message}`);
      unfixed++;
    }
    log.info('');
  }

  if (unfixed === 0) {
    log.info('All issues repaired. Restart Claude Code to apply.');
  } else {
    log.info(`${unfixed} issue(s) remain — see warnings above.`);
  }
  return unfixed;
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[string | undefined], DoctorOptions, number> = { run };
void _module;
