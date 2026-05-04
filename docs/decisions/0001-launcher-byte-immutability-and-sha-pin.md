# ADR-0001: Launcher template byte-immutability and SHA-256 pinning

**Status**: Accepted
**Date**: pre-2.0 (canonical since vaultkit's first published release)
**Related rules**: [.claude/rules/architecture.md](../../.claude/rules/architecture.md), [.claude/rules/security-invariants.md](../../.claude/rules/security-invariants.md)

## Context

Each vault on disk contains a small JavaScript file `.mcp-start.js` (the **launcher**) that Claude Code spawns whenever the user opens a session. The launcher reads the vault's `vault.json`, loads its CLAUDE.md, and exposes the vault's content to Claude as an MCP server. Anyone with write access to the launcher could redirect a session to a different vault, leak file contents, or run arbitrary code under the user's account.

vaultkit ships a single source-of-truth template for this file: [lib/mcp-start.js.tmpl](../../lib/mcp-start.js.tmpl). Every `vaultkit init`, `vaultkit connect`, and `vaultkit update` `copyFileSync`s those bytes into the vault and registers a `--expected-sha256=<hex>` in `~/.claude.json` so the launcher can self-verify on every Claude Code session start.

The forces:

- The launcher must stay simple and predictable so its SHA is meaningful — anything that varies per-vault (vault name interpolation, dates) would mean a different SHA per vault and defeat the verification.
- Existing vaults in the wild already pin a specific SHA in their registry entries. Any change to the template's bytes would invalidate every existing pin and require every user to re-run `vaultkit update`.
- TypeScript would be a natural language for the launcher (vaultkit itself is TS), but a TS source + post-build compile would change the bytes between releases as the TS toolchain evolves.

## Decision

The launcher template is a **byte-immutable** raw JavaScript file at [lib/mcp-start.js.tmpl](../../lib/mcp-start.js.tmpl). It is never preprocessed, transpiled, or interpolated. `vaultkit init`, `vaultkit connect`, and `vaultkit update` `copyFileSync` it into each vault verbatim. The MCP registration includes `--expected-sha256=<hex>` where the hex is the runtime hash of the on-disk launcher; the launcher's first action on every Claude Code session is to re-hash itself and refuse to start on mismatch. The argv shape for that registration is centralized in `runMcpAdd` ([src/lib/mcp.ts](../../src/lib/mcp.ts)) so no command bypasses it.

## Consequences

**Easier:**
- Tampering with the launcher is detected immediately (next session). The user gets a clear `Launcher SHA-256 mismatch` error pointing them at `vaultkit update`.
- The decision boundary is clear: anything that needs to vary per-vault belongs in `vault.json` or CLAUDE.md, not the launcher.
- The launcher's behavior stays auditable in seconds — it's ~50 lines of plain JS.

**Harder:**
- Improving the launcher (e.g. adding a feature, fixing a typo) is a release-coordination event. The template SHA changes, every existing vault's pin becomes stale, and users see the mismatch error until they run `vaultkit update`. We treat any change to `mcp-start.js.tmpl` as a breaking change in CHANGELOG.
- The launcher cannot use TypeScript — even an identity-pass TS toolchain emits different bytes across versions. The build script enforces this by `copyFileSync`-ing the raw template into `dist/lib/`.

**Trade-offs accepted:**
- Trust boundary is the user's home directory: an attacker who can write to both the launcher AND `~/.claude.json` wins by construction (they update both the bytes and the pin). vaultkit does not defend against `~/.claude.json` tampering — see security-invariants.md threat model.
- We do NOT compare a cloned vault's launcher against the canonical template SHA at `connect` time. Older vaultkit releases ship different template SHAs, so cross-version vaults would always mismatch; the trust decision at `connect` is "do you trust this repo's author?" — vaultkit surfaces the launcher path + SHA so the user can `cat` it before confirming, but the call is the user's, not vaultkit's.

## Alternatives considered

- **Sign the launcher with a vaultkit publisher key.** Rejected: requires a key infrastructure vaultkit doesn't have, and fundamentally just shifts the trust root from "the user's home directory" to "wherever the verifying public key is stored" — same threat model, more moving parts.
- **Embed the launcher inline in `init.ts` / `update.ts`.** Rejected: drift between the two would silently produce vaults with different SHAs depending on which command created them, breaking the pin invariant.
- **Per-vault launcher with vault-name interpolation at scaffold time.** Rejected: every vault would have a unique SHA, so the registry pin becomes per-vault content rather than a verifiable reference — the verification reduces to "this file equals itself," providing no integrity guarantee.
