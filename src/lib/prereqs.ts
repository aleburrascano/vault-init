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
  // Match each scope as a quoted literal (not a regex pattern) — a scope name
  // containing `.`, `*`, etc. would otherwise be interpreted as wildcards.
  const output = String(status.stderr ?? '') + String(status.stdout ?? '');
  const missing = scopes.filter(s => !output.includes(`'${s}'`));
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

/**
 * Check-only gate run before every command except `setup` and `doctor`.
 * Throws `VaultkitError('SETUP_REQUIRED')` with a clear pointer if any of:
 *
 *   - Node < 22
 *   - `gh` not on PATH
 *   - `gh auth status` fails (not authenticated)
 *   - `gh` token missing `repo` or `workflow` scope
 *   - `git config user.name` or `user.email` empty
 *
 * `claude` is intentionally NOT required here — not every command uses MCP,
 * and `findOrInstallClaude` already handles its absence per-command.
 *
 * Idempotent and fast on a configured machine: every check is a single
 * `findTool()` call or a `gh auth status` parse. No network. No prompts.
 *
 * Wired into `bin/vaultkit.ts:wrap()` so it runs before every command in
 * `program.commands` except those in the `SETUP_BYPASS` set (`setup`,
 * `doctor`). New commands added via `/add-command` automatically inherit
 * the gate; the architecture fitness function in `tests/architecture.test.ts`
 * enforces that every command file declares its gate posture in
 * `tests/bootstrap-gate.test.ts`.
 *
 * Per the auth scope rule in `.claude/rules/security-invariants.md`,
 * `delete_repo` is NOT one of the required scopes — it's granted on demand
 * by `vaultkit destroy` only.
 */
/**
 * Commands that bypass the bootstrap gate. Two members:
 *   - `setup`  — the gate is a check-only mirror of what setup itself
 *                installs/configures; setup must be runnable when prereqs
 *                are missing (that's its whole job).
 *   - `doctor` — the diagnostic command. Must always work so users can
 *                see what's broken without being blocked by the gate.
 *
 * Co-located with `requireSetup` so a single import wires the entire gate.
 * Exported as a `Set<string>` so callers can also `SETUP_BYPASS.has(name)`
 * directly when needed (e.g. the architecture fitness function).
 */
export const SETUP_BYPASS: ReadonlySet<string> = new Set(['setup', 'doctor']);

/**
 * Apply the bootstrap gate for a command, or skip if the command is in
 * `SETUP_BYPASS`. Used by `bin/vaultkit.ts:wrap()` so the gate is one
 * call rather than an inline conditional.
 *
 * Calling shape mirrors `requireSetup` itself — accepts a Logger so the
 * gate can emit guidance later if we ever want to (today it's silent on
 * the happy path).
 */
export async function gateOrSkip(commandName: string, log: Logger): Promise<void> {
  if (SETUP_BYPASS.has(commandName)) return;
  await requireSetup(log);
}

export async function requireSetup(_log: Logger): Promise<void> {
  const node = checkNode();
  if (!node.ok) {
    throw new VaultkitError('SETUP_REQUIRED', `${node.message}\nThen run 'vaultkit setup' to verify the rest.`);
  }

  const ghPath = await findTool('gh');
  if (!ghPath) {
    throw new VaultkitError('SETUP_REQUIRED',
      "GitHub CLI ('gh') is not installed or not on PATH. Run 'vaultkit setup' to install and authenticate it.");
  }

  const status = await execa(ghPath, ['auth', 'status'], { reject: false });
  if (status.exitCode !== 0) {
    throw new VaultkitError('SETUP_REQUIRED',
      "GitHub CLI is not authenticated. Run 'vaultkit setup' to authenticate (the 'repo' and 'workflow' scopes are needed).");
  }

  // gh prints "Token scopes: 'repo', 'workflow', ..." to stderr in `auth status`.
  // Match each required scope as a quoted literal — same parse shape as ensureGhAuth.
  const output = String(status.stderr ?? '') + String(status.stdout ?? '');
  const requiredScopes = ['repo', 'workflow'];
  const missing = requiredScopes.filter(s => !output.includes(`'${s}'`));
  if (missing.length > 0) {
    throw new VaultkitError('SETUP_REQUIRED',
      `GitHub CLI is missing required OAuth scope(s): ${missing.join(', ')}. Run 'vaultkit setup' to grant them.`);
  }

  const nameResult = await execa('git', ['config', 'user.name'], { reject: false });
  const emailResult = await execa('git', ['config', 'user.email'], { reject: false });
  const hasName = String(nameResult.stdout ?? '').trim().length > 0;
  const hasEmail = String(emailResult.stdout ?? '').trim().length > 0;
  if (!hasName || !hasEmail) {
    throw new VaultkitError('SETUP_REQUIRED',
      "git config user.name / user.email is not set. Run 'vaultkit setup' to configure git.");
  }
}
