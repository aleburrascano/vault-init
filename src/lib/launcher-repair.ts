import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Vault, sha256 } from './vault.js';
import { detectLayoutGaps, writeLayoutFiles } from './templates/vault-layout.js';
import { findTool } from './platform.js';
import { getLauncherTemplate } from './templates/template-paths.js';
import { runMcpRepin, manualMcpRepinCommands } from './mcp/mcp.js';
import { openSearchIndex } from './search/search-index.js';
import { indexVault } from './search/search-indexer.js';
import { add, commit, pushOrPr, getStagedFiles, fetch as gitFetch, hasUpstream, diffFileNames, diff as gitDiff, pull as gitPull } from './git.js';
import { VaultkitError } from './errors.js';
import { VAULT_FILES } from './constants.js';
import { mergeManagedSection, renderManagedSection } from './templates/claude-md-merge.js';
import { WIKI_STYLE_SECTION_ID, WIKI_STYLE_HEADING, renderWikiStyleSection } from './templates/vault-templates.js';
import type { Logger } from './logger.js';

/**
 * The two repair paths vaultkit can take on a vault whose launcher SHA
 * doesn't match its pinned value. Doctor classifies the failure and
 * dispatches to the right one:
 *
 *   - `refreshLauncher(vault, log)` — the "update" path: copy the
 *     current template over the on-disk launcher, restore any missing
 *     layout files, merge the wiki-style CLAUDE.md section, re-index,
 *     re-pin MCP, then commit + push (or open a PR if main is
 *     protected). Used for `historical-drift` (vault made on an older
 *     vaultkit), `no-pin` (legacy registration), and `layout-gap`
 *     (user deleted layout files). Always commits to the vault.
 *
 *   - `repinToOnDisk(vault, log)` — the "verify" path: optionally pull
 *     upstream if it carries a different `.mcp-start.js` (only that
 *     file), then re-pin MCP to whatever SHA is on disk. Used for
 *     `unknown-drift` when the user passed `--force` to accept the
 *     on-disk launcher. Does NOT commit — the launcher came from
 *     upstream (or is a deliberate user choice), and a commit would
 *     re-push it back to the source of truth.
 *
 * Extracted from the prior `src/commands/update.ts` and `verify.ts` so
 * doctor can call them directly. The two old commands themselves
 * become commander deprecation aliases (in `bin/vaultkit.ts`) and
 * their `.ts` files are deleted. See CHANGELOG 3.0.0 + the
 * "Deferred to a follow-up" entry.
 */

// ─── Refresh path (former update.ts:updateOneVault) ────────────────────────

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

async function applyLauncherAndLayout(
  vault: Vault,
  missing: string[],
): Promise<{ afterHash: string; added: string[] }> {
  copyFileSync(getLauncherTemplate(), vault.launcherPath);
  const afterHash = await vault.sha256OfLauncher();
  writeLayoutFiles(vault.dir, { name: vault.name, siteUrl: '' }, missing);
  return { afterHash, added: [...missing] };
}

function mergeWikiStyleClaudeMd(vault: Vault, missing: string[], log: Logger): boolean {
  const claudeMdPath = join(vault.dir, VAULT_FILES.CLAUDE_MD);
  if (!existsSync(claudeMdPath) || missing.includes(VAULT_FILES.CLAUDE_MD)) return false;
  const existing = readFileSync(claudeMdPath, 'utf8');
  const result = mergeManagedSection(existing, WIKI_STYLE_SECTION_ID, renderWikiStyleSection(), WIKI_STYLE_HEADING);
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

async function repinMcpToHash(vault: Vault, afterHash: string, log: Logger): Promise<void> {
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

async function commitAndPushUpdate(vault: Vault, changes: UpdateChanges, log: Logger): Promise<void> {
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

/**
 * Refresh a vault to the current vaultkit template + restore missing
 * layout files + re-pin MCP + commit + push. Doctor's repair path for
 * `historical-drift` / `no-pin` / `layout-gap`.
 *
 * Throws `VaultkitError('NOT_VAULT_LIKE')` if the vault is not a git
 * repo (the repair commits to the vault, so a git repo is required).
 *
 * Equivalent to the prior `src/commands/update.ts:updateOneVault` with
 * `skipConfirm: true` — there is no per-vault confirmation prompt
 * because doctor's outer prompt covers every flagged vault in one go.
 */
export async function refreshLauncher(vault: Vault, log: Logger): Promise<void> {
  if (!vault.hasGitRepo()) {
    throw new VaultkitError('NOT_VAULT_LIKE', `${vault.dir} is not a git repository — aborting.`);
  }

  log.info(`Refreshing ${vault.name} at ${vault.dir}...`);

  const plan = await detectUpdateChanges(vault);
  printUpdatePlan(plan, log);

  const { afterHash, added } = await applyLauncherAndLayout(vault, plan.missing);
  const claudeMdMerged = mergeWikiStyleClaudeMd(vault, plan.missing, log);
  await reindexUpdatedVault(vault, log);
  await repinMcpToHash(vault, afterHash, log);

  const launcherChanged = afterHash !== plan.beforeHash;
  if (!launcherChanged && added.length === 0 && !claudeMdMerged) {
    log.info('');
    log.info('  Nothing to commit.');
    log.info('Done. Restart Claude Code to apply the re-pinned registration.');
    return;
  }

  await commitAndPushUpdate(vault, { launcherChanged, added, claudeMdMerged }, log);
}

// ─── Re-pin path (former verify.ts:run) ─────────────────────────────────────

/**
 * Returns true when the upstream tracking branch carries a different
 * `.mcp-start.js` (and only that file) than HEAD. Side-effects: a
 * `git fetch` and the diff output written to `log`. No-op when the
 * vault has no git repo or no configured upstream.
 */
async function detectUpstreamLauncherDrift(vault: Vault, log: Logger): Promise<boolean> {
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

/**
 * Re-pin MCP to the on-disk launcher SHA. If upstream carries a
 * different `.mcp-start.js`, pull it first (ff-only) and re-pin to the
 * pulled bytes. Doctor's repair path for `unknown-drift` when the user
 * passed `--force` to accept the on-disk launcher.
 *
 * Does NOT commit anything — the launcher is treated as the source of
 * truth (it came from upstream or is a deliberate user choice). The
 * security posture is: vaultkit surfaces the SHA + path so the user
 * can `cat` the file before invoking with `--force`; vaultkit's job
 * is to record the trust decision, not to second-guess it.
 *
 * Throws `VaultkitError('PARTIAL_FAILURE')` if `git pull --ff-only`
 * fails (resolve manually and re-run). Throws
 * `VaultkitError('TOOL_MISSING')` if claude CLI is missing — re-pin
 * cannot proceed without it (the user gets the manual `claude mcp`
 * commands to copy-paste).
 *
 * Equivalent to the prior `src/commands/verify.ts:run` with
 * `yes: true` — there is no confirmation prompt because doctor's outer
 * prompt covers it.
 */
export async function repinToOnDisk(vault: Vault, log: Logger): Promise<void> {
  if (!vault.hasLauncher()) {
    throw new VaultkitError(
      'NOT_VAULT_LIKE',
      `${vault.launcherPath} does not exist.\n  Run 'vaultkit doctor ${vault.name} --fix' to install the launcher.`,
    );
  }

  const onDisk = await vault.sha256OfLauncher();

  log.info(`Vault:    ${vault.name}`);
  log.info(`Path:     ${vault.dir}`);
  log.info('');
  log.info(`On-disk SHA-256: ${onDisk}`);
  log.info('');

  const upstreamDrift = await detectUpstreamLauncherDrift(vault, log);

  let finalHash = onDisk;
  if (upstreamDrift) {
    log.info('Pulling upstream and re-pinning to the new SHA...');
    const pullResult = await gitPull(vault.dir, { ffOnly: true });
    if (!pullResult.success) {
      throw new VaultkitError(
        'PARTIAL_FAILURE',
        `git pull failed. Resolve manually and re-run vaultkit doctor ${vault.name} --fix --force.`,
      );
    }
    finalHash = await sha256(vault.launcherPath);
    log.info(`  Pulled. New on-disk SHA-256: ${finalHash}`);
  }

  const claudePath = await findTool('claude');
  if (!claudePath) {
    const manual = manualMcpRepinCommands(vault.name, vault.launcherPath, finalHash);
    log.warn('Claude Code not found — re-pin manually:');
    log.info(`  ${manual.remove}`);
    log.info(`  ${manual.add}`);
    throw new VaultkitError('TOOL_MISSING', 'Claude Code not found.');
  }

  log.info(`Re-pinning MCP registration with SHA-256 ${finalHash}...`);
  await runMcpRepin(claudePath, vault.name, vault.launcherPath, finalHash);

  log.info('');
  log.info('Done. Restart Claude Code to apply the new pin.');
}
