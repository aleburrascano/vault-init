import { existsSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirm, input, select } from '@inquirer/prompts';
import { execa } from 'execa';
import { validateName, sha256 } from '../lib/vault.js';
import { renderVaultJson } from '../lib/vault-templates.js';
import { createDirectoryTree, writeLayoutFiles, CANONICAL_LAYOUT_FILES } from '../lib/vault-layout.js';
import { findTool, vaultsRoot, isWindows } from '../lib/platform.js';
import { findOrInstallClaude, runMcpAdd, runMcpRemove, manualMcpAddCommand } from '../lib/mcp.js';
import {
  createRepo, deleteRepo, getCurrentUser, getUserPlan,
  enablePages, setPagesVisibility,
  repoUrl, repoCloneUrl,
} from '../lib/github.js';
import { ConsoleLogger, type Logger } from '../lib/logger.js';
import { VAULT_FILES, VAULT_DIRS, WORKFLOW_FILES } from '../lib/constants.js';
import { PROMPTS } from '../lib/messages.js';
import type { CommandModule, RunOptions } from '../types.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TMPL_PATH = join(SCRIPT_DIR, '../../lib/mcp-start.js.tmpl');
const DEPLOY_TMPL = join(SCRIPT_DIR, '../../lib/deploy.yml.tmpl');

export type PublishMode = 'private' | 'public' | 'auth-gated';

export interface InitOptions extends RunOptions {
  publishMode?: PublishMode;
  gitName?: string;
  gitEmail?: string;
  skipInstallCheck?: boolean;
}

async function installGh(log: Logger, skipInstallCheck: boolean = false): Promise<void> {
  log.info('GitHub CLI not found — installing...');
  if (isWindows()) {
    const ok = skipInstallCheck || await confirm({ message: 'Install GitHub CLI via winget?', default: true });
    if (ok) {
      await execa('winget', ['install', '--id', 'GitHub.cli', '-e',
        '--accept-package-agreements', '--accept-source-agreements'], { reject: false });
      // Probe known install paths
      const dirs = [
        join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'GitHub CLI'),
        'C:\\Program Files\\GitHub CLI',
        join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links'),
      ];
      for (const d of dirs) {
        if (existsSync(d)) {
          process.env.PATH = `${d};${process.env.PATH ?? ''}`;
        }
      }
    }
  } else if (process.platform === 'darwin' && await execa('which', ['brew'], { reject: false }).then(r => r.exitCode === 0)) {
    await execa('brew', ['install', 'gh']);
  } else if (await execa('which', ['apt-get'], { reject: false }).then(r => r.exitCode === 0)) {
    await execa('bash', ['-c',
      'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null && ' +
      'echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null && ' +
      'sudo apt-get update -qq && sudo apt-get install gh -y',
    ]);
  } else if (await execa('which', ['dnf'], { reject: false }).then(r => r.exitCode === 0)) {
    await execa('bash', ['-c',
      'sudo dnf install "dnf-command(config-manager)" -y && ' +
      'sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo && ' +
      'sudo dnf install gh --repo gh-cli -y',
    ]);
  } else {
    throw new Error('Cannot auto-install gh. Install from https://cli.github.com and re-run.');
  }
}

// ─── Phase helpers — keep init's run() readable as a sequence ─────────────

async function ensureGhAuth(ghPath: string, log: Logger): Promise<void> {
  const result = await execa(ghPath, ['auth', 'status'], { reject: false });
  if (result.exitCode !== 0) {
    log.info('  GitHub authentication required — a browser window will open...');
    await execa(ghPath, ['auth', 'login'], { stdio: 'inherit' });
  }
}

async function ensureGitConfig(gitNameOpt: string | undefined, gitEmailOpt: string | undefined): Promise<void> {
  const nameResult = await execa('git', ['config', 'user.name'], { reject: false });
  const emailResult = await execa('git', ['config', 'user.email'], { reject: false });
  if (!String(nameResult.stdout ?? '').trim()) {
    const n = gitNameOpt ?? await input({ message: 'Enter your name for git commits:' });
    await execa('git', ['config', '--global', 'user.name', n]);
  }
  if (!String(emailResult.stdout ?? '').trim()) {
    const e = gitEmailOpt ?? await input({ message: 'Enter your email for git commits:' });
    await execa('git', ['config', '--global', 'user.email', e]);
  }
}

interface PublishConfig {
  publishMode: PublishMode;
  repoVisibility: 'public' | 'private';
  enablePages: boolean;
  pagesPrivate: boolean;
  writeDeploy: boolean;
}

async function selectPublishMode(publishModeOpt: PublishMode | undefined): Promise<PublishConfig> {
  if (publishModeOpt !== undefined && !['private', 'public', 'auth-gated'].includes(publishModeOpt)) {
    throw new Error(`Invalid publishMode: "${publishModeOpt}". Must be one of: private, public, auth-gated`);
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
    const plan = await getUserPlan().catch(() => 'free');
    if (plan === 'free') {
      throw new Error(`auth-gated Pages requires GitHub Pro+ (you're on Free).\n  Choose Public or Private instead.`);
    }
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
    throw new Error('Could not fetch your GitHub username. Run: gh auth status');
  }
}

async function createRemoteRepo(vaultDir: string, name: string, githubUser: string, repoVisibility: 'public' | 'private'): Promise<void> {
  await createRepo(name, { visibility: repoVisibility });
  await execa('git', ['-C', vaultDir, 'remote', 'add', 'origin', repoCloneUrl(githubUser, name)]);
}

async function setupGitHubPages(githubUser: string, name: string, pagesPrivate: boolean, log: Logger): Promise<void> {
  const slug = `${githubUser}/${name}`;
  try {
    await enablePages(slug);
  } catch {
    log.info(`  Warning: Could not auto-enable GitHub Pages.`);
    log.info(`  Enable manually: ${repoUrl(slug, 'settings/pages')}`);
    return;
  }
  if (pagesPrivate) {
    try {
      await setPagesVisibility(slug, 'private');
    } catch {
      log.info(`  Warning: Could not set Pages to private — may be publicly accessible.`);
    }
  }
}

async function setupBranchProtection(ghPath: string, githubUser: string, name: string, log: Logger): Promise<void> {
  const protectionBody = JSON.stringify({
    required_status_checks: null,
    enforce_admins: false,
    required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: false },
    restrictions: null,
  });
  const result = await execa(ghPath, [
    'api', `repos/${githubUser}/${name}/branches/main/protection`,
    '--method', 'PUT', '--input', '-',
  ], { input: protectionBody, reject: false });
  if (result.exitCode !== 0) {
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

  // [1/6] Prerequisites
  log.info('[1/6] Checking prerequisites...');

  const nodeMajor = parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (nodeMajor < 22) {
    throw new Error(`Node.js 22+ required (found v${process.versions.node}).\n  Update at: https://nodejs.org`);
  }

  let ghPath = await findTool('gh');
  if (!ghPath) {
    await installGh(log, skipInstallCheck);
    ghPath = await findTool('gh');
    if (!ghPath) {
      throw new Error('gh was installed but could not be found. Open a new terminal and re-run vaultkit init.');
    }
  }

  await ensureGhAuth(ghPath, log);
  await ensureGitConfig(gitNameOpt, gitEmailOpt);

  log.info('');
  const { publishMode, repoVisibility, enablePages: doEnablePages, pagesPrivate, writeDeploy } =
    await selectPublishMode(publishModeOpt);

  mkdirSync(root, { recursive: true });
  if (existsSync(vaultDir)) throw new Error(`${vaultDir} already exists.`);

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
    copyFileSync(TMPL_PATH, join(vaultDir, VAULT_FILES.LAUNCHER));

    if (writeDeploy) {
      copyFileSync(DEPLOY_TMPL, join(vaultDir, VAULT_DIRS.GITHUB_WORKFLOWS, WORKFLOW_FILES.DEPLOY));
      writeFileSync(join(vaultDir, VAULT_FILES.VAULT_JSON), renderVaultJson(githubUser, name));
    }

    // [3/6] Git init + initial commit
    log.info('[3/6] Committing initial files...');
    await execa('git', ['init', vaultDir]);
    await execa('git', ['-C', vaultDir, 'branch', '-M', 'main'], { reject: false });
    await execa('git', ['-C', vaultDir, 'add', '.']);
    await execa('git', ['-C', vaultDir, 'commit', '-m', `chore: initialize ${name}`]);

    // [4/6] GitHub repo
    log.info(`[4/6] Creating GitHub repo: ${name} (${repoVisibility})...`);
    await createRemoteRepo(vaultDir, name, githubUser, repoVisibility);
    createdRepo = true;

    // [5/6] Pages + push
    if (doEnablePages) {
      log.info('[5/6] Enabling Pages and pushing...');
      await setupGitHubPages(githubUser, name, pagesPrivate, log);
    } else {
      log.info('[5/6] Pushing (no Pages — notes-only vault)...');
    }
    await execa('git', ['-C', vaultDir, 'push', '-u', 'origin', 'main']);

    // [6/6] Branch protection
    log.info('[6/6] Protecting main branch...');
    await setupBranchProtection(ghPath, githubUser, name, log);

    // MCP registration
    registeredMcp = await registerMcpForVault(vaultDir, name, skipInstallCheck, log);

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
        log.info(`  Warning: could not delete GitHub repo — run manually: gh repo delete ${githubUser}/${name} --yes`);
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
