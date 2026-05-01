import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { confirm } from '@inquirer/prompts';
import { Vault, sha256, isVaultLike } from '../lib/vault.js';
import { addToRegistry } from '../lib/registry.js';
import { findTool, vaultsRoot } from '../lib/platform.js';
import { findOrInstallClaude, runMcpAdd, manualMcpAddCommand } from '../lib/mcp.js';
import { clone } from '../lib/git.js';
import { VaultkitError } from '../lib/errors.js';
import type { CommandModule, RunOptions } from '../types.js';

export interface ConnectOptions extends RunOptions {
  skipMcp?: boolean;
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
  { cfgPath, skipMcp = false, log = console.log }: ConnectOptions = {},
): Promise<void> {
  const { repo, name } = _normalizeInput(input);

  const existing = await Vault.tryFromName(name, cfgPath);
  if (existing) {
    throw new VaultkitError('ALREADY_REGISTERED', `An MCP server named '${name}' is already registered.\nRun 'vaultkit status' or 'vaultkit disconnect ${name}' first.`);
  }

  const root = vaultsRoot();
  mkdirSync(root, { recursive: true });
  const vaultDir = join(root, name);

  if (existsSync(vaultDir)) {
    throw new VaultkitError('ALREADY_REGISTERED', `${vaultDir} already exists.`);
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

    log('');
    const claudePath = await findOrInstallClaude({
      log,
      promptInstall: () => confirm({ message: 'Claude Code CLI not found. Install it now?', default: false }),
    });

    if (claudePath) {
      log(`Registering MCP server: ${name}`);
      await runMcpAdd(claudePath, name, launcherPath, hash);
      cloned = false;
      log('');
      log(`Done. ${name} is now available in Claude Code.`);
      log(`  Vault: ${vaultDir}`);
      return;
    }

    log('');
    log('Warning: Claude Code CLI not installed — MCP registration skipped.');
    log(`  Once installed, run:`);
    log(`  ${manualMcpAddCommand(name, launcherPath, hash)}`);
    cloned = false;
  } finally {
    if (cloned && existsSync(vaultDir)) {
      log('');
      log(`Connect failed — removing partial clone at ${vaultDir}`);
      rmSync(vaultDir, { recursive: true, force: true });
    }
  }
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[string], ConnectOptions, void> = { run };
void _module;
