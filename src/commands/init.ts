import { existsSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { confirm, select } from '@inquirer/prompts';
import { validateName, sha256 } from '../lib/vault.js';
import { renderVaultJson } from '../lib/vault-templates.js';
import { createDirectoryTree, writeLayoutFiles, CANONICAL_LAYOUT_FILES } from '../lib/vault-layout.js';
import { findTool, vaultsRoot } from '../lib/platform.js';
import { getLauncherTemplate, getDeployTemplate } from '../lib/template-paths.js';
import { checkNode, ensureGh, ensureGhAuth, ensureGitConfig } from '../lib/prereqs.js';
import { findOrInstallClaude, runMcpAdd, runMcpRemove, manualMcpAddCommand } from '../lib/mcp.js';
import { openSearchIndex } from '../lib/search-index.js';
import { indexVault } from '../lib/search-indexer.js';
import { init as gitInit, setDefaultBranch, addRemote, add as gitAdd, commit as gitCommit, pushNewRepo } from '../lib/git.js';
import { ghJsonWithInput } from '../lib/gh-retry.js';
import { createRepo, deleteRepo, repoUrl, repoCloneUrl } from '../lib/github-repo.js';
import { enablePages, setPagesVisibility } from '../lib/github-pages.js';
import { getCurrentUser, requireAuthGatedEligible } from '../lib/github-auth.js';
import { ConsoleLogger, type Logger } from '../lib/logger.js';
import { VaultkitError } from '../lib/errors.js';
import { VAULT_FILES, VAULT_DIRS, WORKFLOW_FILES, PUBLISH_MODES, isPublishMode, type PublishMode } from '../lib/constants.js';
import { PROMPTS } from '../lib/messages.js';
import type { CommandModule, RunOptions } from '../types.js';

export interface InitOptions extends RunOptions {
  publishMode?: PublishMode;
  gitName?: string;
  gitEmail?: string;
  skipInstallCheck?: boolean;
}

// ─── Phase helpers — keep init's run() readable as a sequence ─────────────

export interface PublishConfig {
  publishMode: PublishMode;
  repoVisibility: 'public' | 'private';
  enablePages: boolean;
  pagesPrivate: boolean;
  writeDeploy: boolean;
}

export async function selectPublishMode(publishModeOpt: PublishMode | undefined): Promise<PublishConfig> {
  if (publishModeOpt !== undefined && !isPublishMode(publishModeOpt)) {
    throw new VaultkitError('UNRECOGNIZED_INPUT', `Invalid publishMode: "${publishModeOpt}". Must be one of: ${PUBLISH_MODES.join(', ')}`);
  }
  const publishMode: PublishMode = publishModeOpt ?? await select<PublishMode>({
    message: 'Publish this vault as a public knowledge site?',
    choices: [
      { name: 'Private repo, notes-only (no Pages, no public URL)  [default]', value: 'private' },
      { name: 'Public repo + public Quartz site', value: 'public' },
      { name: 'Private repo + auth-gated Pages site (GitHub Pro+ only)', value: 'auth-gated' },
    ],
  });

  if (publishMode === 'auth-gated') {
    await requireAuthGatedEligible('Choose Public or Private instead.');
  }

  return {
    publishMode,
    repoVisibility: publishMode === 'public' ? 'public' : 'private',
    enablePages: publishMode !== 'private',
    pagesPrivate: publishMode === 'auth-gated',
    writeDeploy: publishMode !== 'private',
  };
}

async function getGithubUser(): Promise<string> {
  try {
    return await getCurrentUser();
  } catch {
    throw new VaultkitError('AUTH_REQUIRED', 'Could not fetch your GitHub username. Run: gh auth status');
  }
}

async function setupGitHubPages(githubUser: string, name: string, pagesPrivate: boolean, log: Logger): Promise<void> {
  const slug = `${githubUser}/${name}`;
  try {
    await enablePages(slug);
  } catch {
    log.warn(`  Could not auto-enable GitHub Pages.`);
    log.info(`  Enable manually: ${repoUrl(slug, 'settings/pages')}`);
    return;
  }
  if (pagesPrivate) {
    try {
      await setPagesVisibility(slug, 'private');
    } catch {
      log.warn(`  Could not set Pages to private — may be publicly accessible.`);
    }
  }
}

async function setupBranchProtection(githubUser: string, name: string, log: Logger): Promise<void> {
  const protectionBody = JSON.stringify({
    required_status_checks: null,
    enforce_admins: false,
    required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: false },
    restrictions: null,
  });
  try {
    await ghJsonWithInput(protectionBody,
      'api', `repos/${githubUser}/${name}/branches/main/protection`,
      '--method', 'PUT', '--input', '-',
    );
  } catch {
    // Branch protection requires a paid plan on private repos and a
    // few other forms of permission; surface as an info-level note
    // with the manual recovery URL rather than aborting init.
    log.info(`  Note: Branch protection not applied (may require a paid plan for private repos).`);
    log.info(`  Set up manually: ${repoUrl(`${githubUser}/${name}`, 'settings/branches')}`);
  }
}

/** Returns true if the MCP server was successfully registered (caller uses for rollback). */
async function registerMcpForVault(vaultDir: string, name: string, skipInstallCheck: boolean, log: Logger): Promise<boolean> {
  const launcherPath = join(vaultDir, VAULT_FILES.LAUNCHER);
  const hash = await sha256(launcherPath);
  const claudePath = await findOrInstallClaude({
    log,
    promptInstall: () => skipInstallCheck
      ? Promise.resolve(true)
      : confirm({ message: PROMPTS.INSTALL_CLAUDE, default: false }),
  });

  if (claudePath) {
    log.info(`Registering MCP server: ${name}`);
    await runMcpAdd(claudePath, name, launcherPath, hash);
    return true;
  }
  log.info(`  Note: Claude Code CLI not installed — skipping MCP registration.`);
  log.info(`  Once installed, run:`);
  log.info(`  ${manualMcpAddCommand(name, launcherPath, hash)}`);
  return false;
}

async function initGitRepo(vaultDir: string, name: string, log: Logger): Promise<void> {
  log.info('[3/6] Committing initial files...');
  await gitInit(vaultDir);
  await setDefaultBranch(vaultDir, 'main');
  await gitAdd(vaultDir, '.');
  await gitCommit(vaultDir, `chore: initialize ${name}`);
}

/**
 * Creates the GitHub repo. Intentionally does NOT also call `addRemote`:
 * the rollback bookkeeping in `run()` flips `createdRepo = true` between
 * the two calls so that a local-side `addRemote` failure still triggers
 * `deleteRepo` in the catch — bundling them would orphan the just-created
 * GitHub repo.
 */
async function createGitHubRepo(
  name: string,
  repoVisibility: 'public' | 'private',
  log: Logger,
): Promise<void> {
  log.info(`[4/6] Creating GitHub repo: ${name} (${repoVisibility})...`);
  await createRepo(name, { visibility: repoVisibility });
}

async function indexNewVault(name: string, vaultDir: string, log: Logger): Promise<void> {
  try {
    const idx = openSearchIndex();
    try {
      const result = await indexVault(name, vaultDir, idx);
      if (result.added > 0) {
        log.info(`  Search: indexed ${result.added} note${result.added === 1 ? '' : 's'} into vaultkit-search.`);
      }
    } finally {
      idx.close();
    }
  } catch (err) {
    log.warn(`  Search: indexing failed — ${(err as Error).message}. Run 'vaultkit update ${name}' to retry.`);
  }
}

function printDoneSummary(name: string, githubUser: string, vaultDir: string, publishMode: PublishMode, baseUrl: string, log: Logger): void {
  log.info('');
  log.info('Done.');
  log.info(`  Repo:  ${repoUrl(`${githubUser}/${name}`)}`);
  if (publishMode === 'public') {
    log.info(`  Site:  https://${baseUrl}  (live after CI finishes, ~1 min)`);
  } else if (publishMode === 'auth-gated') {
    log.info(`  Site:  https://${baseUrl}  (auth-gated — visible only to authorized GitHub users)`);
  }
  log.info(`  Vault: ${vaultDir}`);
}

export async function run(
  name: string,
  {
    cfgPath: _cfgPath,
    publishMode: publishModeOpt,
    gitName: gitNameOpt,
    gitEmail: gitEmailOpt,
    skipInstallCheck = false,
    log = new ConsoleLogger(),
  }: InitOptions = {},
): Promise<void> {
  validateName(name);

  const root = vaultsRoot();
  const vaultDir = join(root, name);

  // [1/6] Prerequisites — delegates to src/lib/prereqs.ts so `vaultkit setup`
  // and init's preflight cannot drift.
  log.info('[1/6] Checking prerequisites...');

  const node = checkNode();
  if (!node.ok) {
    throw new VaultkitError('TOOL_MISSING', `${node.message}\n  Update at: https://nodejs.org`);
  }
  const ghPath = await ensureGh({ log, skipInstallCheck });
  await ensureGhAuth({ ghPath, log });
  await ensureGitConfig({
    ...(gitNameOpt !== undefined && { nameOpt: gitNameOpt }),
    ...(gitEmailOpt !== undefined && { emailOpt: gitEmailOpt }),
  });

  log.info('');
  const { publishMode, repoVisibility, enablePages: doEnablePages, pagesPrivate, writeDeploy } =
    await selectPublishMode(publishModeOpt);

  mkdirSync(root, { recursive: true });
  if (existsSync(vaultDir)) throw new VaultkitError('ALREADY_REGISTERED', `${vaultDir} already exists.`);

  const githubUser = await getGithubUser();
  const baseUrl = `${githubUser}.github.io/${name}`;

  let createdDir = false;
  let createdRepo = false;
  let registeredMcp = false;

  try {
    // [2/6] Create vault layout
    log.info(`\n[2/6] Creating vault: ${name} (${publishMode})`);
    mkdirSync(vaultDir, { recursive: true });
    createdDir = true;

    createDirectoryTree(vaultDir);
    writeLayoutFiles(vaultDir, { name, siteUrl: doEnablePages ? baseUrl : '' }, CANONICAL_LAYOUT_FILES);
    copyFileSync(getLauncherTemplate(), join(vaultDir, VAULT_FILES.LAUNCHER));

    if (writeDeploy) {
      copyFileSync(getDeployTemplate(), join(vaultDir, VAULT_DIRS.GITHUB_WORKFLOWS, WORKFLOW_FILES.DEPLOY));
      writeFileSync(join(vaultDir, VAULT_FILES.VAULT_JSON), renderVaultJson(githubUser, name));
    }

    // [3/6] Git init + initial commit
    await initGitRepo(vaultDir, name, log);

    // [4/6] GitHub repo. Flip createdRepo BEFORE addRemote so a local-side
    // failure (stale remote, perms) still triggers deleteRepo in rollback —
    // otherwise the just-created GitHub repo orphans.
    await createGitHubRepo(name, repoVisibility, log);
    createdRepo = true;
    await addRemote(vaultDir, 'origin', repoCloneUrl(githubUser, name));

    // [5/6] Pages + push
    if (doEnablePages) {
      log.info('[5/6] Enabling Pages and pushing...');
      await setupGitHubPages(githubUser, name, pagesPrivate, log);
    } else {
      log.info('[5/6] Pushing (no Pages — notes-only vault)...');
    }
    await pushNewRepo(vaultDir, 'main');

    // [6/6] Branch protection
    log.info('[6/6] Protecting main branch...');
    await setupBranchProtection(githubUser, name, log);

    // MCP registration
    registeredMcp = await registerMcpForVault(vaultDir, name, skipInstallCheck, log);

    // Index the new vault for vaultkit-search MCP. Best-effort —
    // failures here don't block init or trigger rollback (search is
    // value-add, not critical-path; user can run `vaultkit update`
    // later to retry).
    await indexNewVault(name, vaultDir, log);

    printDoneSummary(name, githubUser, vaultDir, publishMode, baseUrl, log);

  } catch (err) {
    // Transactional rollback
    log.info('');
    log.info('Setup failed — rolling back...');
    if (registeredMcp) {
      const claudePath = await findTool('claude');
      if (claudePath) {
        await runMcpRemove(claudePath, name);
        log.info('  MCP registration removed.');
      }
    }
    if (createdRepo) {
      try {
        await deleteRepo(`${githubUser}/${name}`);
        log.info('  GitHub repo deleted.');
      } catch {
        log.warn(`  Could not delete GitHub repo — run manually: gh repo delete ${githubUser}/${name} --yes`);
      }
    }
    if (createdDir && existsSync(vaultDir)) {
      rmSync(vaultDir, { recursive: true, force: true });
      log.info('  Local directory removed.');
    }
    throw err;
  }
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[string], InitOptions, void> = { run };
void _module;
