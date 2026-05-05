# ADR-0014: `npm deprecate` past versions on every launcher-template breaking change

**Status**: Accepted
**Date**: 2026-05-05
**Related**: [ADR-0001](0001-launcher-byte-immutability-and-sha-pin.md), [ADR-0011](0011-vaultkit-mcp-replaces-obsidian-mcp-pro.md), [src/lib/launcher-history.ts](../../src/lib/launcher-history.ts)

## Context

Per ADR-0001 the launcher template at [lib/mcp-start.js.tmpl](../../lib/mcp-start.js.tmpl) is byte-immutable: any release that changes its bytes invalidates the SHA-256 pin in every existing vault's `~/.claude.json`. Users on the prior version see a `Launcher SHA-256 mismatch` error inside Claude Code on their next session and must run `vaultkit setup && vaultkit update --all` to re-pin.

The 2.8.0 release (ADR-0011) made this concrete. The launcher swapped its spawn target from `npx obsidian-mcp-pro` to `vaultkit mcp-server`, which changed the template bytes. Every pre-2.8.0 vault is now broken until the user migrates. Today the only signal users get is:

1. The CLI's once-per-24h "update available" notice (no migration guidance).
2. The launcher's runtime "SHA mismatch" error (no breaking-change context — could be tampering or could be an upgrade).

Neither path tells a user installing vaultkit fresh — or upgrading via Renovate / Dependabot / `npm outdated` — that they need to migrate. By the time they hit the cryptic launcher error inside Claude Code, vaultkit's CLI is already out of frame.

`npm deprecate <pkg>@<range> "<message>"` is a standard registry-level feature: the message surfaces on every install or update from a matching version range, before any vaultkit code runs. Zero runtime cost, zero code, no maintenance burden — the deprecation lives on the npm registry side.

## Decision

Every breaking-change release that touches `lib/mcp-start.js.tmpl` triggers two coupled actions:

1. **Run `npm deprecate`** against the prior version range, with a message that names the migration command:
   ```
   npm deprecate @aleburrascano/vaultkit@"<X.Y.Z" \
     "Launcher template changed in X.Y.Z. After upgrading run: vaultkit setup && vaultkit update --all"
   ```
   `X.Y.Z` is the new release's version. The range `<X.Y.Z` covers every prior version, since each was shipped against the now-incompatible template.

2. **Add an entry to `HISTORICAL_LAUNCHER_SHAS`** in [src/lib/launcher-history.ts](../../src/lib/launcher-history.ts) for the prior template's SHA, labeled with the version range it shipped. This lets `vaultkit doctor` and `vaultkit verify` classify post-upgrade hash mismatches as "outdated after upgrade" (recoverable, points at `vaultkit update --all`) instead of "possible tampering" (security event).

The `/release` workflow gains a checklist line that fires only when the diff being released changes `lib/mcp-start.js.tmpl`. The two actions stay coupled because half-doing one without the other re-introduces the failure mode this ADR addresses (deprecation with no doctor-level disambiguation, or vice versa).

## Consequences

**Easier:**
- Renovate / Dependabot / `npm outdated` users see the migration command at install time, before any session fails.
- `vaultkit doctor` and `vaultkit verify` distinguish "you upgraded and didn't migrate" from "your launcher was tampered with," eliminating false-tamper alarms after upgrades.
- The deprecation policy is codified, so future maintainers don't have to re-derive it from incident response.

**Harder:**
- Each breaking-change release adds two manual-but-codified steps (run `npm deprecate` + add a SHA entry). Both are quick and reversible (`npm deprecate <range> ""` clears a deprecation), but they're easy to forget without the checklist.

**Trade-offs accepted:**
- `npm deprecate` only fires on install or update — users who installed months ago and never re-ran npm don't see it. The doctor/verify disambiguation (idea 3 in the v2.8.0 migration UX ideation) and the post-upgrade notice path (idea 2, deferred) cover that audience separately.
- Maintaining `HISTORICAL_LAUNCHER_SHAS` grows by one entry per breaking release. The list is small enough to be a static map; if it ever grows past ~20 entries we'll revisit the storage shape, but at one breaking release per ~9 months that's not a near-term concern.

## Alternatives considered

- **Hard gate on stale vaults at command entry.** Rejected per ADR-0011's discussion: a blocking gate would break pinned CI pipelines and leaves no path for users who only use Claude Code (not the CLI) to recover.
- **`postinstall` npm hook.** Rejected: unreliable across `npm install -g` flags and corporate proxy configs; ADR-0011's idea 2 path (one-time post-upgrade notice on first CLI invocation) covers the same moment more reliably and is on the deferred list.
- **Cohort-split gate (hard for new installs, soft for legacy).** Rejected for now: adds registry-shape complexity for a nuance that matters at scale, not at vaultkit's current ~20-user audience. Revisit if the user count grows past a few hundred.

## How the policy gets enforced

The `/release` workflow checklist names this ADR. When the release diff includes a change to `lib/mcp-start.js.tmpl`, the human running `/release` runs both steps before the publish workflow fires. There is no programmatic enforcement — the launcher template changes too rarely to justify a CI fitness function (one breaking release per ~9 months is well below the threshold where review fatigue erodes vigilance).
