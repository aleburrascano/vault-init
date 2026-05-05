# ADR-0012: Fitness functions for security invariants

**Status**: Accepted  
**Date**: 2026-05-05  
**Related rules**: [.claude/rules/security-invariants.md](../../.claude/rules/security-invariants.md), [.claude/rules/architecture.md](../../.claude/rules/architecture.md)  
**Related**: [ADR-0007](0007-git-cli-acl-via-src-lib-git.md) (the ACL fitness function this extends)

## Context

vaultkit's security-invariants.md documents several invariants that protect against destructive-op misuse:

- `isVaultLike()` must be checked before any directory deletion
- Vault paths for destructive ops must come from the MCP registry (`Vault.tryFromName` / `Vault.requireFromName` / `getVaultDir`), not raw user input
- `SearchIndex.close()` must be called whenever `openSearchIndex()` is called
- Catch blocks that rethrow must use `VaultkitError`, not plain `Error` (plain Error loses the `VaultkitErrorCode` and maps to exit 1, breaking the documented exit-code contract)

These four were enforced only by code review. When a new contributor (or AI agent) adds a command, nothing in the CI pipeline reminds them to follow these invariants. The git-bypass-execa ACL check (ADR-0007) demonstrated that machine-checked invariants stay clean over time while documented-only ones drift.

## Decision

Add four fitness functions to `tests/architecture.test.ts` (the existing home for architectural boundary checks). Each is a text-grep over `src/commands/*.ts`:

1. **`rmSync-without-isVaultLike`** — any file calling `rmSync()` must also contain `isVaultLike`. Files where the rmSync is on a directory the command itself just created (not a pre-existing vault) are grandfathered in `EXCEPTIONS` with rationale.

2. **`rmSync-without-registry-path`** — any file calling `rmSync()` must also contain a registry lookup (`Vault.tryFromName`, `Vault.requireFromName`, or `getVaultDir`). Same `EXCEPTIONS` escape hatch.

3. **`searchindex-not-closed`** — any file calling `openSearchIndex()` must also call `.close()`. Detects the resource-leak pattern before it ships.

4. **`catch-rethrows-plain-error`** — detects catch blocks containing `throw new Error(...)`. Uses lightweight brace-depth tracking (not an AST parser) to scope the check to catch block bodies only.

All four checks pass immediately on adoption — they encode the current state and guard against future regressions.

`init.ts`'s rollback `rmSync` is added to `EXCEPTIONS` for checks 1 and 2: its `rmSync` operates on a directory the command just created (guarded by `createdDir && existsSync(vaultDir)`), not a pre-existing vault, so `isVaultLike` is both unnecessary and potentially harmful (could block rollback if init fails before writing vault marker files).

## Consequences

- **Positive**: future contributors cannot accidentally delete a non-vault directory or miss a `close()` without a CI failure pointing at the specific rule file.
- **Positive**: the `EXCEPTIONS` map becomes the canonical record of known exceptions, with rationale inline, superseding free-text comments scattered across rule files.
- **Positive**: consistent with the project's existing architecture fitness function pattern — no new tooling required.
- **Negative (minor)**: text-grep checks can have false positives (e.g., a file that imports `isVaultLike` for a different purpose than guarding an rmSync). The `EXCEPTIONS` map is the escape hatch; add entries with rationale rather than weakening the pattern.
- **Non-goal**: these are guardrails, not a security audit. The checks catch the common regression patterns; a determined adversary who understands the EXCEPTIONS map can circumvent them. The trust model remains "CI catches accidents, code review catches intentional violations."
