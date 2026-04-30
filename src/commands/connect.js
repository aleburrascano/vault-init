import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { confirm } from '@inquirer/prompts';
import { execa } from 'execa';
import { validateName, sha256, isVaultLike } from '../lib/vault.js';
import { getVaultDir, addToRegistry } from '../lib/registry.js';
import { findTool, vaultsRoot, npmGlobalBin } from '../lib/platform.js';
import { clone } from '../lib/git.js';

export function _normalizeInput(input) {
  if (/^https:\/\/github\.com\/([^/]+\/[^/.]+)(\.git)?(\/.*)?$/.test(input)) {
    const m = input.match(/^https:\/\/github\.com\/([^/]+\/[^/.]+?)(\.git)?(\/.*)?$/);
    const repo = m[1];
    return { repo, name: basename(repo) };
  }
  if (/^git@github\.com:([^/]+\/[^/.]+)(\.git)?$/.test(input)) {
    const m = input.match(/^git@github\.com:([^/]+\/[^/.]+?)(\.git)?$/);
    const repo = m[1];
    return { repo, name: basename(repo) };
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input)) {
    return { repo: input, name: basename(input) };
  }
  throw new Error(`Unrecognized format. Use owner/repo or a GitHub URL.`);
}

export async function run(input, { cfgPath, skipMcp = false, log = console.log } = {}) {
  const { repo, name } = _normalizeInput(input);
  validateName(name);

  const existing = await getVaultDir(name, cfgPath);
  if (existing) {
    throw new Error(`An MCP server named '${name}' is already registered.\nRun 'vaultkit status' or 'vaultkit disconnect ${name}' first.`);
  }

  const root = vaultsRoot();
  mkdirSync(root, { recursive: true });
  const vaultDir = join(root, name);

  if (existsSync(vaultDir)) {
    throw new Error(`${vaultDir} already exists.`);
  }

  let cloned = false;
  try {
    log(`Cloning ${repo} into ${vaultDir}...`);
    await clone(repo, vaultDir, { useGh: !!(await findTool('gh')) });
    cloned = true;

    const launcherPath = join(vaultDir, '.mcp-start.js');
    if (!existsSync(launcherPath)) {
      log('');
      log(`Warning: ${name} is missing .mcp-start.js — it may have been created with an older version.`);
      log('  MCP registration skipped.');
      log('  Ask the owner to run \'vaultkit update\' and push, then reconnect.');
      cloned = false;
      return;
    }

    if (!isVaultLike(vaultDir)) {
      log('');
      log(`Warning: ${name} is missing the standard vault layout (CLAUDE.md / raw/ / wiki/).`);
      log('  Connecting anyway — ask the owner to run \'vaultkit update\' so layout-aware features work.');
    }

    const hash = await sha256(launcherPath);

    log('');
    log('This vault\'s .mcp-start.js will run with your full user permissions on every');
    log('Claude Code session start. Only connect vaults from authors you trust.');
    log('');
    log(`  File:    ${launcherPath}`);
    log(`  SHA-256: ${hash}`);
    log('');

    if (skipMcp) {
      await addToRegistry(name, join(vaultDir, '.mcp-start.js'), hash, cfgPath);
      cloned = false;
      log('');
      log(`Done. ${name} registered (MCP CLI skipped).`);
      log(`  Vault: ${vaultDir}`);
      return;
    }

    const confirmed = await confirm({ message: 'Register as MCP server?', default: false });
    if (!confirmed) {
      log('');
      log(`MCP registration skipped. Vault cloned to: ${vaultDir}`);
      log(`To register later, re-run: vaultkit connect ${repo}`);
      cloned = false;
      return;
    }

    let claudePath = await findTool('claude');
    if (!claudePath) {
      log('');
      const installClaude = await confirm({ message: 'Claude Code CLI not found. Install it now?', default: false });
      if (installClaude) {
        log('Installing Claude Code CLI...');
        await execa('npm', ['install', '-g', '@anthropic-ai/claude-code'], { reject: false });
        const bin = await npmGlobalBin();
        if (bin && bin !== '') {
          process.env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`;
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
      cloned = false;
      log('');
      log(`Done. ${name} is now available in Claude Code.`);
      log(`  Vault: ${vaultDir}`);
      return;
    }

    log('');
    log('Warning: Claude Code CLI not installed — MCP registration skipped.');
    log(`  Once installed, run:`);
    log(`  claude mcp add --scope user ${name} -- node "${join(vaultDir, '.mcp-start.js')}" --expected-sha256=${hash}`);
    cloned = false;
  } finally {
    if (cloned && existsSync(vaultDir)) {
      log('');
      log(`Connect failed — removing partial clone at ${vaultDir}`);
      rmSync(vaultDir, { recursive: true, force: true });
    }
  }
}
