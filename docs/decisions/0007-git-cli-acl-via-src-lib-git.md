# ADR-0007: Git CLI Anti-Corruption Layer via `src/lib/git.ts`

**Status**: Accepted
**Date**: 2026-05-04
**Related rules**: [.claude/rules/architecture.md](../../.claude/rules/architecture.md), [.claude/rules/security-invariants.md](../../.claude/rules/security-invariants.md)

## Context

vaultkit had three documented Anti-Corruption Layers when this ADR was written: the `gh` API surface ([gh-retry.ts](../../src/lib/gh-retry.ts) plus the three `github-*.ts` wrappers — see [ADR-0003](0003-gh-retry-four-way-failure-classification.md)), the Claude MCP CLI surface ([mcp.ts](../../src/lib/mcp.ts) — single source of truth for the `--expected-sha256=<hash>` invariant), and the git CLI surface ([git.ts](../../src/lib/git.ts) — `init`, `clone`, `push`, `pull`, `pushNewRepo`, `pushOrPr`, `getRepoSlug`, etc.). The first two were enforced by fitness functions in [tests/architecture.test.ts](../../tests/architecture.test.ts); the git ACL was declared in `.claude/rules/architecture.md` but **never enforced**.

A deep architectural pass (May 2026, plan: `can-you-go-through-inherited-squirrel.md`) found that six command files had drifted into raw `execa('git', …)` calls over time:

- [src/commands/backup.ts](../../src/commands/backup.ts) — `git status --porcelain`
- [src/commands/doctor.ts](../../src/commands/doctor.ts) — `git config user.name` / `user.email`
- [src/commands/init.ts](../../src/commands/init.ts) — `git init`, `git add .`, `git commit`
- [src/commands/status.ts](../../src/commands/status.ts) — `git status` (display)
- [src/commands/update.ts](../../src/commands/update.ts) — `git diff --cached --name-only`
- [src/commands/verify.ts](../../src/commands/verify.ts) — `git fetch`, `git rev-parse @{u}`, `git diff` (×2), `git pull --ff-only`

Each violation was a small benign call. The cumulative effect was that `git.ts` was not actually the sole owner of git — eleven inline call sites across six commands instead. Adding cross-cutting behavior (e.g., extending the abuse-flag classification that already lives in `git.ts:isAccountFlaggedStderr` to all git invocations) would have required touching seven files instead of one. The same architecture-erosion pattern that motivated [ADR-0001](0001-launcher-byte-immutability-and-sha-pin.md), [ADR-0003](0003-gh-retry-four-way-failure-classification.md), and the existing fitness functions: declared but not enforced ⇒ drifted in practice.

A latent regex bug compounded the problem: the existing `gh` ACL fitness function used `\bexeca\s*\(\s*['"]gh['"]\b` — but `\b` requires a word/non-word transition, and a literal quote `'` is not a word character, so the boundary after `'gh'` never matched. The check was passing today only because no command currently has raw `execa('gh', …)`; a future regression would have slipped through silently. A new git ACL check inheriting the same regex pattern would have had the same blind spot.

## Decision

**Enforce the git ACL as a fitness function in [tests/architecture.test.ts](../../tests/architecture.test.ts) (mirroring the existing `gh` and `claude mcp` checks):**

```ts
it('no command file invokes git via raw execa (must go through src/lib/git.ts)', async () => {
  // …
  .filter(({ line }) => /\bexeca\s*\(\s*(['"]git['"]|gitPath|git_path)/.test(line));
  // …
});
```

The trailing `\b` from the original gh-ACL regex was dropped on the literal-form alternation (the closing quote terminates the literal match by construction). The same fix was applied to the `gh` regex retroactively, so the existing ACL also actively detects regressions instead of passing only because the input is empty.

**Migrate the six command files one per commit** (the [Strangler Fig](../../).../wiki/concepts/Strangler%20Fig%20Pattern.md) approach the project has used before — see the TypeScript migration `a0a22f0` → `e0543a2`):

1. **A2** — Land the fitness function with `EXCEPTIONS['git-bypass-execa']` grandfathering all six file paths. Test passes (every violation is exempt). New violations would still fail — the rule applies to additions immediately.
2. **A3-A8** — One commit per command. Each commit (a) adds the missing wrapper verb to `git.ts` if needed, (b) migrates the call site, (c) removes one entry from `EXCEPTIONS['git-bypass-execa']`. Last commit (A8) clears the `EXCEPTIONS` array; the category remains as an empty placeholder for future use, with a comment noting it can be removed entirely once this ADR is referenced from the rule files.

The wrappers added during the migration (in addition to `git.ts`'s pre-existing `init`, `add`, `commit`, `clone`, `push`, `pull`, `pushNewRepo`, `pushOrPr`, `getRepoSlug`, `getStatus`, `archiveZip`, `setDefaultBranch`, `addRemote`):

- **`isWorktreeDirty(dir): Promise<boolean>`** — yes/no answer for the dirty check, cheaper than `getStatus`.
- **`getStatusText(dir): Promise<string>`** — raw human-readable `git status` output for display.
- **`getConfig(key): Promise<string>`** — read a `git config` value; empty string when unset.
- **`getStagedFiles(dir): Promise<string[]>`** — list of staged file paths.
- **`fetch(dir): Promise<{ ok: boolean }>`** — silent `git fetch --quiet`.
- **`hasUpstream(dir): Promise<boolean>`** — does `@{u}` resolve?
- **`diffFileNames(dir, range, paths?): Promise<string[]>`** — list of files changed between two refs.
- **`diff(dir, range, paths?): Promise<string>`** — raw human-readable diff.

Each wrapper is a one-purpose thin function. The naming differs from the underlying git verb when the verb name doesn't carry the semantic (e.g. `git status --porcelain` becomes `isWorktreeDirty` because that's what the *caller* asks; `git diff --cached --name-only` becomes `getStagedFiles` for the same reason). The naming aligns with the underlying verb when the semantic IS the verb (`fetch`, `diff`, `getConfig`).

## Consequences

**Easier:**
- Adding cross-cutting behavior to every git invocation (retry, additional stderr classification, telemetry) is one edit in `git.ts` instead of eleven inline call sites.
- The git ACL can never silently re-erode. The fitness function now actually fails CI when a command introduces a raw `execa('git', …)`. (Verified by injection: temporarily reintroduced an exception removal on backup.ts; the test failed as expected.)
- The `gh` ACL also benefits — the regex fix means future raw `execa('gh', …)` regressions are also caught, where before the check was a no-op due to an empty input set.
- Test refactors get easier: tests that mock `execa` for git can mock the `git.ts` wrappers instead, decoupling tests from the underlying argv shape (which can now evolve in `git.ts` only).

**Harder:**
- One more file to touch when a new git verb is needed (the wrapper goes in `git.ts` first, then the caller). The cost is small per occurrence and pays back on the next cross-cutting change.
- The eight new wrappers expand `git.ts`'s public surface from ~14 exports to ~22. Each is a one-line semantic; total LOC growth is small. Easy to review.
- A few wrappers (e.g., `fetch`) shadow Node global names. Callers use the `import { fetch as gitFetch }` pattern (already in use for `init as gitInit`, `add as gitAdd`, `commit as gitCommit`).

**Trade-offs accepted:**
- The wrappers don't currently add classification or retry beyond what `git.ts` already does (abuse-flag detection is on `pushNewRepo` and `pushOrPr`, not on `pull`/`fetch`/etc.). Rationale: those verbs don't burst-call GitHub's API the way `push` does, so abuse-flagging is unlikely. If a real failure mode appears (e.g., persistent `fetch` failures on an abuse-flagged repo), the classification is now one edit away — exactly the maintainability win this ADR is about.
- The existing `pull(dir, { ffOnly: true })` already returns `{ success, upToDate, timedOut, stderr }`. `verify.ts`'s migration uses this directly rather than introducing a separate `pullFastForward` wrapper for symmetry. KISS — one wrapper covers the use case.
- We do NOT export the internal `git(args, dir, opts)` helper. Exporting it would let any command call any verb, defeating the ACL's purpose. The pattern is "add a named verb to `git.ts` first, then the caller imports it" — same shape as the github-* wrappers.

## Alternatives considered

- **Skip the fitness function; rely on rule-file documentation.** Rejected: the rule already existed and was ignored. "It's in the rules" is not enforcement; ADR-0003's whole point was "automated enforcement over aspirational guidelines."
- **One big-bang migration commit.** Rejected: the project's commit-cadence rule (CLAUDE.md §11) requires each commit to leave `check`/`build`/`test` green. The migration-via-EXCEPTIONS pattern lets each step be independently shippable, and the test suite confirms no regression at every step.
- **Skip the regex fix on the existing gh-ACL.** Rejected: discovered during this work that the gh check was a latent no-op; it would be careless to ship a new check using the same broken regex while leaving the old one buggy. Both fixed in A2.
- **Keep `EXCEPTIONS['git-bypass-execa']` as a permanent slot.** Rejected: empty exceptions categories rot. Removed the entries in A8 and noted that the category itself can be removed once this ADR is referenced from the rule files (deferred trivially — the empty array is harmless).
- **Add wrappers eagerly for verbs we don't currently use.** Rejected: KISS/YAGNI. Each wrapper exists because a command currently needs it. The next migration adds the next wrapper.
