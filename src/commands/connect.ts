import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { confirm } from '@inquirer/prompts';
import { Vault, sha256, isVaultLike } from '../lib/vault.js';
import { addToRegistry } from '../lib/registry.js';
import { findTool, vaultsRoot } from '../lib/platform.js';
import { findOrInstallClaude, runMcpAdd, manualMcpAddCommand } from '../lib/mcp/mcp.js';
import { clone } from '../lib/git.js';
import { ConsoleLogger, type Logger } from '../lib/logger.js';
import { VaultkitError } from '../lib/errors.js';
import { VAULT_FILES } from '../lib/constants.js';
import { PROMPTS } from '../lib/messages.js';
import type { CommandModule, RunOptions } from '../types.js';

export interface ConnectOptions extends RunOptions {
  skipMcp?: boolean;
}

/**
 * Print the load-bearing trust notice the user reads before deciding
 * whether to register a cloned vault as an MCP server. The launcher
 * runs with full user permissions on every Claude Code session, so the
 * file path + SHA-256 must be visible at confirm time.
 */
function printLauncherTrustNotice(launcherPath: string, hash: string, log: Logger): void {
  log.info('');
  log.info('This vault\'s .mcp-start.js will run with your full user permissions on every');
  log.info('Claude Code session start. Only connect vaults from authors you trust.');
  log.info('');
  log.info(`  File:    ${launcherPath}`);
  log.info(`  SHA-256: ${hash}`);
  log.info('');
}

/**
 * Drive the post-clone registration flow: skipMcp (registry-only),
 * user-declined (clone retained, MCP skipped), claude-not-installed
 * (clone retained, manual command surfaced), or full registration.
 * Centralizes every "what happens when we try to register" outcome so
 * `run()` is just clone + this call.
 */
async function registerVaultAsMcp(
  name: string,
  vaultDir: string,
  launcherPath: string,
  hash: string,
  cfgPath: string | undefined,
  skipMcp: boolean,
  repo: string,
  log: Logger,
): Promise<void> {
  if (skipMcp) {
    await addToRegistry(name, launcherPath, hash, cfgPath);
    log.info('');
    log.info(`Done. ${name} registered (MCP CLI skipped).`);
    log.info(`  Vault: ${vaultDir}`);
    return;
  }

  const confirmed = await confirm({ message: PROMPTS.REGISTER_AS_MCP, default: false });
  if (!confirmed) {
    log.info('');
    log.info(`MCP registration skipped. Vault cloned to: ${vaultDir}`);
    log.info(`To register later, re-run: vaultkit connect ${repo}`);
    return;
  }

  log.info('');
  const claudePath = await findOrInstallClaude({
    log,
    promptInstall: () => confirm({ message: PROMPTS.INSTALL_CLAUDE, default: false }),
  });

  if (claudePath) {
    log.info(`Registering MCP server: ${name}`);
    await runMcpAdd(claudePath, name, launcherPath, hash);
    log.info('');
    log.info(`Done. ${name} is now available in Claude Code.`);
    log.info(`  Vault: ${vaultDir}`);
    return;
  }

  log.info('');
  log.warn('Claude Code CLI not installed — MCP registration skipped.');
  log.info(`  Once installed, run:`);
  log.info(`  ${manualMcpAddCommand(name, launcherPath, hash)}`);
}

export function _normalizeInput(input: string): { repo: string; name: string } {
  const httpsM = input.match(/^https:\/\/github\.com\/([^/]+\/[^/.]+?)(\.git)?(\/.*)?$/);
  if (httpsM) {
    const repo = httpsM[1] ?? '';
    return { repo, name: basename(repo) };
  }
  const sshM = input.match(/^git@github\.com:([^/]+\/[^/.]+?)(\.git)?$/);
  if (sshM) {
    const repo = sshM[1] ?? '';
    return { repo, name: basename(repo) };
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input)) {
    return { repo: input, name: basename(input) };
  }
  throw new VaultkitError('UNRECOGNIZED_INPUT', `Unrecognized format. Use owner/repo or a GitHub URL.`);
}

export async function run(
  input: string,
  { cfgPath, skipMcp = false, log = new ConsoleLogger() }: ConnectOptions = {},
): Promise<void> {
  const { repo, name } = _normalizeInput(input);

  const existing = await Vault.tryFromName(name, cfgPath);
  if (existing) {
    throw new VaultkitError('ALREADY_REGISTERED', `An MCP server named '${name}' is already registered.\nRun 'vaultkit list' or 'vaultkit disconnect ${name}' first.`);
  }

  const root = vaultsRoot();
  mkdirSync(root, { recursive: true });
  const vaultDir = join(root, name);

  if (existsSync(vaultDir)) {
    throw new VaultkitError('ALREADY_REGISTERED', `${vaultDir} already exists.`);
  }

  log.info(`Cloning ${repo} into ${vaultDir}...`);
  await clone(repo, vaultDir, { useGh: !!(await findTool('gh')) });

  // From this point on, any thrown error should clean up the partial
  // clone. Successful early returns (skipMcp, user-declined, no-launcher,
  // no-claude) leave the clone intact -- the user opted into a partial
  // state, not a failure.
  try {
    const launcherPath = join(vaultDir, VAULT_FILES.LAUNCHER);
    if (!existsSync(launcherPath)) {
      log.info('');
      log.warn(`${name} is missing .mcp-start.js — it may have been created with an older version.`);
      log.info('  MCP registration skipped.');
      log.info('  Ask the owner to run \'vaultkit update\' and push, then reconnect.');
      return;
    }

    if (!isVaultLike(vaultDir)) {
      log.info('');
      log.warn(`${name} is missing the standard vault layout (CLAUDE.md / raw/ / wiki/).`);
      log.info('  Connecting anyway — ask the owner to run \'vaultkit update\' so layout-aware features work.');
    }

    // We hash the on-disk launcher and pin THAT value — we do NOT compare
    // against the canonical template SHA. See `.claude/rules/security-invariants.md`
    // "Threat model" entry on malicious upstream vaults for why. The user is
    // the one making the trust call; vaultkit surfaces the SHA + path so they
    // can `cat` the launcher before confirming.
    const hash = await sha256(launcherPath);
    printLauncherTrustNotice(launcherPath, hash, log);
    await registerVaultAsMcp(name, vaultDir, launcherPath, hash, cfgPath, skipMcp, repo, log);
  } catch (err) {
    if (existsSync(vaultDir)) {
      log.info('');
      log.info(`Connect failed — removing partial clone at ${vaultDir}`);
      rmSync(vaultDir, { recursive: true, force: true });
    }
    throw err;
  }
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[string], ConnectOptions, void> = { run };
void _module;
