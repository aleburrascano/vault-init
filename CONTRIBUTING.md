# Contributing to vaultkit

Thanks for your interest. vaultkit is intentionally small — a Node.js dispatcher (`bin/vaultkit.js`) plus a set of bash scripts (`vault-*.sh`) — with **zero npm dependencies** and **no build step**. Repo files are published files. Keep contributions in that spirit.

## Local setup

```bash
git clone https://github.com/aleburrascano/vaultkit
cd vaultkit
npm link            # makes the `vaultkit` binary point at this checkout
vaultkit doctor     # sanity check
```

When you're done:

```bash
npm unlink -g @aleburrascano/vaultkit
```

Edits to any `.sh` or `bin/vaultkit.js` are live immediately — no reinstall.

## Repo layout

```
bin/vaultkit.js        Node.js dispatcher — routes vaultkit <cmd> to vault-<cmd>.sh
vault-*.sh             One bash script per command
lib/_helpers.sh        Shared bash functions — every vault-*.sh sources this
lib/mcp-start.js.tmpl  Single source of truth for the per-vault MCP launcher
.claude/commands/      Claude Code slash commands for development workflows
CLAUDE.md              Internal architecture notes (security invariants, command map)
```

Read [CLAUDE.md](./CLAUDE.md) before changing anything — it documents the security invariants and Windows-compatibility patterns that every script must follow.

## Adding a new command

The repo ships a `/add-command` slash command for Claude Code that scaffolds the boilerplate. Manually:

1. Create `vault-<name>.sh` at the repo root. Source `lib/_helpers.sh` near the top:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
   . "$SCRIPT_DIR/lib/_helpers.sh"
   ```
2. Add a row to the `COMMANDS` map in `bin/vaultkit.js`.
3. Add `"vault-<name>.sh"` to the `files` array in `package.json`.
4. Add a row to the help text in both `bin/vaultkit.js` and `README.md`.

## Security invariants

These are non-negotiable. Every PR is checked against them:

- **Vault names** must match `^[a-zA-Z0-9_-]+$` and be ≤64 chars. Use `vk_validate_vault_name` from `lib/_helpers.sh`.
- **Vault paths** for destructive operations must come from the MCP registry (`vk_resolve_vault_dir`), never from raw user input or filesystem fallbacks.
- **MCP registration** must include `--expected-sha256=<hash>` so the launcher can self-verify on every session start.
- **`gh repo delete`** must be preceded by an explicit ownership check (`gh api repos/.../permissions.admin`) and a typed-name confirmation.
- **`.obsidian/` or `CLAUDE.md` + `raw/` + `wiki/`** must be present before any `rm -rf` (use `vk_is_vault_like`).

## Windows compatibility

Every script must work in Git Bash on Windows. Specifically:

- Path conversion: use `vk_to_posix` and `vk_to_windows`. Don't hardcode `cygpath` calls.
- `gh` and `claude` may be installed but not visible to a running shell because Windows PATH changes on install don't reach already-running processes. `vault-init.sh` and `bin/vaultkit.js` show the probe pattern — never assume tools are on PATH.
- Test your changes by running them in Git Bash on Windows if you can. If you can't, mention that in the PR.

## Running checks

The same checks that run in CI:

```bash
shellcheck -x vault-*.sh install.sh        # bash linter
node --check bin/vaultkit.js                # JS syntax check
node --check lib/mcp-start.js.tmpl          # launcher syntax check
npm publish --dry-run                       # verify the package contents
```

## Pull requests

- Keep changes focused. One logical change per PR.
- Update `CHANGELOG.md` under `## [Unreleased]` with what you changed and why.
- Don't add npm dependencies. Use Node.js built-ins (inline `node -e` is fine) or shell utilities only.
- Don't add a build step.
- The PR will run CI automatically — make sure shellcheck, syntax checks, and the publish dry-run pass.

## Reporting bugs

Open an issue at <https://github.com/aleburrascano/vaultkit/issues>. Include:

- `vaultkit doctor` output (redact any private vault names if needed).
- Your platform (`uname -a` on macOS/Linux, `ver` on Windows).
- The exact command that failed and any error output.

## Reporting security issues

See [SECURITY.md](./SECURITY.md) — please do not file public issues for security vulnerabilities.
