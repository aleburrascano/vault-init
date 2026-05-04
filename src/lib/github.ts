/**
 * Anti-Corruption Layer for the `gh` CLI surface — the typed-wrappers half.
 * Translates `gh`'s native JSON shapes into vaultkit's domain types
 * (`Visibility`, `GhRepoInfo`, plain `string` plan names, etc.) and bundles
 * the security-critical argv shapes (e.g. `gh api --method DELETE /repos/<slug>`
 * via `deleteRepo`, `gh api --method PATCH /repos/<slug> visibility=...`
 * via `setRepoVisibility`) so commands consume domain operations, not gh
 * argv quirks. All retry / rate-limit / auth-flag classification is delegated
 * to `gh-retry.ts` so this file only owns the API surface, not the failure
 * model. Mutations that require eventual-consistency bridging (visibility,
 * Pages) `pollUntil` their corresponding read endpoints before returning.
 *
 * Together with `gh-retry.ts`, this forms the single boundary between
 * vaultkit and `gh`. Commands MUST go through these wrappers (or `ghJson`
 * from `gh-retry.ts` for ad-hoc API calls without a wrapper); never
 * `execa('gh', …)` directly. Bypassing this layer loses retry, rate-limit
 * defenses (account-flagging risk), poll-after-mutate, and the
 * `VaultkitError` translation that drives the public exit-code contract.
 */

import { execa } from 'execa';
import { findTool } from './platform.js';
import { VaultkitError } from './errors.js';
import { gh, ghJson } from './gh-retry.js';
import { pollUntil } from './poll.js';
import type { Logger } from './logger.js';
import type {
  GhUserResponse,
  GhRepoResponse,
  GhPagesResponse,
  GhRepoInfo,
  Visibility,
} from '../types.js';

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

/**
 * Create a repository under the authenticated user. Migrated from
 * `gh repo create` to `gh api --include` so the retry layer can read
 * `X-RateLimit-*` / `Retry-After` headers and back off proactively before
 * GitHub's secondary rate limit / abuse detection trips. The `--include`
 * flag adds the response header block to stdout — `ghJson`'s parser
 * strips it before returning the body.
 */
export async function createRepo(name: string, { visibility = 'private' }: CreateRepoOptions = {}): Promise<void> {
  await ghJson(
    'api', '--include', '--method', 'POST', '/user/repos',
    '-f', `name=${name}`,
    '-F', `private=${visibility === 'private'}`,
  );
}

/**
 * Delete a repository. Migrated from `gh repo delete --yes` to `gh api
 * --include` for header-aware retry. Per the security invariant in
 * `.claude/rules/security-invariants.md`, callers must verify ownership
 * (`isAdmin`) and obtain typed-name confirmation before invoking this —
 * the argv shape changed but the precondition is unchanged.
 */
export async function deleteRepo(slug: string): Promise<void> {
  await ghJson('api', '--include', '--method', 'DELETE', `/repos/${slug}`);
}

/**
 * Variant of `deleteRepo` that captures gh's failure mode instead of
 * throwing. Used by `destroy` because the failure must be non-fatal
 * (local + MCP cleanup still proceeds) but the user needs to see *why*
 * gh refused so they can act (typically a missing `delete_repo` scope,
 * despite our upfront `ensureDeleteRepoScope` call — e.g., the user
 * declined the browser flow).
 *
 * Returns the most informative diagnostic available (stderr first since
 * gh writes the error summary there; falls back to body text from the
 * API response when stderr is empty).
 */
export async function deleteRepoCapturing(slug: string): Promise<{ ok: boolean; stderr: string }> {
  const result = await gh('api', '--include', '--method', 'DELETE', `/repos/${slug}`);
  const diagnostic = result.stderr || result.body || '';
  return { ok: result.exitCode === 0, stderr: diagnostic };
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

/**
 * Change repo visibility, then poll until the change is observable on the
 * read endpoint before returning. GitHub's PATCH returns 200 immediately,
 * but downstream endpoints (notably `/pages` auth checks) can see the
 * OLD visibility for several seconds — surfaces as a 422 in a subsequent
 * `enablePages` call ("Your current plan does not support GitHub Pages
 * for this repository") because the Pages service still thinks the repo
 * is private. Polling `getVisibility` lets it confirm propagation on the
 * repo metadata path before any caller proceeds. The 422 race on
 * `enablePages` itself is independently retried in `_classifyGhFailure`
 * as a backstop in case Pages-auth lags getVisibility.
 *
 * The 422 "previous visibility change is still in progress" race on the
 * PATCH itself is still handled by `gh-retry.ts:_classifyGhFailure`'s
 * transient bucket, so the retry happens before this poll even starts.
 */
export async function setRepoVisibility(slug: string, visibility: Visibility): Promise<void> {
  await ghJson(
    'api', '--include', '--method', 'PATCH', `/repos/${slug}`,
    '-f', `visibility=${visibility}`,
  );
  await pollUntil(
    () => getVisibility(slug),
    (current) => current === visibility,
    { description: `${slug} visibility=${visibility}` },
  );
}

export interface EnablePagesOptions {
  buildType?: 'workflow' | 'legacy';
}

/**
 * Enable Pages on a repo, then poll until `pagesExist` confirms the site
 * is provisioned. GitHub's POST returns success when the request is
 * accepted, but a subsequent `setPagesVisibility` (used by `init`'s
 * auth-gated path) can see the Pages site as not-yet-existing for a few
 * seconds — same eventual-consistency pattern as `setRepoVisibility`.
 */
export async function enablePages(slug: string, { buildType = 'workflow' }: EnablePagesOptions = {}): Promise<void> {
  await ghJson('api', `repos/${slug}/pages`, '--method', 'POST',
    '--field', `build_type=${buildType}`,
    '--field', 'source[branch]=main',
    '--field', 'source[path]=/');
  await pollUntil(
    () => pagesExist(slug),
    (exists) => exists === true,
    { description: `Pages site provisioned for ${slug}` },
  );
}

/**
 * Set Pages visibility, then poll until the change is observable on the
 * Pages read endpoint. Same eventual-consistency motivation as
 * `setRepoVisibility` and `enablePages` — without the poll, a caller
 * doing `setPagesVisibility(slug, 'private')` and then reading
 * `getPagesVisibility(slug)` could see the old value briefly.
 */
export async function setPagesVisibility(slug: string, visibility: Visibility): Promise<void> {
  await ghJson('api', `repos/${slug}/pages`, '--method', 'PUT',
    '--field', `public=${visibility === 'public'}`);
  await pollUntil(
    () => getPagesVisibility(slug),
    (current) => current === visibility,
    { description: `${slug} Pages visibility=${visibility}` },
  );
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
