---
date: 2026-05-05
topic: version-migration-ux
focus: UX improvements for users on old vaultkit versions who don't know about 2.8.0 breaking changes
mode: repo-grounded
---

# Ideation: Version Migration UX

## Grounding Context

**Project shape:** TypeScript/Node.js CLI (Node ≥22, ESM), published as `@aleburrascano/vaultkit`. 14 commands via commander, shared libs in `src/lib/`, 6 MCP tools in `src/mcp-tools/`.

**The breaking change:** v2.8.0 changed `lib/mcp-start.js.tmpl` (launcher now starts `vaultkit mcp-server` instead of `npx obsidian-mcp-pro`). Every existing vault's `.mcp-start.js` is stale. Users must run `vaultkit setup` then `vaultkit update <name>` per vault. If they don't, the next Claude Code session fails silently with a `Launcher SHA-256 mismatch` error.

**Relevant machinery:**
- `src/lib/update-check.ts` — fires post-command (via `wrap()`), 24h TTL, emits generic 2-line warn with no breaking-change awareness
- `bin/vaultkit.ts` `wrap()` — already has hint-appending pattern for specific error codes (precedent for in-band actionable hints)
- `vaultkit doctor` — reads registry, checks launcher SHAs
- `vaultkit update <name>` — per-vault migration command
- SHA-mismatch error in `src/lib/mcp.ts` — exists, names `vaultkit update`, but doesn't distinguish upgrade from tampering
- ADR-0001: template change = breaking change release event
- ADR-0011: migration path is `setup` + `update <name>`; blocking gate explicitly rejected

**External signals:**
- `update-notifier`: exposes `update.type` (major/minor/patch), `notify({ message })` for custom messages
- AWS CLI: per-command behavioral warnings — contextual, not nagging
- Flyway/Prisma: `schemaVersion` in config checked on startup — fires only when gap is real
- `npm deprecate`: zero-cost registry-level flag for install-time warnings

---

## Ranked Ideas

### 1. `npm deprecate` pre-2.8.0 versions
**Description:** Run `npm deprecate @aleburrascano/vaultkit@"<2.8.0" "Vaults need migration after upgrading. Run: vaultkit setup && vaultkit update <name>"` — one command, no code changes. Anyone installing or updating from an old pin sees npm's deprecation notice before running the CLI.

**Warrant:** `direct:` — project is a public npm package; `npm deprecate` is a standard npm registry feature. Can be codified as a standing step in the `/release` workflow.

**Rationale:** Reaches users who update via package managers (Renovate, Dependabot, `npm outdated`) at install time — before any session fails. Zero runtime cost, zero maintenance burden, zero code changes.

**Downsides:** Passive — only fires on install/update, not on existing installs already running an old version. Users who installed months ago and never re-run npm won't see it.

**Confidence:** 95%
**Complexity:** Trivial (one command, no code)
**Status:** Explored — 2026-05-05

**Implementation note:** Codified as a standing step in [`/release`](../../.claude/commands/release.md) and recorded in [ADR-0014](../decisions/0014-npm-deprecate-on-launcher-breaking-change.md). Future launcher-breaking releases run `npm deprecate` against the prior range *and* add an entry to `src/lib/launcher-history.ts:HISTORICAL_LAUNCHER_SHAS`, so the deprecation message + the doctor/verify disambiguation evolve together. The actual `npm deprecate` command for `<2.8.0` will be run after the next release that ships this work — it can't be run earlier because the message references the new `--all` flag introduced in idea 4.

---

### 2. One-time post-upgrade breaking-change notice
**Description:** On the first command invocation after a version bump — detected by comparing a stored `last-seen-version` file to the running binary — emit a targeted one-time notice that names all stale vaults and the exact commands to fix them. Replaces the generic "update available" two-liner for breaking-change versions. The stored file is updated after the notice fires, suppressing it on subsequent invocations.

**Warrant:** `direct:` — `src/lib/update-check.ts` already fires post-command, reads/writes a local cache file with a TTL, and exports `_isNewer()` for testing. The registry-read to enumerate stale vaults already happens in `vaultkit doctor`. The `wrap()` hint pattern is the precedent for in-band actionable messages.

**Rationale:** The first command after upgrading is the highest-signal moment to surface migration steps. Currently wasted on a generic "update available" that gives no migration guidance. Converting that moment into a migration brief eliminates the CHANGELOG-reading assumption that ADR-0011 made but which most users skip.

**Downsides:** Requires the user to run a vaultkit CLI command after upgrading (likely, but not guaranteed if they only use Claude Code directly). Needs `last-seen-version` persistence + vault enumeration at startup — low-medium complexity.

**Confidence:** 90%
**Complexity:** Low-Medium
**Status:** Explored — 2026-05-05

**Implementation note:** Landed in `src/lib/post-upgrade-check.ts` (new — `checkPostUpgrade(currentVersion, cfgPath?, log)` plus a `~/.vaultkit-last-seen-version.json` cache). Wired into `bin/vaultkit.ts:wrap()` after every successful action. On first run on a machine the cache is silently seeded; on every subsequent run where the running version differs from the cached value, the function enumerates every registered vault via `getAllVaults`, classifies each launcher via `classifyLauncherSha` from idea 3's `launcher-history.ts`, and prints a "vaultkit upgraded from X to Y" header plus a per-vault list of stale entries with `vaultkit update --all` as the action. Cache is written before classification so a corrupt registry produces a single "could not enumerate" line instead of trapping the user in an infinite-notice loop. Reuses the `VAULTKIT_NO_UPDATE_CHECK=1` gate (one env var for both post-action notification concerns). The existing 2.8.0 → first-2.9.0 transition won't trigger because pre-2.9.0 users have no cache file yet — the bootstrap is silent — but every subsequent breaking-change release will fire correctly.

---

### 3. SHA-mismatch error disambiguation + causal context
**Description:** Split the existing `Launcher SHA-256 mismatch` error into two code paths: (a) if the launcher's SHA matches a known prior template version → "launcher is outdated after upgrade — run `vaultkit update <name>`"; (b) if the SHA doesn't match any known version → "possible tampering detected." Add a causal line: "v2.8.0 changed the launcher template — this is expected after upgrading."

**Warrant:** `direct:` — the SHA-mismatch error exists in `src/lib/mcp.ts` today; `bin/vaultkit.ts` `wrap()` already has the hint-appending pattern for specific error codes; `vaultkit doctor` already compares SHAs against known values. The disambiguation is entirely within existing machinery.

**Rationale:** The current error panics users (security breach?) or gets dismissed (will Google later). Two sentences of context take the worst error a user will encounter and make it self-diagnosing with a copy-pasteable fix. Also removes false tamper alarms for users who legitimately upgraded.

**Downsides:** Requires maintaining a table of known historical template SHAs (grows with each breaking change — but idea 6 provides the infrastructure for this).

**Confidence:** 95%
**Complexity:** Low
**Status:** Explored — 2026-05-05

**Implementation note:** Landed in `src/lib/launcher-history.ts` (new — `HISTORICAL_LAUNCHER_SHAS` table + `classifyLauncherSha`/`historicalVersionLabel` helpers), with the classifier wired into `src/commands/doctor.ts` and `src/commands/verify.ts`. The byte-immutable launcher template was *not* edited — disambiguation lives entirely in the CLI surfaces. `doctor` now prints `! warn ... outdated after upgrade ... vaultkit update --all` for known historical SHAs and `x fail ... possible tampering` for unknown SHAs (only the latter increments the issue count). `verify` prefaces its re-pin prompt with the same causal context for historical SHAs. The HASH_MISMATCH hint at `bin/vaultkit.ts:wrap()` was deliberately *not* added — that error code is not currently thrown anywhere, so the hint would be dead code; the doctor/verify text already carries the action.

---

### 4. `vaultkit update --all` bulk migration
**Description:** Add a `--all` flag to `vaultkit update` (or a `--fix` flag to `vaultkit doctor`) that iterates every registered vault, checks each launcher SHA, and migrates all stale ones in a single pass with a per-vault status line. Users currently must know every vault name and run the command once per vault.

**Warrant:** `direct:` — `vaultkit doctor` already iterates all registered vaults and checks launcher SHAs. `vaultkit update <name>` already contains the per-vault migration logic. The `--all` flag is a loop connecting two existing pieces — no new logic required.

**Rationale:** Collapses N per-vault commands into one. Eliminates the "I migrated `main` but forgot `notes`" class of partial-migration bugs. The per-vault loop is tolerable with 1–3 vaults today but creates a growing support surface as vault counts increase.

**Downsides:** None significant. Whether `update --all` or `doctor --fix` is the right surface is a short design discussion.

**Confidence:** 85%
**Complexity:** Low
**Status:** Explored — 2026-05-05

**Implementation note:** `src/commands/update.ts` was refactored: the inline per-vault flow became a private `updateOneVault(vault, opts)` helper, and `run(name, opts)` is now a thin shim. A new `--all` flag (handled in `bin/vaultkit.ts:228`-style update wiring) iterates `getAllVaults(cfgPath)` from `src/lib/registry.ts`, calls `updateOneVault` per vault with `skipConfirm: true`, accumulates a `+ ok` / `x fail` summary, and throws `PARTIAL_FAILURE` if any vault failed (so CI pipelines can detect partial migration). The argument parser rejects both `vaultkit update` (no name, no flag) and `vaultkit update <name> --all` (conflict). README, CHANGELOG, and bin help text updated. Single-vault behavior is unchanged.

---

### 5. Pre-flight launcher check on vault-touching commands
**Description:** Before executing any `vaultkit` command that references a specific vault (e.g., `status`, `pull`, `refresh`, `update <name>`), compare the vault's launcher SHA against the current template SHA and emit a warning if stale — before the command body runs. Moves detection to the CLI layer, preventing the silent failure path where the problem surfaces only inside a Claude Code session.

**Warrant:** `direct:` — `vaultkit doctor` already reads the registry and checks launcher SHAs per vault (O(1) single SHA comparison). The vault name is already resolved at command dispatch time in `bin/vaultkit.ts`. AWS CLI per-command behavioral warnings is the named pattern: fires only for commands you actually run, contextual not ambient.

**Rationale:** The worst failure mode is opening Claude Code, seeing a cryptic MCP error, and having no idea vaultkit was the cause. A pre-flight check in the CLI layer intercepts this before the user enters Claude Code, at the moment they're most likely to act on it.

**Downsides:** Adds a sync SHA read to vault-touching commands (negligible I/O cost). Commands without an explicit vault argument need a different trigger strategy. Vault names must be fully resolved before the check can run.

**Confidence:** 80%
**Complexity:** Low-Medium
**Status:** Explored — 2026-05-05

**Implementation note:** Landed in `src/lib/preflight-launcher.ts` (new) — `preflightLauncherCheck(name, cfgPath?, log)` (single-vault) and `preflightAllVaults(cfgPath?, log)` (multi-vault). Wired into `bin/vaultkit.ts:wrap()` BEFORE the command body runs, gated on a `VAULT_PREFLIGHT_COMMANDS = new Set(['status', 'pull', 'refresh'])` set. Single-vault variant runs when `args[0]` looks like a valid vault name; multi-vault variant runs when `args[0]` is empty (nameless `pull` / `status` / `refresh`). Stale launchers produce a per-vault warn line pointing at the right remediation command (`vaultkit update <name>` for historical, `vaultkit verify <name>` for unknown). The multi-vault variant aggregates into a summary line plus per-vault detail to bound noise. Excluded from `verify`/`update` (already disambiguate stale launchers in their own bodies — preflight there would duplicate) and from `backup`/`disconnect`/`destroy`/`visibility` (launcher staleness is irrelevant to those operations — warning would be noise). Disabled with `VAULTKIT_NO_LAUNCHER_PREFLIGHT=1`.

---

### 6. Schema versioning infrastructure
**Description:** Add a `schemaVersion` integer to each vault's registry entry (written at `vaultkit setup` / `vaultkit update` time). Ship a `src/lib/breaking-changes.ts` static lookup table mapping version ranges to structured descriptors (affected component, severity, remedy command, human label). All detection paths (`update-check.ts`, `doctor`, error hints in `mcp.ts`) read from this single table. A new breaking change requires one array entry; messaging stays consistent across all paths automatically.

**Warrant:** `direct:` — `src/lib/mcp.ts` SHA-mismatch check already names `vaultkit update` as remedy — that check becomes a version-range comparison. ADR-0001 defines template change as a breaking change event by policy — `schemaVersion` formalizes that policy in code. Flyway/Prisma `schemaVersion` pattern is the named external precedent. Without this, each new breaking change requires updating every detection path independently (O(paths × changes)); with it, it is O(1) per change.

**Rationale:** Ideas 1–5 are targeted fixes for v2.8.0. This is the compounding foundation that makes the next migration near-frictionless. Pays for itself by the third breaking change.

**Downsides:** Medium complexity — requires updating `vaultkit setup` and `vaultkit update` to write the field, and all detection paths to read from the table. Doesn't deliver immediate user-visible UX unless paired with ideas 2–5.

**Confidence:** 80%
**Complexity:** Medium
**Status:** Explored — 2026-05-05

**Implementation note:** Landed in `src/lib/breaking-changes.ts` (new — `CURRENT_SCHEMA_VERSION` + `BreakingChange` interface + empty `BREAKING_CHANGES` table + `migrationsNeeded` filter). Every vault registered or re-pinned now carries `--schema-version=N` alongside `--expected-sha256=` (added structurally inside `runMcpAdd` and `addToRegistry` so callers can't omit it). `Vault.schemaVersion` and `VaultRecord.schemaVersion` surface the value across the codebase. `vaultkit doctor` now prints `schema: vN | (legacy)` per vault. The `BREAKING_CHANGES` table is intentionally empty at this release — the 2.8.0 transition is already covered by the SHA-classification path in `launcher-history.ts`, and adding entries for hypothetical future migrations would be dead code. The first real entry will land alongside the next release that needs a vault-side migration. ADR-0015 documents the policy.

---

### 7. Thin forwarder launcher (architectural elimination)
**Description:** Instead of copying a versioned launcher template into each vault, ship the launcher as a minimal stable stub that delegates entirely to the currently-installed vaultkit binary's own launcher entry point. The stub contains no template-version-specific logic — it resolves and execs the installed package. After any npm upgrade the stub automatically uses the new code. The "stale launcher" problem cannot exist because there is no per-vault copy of version-sensitive logic.

**Warrant:** `reasoned:` — The SHA-pinning invariant (ADR-0001) exists because the launcher has meaningful content that can drift. If the launcher's only job is "find and exec the installed CLI," its content is trivially stable and the pin becomes unnecessary. Every other idea in this list is mitigation; this removes the problem class. Requires one-time migration for existing vaults plus updating the security model in the ADRs.

**Rationale:** Ideas 1–6 all reduce migration friction. This one makes future migrations impossible by eliminating the static per-vault copy. Cost is upfront architectural work; benefit is permanent.

**Downsides:** High complexity. Requires revising ADR-0001 and ADR-0011. Requires one-time migration for all existing vaults. Changes the security model — SHA-pinning provided tamper detection that the thin forwarder gives up unless a different tamper-detection mechanism is added.

**Confidence:** 65%
**Complexity:** High
**Status:** Declined — 2026-05-05

**Rationale:** Ideas 1–6 collectively cover the user-facing pain: deprecation message at install (idea 1), post-upgrade notice on first command (idea 2), SHA-mismatch disambiguation in `doctor`/`verify` (idea 3), bulk migration via `update --all` (idea 4), pre-flight warning on vault-touching commands (idea 5), and a centralized breaking-changes table for future migrations (idea 6). Idea 7's prize was eliminating the problem class architecturally, but the cost is giving up vaultkit's only launcher-layer tamper detection — replacing `.mcp-start.js` with arbitrary code would silently succeed under a thin forwarder. Building a replacement tamper-detection mechanism (e.g. verifying the installed `vaultkit` binary's signature, or path-ownership checks on the stub) is a separate design project worth its own ADR; not justified by the residual UX pain after ideas 1–6 ship. Revisit if a future incident or threat-model change makes the SHA-pin scheme structurally untenable.

---

## Rejection Summary

| Idea | Reason rejected |
|------|----------------|
| Silent auto-migrate in `wrap()` | Unsafe file writes without user consent; races with active MCP sessions; ADR-0011 context |
| `postinstall` npm hook | Unreliable in global npm install context; idea 2 covers the same moment more reliably |
| Hard gate on stale vaults | ADR-0011 explicitly prohibits blocking migration gates; would break pinned CI pipelines |
| Cohort-split gate (hard for new installs, soft for legacy) | Adds registry complexity for a nuance that matters at scale, not at the current ~20-user audience |
| Graduated countdown / grace window | Idea 2's one-time notice covers the nudge; countdown adds stateful deadline tracking for marginal gain |
| MCP tool pre-flight in 6 tool handlers | MCP session already established by tool-call time; SHA-mismatch fires at MCP connect; depends on idea 6 first |
| Per-command session-once vault warning | Overlaps idea 5 (pre-flight); adds per-session state tracking for marginal signal gain |
| `doctor --fix` as standalone | Merged into idea 4 (`update --all`) — same behavior, surface-choice question only |
| Causal chain in error message (standalone) | Sub-component of idea 3 disambiguation; belongs in the enriched error, not a separate idea |
| Diff output before applying launcher update | Sub-component of a future `migrate --dry-run` flag; not a standalone product idea |
| Breaking-change registry as standalone | Merged into idea 6 as implementation detail |
| Compiler escalation (warn → hard error in next major) | Policy layer on top of ideas 2–3; not a distinct product idea |
| Vault-scoped per-command ambient warning | Overlaps ideas 3 + 5; adds per-vault session state for marginal signal gain |
