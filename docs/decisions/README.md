# Architectural Decision Records

This directory holds the chronological log of architectural decisions in vaultkit. Each ADR captures the *context* and *rationale* behind a structural choice — the **why** that survives across releases when commit messages decay and rule files only describe the **what**.

Format: [Michael Nygard's template](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) — Title / Status / Context / Decision / Consequences. ADRs are short by design so they're written, not skipped.

## Conventions

- **Filename**: `NNNN-kebab-case-title.md` (zero-padded; never reuse a number).
- **Status**: `Accepted` | `Superseded by ADR-NNNN` | `Deprecated`. ADRs are immutable once accepted; supersede rather than rewrite.
- **Cross-link**: `.claude/rules/*.md` files (which describe the *current* state) should reference the ADR(s) behind any non-obvious invariant.
- **Scope**: only architecturally significant choices — the kind a future contributor or AI agent might second-guess without knowing the history. Day-to-day refactors don't need an ADR.

## Index

| ADR | Title | Status |
|---|---|---|
| [ADR-0001](0001-launcher-byte-immutability-and-sha-pin.md) | Launcher template byte-immutability and SHA-256 pinning | Accepted |
| [ADR-0002](0002-poll-after-mutate-at-eventual-consistency-boundaries.md) | Poll-after-mutate at GitHub eventual-consistency boundaries | Accepted |
| [ADR-0003](0003-gh-retry-four-way-failure-classification.md) | gh-retry four-way failure classification | Accepted |
| [ADR-0004](0004-deleteRepo-via-gh-api-for-header-aware-retry.md) | `deleteRepo` migrated to `gh api` for header-aware retry | Accepted |
| [ADR-0005](0005-two-pat-round-robin-and-burst-rate-hardening.md) | Two-PAT round-robin and burst-rate hardening in CI | Accepted |
| [ADR-0006](0006-vitest-fileParallelism-disabled.md) | Vitest `fileParallelism: false` for shared-state safety | Accepted |
| [ADR-0009](0009-bootstrap-gate-at-dispatch-layer.md) | Bootstrap gate at the dispatch layer | Accepted |

## When to add an ADR

Write a fresh ADR for any decision worth a `.claude/rules/*.md` edit. The threshold is:

- **A stakeholder might re-litigate this in 6 months without knowing the context.** Capture the context now.
- **The decision constrains future code.** Future-you needs to know why before changing it.
- **An alternative was rejected and the reasoning is non-obvious.** ADRs that document `Considered but rejected` save the most time.

What does NOT belong here:
- Bug fixes (commit message + CHANGELOG).
- Renames, formatting, or local refactors.
- Per-PR rationale (PR description).
- Things already covered by a rule file with no separate "why" worth preserving.
