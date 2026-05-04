# ADR-0002: Poll-after-mutate at GitHub eventual-consistency boundaries

**Status**: Accepted
**Date**: 2026-05-03 (v2.7.4)
**Related rules**: [.claude/rules/architecture.md](../../.claude/rules/architecture.md), [.claude/rules/code-style.md](../../.claude/rules/code-style.md)
**Supersedes**: pre-2.7.4 retry-only behavior

## Context

GitHub's REST API is eventually consistent across endpoints. A `PATCH /repos/<slug>` returning HTTP 200 with `visibility=public` does not guarantee that a subsequent read on `/repos/<slug>/pages` will reflect the new visibility — the Pages auth-check service can serve stale state for several seconds. In practice this surfaces as 422 errors with body messages like *"your current plan does not support GitHub Pages for this repository"* on a downstream `enablePages` POST that, by all rights, should succeed because the visibility flip already returned 200.

vaultkit's pre-2.7.4 retry layer (`gh-retry.ts:_classifyGhFailure`) handled this as a transient and retried with exponential backoff (1s/2s/4s/8s/16s ≈ 31s total). That works as a backstop, but it conflates two different problems:

1. **Call failed** → retry might succeed.
2. **Call succeeded but its effect isn't yet observable** → retry is the wrong primitive; we want a poll on the read endpoint.

Conflating them means retries fire on every transient — including the genuinely-failed-and-truly-transient case — and the caller of (e.g.) `setRepoVisibility` has no way to know if the change has actually propagated when the function returns.

## Decision

Mutations that another vaultkit call will immediately depend on `pollUntil` on their corresponding read endpoint before returning. The pattern lives in the new [src/lib/poll.ts](../../src/lib/poll.ts) helper:

```ts
await ghJson(...mutationArgs);                  // mutation returns 200
await pollUntil(
  () => readEndpoint(slug),                      // poll the read
  (current) => current === target,               // until predicate matches
  { description: 'human-readable for timeout msg' },
);
```

Applied at three boundaries:
- `setRepoVisibility(slug, v)` → polls `getVisibility(slug)` (in `github-repo.ts`).
- `enablePages(slug)` → polls `pagesExist(slug)` (in `github-pages.ts`).
- `setPagesVisibility(slug, v)` → polls `getPagesVisibility(slug)` (in `github-pages.ts`).

Default timeout 30s, default poll interval 500ms. On timeout, throws `VaultkitError('NETWORK_TIMEOUT')` with the description and last-observed value embedded in the message so the user knows what didn't propagate.

The retry-on-failure layer in `gh-retry.ts` stays — it now serves as a backstop for the genuinely-failed case, AND for the cross-endpoint propagation case where the mutation's *own* read endpoint catches up but a *different* downstream endpoint (e.g. Pages auth's separate cache) still lags.

## Consequences

**Easier:**
- Callers of these wrappers can trust that the change is observable when the function returns. No more "I just set it to public, why does the next call think it's private?"
- The two distinct problems (failed call vs slow propagation) have distinct primitives. Retry budgets stop being inflated by propagation waits.
- Failure messages are precise: timeout says *"setRepoVisibility succeeded but propagation didn't catch up in 30s"*, not *"retry budget exhausted after a transient classification."*

**Harder:**
- Every new GitHub mutation wrapper needs to consider whether to add a poll. The rule is captured in code-style.md ("Poll-after-mutate at eventual-consistency boundaries") and reinforced by the wrappers' top-of-file ACL doc-comment, but it requires judgment per call.
- 30s is a soft upper bound. Pathologically slow propagation surfaces as a `NETWORK_TIMEOUT` even when the mutation eventually succeeds; visibility.ts wraps the Pages-related operations in `try`/`log.warn`/manual-recovery URL so the visibility flip itself isn't aborted on Pages-auth lag.

**Trade-offs accepted:**
- Some duplication between the poll's read endpoint and the eventual user-facing read. Acceptable: the reads are cheap (a single GET) and the alternative — letting callers handle propagation — pushed the same logic into every consumer.
- A rare propagation that takes >30s surfaces as `NETWORK_TIMEOUT` even though the mutation went through. The accompanying retry layer (with the extended `[1s, 2s, 4s, 8s, 16s]` schedule) catches downstream calls that hit the Pages-auth lag separately.

## Alternatives considered

- **Pure retry, no poll.** Rejected: forces every caller to assume the mutation might not be visible yet, and conflates the two failure modes.
- **Embed the poll inside `ghJson`** as a generic post-success step. Rejected: ghJson doesn't know the read endpoint that corresponds to a given mutation. Wrapping at the wrapper layer (where the pairing is obvious) is correct.
- **Block the entire wrapper layer from returning until propagation, including for rare ops.** Rejected: simple operations like `getVisibility` (read-only) shouldn't poll; `disablePages` (one-shot, no caller waits on its propagation) doesn't need it. Per-wrapper judgment captured in the file's doc-comment is the right granularity.
