import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { confirm } from '@inquirer/prompts';
import { execa } from 'execa';
import { Vault, sha256 } from '../lib/vault.js';
import { detectLayoutGaps, writeLayoutFiles } from '../lib/vault-layout.js';
import { findTool } from '../lib/platform.js';
import { getLauncherTemplate } from '../lib/template-paths.js';
import { runMcpRepin, manualMcpRepinCommands } from '../lib/mcp.js';
import { add, commit, pushOrPr } from '../lib/git.js';
import { ConsoleLogger } from '../lib/logger.js';
import { VaultkitError } from '../lib/errors.js';
import { PROMPTS, LABELS } from '../lib/messages.js';
import { VAULT_FILES } from '../lib/constants.js';
import { mergeManagedSection, renderManagedSection } from '../lib/claude-md-merge.js';
import {
  WIKI_STYLE_SECTION_ID,
  WIKI_STYLE_HEADING,
  renderWikiStyleSection,
} from '../lib/vault-templates.js';
import type { CommandModule, RunOptions } from '../types.js';

export interface UpdateOptions extends RunOptions {
  skipConfirm?: boolean;
}

export async function run(
  name: string,
  { cfgPath, log = new ConsoleLogger(), skipConfirm = false }: UpdateOptions = {},
): Promise<void> {
  const vault = await Vault.requireFromName(name, cfgPath);

  if (!vault.hasGitRepo()) {
    throw new VaultkitError('NOT_VAULT_LIKE', `${vault.dir} is not a git repository — aborting.`);
  }

  log.info(`Updating ${name} at ${vault.dir}...`);

  // Launcher refresh detection
  const beforeHash = vault.hasLauncher() ? await vault.sha256OfLauncher() : '';
  const tmplHash = await sha256(getLauncherTemplate());
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
  copyFileSync(getLauncherTemplate(), vault.launcherPath);
  const afterHash = await vault.sha256OfLauncher();

  // Apply: create missing layout files
  writeLayoutFiles(vault.dir, { name, siteUrl: '' }, missing);
  const added = [...missing];

  // Apply: merge the wiki-style section into existing CLAUDE.md (no-op if
  // CLAUDE.md was just freshly created via writeLayoutFiles above — that
  // path already includes the marker-wrapped section via renderClaudeMd).
  let claudeMdMerged = false;
  const claudeMdPath = join(vault.dir, VAULT_FILES.CLAUDE_MD);
  if (existsSync(claudeMdPath) && !missing.includes(VAULT_FILES.CLAUDE_MD)) {
    const existing = readFileSync(claudeMdPath, 'utf8');
    const result = mergeManagedSection(
      existing,
      WIKI_STYLE_SECTION_ID,
      renderWikiStyleSection(),
      WIKI_STYLE_HEADING,
    );
    if (result.merged !== existing && (result.action === 'replaced' || result.action === 'appended')) {
      writeFileSync(claudeMdPath, result.merged);
      claudeMdMerged = true;
      const verb = result.action === 'replaced' ? 'updated' : 'appended';
      log.info(`  ${VAULT_FILES.CLAUDE_MD}: "${WIKI_STYLE_HEADING}" section ${verb}.`);
    } else if (result.action === 'manual') {
      log.warn(`  ${VAULT_FILES.CLAUDE_MD}: existing "${WIKI_STYLE_HEADING}" heading found without vaultkit markers.`);
      log.info('  vaultkit will not overwrite a hand-edited section. To opt into managed merges, replace your section with:');
      log.info('');
      const snippet = renderManagedSection(WIKI_STYLE_SECTION_ID, renderWikiStyleSection());
      for (const line of snippet.split('\n')) log.info(`    ${line}`);
      log.info('');
    }
  }

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
  if (!launcherChanged && added.length === 0 && !claudeMdMerged) {
    log.info('');
    log.info('  Nothing to commit.');
    log.info('Done. Restart Claude Code to apply the re-pinned registration.');
    return;
  }

  // Commit
  const filesToStage: string[] = [];
  if (launcherChanged) filesToStage.push(VAULT_FILES.LAUNCHER);
  filesToStage.push(...added);
  if (claudeMdMerged) filesToStage.push(VAULT_FILES.CLAUDE_MD);

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
