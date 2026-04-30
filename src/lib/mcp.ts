import { execa } from 'execa';
import { findTool, npmGlobalBin, isWindows } from './platform.js';
import type { LogFn } from '../types.js';

/**
 * Single source of truth for the `claude mcp add` argv shape. Every
 * vaultkit registration path must go through this function so the
 * security-critical `--expected-sha256=<hash>` flag is structurally
 * impossible to omit.
 */
export async function runMcpAdd(
  claudePath: string,
  name: string,
  launcherPath: string,
  hash: string,
): Promise<void> {
  await execa(claudePath, [
    'mcp', 'add', '--scope', 'user',
    name, '--', 'node', launcherPath,
    `--expected-sha256=${hash}`,
  ]);
}

/**
 * Re-pin a registered vault to a new launcher hash by removing the
 * existing entry and adding it back. Used by `update` and `verify` after
 * the launcher template bytes change.
 */
export async function runMcpRepin(
  claudePath: string,
  name: string,
  launcherPath: string,
  hash: string,
): Promise<void> {
  await execa(claudePath, ['mcp', 'remove', name, '--scope', 'user'], { reject: false });
  await runMcpAdd(claudePath, name, launcherPath, hash);
}

/**
 * Manual `claude mcp add` command line shown to the user when the Claude
 * CLI is missing — formatted to match {@link runMcpAdd} so a copy-paste
 * registration is identical to what vaultkit would have done.
 */
export function manualMcpAddCommand(name: string, launcherPath: string, hash: string): string {
  return `claude mcp add --scope user ${name} -- node "${launcherPath}" --expected-sha256=${hash}`;
}

/**
 * The two-step manual re-pin command set, for fallback messages in
 * `update` and `verify` when the Claude CLI is missing.
 */
export function manualMcpRepinCommands(
  name: string, launcherPath: string, hash: string,
): { remove: string; add: string } {
  return {
    remove: `claude mcp remove ${name} --scope user`,
    add: manualMcpAddCommand(name, launcherPath, hash),
  };
}

/**
 * Find Claude CLI; if missing, optionally prompt to install via npm. The
 * caller supplies the confirmation callback so `init` (which has a
 * `skipInstallCheck` bypass) and `connect` (which always asks) can share
 * the install machinery without sharing their UX.
 */
export async function findOrInstallClaude(opts: {
  log: LogFn;
  promptInstall: () => Promise<boolean>;
}): Promise<string | null> {
  const found = await findTool('claude');
  if (found) return found;

  const install = await opts.promptInstall();
  if (!install) return null;

  opts.log('Installing Claude Code CLI...');
  await execa('npm', ['install', '-g', '@anthropic-ai/claude-code'], { reject: false });
  const bin = await npmGlobalBin();
  if (bin && bin !== '') {
    process.env.PATH = `${bin}${isWindows() ? ';' : ':'}${process.env.PATH ?? ''}`;
  }
  return findTool('claude');
}
