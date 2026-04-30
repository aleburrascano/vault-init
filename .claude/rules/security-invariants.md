---
paths:
  - "src/commands/destroy.ts"
  - "src/commands/disconnect.ts"
  - "src/commands/connect.ts"
  - "src/commands/init.ts"
  - "src/lib/registry.ts"
  - "src/lib/vault.ts"
  - "src/lib/github.ts"
---

# Security Invariants — Never Break These

- **Vault names** must match `^[a-zA-Z0-9_-]+$`, max 64 chars. Use `validateName` from [src/lib/vault.ts](../../src/lib/vault.ts) (also enforced by `Vault.tryFromName`).
- **Vault paths** for destructive ops must come from the MCP registry (`getVaultDir` from [src/lib/registry.ts](../../src/lib/registry.ts), or `Vault.tryFromName` which calls it), never raw user input or filesystem fallbacks. `connect`/`init` are the only commands allowed to create new entries.
- **MCP registration** must include `--expected-sha256=<hash>` so the launcher can self-verify on every Claude Code session.
- **`gh repo delete`** must be preceded by an explicit ownership check (`isAdmin` from [src/lib/github.ts](../../src/lib/github.ts)) and a typed-name confirmation.
- **`isVaultLike`** (or `Vault.isVaultLike()`) must be checked before any directory deletion.
- **`delete_repo` scope** must be requested only when actually about to delete (skip for collaborators who can't delete anyway).
