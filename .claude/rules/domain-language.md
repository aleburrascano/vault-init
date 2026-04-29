# Domain Language

- **vault** = a local Obsidian directory containing `.obsidian/`, `CLAUDE.md`, `raw/`, and `wiki/` subdirectories, registered in `~/.claude.json` for Claude Code MCP access.
- **vault name** = user-chosen identifier matching `^[a-zA-Z0-9_-]+$`, max 64 chars; used as the key in the MCP registry.
- **vault dir** = the full filesystem path to a vault on disk; always resolved via the MCP registry, never from user input.
- **MCP registry** = the `mcpServers` object in `~/.claude.json`, where each vault is registered with its path and expected SHA-256 hash.
- **launcher** = `.mcp-start.js` in each vault root; sources the `lib/mcp-start.js.tmpl` template, pinned to a SHA-256 hash for self-verification.
- **GitHub Pages** = static site hosting integrated via `vault-visibility.sh` and deploy templates for publishing `raw/` and `wiki/` branches.
- **dispatch** = the flow `vaultkit <cmd>` → `bin/vaultkit.js` (COMMANDS lookup) → `vault-<cmd>.sh` script.
- **script** = a `vault-*.sh` bash file that implements a single command; always sources `lib/_helpers.sh`.
- **helper** = a shared bash function in `lib/_helpers.sh` used by all scripts (e.g., `vk_resolve_vault_dir`, `vk_to_posix`).

Run `/common-ground` at the start of each session to surface assumptions about this domain.
