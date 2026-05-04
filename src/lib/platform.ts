import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { execa } from 'execa';
import { confirm } from '@inquirer/prompts';
import { VaultkitError } from './errors.js';
import type { Logger } from './logger.js';

/**
 * Platform / OS / external-tool discovery. Owns: which platform we're on,
 * where the user's home-dir state files live, where the vaults root is,
 * how to find or install the `gh` and `claude` CLIs.
 *
 * Template path resolution lives in [template-paths.ts](./template-paths.ts)
 * — that module changes for different reasons (new template, build pipeline)
 * than this one (new OS, new tool to discover or install).
 */

export function isWindows(): boolean {
  return process.platform === 'win32';
}

export function claudeJsonPath(): string {
  if (isWindows()) {
    return join(process.env.USERPROFILE ?? '', '.claude.json');
  }
  return join(process.env.HOME ?? '', '.claude.json');
}

export function vaultsRoot(): string {
  if (process.env.VAULTKIT_HOME) return process.env.VAULTKIT_HOME;
  const home = isWindows() ? (process.env.USERPROFILE ?? '') : (process.env.HOME ?? '');
  return join(home, 'vaults');
}

function probeWinGetGhPath(): string | null {
  const base = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  try {
    const entries = readdirSync(base);
    for (const entry of entries) {
      if (entry.startsWith('GitHub.cli_')) {
        const p = join(base, entry, 'tools', 'gh.exe');
        if (existsSync(p)) return p;
      }
    }
  } catch { /* ignore */ }
  return null;
}

async function findOnPath(name: string): Promise<string | null> {
  try {
    const cmd = isWindows() ? 'where' : 'which';
    const result = await execa(cmd, [name], { reject: false });
    if (result.exitCode === 0) {
      const out = String(result.stdout ?? '').trim();
      const first = out.split('\n')[0]?.trim() ?? '';
      return first || null;
    }
  } catch { /* ignore */ }
  return null;
}

export async function findTool(name: string): Promise<string | null> {
  if (isWindows()) {
    if (name === 'gh') {
      const candidates = [
        join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
        'C:\\Program Files\\GitHub CLI\\gh.exe',
        join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'gh.exe'),
      ];
      for (const p of candidates) {
        if (existsSync(p)) return p;
      }
      const wingetHit = probeWinGetGhPath();
      if (wingetHit) return wingetHit;
    }
    if (name === 'claude') {
      const npmPaths = [
        join(process.env.APPDATA ?? '', 'npm', 'claude.cmd'),
        join(process.env.APPDATA ?? '', 'npm', 'claude'),
      ];
      for (const p of npmPaths) {
        if (existsSync(p)) return p;
      }
      const bin = await npmGlobalBin();
      if (bin) {
        for (const candidate of ['claude.cmd', 'claude']) {
          const p = join(bin, candidate);
          if (existsSync(p)) return p;
        }
      }
    }
  }
  return findOnPath(name);
}

export async function npmGlobalBin(): Promise<string | null> {
  try {
    const result = await execa('npm', ['config', 'get', 'prefix'], { reject: false });
    if (result.exitCode !== 0) return null;
    const prefix = String(result.stdout ?? '').trim();
    return isWindows() ? prefix : join(prefix, 'bin');
  } catch {
    return null;
  }
}

/**
 * Bootstraps the GitHub CLI for the current platform: winget on Windows,
 * brew on macOS, apt or dnf on Linux. Used by `vaultkit init` when `findTool('gh')`
 * comes back empty. Throws `VaultkitError('TOOL_MISSING')` when the platform's
 * package manager isn't recognized so the caller can surface a manual-install
 * hint with the documented exit code.
 */
export async function installGhForPlatform(
  { log, skipInstallCheck = false }: { log: Logger; skipInstallCheck?: boolean },
): Promise<void> {
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
    throw new VaultkitError('TOOL_MISSING', 'Cannot auto-install gh. Install from https://cli.github.com and re-run.');
  }
}
