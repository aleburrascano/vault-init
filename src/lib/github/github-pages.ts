/**
 * Anti-Corruption Layer for `gh`'s GitHub Pages surface — enable / disable /
 * visibility / read / URL. One of the three sibling modules that together
 * with `gh-retry.ts` form the single boundary between vaultkit and `gh`
 * (see also [github-repo.ts](./github-repo.ts) and
 * [github-auth.ts](./github-auth.ts)). Pages mutations `pollUntil` their
 * corresponding read endpoints (`pagesExist`, `getPagesVisibility`) before
 * returning, to bridge GitHub's eventual-consistency window between a
 * 200 response and the change being observable.
 *
 * Commands MUST go through these wrappers (or `ghJson` from `gh-retry.ts`
 * for ad-hoc API calls without a wrapper); never `execa('gh', …)` directly.
 */

import { ghJson, gh } from './gh-retry.js';
import { pollUntil } from '../poll.js';
import type { GhPagesResponse, Visibility } from '../../types.js';

// ── Pure JSON parser (exported for unit tests) ────────────────────────────────

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

// ─── URL builders ─────────────────────────────────────────────────────────

/** Public site URL for a GitHub Pages-enabled repository (with trailing slash). */
export function pagesUrl(owner: string, repo: string): string {
  return `https://${owner}.github.io/${repo}/`;
}
