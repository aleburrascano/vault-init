# ADR-0004: `deleteRepo` migrated to `gh api` for header-aware retry

**Status**: Accepted
**Date**: 2026-05-02 (v2.7.1)
**Related rules**: [.claude/rules/security-invariants.md](../../.claude/rules/security-invariants.md)
**Builds on**: [ADR-0003](0003-gh-retry-four-way-failure-classification.md)

## Context

Pre-2.7.1, vaultkit's destructive GitHub operations used `gh` shorthand commands:

- `gh repo create <slug> --private` → POST `/user/repos`
- `gh repo delete <slug> --yes` → DELETE `/repos/<slug>`
- `gh repo edit <slug> --visibility public` → PATCH `/repos/<slug>`

The shorthands hide HTTP status codes and response headers behind a string-based stderr summary. That made the v2.7.1 four-way classifier (ADR-0003) unable to:

1. Read `X-RateLimit-Remaining` and `X-RateLimit-Reset` to proactively sleep before tripping secondary rate limits — critical on the v2.7.0 Ubuntu CI run where the test PAT got abuse-flagged mid-burst because the operations preceded the wrappers' retry logic.
2. Honor `Retry-After` headers on rate-limited responses — the shorthand stderr included only a body excerpt, not the header block.
3. Distinguish HTTP status codes (5xx vs 422 vs 403) from each other — the classifier had to fall back to body-text pattern matching, which is fragile.

Per [.claude/rules/security-invariants.md](../../.claude/rules/security-invariants.md), `deleteRepo` is a security-critical single-source-of-truth: every call to delete a repo must go through it (with `isAdmin` + typed-name confirmation preconditions). Changing its argv shape carries weight — every consumer that constructed the call had to be migrated atomically.

## Decision

Migrate the three high-volume mutations to `gh api --include`:

```ts
// before (2.7.0):
await execa(ghPath, ['repo', 'delete', slug, '--yes']);

// after (2.7.1+):
await ghJson('api', '--include', '--method', 'DELETE', `/repos/${slug}`);
```

The `--include` flag adds the response header block to stdout. `gh-retry.ts:_parseGhIncludeOutput` parses it into `{ status, headers, body }`, lower-casing header names so case-insensitive lookups work (`headers['retry-after']`, `headers['x-ratelimit-remaining']`). The wrapper layer (`createRepo`, `deleteRepo`, `setRepoVisibility`) calls `ghJson` and lets it apply the four-way classification + retry from ADR-0003.

`deleteRepoCapturing` is the exception: a non-throwing variant for `destroy` that captures `{ ok: bool, stderr: string }` instead of letting `ghJson`'s error propagation kick in. Used because `destroy`'s local + MCP cleanup must continue even if the GitHub-side delete fails (typically `delete_repo` scope missing); the user gets the diagnostic stderr to act on.

The security precondition — `isAdmin(slug)` + typed-name confirmation — is unchanged. The argv shape changed; the trust boundary did not. `.claude/rules/security-invariants.md` documents both the unchanged precondition and the migrated call shape so future contributors don't reintroduce the shorthand.

## Consequences

**Easier:**
- Rate-limit and abuse-flag classification works on the destructive path. The v2.7.0 Ubuntu symptom (account flagged mid-burst, opaque 403 from the next git push) now surfaces as `VaultkitError('AUTH_REQUIRED')` with operator-facing recovery instructions.
- Proactive rate-limit sleep (`maybeProactiveSleep` based on `X-RateLimit-Remaining`) keeps long batch operations under GitHub's secondary rate limit ceiling without requiring per-call orchestration.
- All three high-volume mutations share one call shape and one classification model. A future GitHub API change — new error format, new rate-limit signal — needs one edit, not three.

**Harder:**
- `gh api` argv is more verbose than `gh repo`. The wrapper is the single source of truth, so the verbosity is hidden from callers, but anyone reading github-repo.ts directly sees `'api', '--include', '--method', 'DELETE', '/repos/${slug}'` instead of the readable shorthand.
- `gh repo create` had implicit user-namespace resolution; `gh api POST /user/repos` requires the explicit endpoint. The migration moves the endpoint into the wrapper definition where it stays put.

**Trade-offs accepted:**
- The migration was a single atomic commit (no flag/staged rollout) because every call site goes through one wrapper. Acceptable because the test suite covers each wrapper in `tests/lib/github-mocked.test.ts` and the live tests in `tests/commands/*.test.ts` exercised the new shape end-to-end before the v2.7.1 release.
- `deleteRepoCapturing` duplicates a small amount of `gh()` body-extraction logic. Acceptable: the alternative (a flag on `ghJson` to capture instead of throw) makes the throwing variant's signature less clear.

## Alternatives considered

- **Stay on `gh repo` shorthands and parse stderr more aggressively.** Rejected: stderr text is GitHub-specific, gh-version-specific, and undocumented as a stable contract. Header parsing on `--include` is the documented path.
- **Per-mutation retry without a shared classifier.** Rejected: the three operations share most failure modes; per-call retry logic would drift.
- **A separate `deleteRepoSafe` for `destroy` that doesn't throw.** Rejected in favor of `deleteRepoCapturing` which makes the non-throwing semantics visible at the call site.
