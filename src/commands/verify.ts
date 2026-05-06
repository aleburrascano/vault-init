import { confirm } from '@inquirer/prompts';
import { Vault, sha256 } from '../lib/vault.js';
import { findTool } from '../lib/platform.js';
import { runMcpRepin, manualMcpRepinCommands } from '../lib/mcp/mcp.js';
import { fetch as gitFetch, hasUpstream, diffFileNames, diff as gitDiff, pull } from '../lib/git.js';
import { ConsoleLogger, type Logger } from '../lib/logger.js';
import { VaultkitError } from '../lib/errors.js';
import { LABELS } from '../lib/messages.js';
import { classifyLauncherSha, historicalVersionLabel } from '../lib/notices/launcher-history.js';
import type { CommandModule, RunOptions } from '../types.js';

export interface VerifyOptions extends RunOptions {
  yes?: boolean;
}

/**
 * Returns true when the upstream tracking branch carries a different
 * `.mcp-start.js` (and only that file) than HEAD. Side-effects: a
 * `git fetch` and the diff output written to `log`. No-op when the
 * vault has no git repo or no configured upstream.
 */
async function detectUpstreamDrift(vault: Vault, log: Logger): Promise<boolean> {
  if (!vault.hasGitRepo()) return false;
  await gitFetch(vault.dir);
  if (!await hasUpstream(vault.dir)) return false;
  const diffFiles = await diffFileNames(vault.dir, 'HEAD..@{u}', ['.mcp-start.js']);
  if (diffFiles.length !== 1 || diffFiles[0] !== '.mcp-start.js') return false;
  log.info('Upstream has a different .mcp-start.js — diff:');
  log.info('----------------------------------------');
  log.info(await gitDiff(vault.dir, 'HEAD..@{u}', ['.mcp-start.js']));
  log.info('----------------------------------------');
  log.info('');
  return true;
}

export async function run(
  name: string,
  { cfgPath, yes = false, log = new ConsoleLogger() }: VerifyOptions = {},
): Promise<void> {
  const vault = await Vault.requireFromName(name, cfgPath);

  if (!vault.hasLauncher()) {
    throw new VaultkitError('NOT_VAULT_LIKE', `${vault.launcherPath} does not exist.\n  Run 'vaultkit update ${name}' to install the launcher.`);
  }

  const pinned = vault.expectedHash ?? '';
  const onDisk = await vault.sha256OfLauncher();

  log.info(`Vault:    ${vault.name}`);
  log.info(`Path:     ${vault.dir}`);
  log.info('');
  log.info(`Pinned SHA-256:  ${pinned || '(none registered)'}`);
  log.info(`On-disk SHA-256: ${onDisk}`);
  log.info('');

  const upstreamDrift = await detectUpstreamDrift(vault, log);

  // Comparison is on-disk hash vs registered (pinned) hash, NOT vs the
  // canonical template hash. See `.claude/rules/security-invariants.md`
  // "Threat model — what vaultkit DOES NOT protect against" for why.
  // tl;dr: registry tampering is out-of-scope; trust boundary is $HOME.
  if (pinned && pinned === onDisk && !upstreamDrift) {
    log.info('Verified — pinned hash matches on-disk and upstream.');
    return;
  }

  let finalHash = onDisk;

  if (upstreamDrift) {
    log.info('If you accept the upstream version, vaultkit will:');
    log.info('  1. git pull --ff-only (applies the upstream .mcp-start.js)');
    log.info('  2. Re-pin the new SHA-256 in your MCP registration');
    log.info('');
    const ok = yes || await confirm({ message: 'Pull upstream and re-pin?', default: false });
    if (!ok) { log.info(LABELS.ABORTED); return; }
    const pullResult = await pull(vault.dir, { ffOnly: true });
    if (!pullResult.success) {
      throw new VaultkitError('PARTIAL_FAILURE', `git pull failed. Resolve manually and re-run vaultkit verify ${name}.`);
    }
    finalHash = await sha256(vault.launcherPath);
    log.info(`  Pulled. New on-disk SHA-256: ${finalHash}`);
  } else {
    const classification = pinned ? classifyLauncherSha(onDisk, pinned) : 'unknown';
    if (classification === 'historical') {
      const label = historicalVersionLabel(onDisk) ?? 'a prior version';
      log.info(`On-disk launcher is outdated after a vaultkit upgrade (was ${label}).`);
      log.info('This is expected after upgrading — the launcher template changed in a release.');
      log.info('Re-pinning to the on-disk hash will accept the older launcher; if you want the');
      log.info(`current template instead, run 'vaultkit update ${name}' (or 'vaultkit update --all').`);
    } else {
      log.info('On-disk launcher does not match the pinned hash.');
      log.info('Inspect the file before trusting it:');
      log.info(`  cat "${vault.launcherPath}"`);
    }
    log.info('');
    const ok = yes || await confirm({ message: `Re-pin the on-disk SHA-256 (${onDisk})?`, default: false });
    if (!ok) { log.info(LABELS.ABORTED); return; }
  }

  const claudePath = await findTool('claude');
  if (!claudePath) {
    const manual = manualMcpRepinCommands(name, vault.launcherPath, finalHash);
    log.warn('Claude Code not found — re-pin manually:');
    log.info(`  ${manual.remove}`);
    log.info(`  ${manual.add}`);
    throw new VaultkitError('TOOL_MISSING', 'Claude Code not found.');
  }

  log.info(`Re-pinning MCP registration with SHA-256 ${finalHash}...`);
  await runMcpRepin(claudePath, name, vault.launcherPath, finalHash);

  log.info('');
  log.info('Done. Restart Claude Code to apply the new pin.');
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[string], VerifyOptions, void> = { run };
void _module;
