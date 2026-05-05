# ADR-0015: Per-vault schema version + centralized breaking-changes table

**Status**: Accepted
**Date**: 2026-05-05
**Related**: [ADR-0001](0001-launcher-byte-immutability-and-sha-pin.md), [ADR-0014](0014-npm-deprecate-on-launcher-breaking-change.md), [src/lib/breaking-changes.ts](../../src/lib/breaking-changes.ts), [src/lib/launcher-history.ts](../../src/lib/launcher-history.ts)

## Context

The 2.8.0 launcher-template change exposed a structural pattern: each vault's "version" is implicit in the bytes of its launcher and the shape of its registry entry. To detect "this vault is on an old version and needs a migration," vaultkit currently relies on SHA-mismatch classification ([src/lib/launcher-history.ts](../../src/lib/launcher-history.ts)) — comparing the on-disk launcher's SHA-256 against a hard-coded historical-SHA table.

That works for *one* dimension of breaking change (the launcher template's bytes). It does not scale to:

- Registry-shape changes (new flag on the `claude mcp add` argv that older vaults don't have).
- Layout-file changes (a file added to the canonical vault layout).
- Behavioral changes in the per-vault MCP server that need a re-pin.

Each of those would need its own bespoke detection path. With ~3 historical SHAs already in the table from one breaking change, the cost is small. With three more breaking changes touching three different components, the cost compounds: every detection path (`doctor`, `post-upgrade-check`, `preflight-launcher`, plus future surfaces) would need to know about every dimension independently.

The 2.8.0 ideation doc (Idea 6) called for a single `schemaVersion` integer on each vault's registry entry plus a centralized table mapping versions to migration descriptors. The promise: "by the third breaking change," wiring is O(1) per change instead of O(detection-paths × changes).

## Decision

Each vault's MCP registry entry carries a `--schema-version=<n>` flag alongside `--expected-sha256=<hex>`. The flag is parsed by [src/lib/registry.ts:extractVaultEntry](../../src/lib/registry.ts) into a typed `schemaVersion: number | null` field on `VaultRecord` (and surfaced on the `Vault` class). [src/lib/registry.ts:addToRegistry](../../src/lib/registry.ts) and [src/lib/mcp.ts:runMcpAdd](../../src/lib/mcp.ts) both write the current value automatically — callers do not thread it through.

[src/lib/breaking-changes.ts](../../src/lib/breaking-changes.ts) owns the policy:

- `CURRENT_SCHEMA_VERSION: number` — the version every newly-registered or freshly-updated vault gets.
- `BREAKING_CHANGES: readonly BreakingChange[]` — chronological, append-only list of structured descriptors.
- `migrationsNeeded(vaultSchemaVersion): BreakingChange[]` — pure filter; legacy (`null` / `undefined`) entries are treated as version 0, so every recorded migration applies.

A `BreakingChange` carries `{ toSchemaVersion, component, severity, remedyCommand, humanLabel }`. Detection paths consume the structured shape, not free-form prose, so messaging stays consistent across surfaces by construction.

The byte-immutable launcher template ([lib/mcp-start.js.tmpl](../../lib/mcp-start.js.tmpl)) only reads `--expected-sha256=`; unknown flags are ignored, so adding `--schema-version=` is backward-compatible with every existing pinned launcher. No template change is needed.

Adding a new breaking change is a two-step operation per [src/lib/breaking-changes.ts](../../src/lib/breaking-changes.ts):

1. Bump `CURRENT_SCHEMA_VERSION` to N+1.
2. Append a `BreakingChange` entry with `toSchemaVersion: N+1` describing what changed and the remedy command.

Existing detection paths automatically pick up the new entry through `migrationsNeeded` — no per-path edits.

## Consequences

**Easier:**
- A single edit (a `BreakingChange` entry) makes a vault-version migration visible across `doctor`, `post-upgrade-check`, `preflight-launcher`, and any future surface that consumes `migrationsNeeded`.
- `doctor` shows each vault's `schema: vN | (legacy)` line, giving users at-a-glance visibility into registration age.
- The detection space is *typed* — `BreakingChange.severity = 'warn' | 'fail'` and `BreakingChange.component = 'launcher' | 'registry' | …` are statically checked, so a missing branch in messaging code surfaces at compile time, not at user-bug time.

**Harder:**
- Two coupled writes per registration path (the launcher SHA pin AND the schema version). The single source of truth in `addToRegistry` / `runMcpAdd` keeps the coupling local — no caller needs to know — but the contract has more surface area than the SHA-only era.
- Existing pre-2.8.0 vaults register with `schemaVersion: null` (no flag in their args). The first time their owners run `vaultkit update`, the flag is backfilled. Until then, the registry has a mix of legacy and current entries — `migrationsNeeded` handles this by treating `null` as version 0.

**Trade-offs accepted:**
- The launcher template still has its own SHA-based version classification ([src/lib/launcher-history.ts](../../src/lib/launcher-history.ts)) for the pre-schema-version era. That table covers users on v1.3.0 / v1.4.1 / pre-2.8.0; the schema-version table covers everyone going forward. The two coexist: SHA classification handles "the historical record"; schema-version handles "the forward record." We accept the dual mechanism because retrofitting old releases isn't possible — only the new path can be enforced.
- `BREAKING_CHANGES` ships empty at the time of introduction. The mechanism's value is in *future* breaking changes; the 2.8.0 transition is already covered by `launcher-history.ts`. Wiring detection paths to call `migrationsNeeded` is therefore deferred until the first real entry — calling it against an empty table would be dead code by [CLAUDE.md §2](../../.claude/CLAUDE.md). The first entry's author will wire detection in the same change as adding the entry, where the messaging shape is concrete.

## Alternatives considered

- **Per-component version flags (`--launcher-version=N` + `--registry-version=M` + …).** Rejected: orthogonal flags push compatibility-matrix complexity onto every detection path; one integer captures "what shape is this vault" with the minimum surface that future authors can extend.
- **Store `schemaVersion` in `<vault-dir>/_vault.json` instead of the registry entry.** Rejected: the registry is already the trust boundary for vault identity (per ADR-0001); splitting the version across two files invites drift between "registry says X, vault file says Y" states.
- **Auto-migrate on registry read.** Rejected: writing to `~/.claude.json` from a read path is the wrong direction. Migration is a user-consent operation; auto-rewrite would silently change the registry shape and break ADR-0001's "the user's home directory is the trust boundary" model.
- **Use SemVer of vaultkit itself instead of a separate integer.** Rejected: vaultkit version != vault registration version — a 2.8.5 patch release that doesn't change anything vault-side shouldn't bump the schema. The integer keeps the two cadences independent.

## How the policy gets enforced

- The fitness functions in [tests/architecture.test.ts](../../tests/architecture.test.ts) already enforce ACL non-bypass: every `claude mcp add` goes through `runMcpAdd`. Since `runMcpAdd` writes `--schema-version=` automatically, the flag is structurally guaranteed on every new registration.
- [tests/lib/breaking-changes.test.ts](../../tests/lib/breaking-changes.test.ts) pins shape invariants on `BREAKING_CHANGES` (every entry has a positive `toSchemaVersion ≤ CURRENT_SCHEMA_VERSION`, non-empty `remedyCommand` and `humanLabel`).
- [tests/lib/mcp.test.ts](../../tests/lib/mcp.test.ts) and [tests/lib/registry.test.ts](../../tests/lib/registry.test.ts) pin the canonical argv / record shape with the new flag.

When the next breaking change lands, the author adds (a) the `BREAKING_CHANGES` entry, (b) detection wiring (e.g. in `doctor.ts` or a new lib), and (c) tests for the wiring. The shape-invariant tests already pin the table's invariants; the new tests pin the new detection.
