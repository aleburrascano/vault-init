/**
 * Anti-Corruption Layer for `gh`'s repository CRUD surface — repo create /
 * delete / visibility / ownership / URLs. One of the three sibling modules
 * that together with `gh-retry.ts` form the single boundary between
 * vaultkit and `gh` (see also [github-pages.ts](./github-pages.ts) and
 * [github-auth.ts](./github-auth.ts)). Translates `gh`'s native JSON shapes
 * into vaultkit's domain types (`GhRepoInfo`, `Visibility`) and bundles
 * the security-critical argv shapes (e.g. `gh api --method DELETE
 * /repos/<slug>` via `deleteRepo`) so commands consume domain operations,
 * not gh argv quirks.
 *
 * Visibility mutations `pollUntil` `getVisibility` before returning to
 * bridge GitHub's eventual-consistency window; the same retry +
 * classification semantics from `gh-retry.ts:ghJson` apply to every call.
 *
 * Commands MUST go through these wrappers (or `ghJson` from `gh-retry.ts`
 * for ad-hoc API calls without a wrapper); never `execa('gh', …)` directly.
 */

import { ghJson, gh } from './gh-retry.js';
import { pollUntil } from './poll.js';
import type { GhRepoResponse, GhRepoInfo, Visibility } from '../types.js';

// ── Pure JSON parser (exported for unit tests) ────────────────────────────────

export function _parseRepoJson(json: string): GhRepoInfo {
  const data = JSON.parse(json) as GhRepoResponse;
  return {
    visibility: data.visibility ?? '',
    isAdmin: data?.permissions?.admin === true,
  };
}

// ── Live gh wrappers ──────────────────────────────────────────────────────────

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

/**
 * Lightweight commit metadata returned by `getCommitsSince`. The full
 * GitHub commits API response carries a lot more (sha, parents, author,
 * stats, files, …) — this is the trimmed shape vaultkit's freshness
 * check cares about. Add fields here on demand; keep YAGNI honest.
 */
export interface CommitInfo {
  /** First line of the commit message (before the `\n\n` body separator). */
  subject: string;
}

/**
 * Lists commits on the default branch, optionally bounded to a `since`
 * timestamp. Replaces the previous ad-hoc `ghJson('api',
 * 'repos/<slug>/commits', …)` call in `refresh.ts` so the GitHub API
 * response shape never leaks past the ACL boundary.
 *
 * `sinceISO` is an ISO-8601 timestamp (e.g. `2025-12-01T00:00:00Z`); when
 * omitted, returns the most recent `perPage` commits regardless of date.
 *
 * Default `perPage`: 30 when `sinceISO` is given (matches the previous
 * inline default — wide enough to capture a meaningful window), 10
 * otherwise (sampling shape).
 */
export async function getCommitsSince(slug: string, sinceISO?: string, perPage?: number): Promise<CommitInfo[]> {
  const args = ['api', `repos/${slug}/commits`, '-X', 'GET'];
  if (sinceISO) args.push('-F', `since=${sinceISO}`);
  args.push('-F', `per_page=${perPage ?? (sinceISO ? 30 : 10)}`);
  const stdout = await ghJson(...args);
  const raw = JSON.parse(stdout || '[]') as Array<{ commit?: { message?: string } }>;
  return raw
    .map(c => ({ subject: (c.commit?.message ?? '').split(/\r?\n/)[0] ?? '' }))
    .filter(c => c.subject.length > 0);
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
