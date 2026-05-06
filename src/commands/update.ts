import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { confirm } from '@inquirer/prompts';
import { Vault, sha256 } from '../lib/vault.js';
import { detectLayoutGaps, writeLayoutFiles } from '../lib/templates/vault-layout.js';
import { findTool } from '../lib/platform.js';
import { getLauncherTemplate } from '../lib/templates/template-paths.js';
import { runMcpRepin, manualMcpRepinCommands } from '../lib/mcp/mcp.js';
import { openSearchIndex } from '../lib/search/search-index.js';
import { indexVault } from '../lib/search/search-indexer.js';
import { add, commit, pushOrPr, getStagedFiles } from '../lib/git.js';
import { getAllVaults } from '../lib/registry.js';
import { ConsoleLogger, type Logger } from '../lib/logger.js';
import { VaultkitError } from '../lib/errors.js';
import { PROMPTS, LABELS } from '../lib/messages.js';
import { VAULT_FILES } from '../lib/constants.js';
import { mergeManagedSection, renderManagedSection } from '../lib/templates/claude-md-merge.js';
import {
  WIKI_STYLE_SECTION_ID,
  WIKI_STYLE_HEADING,
  renderWikiStyleSection,
} from '../lib/templates/vault-templates.js';
import type { CommandModule, RunOptions } from '../types.js';

interface UpdatePlan {
  beforeHash: string;
  tmplHash: string;
  launcherWillChange: boolean;
  missing: string[];
}

async function detectUpdateChanges(vault: Vault): Promise<UpdatePlan> {
  const beforeHash = vault.hasLauncher() ? await vault.sha256OfLauncher() : '';
  const tmplHash = await sha256(getLauncherTemplate());
  const launcherWillChange = beforeHash !== tmplHash;
  const missing = detectLayoutGaps(vault.dir);
  return { beforeHash, tmplHash, launcherWillChange, missing };
}

function printUpdatePlan(plan: UpdatePlan, log: Logger): void {
  log.info('');
  if (plan.launcherWillChange) {
    log.info(`  ${VAULT_FILES.LAUNCHER}: ${plan.beforeHash || '(missing)'} → ${plan.tmplHash}`);
  } else {
    log.info(`  ${VAULT_FILES.LAUNCHER}: up to date (${plan.beforeHash})`);
  }
  if (plan.missing.length > 0) {
    log.info(`  Missing layout files (${plan.missing.length}):`);
    for (const f of plan.missing) log.info(`    - ${f}`);
  } else {
    log.info('  Layout: complete.');
  }
  if (!plan.launcherWillChange && plan.missing.length === 0) {
    log.info('');
    log.info('Already up to date. Re-pinning MCP registration anyway (idempotent).');
  }
}

/**
 * Apply the launcher copy + missing-layout writes. Returns the new
 * launcher SHA (always recomputed — even when the template equals the
 * existing on-disk hash, copying ensures a corrupt prior copy is fixed)
 * and the list of layout files added.
 */
async function applyLauncherAndLayout(
  vault: Vault,
  missing: string[],
): Promise<{ afterHash: string; added: string[] }> {
  copyFileSync(getLauncherTemplate(), vault.launcherPath);
  const afterHash = await vault.sha256OfLauncher();
  writeLayoutFiles(vault.dir, { name: vault.name, siteUrl: '' }, missing);
  return { afterHash, added: [...missing] };
}

/**
 * Merge the wiki-style policy section into existing CLAUDE.md. No-op if
 * CLAUDE.md is in the just-written `missing` list (renderClaudeMd
 * already includes the marker-wrapped section). Returns true iff the
 * file was actually written, so caller knows to stage it.
 */
function mergeWikiStyleClaudeMd(
  vault: Vault,
  missing: string[],
  log: Logger,
): boolean {
  const claudeMdPath = join(vault.dir, VAULT_FILES.CLAUDE_MD);
  if (!existsSync(claudeMdPath) || missing.includes(VAULT_FILES.CLAUDE_MD)) return false;
  const existing = readFileSync(claudeMdPath, 'utf8');
  const result = mergeManagedSection(
    existing,
    WIKI_STYLE_SECTION_ID,
    renderWikiStyleSection(),
    WIKI_STYLE_HEADING,
  );
  if (result.merged !== existing && (result.action === 'replaced' || result.action === 'appended')) {
    writeFileSync(claudeMdPath, result.merged);
    const verb = result.action === 'replaced' ? 'updated' : 'appended';
    log.info(`  ${VAULT_FILES.CLAUDE_MD}: "${WIKI_STYLE_HEADING}" section ${verb}.`);
    return true;
  }
  if (result.action === 'manual') {
    log.warn(`  ${VAULT_FILES.CLAUDE_MD}: existing "${WIKI_STYLE_HEADING}" heading found without vaultkit markers.`);
    log.info('  vaultkit will not overwrite a hand-edited section. To opt into managed merges, replace your section with:');
    log.info('');
    const snippet = renderManagedSection(WIKI_STYLE_SECTION_ID, renderWikiStyleSection());
    for (const line of snippet.split('\n')) log.info(`    ${line}`);
    log.info('');
  }
  return false;
}

/**
 * Best-effort vault re-index. Failures are logged as warnings — search
 * is value-add, not critical-path; the rest of update should still run.
 */
async function reindexUpdatedVault(vault: Vault, log: Logger): Promise<void> {
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
}

async function repinMcp(vault: Vault, afterHash: string, log: Logger): Promise<void> {
  const claudePath = await findTool('claude');
  if (claudePath) {
    log.info(`Re-pinning MCP registration with SHA-256 ${afterHash}...`);
    await runMcpRepin(claudePath, vault.name, vault.launcherPath, afterHash);
    return;
  }
  const manual = manualMcpRepinCommands(vault.name, vault.launcherPath, afterHash);
  log.warn('Claude Code not found — MCP re-registration skipped.');
  log.info(`  Once installed, run:`);
  log.info(`    ${manual.remove}`);
  log.info(`    ${manual.add}`);
}

interface UpdateChanges {
  launcherChanged: boolean;
  added: string[];
  claudeMdMerged: boolean;
}

/**
 * Stage the changed files, build a commit message that names what
 * actually changed, and push (or open a PR if direct push is blocked).
 */
async function commitAndPushUpdate(
  vault: Vault,
  changes: UpdateChanges,
  log: Logger,
): Promise<void> {
  const filesToStage: string[] = [];
  if (changes.launcherChanged) filesToStage.push(VAULT_FILES.LAUNCHER);
  filesToStage.push(...changes.added);
  if (changes.claudeMdMerged) filesToStage.push(VAULT_FILES.CLAUDE_MD);

  await add(vault.dir, filesToStage);

  const staged = await getStagedFiles(vault.dir);
  if (staged.length === 0) {
    log.info('  Nothing staged — skipping commit.');
    log.info('Done. Restart Claude Code to apply.');
    return;
  }

  let commitMsg: string;
  if (changes.launcherChanged && changes.added.length > 0) {
    commitMsg = 'chore: update .mcp-start.js + restore standard layout files';
  } else if (changes.launcherChanged) {
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

  const plan = await detectUpdateChanges(vault);
  printUpdatePlan(plan, log);

  if (!skipConfirm) {
    log.info('');
    const ok = await confirm({ message: PROMPTS.PROCEED, default: false });
    if (!ok) { log.info(LABELS.ABORTED); return; }
    log.info('');
  }

  const { afterHash, added } = await applyLauncherAndLayout(vault, plan.missing);
  const claudeMdMerged = mergeWikiStyleClaudeMd(vault, plan.missing, log);
  await reindexUpdatedVault(vault, log);
  await repinMcp(vault, afterHash, log);

  const launcherChanged = afterHash !== plan.beforeHash;
  if (!launcherChanged && added.length === 0 && !claudeMdMerged) {
    log.info('');
    log.info('  Nothing to commit.');
    log.info('Done. Restart Claude Code to apply the re-pinned registration.');
    return;
  }

  await commitAndPushUpdate(vault, { launcherChanged, added, claudeMdMerged }, log);
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[string | undefined], UpdateOptions, void> = { run };
void _module;
