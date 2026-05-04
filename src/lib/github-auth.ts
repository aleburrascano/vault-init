/**
 * Anti-Corruption Layer for `gh`'s authentication and account-state surface —
 * current user, plan, scope grants, auth status. One of the three sibling
 * modules that together with `gh-retry.ts` form the single boundary
 * between vaultkit and `gh` (see also [github-repo.ts](./github-repo.ts)
 * and [github-pages.ts](./github-pages.ts)). Translates `gh`'s native
 * JSON shapes into vaultkit's domain values (login string, plan name)
 * and bundles security-critical scope-grant flows behind one wrapper.
 *
 * Commands MUST go through these wrappers; never `execa('gh', …)` directly
 * for user / plan / auth-status lookups, and never invoke `gh auth refresh`
 * outside `ensureDeleteRepoScope` — that wrapper centralizes the
 * interactive `stdio: 'inherit'` handoff that earlier versions broke by
 * silently killing the device-flow before the user could complete it.
 */

import { execa } from 'execa';
import { findTool } from './platform.js';
import { VaultkitError } from './errors.js';
import { gh, ghJson } from './gh-retry.js';
import type { Logger } from './logger.js';
import type { GhUserResponse } from '../types.js';

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
