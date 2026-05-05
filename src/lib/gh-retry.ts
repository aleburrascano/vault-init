import { execa } from 'execa';
import { findTool } from './platform.js';
import { VaultkitError } from './errors.js';

/**
 * Anti-Corruption Layer for the `gh` CLI surface — the retry / classification
 * half. Translates `gh`'s native failure shapes (process exit codes, stderr
 * patterns, HTTP status + headers from `--include`) into vaultkit's domain
 * vocabulary (`VaultkitError` codes: `AUTH_REQUIRED`, `RATE_LIMITED`,
 * `NETWORK_TIMEOUT`, `PERMISSION_DENIED`). Together with `github.ts`'s typed
 * wrappers + JSON parsers, this forms the single boundary between vaultkit
 * and `gh` — nothing else in the codebase should `execa('gh', …)` directly.
 *
 * Lives separately from `github.ts` so:
 *   1. The retry layer is independently testable (see github-rate-limit.test.ts).
 *   2. Ad-hoc consumers (e.g. `vaultkit refresh` calling `gh api repos/<slug>/commits`)
 *      can reach `ghJson` without pulling in the whole API-wrappers surface.
 *      Commands ARE allowed to import `ghJson` directly when no `github.ts`
 *      wrapper exists yet — this preserves the ACL because `ghJson` already
 *      embeds the retry + classification semantics.
 *
 * The pure helpers `_parseGhIncludeOutput` and `_classifyGhFailure` are
 * exported with the `_` prefix as a "exported only for tests" convention.
 */

export interface GhResult {
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

export const GH_FAILURE_KINDS = ['transient', 'rate_limited', 'auth_flagged', 'fatal'] as const;
export type GhFailureKind = typeof GH_FAILURE_KINDS[number];

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
    return { kind: 'rate_limited', backoffMs: parseRetryAfterMs(headers), reason: 'secondary rate limit' };
  }
  // Primary rate limit (HTTP 429).
  if (status === 429 || /HTTP 429/.test(stderr)) {
    return { kind: 'rate_limited', backoffMs: parseRetryAfterMs(headers), reason: 'primary rate limit' };
  }
  // 5xx server errors.
  if ((status !== undefined && status >= 500 && status < 600) || /HTTP 5\d\d/.test(stderr)) {
    return { kind: 'transient', reason: '5xx server error' };
  }
  // 422 visibility-change race the old retry already special-cased.
  if (/previous visibility change is still in progress/i.test(blob)) {
    return { kind: 'transient', reason: '422 visibility-change race' };
  }
  // 422 "current plan does not support GitHub Pages" — surfaces on the
  // /pages endpoint immediately after a private→public visibility flip,
  // when Pages' auth check has stale state and still sees the repo as
  // private. Polling getVisibility in setRepoVisibility narrows the
  // window, but Pages-auth can lag the repo metadata read so this
  // retry is a backstop. False-positive cost on a genuinely Free-tier
  // private-repo Pages attempt: 4 retries × 1/2/4s = ~7s extra wait
  // before the surfaced error. visibility.ts only emits enablePages
  // when going public/auth-gated, so in practice this only fires on
  // the propagation race, never on a true permission denial.
  if (/your current plan does not support github pages/i.test(blob)) {
    return { kind: 'transient', reason: '422 Pages-auth visibility propagation race' };
  }
  // Network resets / timeouts — surface from execa stderr.
  if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH/.test(stderr)) {
    return { kind: 'transient', reason: 'network reset/timeout' };
  }
  return { kind: 'fatal', reason: stderr.split('\n')[0]?.trim() || `exit ${status ?? 'unknown'}` };
}

/**
 * One gh invocation with an optional stdin payload. Private — public
 * callers go through `gh()` (no stdin) or one of the higher-level
 * wrappers. Centralizes the `findTool` + execa shape so that adding
 * stdin support didn't require changing every public entry point's
 * signature.
 */
async function ghCall(args: string[], input?: string): Promise<GhResult> {
  const ghPath = await findTool('gh');
  if (!ghPath) throw new Error('gh CLI not found. Install from https://cli.github.com');
  const execaOpts = input !== undefined
    ? { reject: false, input }
    : { reject: false };
  const result = await execa(ghPath, args, execaOpts);
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  const exitCode = result.exitCode ?? 1;
  if (args.includes('--include')) {
    const parsed = _parseGhIncludeOutput(stdout);
    return { stdout, stderr, exitCode, ...parsed };
  }
  return { stdout, stderr, exitCode, headers: {}, body: stdout, status: undefined };
}

export async function gh(...args: string[]): Promise<GhResult> {
  return ghCall(args);
}

const RATE_LIMIT_PROACTIVE_THRESHOLD = 50;
const RATE_LIMIT_RETRY_BUDGET = 3;
// Transient retry schedule. The first three slots cover network hiccups,
// 5xx server errors, and the original "previous visibility change is in
// progress" 422 race, all of which clear in seconds. The longer slots
// were added to cover GitHub's Pages-auth visibility-propagation cache
// (the "current plan does not support GitHub Pages" 422 surfaced on
// `enablePages` after a private→public flip): empirically observed at
// >7s on Free-tier accounts in CI, so the previous [1000, 2000, 4000]
// schedule (7s total) was insufficient. Total wait now ~31s.
const TRANSIENT_DELAYS = [1000, 2000, 4000, 8000, 16000];
const PROACTIVE_SLEEP_CAP_MS = 60_000;
const RATE_LIMIT_BACKOFF_CAP_MS = 60_000;

// Bounded `Retry-After` parser. GitHub's secondary-rate-limit responses
// usually request 60s; primary-rate-limit can request hourly resets. We
// honor the requested value up to RATE_LIMIT_BACKOFF_CAP_MS so a hostile
// (or buggy) `Retry-After: 999999` cannot stall the process for days.
function parseRetryAfterMs(headers: Record<string, string>): number {
  const retryAfter = parseInt(headers['retry-after'] ?? '', 10);
  const requested = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60) * 1000;
  return Math.min(requested, RATE_LIMIT_BACKOFF_CAP_MS);
}

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
 * Classification-aware retry loop. Calls `makeCall()` repeatedly until
 * success or until classification says to stop. `contextDesc` is the
 * caller-formatted "gh <args>" string used in error messages — kept
 * separate from `makeCall` so the input variant can elide stdin
 * payloads (which may contain sensitive data) from surfaced errors.
 *
 * Behavior on success: if response headers advertise low
 * `X-RateLimit-Remaining`, sleep until reset (capped at 60s).
 *
 * Behavior on failure: classify the response and either:
 * - `transient`: retry with the TRANSIENT_DELAYS schedule (5 attempts).
 * - `rate_limited`: wait `Retry-After` (or 60s) then retry up to 3x more.
 * - `auth_flagged`: throw VaultkitError('AUTH_REQUIRED') — do not retry.
 * - `fatal`: throw immediately with the underlying error.
 */
async function runWithRetry(makeCall: () => Promise<GhResult>, contextDesc: string): Promise<string> {
  let transientAttempts = 0;
  let rateLimitedAttempts = 0;
  for (;;) {
    const result = await makeCall();
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
          `  (${contextDesc})`,
      );
    }
    if (cls.kind === 'fatal') {
      throw new Error(`${contextDesc}: ${result.stderr || cls.reason}`);
    }
    if (cls.kind === 'rate_limited') {
      if (rateLimitedAttempts >= RATE_LIMIT_RETRY_BUDGET) {
        throw new VaultkitError(
          'RATE_LIMITED',
          `GitHub rate-limited '${contextDesc}' after ${RATE_LIMIT_RETRY_BUDGET + 1} attempts (${cls.reason}).`,
        );
      }
      rateLimitedAttempts += 1;
      await sleep(cls.backoffMs ?? 60_000);
      continue;
    }
    // transient
    if (transientAttempts >= TRANSIENT_DELAYS.length) {
      throw new Error(`${contextDesc}: ${cls.reason} — exhausted retry budget. ${result.stderr}`);
    }
    await sleep(TRANSIENT_DELAYS[transientAttempts] ?? 0);
    transientAttempts += 1;
  }
}

/**
 * Throwing variant of `gh` with classification-aware retry. Used by
 * every wrapper that expects success (createRepo, deleteRepo,
 * setRepoVisibility, getVisibility, enablePages, etc.) so retry
 * semantics live in one place. For calls that need to forward a
 * stdin payload (e.g. `gh api --input -` for branch protection),
 * use `ghJsonWithInput` instead.
 */
export async function ghJson(...args: string[]): Promise<string> {
  return runWithRetry(() => ghCall(args), `gh ${args.join(' ')}`);
}

/**
 * Variant of `ghJson` that forwards a stdin payload to gh — for calls
 * like `gh api --method PUT /repos/<slug>/branches/main/protection
 * --input -` where the request body is supplied on stdin. Same retry +
 * classification semantics as `ghJson`. The `input` is elided from
 * surfaced error messages (replaced by the literal `<stdin>` token) so
 * a future caller passing sensitive data does not leak it to logs.
 */
export async function ghJsonWithInput(input: string, ...args: string[]): Promise<string> {
  return runWithRetry(() => ghCall(args, input), `gh ${args.join(' ')} <stdin>`);
}
