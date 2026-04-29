# VaultKit

CLI that connects Claude Code to Obsidian vaults via MCP. No build step. Zero npm dependencies.

## Commands
test:  npm test
build: (none — published files)
lint:  npm run lint

## Architecture

**Dispatch flow**: `vaultkit <cmd>` → `bin/vaultkit.js` (COMMANDS lookup) → `vault-<cmd>.sh` (bash, cwd = package root)

**State**: `~/.claude.json` — the `mcpServers` object is the vault registry. Scripts read it via shared helpers in `lib/_helpers.sh`.

**Launcher template**: `lib/mcp-start.js.tmpl` is the single source of truth for the per-vault `.mcp-start.js`. `vault-init.sh` and `vault-update.sh` `cp` it into vaults — never duplicate the template inline.

**Windows**: every script uses `vk_to_posix` / `vk_to_windows` helpers; `vault-init.sh` and `bin/vaultkit.js` probe known install paths for `gh`/`claude`. Never assume tools are on PATH.

## Command → Script Map

| Command      | Script              |
|-------------|---------------------|
| init         | vault-init.sh       |
| connect      | vault-connect.sh    |
| disconnect   | vault-disconnect.sh |
| destroy      | vault-destroy.sh    |
| list         | vault-list.sh       |
| pull         | vault-pull.sh       |
| update       | vault-update.sh     |
| doctor       | vault-doctor.sh     |

To add a command: see `/add-command`.

## Shared library — `lib/`

| File | Purpose |
|---|---|
| `lib/_helpers.sh` | Bash functions sourced by every `vault-*.sh`: `vk_resolve_vault_dir`, `vk_resolve_expected_hash`, `vk_is_vault_like`, `vk_to_posix`, `vk_to_windows`, `vk_claude_json`, `vk_sha256`, `vk_validate_vault_name`, `vk_error/warning/note`. |
| `lib/mcp-start.js.tmpl` | Single source of truth for `.mcp-start.js`. Implements the launcher self-verification (pinned SHA-256 check + refuse-to-merge on upstream launcher change). |

Both are listed in `package.json#files` and ship with the npm package.

## Local Development — No npm Publish Loop

```bash
# One-time: point the global `vaultkit` binary at this directory
npm link

# Now every file edit is live — no reinstall
vaultkit <command>

# Undo when done
npm unlink -g @aleburrascano/vaultkit
```

## Adding a New Command (summary — use `/add-command` for guided scaffold)

1. Create `vault-<name>.sh` at repo root. Required header:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
   . "$SCRIPT_DIR/lib/_helpers.sh"
   ```
2. Add a row to the `COMMANDS` map in `bin/vaultkit.js` (string key → script filename).
3. Add `"vault-<name>.sh"` to the `files` array in `package.json`.
4. Add a row to the `HELP` text in `bin/vaultkit.js` and to `README.md`.

## Security Invariants — Never Break These

- **Vault names** must match `^[a-zA-Z0-9_-]+$`, max 64 chars. Use `vk_validate_vault_name`.
- **Vault paths** for destructive ops must come from the MCP registry (`vk_resolve_vault_dir`), never raw user input or filesystem fallbacks. `connect`/`init` are the only commands allowed to create new entries.
- **MCP registration** must include `--expected-sha256=<hash>` so the launcher can self-verify on every Claude Code session.
- **`gh repo delete`** must be preceded by an explicit ownership check (`gh api repos/.../permissions.admin`) and a typed-name confirmation.
- **`.obsidian/` or `CLAUDE.md` + `raw/` + `wiki/`** must be present before any `rm -rf` (use `vk_is_vault_like`).
- **`delete_repo` scope** must be requested only when actually about to delete (skip the prompt for collaborators who can't delete anyway).

## Hard Invariants

- No npm dependencies — Node.js built-ins + shell utilities only.
- No build step — repo files are published files. `lib/` ships verbatim.
- Windows compatibility is mandatory — test `cygpath` branches via the helpers.
- Never duplicate the `.mcp-start.js` template — `cp` it from `lib/mcp-start.js.tmpl`.

## Standing Workflows
- Bug fix: write a failing test that reproduces the bug first. Show it fail. Fix it. Show it pass. Run full suite.
- Feature: run full test suite before and after.
- Refactor: confirm all tests pass before touching anything; confirm they still pass after.

## Known Hallucination Patterns
@.claude/rules/hallucination-patterns.md
