import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { confirm } from '@inquirer/prompts';
import { Vault, sha256 } from '../lib/vault.js';
import { detectLayoutGaps, writeLayoutFiles } from '../lib/vault-layout.js';
import { findTool } from '../lib/platform.js';
import { getLauncherTemplate } from '../lib/template-paths.js';
import { runMcpRepin, manualMcpRepinCommands } from '../lib/mcp.js';
import { openSearchIndex } from '../lib/search-index.js';
import { indexVault } from '../lib/search-indexer.js';
import { add, commit, pushOrPr, getStagedFiles } from '../lib/git.js';
import { getAllVaults } from '../lib/registry.js';
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
  all?: boolean;
}

export async function run(
  name: string | undefined,
  opts: UpdateOptions = {},
): Promise<void> {
  const log = opts.log ?? new ConsoleLogger();

  if (opts.all) {
    if (name !== undefined) {
      throw new VaultkitError(
        'UNRECOGNIZED_INPUT',
        `'vaultkit update' accepts either a vault name OR --all, not both.`,
      );
    }
    return runAll({ ...opts, log });
  }

  if (name === undefined) {
    throw new VaultkitError(
      'UNRECOGNIZED_INPUT',
      `'vaultkit update' requires a vault name (or --all to update every registered vault).`,
    );
  }

  const vault = await Vault.requireFromName(name, opts.cfgPath);
  await updateOneVault(vault, { ...opts, log });
}

async function runAll(opts: UpdateOptions): Promise<void> {
  const log = opts.log ?? new ConsoleLogger();
  const records = await getAllVaults(opts.cfgPath);

  if (records.length === 0) {
    log.info('No registered vaults — nothing to update.');
    return;
  }

  log.info(`Updating ${records.length} registered vault(s)...`);
  log.info('');

  const results: Array<{ name: string; status: 'ok' | 'fail'; message?: string }> = [];

  for (const record of records) {
    const vault = Vault.fromRecord(record);
    log.info(`--- ${vault.name} ---`);
    try {
      await updateOneVault(vault, { ...opts, log, skipConfirm: true });
      results.push({ name: vault.name, status: 'ok' });
    } catch (err) {
      const msg = (err as { message?: string })?.message ?? String(err);
      results.push({ name: vault.name, status: 'fail', message: msg });
      log.warn(`  Failed: ${msg}`);
    }
    log.info('');
  }

  log.info('Summary:');
  for (const r of results) {
    if (r.status === 'ok') {
      log.info(`  + ok   ${r.name}`);
    } else {
      log.info(`  x fail ${r.name}: ${r.message}`);
    }
  }

  const fails = results.filter(r => r.status === 'fail');
  if (fails.length > 0) {
    throw new VaultkitError(
      'PARTIAL_FAILURE',
      `${fails.length} of ${results.length} vault(s) failed to update.`,
    );
  }
}

async function updateOneVault(
  vault: Vault,
  { log = new ConsoleLogger(), skipConfirm = false }: UpdateOptions,
): Promise<void> {
  if (!vault.hasGitRepo()) {
    throw new VaultkitError('NOT_VAULT_LIKE', `${vault.dir} is not a git repository — aborting.`);
  }

  log.info(`Updating ${vault.name} at ${vault.dir}...`);

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
  writeLayoutFiles(vault.dir, { name: vault.name, siteUrl: '' }, missing);
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

  // Re-index vault for vaultkit-search MCP. Runs after layout
  // reconcile + CLAUDE.md merge so any newly-added files are picked
  // up. Best-effort — failures here don't block the rest of update
  // (search is value-add, not critical-path).
  try {
    const idx = openSearchIndex();
    try {
      await indexVault(vault.name, vault.dir, idx);
    } finally {
      idx.close();
    }
  } catch (err) {
    log.warn(`  Search: re-index failed — ${(err as Error).message}.`);
  }

  // Re-pin MCP
  const claudePath = await findTool('claude');
  if (claudePath) {
    log.info(`Re-pinning MCP registration with SHA-256 ${afterHash}...`);
    await runMcpRepin(claudePath, vault.name, vault.launcherPath, afterHash);
  } else {
    const manual = manualMcpRepinCommands(vault.name, vault.launcherPath, afterHash);
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

  const staged = await getStagedFiles(vault.dir);
  if (staged.length === 0) {
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
const _module: CommandModule<[string | undefined], UpdateOptions, void> = { run };
void _module;
