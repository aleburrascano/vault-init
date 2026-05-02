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
  /** Lower-cased response headers, populated only when `--include` was passed. */
  headers: Record<string, string>;
  /** Stripped body — equals stdout when `--include` was not passed. */
  body: string;
  /** HTTP status from the include header block, undefined otherwise. */
  status: number | undefined;
}

/**
 * Parse a `gh api --include` raw stdout blob into status / headers / body.
 *
 * Format: status line ("HTTP/1.1 200 OK"), header lines, blank line, body.
 * Returns empty headers + body=raw + status=undefined when the input does
 * not look like a header block (e.g. the call did not use `--include`,
 * the response was empty, or gh emitted only the body on error).
 */
export function _parseGhIncludeOutput(raw: string): {
  headers: Record<string, string>;
  body: string;
  status: number | undefined;
} {
  if (!raw) return { headers: {}, body: '', status: undefined };
  const splitMatch = /\r?\n\r?\n/.exec(raw);
  if (!splitMatch) return { headers: {}, body: raw, status: undefined };
  const head = raw.slice(0, splitMatch.index);
  const body = raw.slice(splitMatch.index + splitMatch[0].length);
  const lines = head.split(/\r?\n/);
  const statusLine = lines[0] ?? '';
  const statusMatch = /^HTTP\/[\d.]+\s+(\d{3})/.exec(statusLine);
  if (!statusMatch) return { headers: {}, body: raw, status: undefined };
  const status = parseInt(statusMatch[1] ?? '', 10) || undefined;
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m && m[1] && m[2] !== undefined) headers[m[1].toLowerCase()] = m[2].trim();
  }
  return { headers, body, status };
}

export type GhFailureKind = 'transient' | 'rate_limited' | 'auth_flagged' | 'fatal';

export interface GhFailureClassification {
  kind: GhFailureKind;
  /** Suggested wait before retry, when applicable. */
  backoffMs?: number;
  reason: string;
}

/**
 * Classify a non-zero gh result so the retry layer knows what to do.
 *
 * - `transient`: temporary (5xx, 429, "previous visibility change in
 *   progress" 422, network reset/timeout). Retry with backoff schedule.
 * - `rate_limited`: GitHub secondary rate limit (403 + abuse/secondary
 *   message). Honor `Retry-After` header (seconds) or fallback to 60s
 *   per GitHub's documented secondary-rate-limit guidance.
 * - `auth_flagged`: account abuse-flagged by GitHub — repo disabled,
 *   "Please ask the owner to check their account". Will not recover in
 *   seconds; do not retry. Surfaces as VaultkitError('AUTH_REQUIRED').
 * - `fatal`: all other non-zero exits. Throw immediately.
 */
export function _classifyGhFailure(
  status: number | undefined,
  body: string,
  stderr: string,
  headers: Record<string, string>,
): GhFailureClassification {
  const blob = `${body}\n${stderr}`;
  // Auth-flagged first — most diagnostic signal, surface without retrying.
  if (/Repository '[^']+' is disabled\.|Please ask the owner to check their account\./i.test(blob)) {
    return { kind: 'auth_flagged', reason: 'GitHub disabled the repo (account abuse-flag).' };
  }
  // Secondary rate limit / abuse detection (typically 403).
  if (
    /You have exceeded a secondary rate limit/i.test(blob) ||
    /abuse detection mechanism/i.test(blob)
  ) {
    const retryAfter = parseInt(headers['retry-after'] ?? '', 10);
    const backoffMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60) * 1000;
    return { kind: 'rate_limited', backoffMs, reason: 'secondary rate limit' };
  }
  // Primary rate limit (HTTP 429).
  if (status === 429 || /HTTP 429/.test(stderr)) {
    const retryAfter = parseInt(headers['retry-after'] ?? '', 10);
    const backoffMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60) * 1000;
    return { kind: 'rate_limited', backoffMs, reason: 'primary rate limit' };
  }
  // 5xx server errors.
  if ((status !== undefined && status >= 500 && status < 600) || /HTTP 5\d\d/.test(stderr)) {
    return { kind: 'transient', reason: '5xx server error' };
  }
  // 422 visibility-change race the old retry already special-cased.
  if (/previous visibility change is still in progress/i.test(blob)) {
    return { kind: 'transient', reason: '422 visibility-change race' };
  }
  // Network resets / timeouts — surface from execa stderr.
  if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH/.test(stderr)) {
    return { kind: 'transient', reason: 'network reset/timeout' };
  }
  return { kind: 'fatal', reason: stderr.split('\n')[0]?.trim() || `exit ${status ?? 'unknown'}` };
}

async function gh(...args: string[]): Promise<GhResult> {
  const ghPath = await findTool('gh');
  if (!ghPath) throw new Error('gh CLI not found. Install from https://cli.github.com');
  const result = await execa(ghPath, args, { reject: false });
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  const exitCode = result.exitCode ?? 1;
  if (args.includes('--include')) {
    const parsed = _parseGhIncludeOutput(stdout);
    return { stdout, stderr, exitCode, ...parsed };
  }
  return { stdout, stderr, exitCode, headers: {}, body: stdout, status: undefined };
}

const RATE_LIMIT_PROACTIVE_THRESHOLD = 50;
const RATE_LIMIT_RETRY_BUDGET = 3;
const TRANSIENT_DELAYS = [1000, 2000, 4000];
const PROACTIVE_SLEEP_CAP_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise<void>(r => setTimeout(r, ms));
}

async function maybeProactiveSleep(headers: Record<string, string>): Promise<void> {
  const remainingRaw = headers['x-ratelimit-remaining'];
  if (!remainingRaw) return;
  const remaining = parseInt(remainingRaw, 10);
  if (!Number.isFinite(remaining) || remaining > RATE_LIMIT_PROACTIVE_THRESHOLD) return;
  const resetUnix = parseInt(headers['x-ratelimit-reset'] ?? '', 10);
  if (!Number.isFinite(resetUnix)) return;
  const ms = Math.max(0, resetUnix * 1000 - Date.now());
  // Cap at 60s so a bad reset value (e.g. clock skew) can't block tests indefinitely.
  await sleep(Math.min(ms, PROACTIVE_SLEEP_CAP_MS));
}

/**
 * Throwing variant of `gh` with classification-aware retry.
 *
 * On success: if the call used `--include` and headers advertise low
 * `X-RateLimit-Remaining`, sleep until reset (capped at 60s).
 *
 * On failure: classify the response and either:
 * - `transient`: retry with 1s/2s/4s backoff (4 attempts total).
 * - `rate_limited`: wait `Retry-After` (or 60s) then retry up to 3x more.
 * - `auth_flagged`: throw VaultkitError('AUTH_REQUIRED') — do not retry.
 * - `fatal`: throw immediately with the underlying error.
 *
 * Used by every wrapper that expects success (createRepo, deleteRepo,
 * setRepoVisibility, getVisibility, enablePages, etc.) so retry semantics
 * live in one place.
 */
async function ghJson(...args: string[]): Promise<string> {
  let transientAttempts = 0;
  let rateLimitedAttempts = 0;
  for (;;) {
    const result = await gh(...args);
    if (result.exitCode === 0) {
      await maybeProactiveSleep(result.headers);
      return result.body;
    }
    const cls = _classifyGhFailure(result.status, result.body, result.stderr, result.headers);
    if (cls.kind === 'auth_flagged') {
      throw new VaultkitError(
        'AUTH_REQUIRED',
        `GitHub disabled the test repo — the account is likely abuse-flagged.\n` +
          `  Wait 24-72h for the flag to clear, or rotate VAULTKIT_TEST_GH_TOKEN to a fresh PAT account.\n` +
          `  (gh ${args.join(' ')})`,
      );
    }
    if (cls.kind === 'fatal') {
      throw new Error(`gh ${args.join(' ')}: ${result.stderr || cls.reason}`);
    }
    if (cls.kind === 'rate_limited') {
      if (rateLimitedAttempts >= RATE_LIMIT_RETRY_BUDGET) {
        throw new VaultkitError(
          'RATE_LIMITED',
          `GitHub rate-limited 'gh ${args.join(' ')}' after ${RATE_LIMIT_RETRY_BUDGET + 1} attempts (${cls.reason}).`,
        );
      }
      rateLimitedAttempts += 1;
      await sleep(cls.backoffMs ?? 60_000);
      continue;
    }
    // transient
    if (transientAttempts >= TRANSIENT_DELAYS.length) {
      throw new Error(`gh ${args.join(' ')}: ${cls.reason} — exhausted retry budget. ${result.stderr}`);
    }
    await sleep(TRANSIENT_DELAYS[transientAttempts] ?? 0);
    transientAttempts += 1;
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
 * Change repo visibility. Migrated from `gh repo edit --visibility` to
 * `gh api --include` for header-aware retry. The 422 "previous visibility
 * change is still in progress" race is still classified as transient
 * inside `_classifyGhFailure`, so this stays a one-liner.
 */
export async function setRepoVisibility(slug: string, visibility: Visibility): Promise<void> {
  await ghJson(
    'api', '--include', '--method', 'PATCH', `/repos/${slug}`,
    '-f', `visibility=${visibility}`,
  );
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
