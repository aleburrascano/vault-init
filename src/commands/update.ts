import { copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirm } from '@inquirer/prompts';
import { execa } from 'execa';
import { Vault, sha256 } from '../lib/vault.js';
import { detectLayoutGaps, writeLayoutFiles } from '../lib/vault-layout.js';
import { findTool } from '../lib/platform.js';
import { runMcpRepin, manualMcpRepinCommands } from '../lib/mcp.js';
import { add, commit, pushOrPr } from '../lib/git.js';
import { ConsoleLogger } from '../lib/logger.js';
import { PROMPTS, LABELS } from '../lib/messages.js';
import { VAULT_FILES } from '../lib/constants.js';
import type { CommandModule, RunOptions } from '../types.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TMPL_PATH = join(SCRIPT_DIR, '../../lib/mcp-start.js.tmpl');

export interface UpdateOptions extends RunOptions {
  skipConfirm?: boolean;
}

export async function run(
  name: string,
  { cfgPath, log = new ConsoleLogger(), skipConfirm = false }: UpdateOptions = {},
): Promise<void> {
  const vault = await Vault.requireFromName(name, cfgPath);

  if (!vault.hasGitRepo()) {
    throw new Error(`${vault.dir} is not a git repository — aborting.`);
  }

  log.info(`Updating ${name} at ${vault.dir}...`);

  // Launcher refresh detection
  const beforeHash = vault.hasLauncher() ? await vault.sha256OfLauncher() : '';
  const tmplHash = await sha256(TMPL_PATH);
  const launcherWillChange = beforeHash !== tmplHash;

  // Layout-repair detection
  const missing = detectLayoutGaps(vault.dir);

  // Summary
  log.info('');
  if (launcherWillChange) {
    log.info(`  ${VAULT_FILES.LAUNCHER}: ${beforeHash || '(missing)'} → ${tmplHash}`);
  } else {
    log.info(`  ${VAULT_FILES.LAUNCHER}: up to date (${beforeHash})`);
  }
  if (missing.length > 0) {
    log.info(`  Missing layout files (${missing.length}):`);
    for (const f of missing) log.info(`    - ${f}`);
  } else {
    log.info('  Layout: complete.');
  }

  if (!launcherWillChange && missing.length === 0) {
    log.info('');
    log.info('Already up to date. Re-pinning MCP registration anyway (idempotent).');
  }

  if (!skipConfirm) {
    log.info('');
    const ok = await confirm({ message: PROMPTS.PROCEED, default: false });
    if (!ok) { log.info(LABELS.ABORTED); return; }
    log.info('');
  }

  // Apply: copy launcher
  copyFileSync(TMPL_PATH, vault.launcherPath);
  const afterHash = await vault.sha256OfLauncher();

  // Apply: create missing layout files
  writeLayoutFiles(vault.dir, { name, siteUrl: '' }, missing);
  const added = [...missing];

  // Re-pin MCP
  const claudePath = await findTool('claude');
  if (claudePath) {
    log.info(`Re-pinning MCP registration with SHA-256 ${afterHash}...`);
    await runMcpRepin(claudePath, name, vault.launcherPath, afterHash);
  } else {
    const manual = manualMcpRepinCommands(name, vault.launcherPath, afterHash);
    log.warn('Claude Code not found — MCP re-registration skipped.');
    log.info(`  Once installed, run:`);
    log.info(`    ${manual.remove}`);
    log.info(`    ${manual.add}`);
  }

  const launcherChanged = afterHash !== beforeHash;
  if (!launcherChanged && added.length === 0) {
    log.info('');
    log.info('  Nothing to commit.');
    log.info('Done. Restart Claude Code to apply the re-pinned registration.');
    return;
  }

  // Commit
  const filesToStage: string[] = [];
  if (launcherChanged) filesToStage.push('.mcp-start.js');
  filesToStage.push(...added);

  await add(vault.dir, filesToStage);

  const stagedResult = await execa('git', ['-C', vault.dir, 'diff', '--cached', '--name-only'], { reject: false });
  const staged = String(stagedResult.stdout ?? '').trim();
  if (!staged) {
    log.info('  Nothing staged — skipping commit.');
    log.info('Done. Restart Claude Code to apply.');
    return;
  }

  let commitMsg: string;
  if (launcherChanged && added.length > 0) {
    commitMsg = 'chore: update .mcp-start.js + restore standard layout files';
  } else if (launcherChanged) {
    commitMsg = 'chore: update .mcp-start.js to latest vaultkit version';
  } else {
    commitMsg = 'chore: restore standard vaultkit layout files';
  }

  await commit(vault.dir, commitMsg);
  log.info('');

  const pushResult = await pushOrPr(vault.dir, {
    branchPrefix: 'vaultkit-update',
    prTitle: commitMsg,
    prBody: 'Brings the vault up to the current vaultkit standard.',
  });

  if (pushResult.mode === 'direct') {
    log.info('Done. Restart Claude Code to apply the update.');
  } else {
    log.info(`Done. Changes will take effect after the PR (branch: ${pushResult.branch}) is merged.`);
  }
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[string], UpdateOptions, void> = { run };
void _module;
