import { confirm } from '@inquirer/prompts';
import { execa } from 'execa';
import { Vault, sha256 } from '../lib/vault.js';
import { findTool } from '../lib/platform.js';
import { runMcpRepin, manualMcpRepinCommands } from '../lib/mcp.js';
import { VaultkitError } from '../lib/errors.js';
import type { CommandModule, RunOptions } from '../types.js';

export interface VerifyOptions extends RunOptions {
  yes?: boolean;
}

export async function run(
  name: string,
  { cfgPath, yes = false, log = console.log }: VerifyOptions = {},
): Promise<void> {
  const vault = await Vault.tryFromName(name, cfgPath);
  if (!vault) throw new VaultkitError('NOT_REGISTERED', `"${name}" is not a registered vault.`);

  if (!vault.hasLauncher()) {
    throw new Error(`${vault.launcherPath} does not exist.\n  Run 'vaultkit update ${name}' to install the launcher.`);
  }

  const pinned = vault.expectedHash ?? '';
  const onDisk = await vault.sha256OfLauncher();

  log(`Vault:    ${vault.name}`);
  log(`Path:     ${vault.dir}`);
  log('');
  log(`Pinned SHA-256:  ${pinned || '(none registered)'}`);
  log(`On-disk SHA-256: ${onDisk}`);
  log('');

  // Check for upstream drift
  let upstreamDrift = false;
  if (vault.hasGitRepo()) {
    await execa('git', ['-C', vault.dir, 'fetch', '--quiet'], { reject: false });
    const hasUpstream = (await execa('git', ['-C', vault.dir, 'rev-parse', '@{u}'], { reject: false })).exitCode === 0;
    if (hasUpstream) {
      const diffResult = await execa('git', [
        '-C', vault.dir, 'diff', '--name-only', 'HEAD..@{u}', '--', '.mcp-start.js',
      ], { reject: false });
      const diffFiles = String(diffResult.stdout ?? '').trim();
      if (diffFiles === '.mcp-start.js') {
        upstreamDrift = true;
        log('Upstream has a different .mcp-start.js — diff:');
        log('----------------------------------------');
        const diffOut = await execa('git', ['-C', vault.dir, '--no-pager', 'diff', 'HEAD..@{u}', '--', '.mcp-start.js'], { reject: false });
        log(String(diffOut.stdout ?? ''));
        log('----------------------------------------');
        log('');
      }
    }
  }

  if (pinned && pinned === onDisk && !upstreamDrift) {
    log('Verified — pinned hash matches on-disk and upstream.');
    return;
  }

  let finalHash = onDisk;

  if (upstreamDrift) {
    log('If you accept the upstream version, vaultkit will:');
    log('  1. git pull --ff-only (applies the upstream .mcp-start.js)');
    log('  2. Re-pin the new SHA-256 in your MCP registration');
    log('');
    const ok = yes || await confirm({ message: 'Pull upstream and re-pin?', default: false });
    if (!ok) { log('Aborted.'); return; }
    const pullResult = await execa('git', ['-C', vault.dir, 'pull', '--ff-only', '--quiet'], { reject: false });
    if (pullResult.exitCode !== 0) {
      throw new Error(`git pull failed. Resolve manually and re-run vaultkit verify ${name}.`);
    }
    finalHash = await sha256(vault.launcherPath);
    log(`  Pulled. New on-disk SHA-256: ${finalHash}`);
  } else {
    log('On-disk launcher does not match the pinned hash.');
    log('Inspect the file before trusting it:');
    log(`  cat "${vault.launcherPath}"`);
    log('');
    const ok = yes || await confirm({ message: `Re-pin the on-disk SHA-256 (${onDisk})?`, default: false });
    if (!ok) { log('Aborted.'); return; }
  }

  const claudePath = await findTool('claude');
  if (!claudePath) {
    const manual = manualMcpRepinCommands(name, vault.launcherPath, finalHash);
    log('Warning: Claude Code not found — re-pin manually:');
    log(`  ${manual.remove}`);
    log(`  ${manual.add}`);
    throw new VaultkitError('TOOL_MISSING', 'Claude Code not found.');
  }

  log(`Re-pinning MCP registration with SHA-256 ${finalHash}...`);
  await runMcpRepin(claudePath, name, vault.launcherPath, finalHash);

  log('');
  log('Done. Restart Claude Code to apply the new pin.');
}

// Compile-time check: `run` matches the CommandModule contract.
const _module: CommandModule<[string], VerifyOptions, void> = { run };
void _module;
