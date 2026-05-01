import { execa } from 'execa';
import { input } from '@inquirer/prompts';
import { findTool, installGhForPlatform } from './platform.js';
import { VaultkitError } from './errors.js';
import type { Logger } from './logger.js';

/**
 * Shared prerequisite checks used by both `vaultkit setup` (interactive,
 * user-facing) and `vaultkit init`'s `[1/6] Checking prerequisites...`
 * phase. Extracted from init.ts in v2.5.0 so the two paths cannot drift.
 *
 * Each function either succeeds quietly (`ensureGh`, `ensureGitConfig`)
 * or throws `VaultkitError` with a category code. Callers translate
 * thrown errors into their own UX (init re-throws to trigger rollback;
 * setup catches and prints `x fail` lines).
 */

export interface NodeCheck {
  ok: boolean;
  version: string;
  message: string;
}

export function checkNode(): NodeCheck {
  const version = process.versions.node;
  const major = parseInt(version.split('.')[0] ?? '0', 10);
  if (major < 22) {
    return {
      ok: false,
      version,
      message: `Node.js 22+ required (found v${version}). Update at https://nodejs.org`,
    };
  }
  return { ok: true, version, message: `node: v${version}` };
}

export interface EnsureGhOptions {
  log: Logger;
  skipInstallCheck?: boolean;
}

/**
 * Locate `gh` on PATH; bootstrap via the platform package manager if
 * missing; return the absolute path. Throws `VaultkitError('TOOL_MISSING')`
 * if installation succeeded but the binary still cannot be located (the
 * usual reason is a stale shell PATH on Windows — open a new terminal).
 */
export async function ensureGh({ log, skipInstallCheck = false }: EnsureGhOptions): Promise<string> {
  let path = await findTool('gh');
  if (path) return path;
  await installGhForPlatform({ log, skipInstallCheck });
  path = await findTool('gh');
  if (!path) {
    throw new VaultkitError('TOOL_MISSING',
      'gh was installed but could not be found. Open a new terminal and re-run.');
  }
  return path;
}

export interface EnsureGhAuthOptions {
  ghPath: string;
  log: Logger;
  /**
   * Additional OAuth scopes to request. If `gh` is already authenticated
   * but missing one of these, `gh auth refresh -s ...` is invoked to
   * top up. If `gh` is not authenticated, `gh auth login -s ...` is run
   * with the scopes baked into the initial grant. Empty/undefined means
   * "any working auth is fine."
   */
  scopes?: string[];
}

/**
 * Ensure the current `gh` session is authenticated and (optionally) holds
 * the requested OAuth scopes. Interactive — `stdio: 'inherit'` so the
 * user sees the device-code prompt. Per the security invariant in
 * `.claude/rules/security-invariants.md`, do NOT request `delete_repo`
 * here — that scope is granted on demand by `destroy` only.
 */
export async function ensureGhAuth({ ghPath, log, scopes }: EnsureGhAuthOptions): Promise<void> {
  const status = await execa(ghPath, ['auth', 'status'], { reject: false });
  if (status.exitCode !== 0) {
    log.info('  GitHub authentication required — a browser window will open...');
    const args = ['auth', 'login'];
    if (scopes && scopes.length > 0) {
      args.push('-s', scopes.join(','));
    }
    await execa(ghPath, args, { stdio: 'inherit' });
    return;
  }
  if (!scopes || scopes.length === 0) return;
  // gh prints "Token scopes: 'repo', 'workflow', ..." to stderr in `auth status`.
  const output = String(status.stderr ?? '') + String(status.stdout ?? '');
  const missing = scopes.filter(s => !new RegExp(`'${s}'`).test(output));
  if (missing.length > 0) {
    log.info(`  Granting additional scopes: ${missing.join(', ')}…`);
    await execa(ghPath, ['auth', 'refresh', '-h', 'github.com', '-s', missing.join(',')],
      { stdio: 'inherit' });
  }
}

export interface EnsureGitConfigOptions {
  nameOpt?: string;
  emailOpt?: string;
}

/**
 * Ensure `git config user.name` and `user.email` are set globally. If
 * either is missing, prompt the user (or accept a pre-supplied value
 * from `nameOpt`/`emailOpt`) and `git config --global` it.
 */
export async function ensureGitConfig({ nameOpt, emailOpt }: EnsureGitConfigOptions = {}): Promise<void> {
  const nameResult = await execa('git', ['config', 'user.name'], { reject: false });
  const emailResult = await execa('git', ['config', 'user.email'], { reject: false });
  if (!String(nameResult.stdout ?? '').trim()) {
    const n = nameOpt ?? await input({ message: 'Enter your name for git commits:' });
    await execa('git', ['config', '--global', 'user.name', n]);
  }
  if (!String(emailResult.stdout ?? '').trim()) {
    const e = emailOpt ?? await input({ message: 'Enter your email for git commits:' });
    await execa('git', ['config', '--global', 'user.email', e]);
  }
}
