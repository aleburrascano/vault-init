# ADR-0003: gh-retry four-way failure classification

**Status**: Accepted
**Date**: 2026-05-02 (v2.7.1; refined 2.7.2 cap, 2.7.4 schedule)
**Related rules**: [.claude/rules/architecture.md](../../.claude/rules/architecture.md), [.claude/rules/domain-language.md](../../.claude/rules/domain-language.md)
**Supersedes**: pre-2.7.1 stderr-only pattern matching

## Context

The pre-2.7.1 retry logic in `github.ts` matched stderr text against a flat list of patterns (5xx, 429, ECONN*) and retried with backoff on any match. That worked for clean network hiccups but failed on three real failure modes encountered in CI:

1. **Secondary rate limit / abuse detection.** GitHub's rate-limit response is HTTP 403 with body `"You have exceeded a secondary rate limit"` and a `Retry-After` header. The pre-2.7.1 logic neither classified this as rate-limited nor honored `Retry-After` — it either threw immediately (false fatal) or burned the 1s/2s/4s budget and threw an opaque error.
2. **Account abuse-flagged.** When GitHub disables a PAT account mid-burst, subsequent calls return 403 with body `"Repository '<x>' is disabled. Please ask the owner to check their account."` This will not recover in seconds — retries make it worse by piling on more abuse-detection signal. The pre-2.7.1 logic treated it as transient and burned the retry budget.
3. **Visibility-change propagation race.** A `setRepoVisibility` PATCH followed quickly by another visibility-related call gets 422 *"previous visibility change is still in progress"*. This is genuinely transient (clears in ~1s) but the pre-2.7.1 logic didn't recognize the body text and threw.

Conflating these three distinct failure modes meant the retry layer was simultaneously too aggressive (retrying account-flagged 403s, accelerating the flag-out) and too permissive (giving up on rate-limited calls without honoring `Retry-After`).

## Decision

Refactor the retry layer into [src/lib/gh-retry.ts](../../src/lib/gh-retry.ts) with a pure classifier `_classifyGhFailure(status, body, stderr, headers)` returning one of four kinds:

| Kind | Trigger patterns | Action |
|---|---|---|
| `transient` | 5xx; HTTP 429; *"previous visibility change is still in progress"* (422); *"your current plan does not support GitHub Pages"* (422 — Pages-auth lag); ECONNRESET / ETIMEDOUT / ECONNREFUSED / EHOSTUNREACH | Retry on schedule `[1s, 2s, 4s, 8s, 16s]` (5 attempts after the first; ~31s total) |
| `rate_limited` | *"secondary rate limit"*; *"abuse detection mechanism"*; HTTP 429 | Honor `Retry-After` header (capped at 60s — see ADR-0003 sidebar); retry up to 3 more times, then throw `VaultkitError('RATE_LIMITED')` |
| `auth_flagged` | *"Repository '<x>' is disabled"*; *"Please ask the owner to check their account"* | Throw `VaultkitError('AUTH_REQUIRED')` immediately, no retry |
| `fatal` | everything else | Throw immediately with the underlying stderr |

The classifier is pure (no I/O) and exported with the `_` test-only prefix. Mutation wrappers that need response headers migrate to `gh api --include` so the parser `_parseGhIncludeOutput` can extract HTTP status + headers (see ADR-0004 for the Repo-side migration). `git.ts:pushNewRepo` and `git.ts:pushOrPr` recognize the same `auth_flagged` stderr patterns so the failure surfaces identically across the gh-API and git-push paths.

`Retry-After` is capped at 60s (added in 2.7.2) to defend against a multi-hour `Retry-After` value that could hang `vaultkit init` indefinitely. The transient schedule was extended from `[1s, 2s, 4s]` (7s total) to `[1s, 2s, 4s, 8s, 16s]` (31s total) in 2.7.4 because the Pages-auth visibility-propagation cache empirically takes >7s on Free-tier accounts.

## Consequences

**Easier:**
- Each failure mode has the right primitive: rate-limited honors GitHub's request, auth-flagged surfaces immediately with a clear `AUTH_REQUIRED` exit code, transients retry with backoff, fatals fail loudly.
- The new `RATE_LIMITED` exit code (13) lets scripted callers distinguish "I'm being asked to slow down" from "this is broken" — matters for CI orchestration and operator alerting.
- The pure classifier is unit-testable without any gh CLI mocking — `tests/lib/gh-retry.test.ts` and `tests/lib/github-rate-limit.test.ts` exhaustively cover the matrix.

**Harder:**
- Adding a new failure pattern means understanding which of the 4 kinds it belongs to. The dispatch order in `_classifyGhFailure` matters (auth-flagged checked first to short-circuit before rate-limit pattern overlap on 403s).
- The classifier reads body text from `gh api --include` output, which means high-value mutations that need classification must use `--include` and the corresponding parser. Operations that don't need classification (read-only, idempotent reads) don't pay this cost.

**Trade-offs accepted:**
- 60s cap on `Retry-After` is a defensive lie if GitHub legitimately needs hours. We accept the trade because (a) GitHub's typical secondary-rate-limit retry is 60s, (b) hours-long waits in a CLI command are worse UX than a clear `RATE_LIMITED` error pointing at the operator, and (c) the cap is documented in `parseRetryAfterMs`.
- 5-attempt transient schedule (~31s total) is slow on a genuinely broken endpoint. Acceptable because most transients clear in ≤2s; the long tail covers the empirically-observed Pages-auth window.

## Alternatives considered

- **Single retry budget across all failure kinds.** Rejected: conflates the three distinct problems and either over-retries auth-flagged (accelerates flag-out) or under-retries rate-limited (gives up before `Retry-After` would have unblocked).
- **Move classification into each wrapper instead of the central layer.** Rejected: every wrapper would re-implement the same logic, drifting over time. Centralizing the failure model in `gh-retry.ts` is the matching pair to centralizing the API surface in the github-* files (see Anti-Corruption Layer in architecture.md).
- **Use a circuit breaker.** Rejected (see ADR-0002 trade-offs and architecture.md non-goals): vaultkit's burst rate is too low for circuit breakers to add value beyond classification + cap.
