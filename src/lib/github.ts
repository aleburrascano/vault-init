import { execa } from 'execa';
import { findTool } from './platform.js';
import { VaultkitError } from './errors.js';
import type { Logger } from './logger.js';
import type {
  GhUserResponse,
  GhRepoResponse,
  GhPagesResponse,
  GhRepoInfo,
  Visibility,
} from '../types.js';

interface GhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function gh(...args: string[]): Promise<GhResult> {
  const ghPath = await findTool('gh');
  if (!ghPath) throw new Error('gh CLI not found. Install from https://cli.github.com');
  const result = await execa(ghPath, args, { reject: false });
  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    exitCode: result.exitCode ?? 1,
  };
}

/**
 * Throwing variant of `gh` that retries on transient GitHub API failures —
 * 5xx server errors, 429 rate limits, network resets/timeouts, and the
 * GitHub-specific "previous visibility change is still in progress" 422.
 * Backoff: 1s / 2s / 4s (4 attempts total). Non-transient errors throw
 * immediately. Used by every wrapper that expects success (createRepo,
 * setRepoVisibility, getVisibility, enablePages, etc.) so all gh-API
 * callers get retry semantics from one place.
 */
async function ghJson(...args: string[]): Promise<string> {
  const delays = [1000, 2000, 4000];
  for (let attempt = 0; ; attempt++) {
    const result = await gh(...args);
    if (result.exitCode === 0) return result.stdout;
    const stderr = result.stderr;
    const isTransient =
      /HTTP 5\d\d/.test(stderr) ||
      /HTTP 429/.test(stderr) ||
      stderr.includes('previous visibility change is still in progress') ||
      /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH/.test(stderr);
    if (!isTransient || attempt >= delays.length) {
      throw new Error(`gh ${args.join(' ')}: ${stderr}`);
    }
    await new Promise<void>(r => setTimeout(r, delays[attempt] ?? 0));
  }
}

// ── Pure JSON parsers (exported for unit tests) ───────────────────────────────

export function _parseUserJson(json: string): string {
  const data = JSON.parse(json) as GhUserResponse;
  if (!data.login) throw new Error('login field missing from user response');
  return data.login;
}

export function _parsePlanJson(json: string): string {
  const data = JSON.parse(json) as GhUserResponse;
  return data?.plan?.name ?? 'free';
}

export function _parseRepoJson(json: string): GhRepoInfo {
  const data = JSON.parse(json) as GhRepoResponse;
  return {
    visibility: data.visibility ?? '',
    isAdmin: data?.permissions?.admin === true,
  };
}

export function _parsePagesJson(json: string | null | undefined): Visibility | null {
  if (!json) return null;
  try {
    const data = JSON.parse(json) as GhPagesResponse;
    if (typeof data.public === 'boolean') return data.public ? 'public' : 'private';
    if (data.visibility) return data.visibility === 'public' ? 'public' : 'private';
    return 'public';
  } catch {
    return null;
  }
}

// ── Live gh wrappers ──────────────────────────────────────────────────────────

export async function getCurrentUser(): Promise<string> {
  const json = await ghJson('api', 'user');
  return _parseUserJson(json);
}

export async function getUserPlan(): Promise<string> {
  const json = await ghJson('api', 'user');
  return _parsePlanJson(json);
}

/**
 * Throws `VaultkitError('PERMISSION_DENIED')` if the current GitHub
 * account is on the Free plan (auth-gated Pages requires Pro+). The
 * `extraHint` is appended on its own line so callers can add
 * command-specific guidance (e.g. init's interactive flow says
 * "Choose Public or Private instead"). Reads `getUserPlan()` once;
 * defaults to 'free' on any API error so we fail closed rather than
 * letting an auth-gated setup proceed against an unknown plan.
 */
export async function requireAuthGatedEligible(extraHint?: string): Promise<void> {
  const plan = await getUserPlan().catch(() => 'free');
  if (plan === 'free') {
    const base = `auth-gated Pages requires GitHub Pro+ (your plan: ${plan}).`;
    throw new VaultkitError('PERMISSION_DENIED', extraHint ? `${base}\n  ${extraHint}` : base);
  }
}

export async function isAuthenticated(): Promise<boolean> {
  const result = await gh('auth', 'status');
  return result.exitCode === 0;
}

export interface CreateRepoOptions {
  visibility?: Visibility;
}

export async function createRepo(name: string, { visibility = 'private' }: CreateRepoOptions = {}): Promise<void> {
  await ghJson('repo', 'create', name, `--${visibility}`, '--confirm');
}

export async function deleteRepo(slug: string): Promise<void> {
  await ghJson('repo', 'delete', slug, '--yes');
}

/**
 * Variant of `deleteRepo` that captures gh's stderr instead of throwing.
 * Used by `destroy` because the failure must be non-fatal (local + MCP
 * cleanup still proceeds) but the user needs to see *why* gh refused so
 * they can act (typically a missing `delete_repo` scope, despite our
 * upfront `ensureDeleteRepoScope` call — e.g., the user declined the
 * browser flow).
 */
export async function deleteRepoCapturing(slug: string): Promise<{ ok: boolean; stderr: string }> {
  const result = await gh('repo', 'delete', slug, '--yes');
  return { ok: result.exitCode === 0, stderr: result.stderr };
}

export async function repoExists(slug: string): Promise<boolean> {
  const result = await gh('repo', 'view', slug);
  return result.exitCode === 0;
}

export async function isAdmin(slug: string): Promise<boolean> {
  try {
    const json = await ghJson('api', `repos/${slug}`);
    return _parseRepoJson(json).isAdmin;
  } catch {
    return false;
  }
}

export async function getVisibility(slug: string): Promise<string> {
  const json = await ghJson('api', `repos/${slug}`);
  return _parseRepoJson(json).visibility;
}

export async function setRepoVisibility(slug: string, visibility: Visibility): Promise<void> {
  // ghJson retries the "previous visibility change is still in progress" 422
  // automatically, so this is a one-liner.
  await ghJson('repo', 'edit', slug, '--visibility', visibility, '--accept-visibility-change-consequences');
}

export interface EnablePagesOptions {
  buildType?: 'workflow' | 'legacy';
}

export async function enablePages(slug: string, { buildType = 'workflow' }: EnablePagesOptions = {}): Promise<void> {
  await ghJson('api', `repos/${slug}/pages`, '--method', 'POST',
    '--field', `build_type=${buildType}`,
    '--field', 'source[branch]=main',
    '--field', 'source[path]=/');
}

export async function setPagesVisibility(slug: string, visibility: Visibility): Promise<void> {
  await ghJson('api', `repos/${slug}/pages`, '--method', 'PUT',
    '--field', `public=${visibility === 'public'}`);
}

export async function disablePages(slug: string): Promise<void> {
  await gh('api', `repos/${slug}/pages`, '--method', 'DELETE');
}

export async function pagesExist(slug: string): Promise<boolean> {
  const result = await gh('api', `repos/${slug}/pages`);
  return result.exitCode === 0;
}

export async function getPagesVisibility(slug: string): Promise<Visibility | null> {
  const result = await gh('api', `repos/${slug}/pages`);
  if (result.exitCode !== 0) return null;
  return _parsePagesJson(result.stdout);
}

/**
 * Grant the `delete_repo` OAuth scope to the current `gh` session.
 *
 * Implementation notes:
 * - `gh auth refresh -s delete_repo` is **interactive** when the scope is
 *   missing (one-time code + browser handoff). We pass `stdio: 'inherit'`
 *   so the user actually sees the prompt; previous versions used
 *   `timeout: 10_000` + `reject: false` and silently killed the process
 *   before the user could complete the flow, leaving `delete_repo`
 *   ungranted and `vaultkit destroy` then failing with HTTP 403 and no
 *   diagnostic.
 * - When the scope is already present, gh exits in well under a second
 *   without printing anything noisy.
 * - On non-zero exit (user declined / network error / etc.) we throw
 *   `VaultkitError('AUTH_REQUIRED')` with the manual recovery command.
 *   Callers must not silently swallow this — the user needs the hint.
 *
 * Per the security invariant in `.claude/rules/security-invariants.md`,
 * this is called only at the moment of deletion, never preemptively.
 */
export async function ensureDeleteRepoScope(log?: Logger): Promise<void> {
  const ghPath = await findTool('gh');
  if (!ghPath) throw new VaultkitError('TOOL_MISSING', 'gh CLI not found. Install from https://cli.github.com');

  // PAT-based auth (GH_TOKEN env var, used by CI) does not support
  // `gh auth refresh` — PAT scopes are fixed at creation time. Trust the
  // token; if it lacks delete_repo, the subsequent `gh repo delete` will
  // surface a clear 403 via deleteRepoCapturing's stderr.
  if (process.env.GH_TOKEN) return;

  log?.info('Granting delete_repo scope (browser will open if not already granted)…');
  const result = await execa(ghPath, ['auth', 'refresh', '-h', 'github.com', '-s', 'delete_repo'],
    { stdio: 'inherit', reject: false });
  if (result.exitCode !== 0) {
    throw new VaultkitError('AUTH_REQUIRED',
      `could not grant delete_repo scope. Run manually: gh auth refresh -h github.com -s delete_repo`);
  }
}

// ─── URL builders ─────────────────────────────────────────────────────────

/**
 * Public URL of a GitHub repository. With `path`, returns a sub-page URL
 * (e.g. `repoUrl('owner/repo', 'settings/pages')`). Single source of
 * truth so a hypothetical github.com → ghe.example.com swap edits one
 * file, not ten.
 */
export function repoUrl(slug: string, path?: string): string {
  return path ? `https://github.com/${slug}/${path}` : `https://github.com/${slug}`;
}

/** HTTPS clone URL for a repository (`.git` suffix). */
export function repoCloneUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

/** Public site URL for a GitHub Pages-enabled repository (with trailing slash). */
export function pagesUrl(owner: string, repo: string): string {
  return `https://${owner}.github.io/${repo}/`;
}
