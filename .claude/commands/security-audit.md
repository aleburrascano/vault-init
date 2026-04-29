---
name: security-audit
description: Audit vaultkit scripts for security invariants
---

Security audit for vaultkit.

Target: "$ARGUMENTS" (if empty, audit all vault-*.sh scripts).

For each script, verify:

1. **Vault name validation** — uses `vk_validate_vault_name` (or equivalent enforcing `^[a-zA-Z0-9_-]+$` and ≤64 chars).
2. **No raw path acceptance** for destructive operations — paths come from `vk_resolve_vault_dir` (MCP registry), never raw user input or filesystem fallbacks.
3. **Vault structure check** — `vk_is_vault_like` (or equivalent verifying `.obsidian/` or `CLAUDE.md+raw/+wiki/`) is called before any `rm -rf`.
4. **MCP registration pins the hash** — every `claude mcp add` includes `--expected-sha256=<hash>`. SHA-256 is shown to user + `[y/N]` prompt before registration.
5. **GitHub ownership check** — `gh repo delete` is preceded by an explicit `gh api repos/.../permissions.admin` check; `delete_repo` scope is requested only when about to delete.
6. **Transactional rollback** — `connect`/`init`/destructive flows use `trap cleanup EXIT` to undo partial work on failure.
7. **No command injection** — user input is never interpolated directly into shell commands without validation. Inline `node -e` snippets pass user values via `process.argv`, not string interpolation.
8. **Windows safety** — paths converted via `vk_to_posix` / `vk_to_windows`, not raw `cygpath`.

Report: list each check as PASS / FAIL / N/A with the specific line number for any FAIL.
