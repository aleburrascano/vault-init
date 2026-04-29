---
paths:
  - "vault-*.sh"
---

# Shell Script Conventions for vault-*.sh

Every vault-*.sh must follow these patterns or you will break Windows support, security invariants, or consistency.

## Required header

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/_helpers.sh"
```

## Argument validation

Use the shared helper — it covers regex, length, and the `owner/repo` rejection:

```bash
VAULT_NAME="$1"
vk_validate_vault_name "$VAULT_NAME" || exit 1
```

## Reading ~/.claude.json

Use the helpers, not raw inline node:

```bash
# Resolve the vault directory from the MCP registry. Exits non-zero if not registered.
VAULT_DIR=$(vk_resolve_vault_dir "$VAULT_NAME") || {
  vk_error "'$VAULT_NAME' is not a registered vaultkit vault."
  exit 1
}
```

For ad-hoc reads, `vk_claude_json` echoes the platform-correct path:

```bash
CLAUDE_JSON=$(vk_claude_json)
node -e "..." "$CLAUDE_JSON"
```

## Windows path conversion

Use the helpers — they no-op when cygpath is unavailable, so writing them is always safe:

```bash
VAULT_DIR_POSIX=$(vk_to_posix "$VAULT_DIR")    # for bash file ops
WIN_PATH=$(vk_to_windows "$VAULT_DIR_POSIX")    # for native tools (node.exe, gh.exe, claude)
```

Don't call `cygpath` directly — wrap it via the helper so behavior stays consistent.

## Vault structure check before destructive ops

Always sanity-check paths before `rm -rf`:

```bash
if [ -d "$VAULT_DIR_POSIX" ] && ! vk_is_vault_like "$VAULT_DIR_POSIX"; then
  vk_error "$VAULT_DIR does not look like a vaultkit vault — refusing to delete."
  exit 1
fi
```

## SHA-256 hashing

```bash
HASH=$(vk_sha256 "$VAULT_DIR/.mcp-start.js")
```

## MCP registration must pin the hash

Every `claude mcp add` for a vaultkit vault must include `--expected-sha256=<hash>` so the launcher can self-verify on each Claude Code session start:

```bash
claude mcp add --scope user "$VAULT_NAME" -- node "$WIN_PATH/.mcp-start.js" "--expected-sha256=$HASH"
```

## Error messaging

Three prefixes — pick the right one:

```bash
vk_error   "fatal — exits expected"        # >&2, callers should exit
vk_warning "non-fatal but user should care" # >&2
vk_note    "informational only"             # stdout
```

## gh / claude binary resolution

Don't assume these are on PATH. The probe pattern in `bin/vaultkit.js` (Windows tool discovery) and `vault-init.sh` `_win_find_gh` shows the bash equivalent. Once located via the probe, regular `command -v gh` works for the rest of the script.

## .mcp-start.js template

Never inline the launcher template. Copy it from the single source of truth:

```bash
cp "$SCRIPT_DIR/lib/mcp-start.js.tmpl" "$VAULT_DIR/.mcp-start.js"
```
