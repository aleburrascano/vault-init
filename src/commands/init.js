import { existsSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirm, input, select } from '@inquirer/prompts';
import { execa } from 'execa';
import {
  validateName, sha256,
  renderClaudeMd, renderReadme, renderDuplicateCheckYaml,
  renderVaultJson, renderGitignore, renderGitattributes, renderIndexMd, renderLogMd,
} from '../lib/vault.js';
import { findTool, vaultsRoot, npmGlobalBin, isWindows } from '../lib/platform.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TMPL_PATH = join(SCRIPT_DIR, '../../lib/mcp-start.js.tmpl');
const DEPLOY_TMPL = join(SCRIPT_DIR, '../../lib/deploy.yml.tmpl');

async function installGh(log, skipInstallCheck = false) {
  log('GitHub CLI not found — installing...');
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

export async function run(name, { cfgPath, publishMode: publishModeOpt, gitName: gitNameOpt, gitEmail: gitEmailOpt, skipInstallCheck = false, log = console.log } = {}) {
  validateName(name);

  const root = vaultsRoot();
  const vaultDir = join(root, name);

  // [1/6] Prerequisites
  log('[1/6] Checking prerequisites...');

  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
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

  // Auth
  const authResult = await execa(ghPath, ['auth', 'status'], { reject: false });
  if (authResult.exitCode !== 0) {
    log('  GitHub authentication required — a browser window will open...');
    await execa(ghPath, ['auth', 'login'], { stdio: 'inherit' });
  }

  // Git user config
  const gitName = (await execa('git', ['config', 'user.name'], { reject: false })).stdout?.trim();
  const gitEmail = (await execa('git', ['config', 'user.email'], { reject: false })).stdout?.trim();
  if (!gitName) {
    const n = gitNameOpt ?? await input({ message: 'Enter your name for git commits:' });
    await execa('git', ['config', '--global', 'user.name', n]);
  }
  if (!gitEmail) {
    const e = gitEmailOpt ?? await input({ message: 'Enter your email for git commits:' });
    await execa('git', ['config', '--global', 'user.email', e]);
  }

  // Publish mode
  log('');
  if (publishModeOpt !== undefined && !['private', 'public', 'auth-gated'].includes(publishModeOpt)) {
    throw new Error(`Invalid publishMode: "${publishModeOpt}". Must be one of: private, public, auth-gated`);
  }
  const publishMode = publishModeOpt ?? await select({
    message: 'Publish this vault as a public knowledge site?',
    choices: [
      { name: 'Private repo, notes-only (no Pages, no public URL)  [default]', value: 'private' },
      { name: 'Public repo + public Quartz site', value: 'public' },
      { name: 'Private repo + auth-gated Pages site (GitHub Pro+ only)', value: 'auth-gated' },
    ],
  });

  const repoVisibility = publishMode === 'public' ? 'public' : 'private';
  const enablePages = publishMode !== 'private';
  const pagesPrivate = publishMode === 'auth-gated';
  const writeDeploy = publishMode !== 'private';

  if (publishMode === 'auth-gated') {
    const planResult = await execa(ghPath, ['api', 'user', '--jq', '.plan.name'], { reject: false });
    const plan = planResult.stdout?.trim() ?? 'free';
    if (plan === 'free') {
      throw new Error(`auth-gated Pages requires GitHub Pro+ (you're on Free).\n  Choose Public or Private instead.`);
    }
  }

  mkdirSync(root, { recursive: true });
  if (existsSync(vaultDir)) throw new Error(`${vaultDir} already exists.`);

  const userResult = await execa(ghPath, ['api', 'user', '--jq', '.login'], { reject: false });
  const githubUser = userResult.stdout?.trim();
  if (!githubUser) throw new Error('Could not fetch your GitHub username. Run: gh auth status');

  const baseUrl = `${githubUser}.github.io/${name}`;

  let createdDir = false;
  let createdRepo = false;
  let registeredMcp = false;

  try {
    // [2/6] Create vault
    log(`\n[2/6] Creating vault: ${name} (${publishMode})`);
    mkdirSync(vaultDir, { recursive: true });
    createdDir = true;

    // Directory structure
    for (const sub of ['raw/articles', 'raw/books', 'raw/papers', 'raw/notes', 'raw/transcripts', 'raw/assets',
      'wiki/concepts', 'wiki/topics', 'wiki/people', 'wiki/sources', '.github/workflows']) {
      mkdirSync(join(vaultDir, sub), { recursive: true });
    }

    writeFileSync(join(vaultDir, 'raw', '.gitkeep'), '');
    writeFileSync(join(vaultDir, 'wiki', '.gitkeep'), '');
    writeFileSync(join(vaultDir, 'CLAUDE.md'), renderClaudeMd(name));
    writeFileSync(join(vaultDir, 'README.md'), renderReadme(name, enablePages ? baseUrl : ''));
    writeFileSync(join(vaultDir, 'index.md'), renderIndexMd(name));
    writeFileSync(join(vaultDir, 'log.md'), renderLogMd());
    writeFileSync(join(vaultDir, '.gitignore'), renderGitignore());
    writeFileSync(join(vaultDir, '.gitattributes'), renderGitattributes());
    writeFileSync(join(vaultDir, '.github', 'workflows', 'duplicate-check.yml'), renderDuplicateCheckYaml());
    copyFileSync(TMPL_PATH, join(vaultDir, '.mcp-start.js'));

    if (writeDeploy) {
      copyFileSync(DEPLOY_TMPL, join(vaultDir, '.github', 'workflows', 'deploy.yml'));
      writeFileSync(join(vaultDir, '_vault.json'), renderVaultJson(githubUser, name));
    }

    // [3/6] Git init + commit
    log('[3/6] Committing initial files...');
    await execa('git', ['init', vaultDir]);
    await execa('git', ['-C', vaultDir, 'branch', '-M', 'main'], { reject: false });
    await execa('git', ['-C', vaultDir, 'add', '.']);
    await execa('git', ['-C', vaultDir, 'commit', '-m', `chore: initialize ${name}`]);

    // [4/6] GitHub repo
    log(`[4/6] Creating GitHub repo: ${name} (${repoVisibility})...`);
    await execa(ghPath, ['repo', 'create', name, `--${repoVisibility}`]);
    await execa('git', ['-C', vaultDir, 'remote', 'add', 'origin', `https://github.com/${githubUser}/${name}.git`]);
    createdRepo = true;

    // [5/6] Pages + push
    if (enablePages) {
      log('[5/6] Enabling Pages and pushing...');
      const pagesResult = await execa(ghPath, [
        'api', `repos/${githubUser}/${name}/pages`,
        '--method', 'POST', '-f', 'build_type=workflow',
      ], { reject: false });
      if (pagesResult.exitCode !== 0) {
        log(`  Warning: Could not auto-enable GitHub Pages.`);
        log(`  Enable manually: https://github.com/${githubUser}/${name}/settings/pages`);
      } else if (pagesPrivate) {
        const privResult = await execa(ghPath, [
          'api', `repos/${githubUser}/${name}/pages`,
          '--method', 'PUT', '-f', 'visibility=private',
        ], { reject: false });
        if (privResult.exitCode !== 0) {
          log(`  Warning: Could not set Pages to private — may be publicly accessible.`);
        }
      }
    } else {
      log('[5/6] Pushing (no Pages — notes-only vault)...');
    }

    await execa('git', ['-C', vaultDir, 'push', '-u', 'origin', 'main']);

    // [6/6] Branch protection
    log('[6/6] Protecting main branch...');
    const protectionBody = JSON.stringify({
      required_status_checks: null,
      enforce_admins: false,
      required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: false },
      restrictions: null,
    });
    const protResult = await execa(ghPath, [
      'api', `repos/${githubUser}/${name}/branches/main/protection`,
      '--method', 'PUT', '--input', '-',
    ], { input: protectionBody, reject: false });
    if (protResult.exitCode !== 0) {
      log(`  Note: Branch protection not applied (may require a paid plan for private repos).`);
      log(`  Set up manually: https://github.com/${githubUser}/${name}/settings/branches`);
    }

    // MCP registration
    const hash = await sha256(join(vaultDir, '.mcp-start.js'));
    let claudePath = await findTool('claude');

    if (!claudePath) {
      const installClaude = skipInstallCheck || await confirm({ message: 'Claude Code CLI not found. Install it now?', default: false });
      if (installClaude) {
        log('Installing Claude Code CLI...');
        await execa('npm', ['install', '-g', '@anthropic-ai/claude-code'], { reject: false });
        const bin = await npmGlobalBin();
        if (bin) {
          process.env.PATH = `${bin}${isWindows() ? ';' : ':'}${process.env.PATH ?? ''}`;
        }
        claudePath = await findTool('claude');
      }
    }

    if (claudePath) {
      log(`Registering MCP server: ${name}`);
      await execa(claudePath, [
        'mcp', 'add', '--scope', 'user',
        name, '--', 'node', join(vaultDir, '.mcp-start.js'),
        `--expected-sha256=${hash}`,
      ]);
      registeredMcp = true;
    } else {
      log(`  Note: Claude Code CLI not installed — skipping MCP registration.`);
      log(`  Once installed, run:`);
      log(`  claude mcp add --scope user ${name} -- node "${join(vaultDir, '.mcp-start.js')}" --expected-sha256=${hash}`);
    }

    log('');
    log('Done.');
    log(`  Repo:  https://github.com/${githubUser}/${name}`);
    if (publishMode === 'public') {
      log(`  Site:  https://${baseUrl}  (live after CI finishes, ~1 min)`);
    } else if (publishMode === 'auth-gated') {
      log(`  Site:  https://${baseUrl}  (auth-gated — visible only to authorized GitHub users)`);
    }
    log(`  Vault: ${vaultDir}`);

  } catch (err) {
    // Transactional rollback
    log('');
    log('Setup failed — rolling back...');
    if (registeredMcp) {
      const claudePath = await findTool('claude');
      if (claudePath) {
        await execa(claudePath, ['mcp', 'remove', name, '--scope', 'user'], { reject: false });
        log('  MCP registration removed.');
      }
    }
    if (createdRepo) {
      const result = await execa(ghPath, ['repo', 'delete', `${githubUser}/${name}`, '--yes'], { reject: false });
      if (result.exitCode === 0) log('  GitHub repo deleted.');
      else log(`  Warning: could not delete GitHub repo — run manually: gh repo delete ${githubUser}/${name} --yes`);
    }
    if (createdDir && existsSync(vaultDir)) {
      rmSync(vaultDir, { recursive: true, force: true });
      log('  Local directory removed.');
    }
    throw err;
  }
}
