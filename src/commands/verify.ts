import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { confirm } from '@inquirer/prompts';
import { execa } from 'execa';
import { validateName, sha256 } from '../lib/vault.js';
import { getVaultDir, getExpectedHash } from '../lib/registry.js';
import { findTool } from '../lib/platform.js';
import type { RunOptions } from '../types.js';

export interface VerifyOptions extends RunOptions {
  yes?: boolean;
}

export async function run(
  name: string,
  { cfgPath, yes = false, log = console.log }: VerifyOptions = {},
): Promise<void> {
  validateName(name);

  const dir = await getVaultDir(name, cfgPath);
  if (!dir) throw new Error(`"${name}" is not a registered vault.`);

  const launcherPath = join(dir, '.mcp-start.js');
  if (!existsSync(launcherPath)) {
    throw new Error(`${launcherPath} does not exist.\n  Run 'vaultkit update ${name}' to install the launcher.`);
  }

  const pinned = await getExpectedHash(name, cfgPath) ?? '';
  const onDisk = await sha256(launcherPath);

  log(`Vault:    ${name}`);
  log(`Path:     ${dir}`);
  log('');
  log(`Pinned SHA-256:  ${pinned || '(none registered)'}`);
  log(`On-disk SHA-256: ${onDisk}`);
  log('');

  // Check for upstream drift
  let upstreamDrift = false;
  if (existsSync(join(dir, '.git'))) {
    await execa('git', ['-C', dir, 'fetch', '--quiet'], { reject: false });
    const hasUpstream = (await execa('git', ['-C', dir, 'rev-parse', '@{u}'], { reject: false })).exitCode === 0;
    if (hasUpstream) {
      const diffResult = await execa('git', [
        '-C', dir, 'diff', '--name-only', 'HEAD..@{u}', '--', '.mcp-start.js',
      ], { reject: false });
      const diffFiles = String(diffResult.stdout ?? '').trim();
      if (diffFiles === '.mcp-start.js') {
        upstreamDrift = true;
        log('Upstream has a different .mcp-start.js — diff:');
        log('----------------------------------------');
        const diffOut = await execa('git', ['-C', dir, '--no-pager', 'diff', 'HEAD..@{u}', '--', '.mcp-start.js'], { reject: false });
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
    const pullResult = await execa('git', ['-C', dir, 'pull', '--ff-only', '--quiet'], { reject: false });
    if (pullResult.exitCode !== 0) {
      throw new Error(`git pull failed. Resolve manually and re-run vaultkit verify ${name}.`);
    }
    finalHash = await sha256(launcherPath);
    log(`  Pulled. New on-disk SHA-256: ${finalHash}`);
  } else {
    log('On-disk launcher does not match the pinned hash.');
    log('Inspect the file before trusting it:');
    log(`  cat "${launcherPath}"`);
    log('');
    const ok = yes || await confirm({ message: `Re-pin the on-disk SHA-256 (${onDisk})?`, default: false });
    if (!ok) { log('Aborted.'); return; }
  }

  const claudePath = await findTool('claude');
  if (!claudePath) {
    log('Warning: Claude Code not found — re-pin manually:');
    log(`  claude mcp remove ${name} --scope user`);
    log(`  claude mcp add --scope user ${name} -- node "${launcherPath}" --expected-sha256=${finalHash}`);
    throw new Error('Claude Code not found.');
  }

  log(`Re-pinning MCP registration with SHA-256 ${finalHash}...`);
  await execa(claudePath, ['mcp', 'remove', name, '--scope', 'user'], { reject: false });
  await execa(claudePath, [
    'mcp', 'add', '--scope', 'user',
    name, '--', 'node', launcherPath,
    `--expected-sha256=${finalHash}`,
  ]);

  log('');
  log('Done. Restart Claude Code to apply the new pin.');
}
