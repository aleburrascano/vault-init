#!/usr/bin/env bash
# Remove a connected vault locally and from MCP — does NOT delete the GitHub repo.
#
# Usage: vaultkit disconnect <vault-name>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/_helpers.sh"

if [ $# -eq 0 ]; then
  echo "Usage: vaultkit disconnect <vault-name>"
  exit 1
fi

VAULT_NAME="$1"
vk_validate_vault_name "$VAULT_NAME" || exit 1

# Require the vault to be in the MCP registry — no CWD fallback (too dangerous)
VAULT_DIR=$(vk_resolve_vault_dir "$VAULT_NAME") || {
  vk_error "'$VAULT_NAME' is not a registered vaultkit vault."
  echo "Run 'vaultkit list' to see what's registered." >&2
  exit 1
}

VAULT_DIR_POSIX=$(vk_to_posix "$VAULT_DIR")

# Sanity-check before destructive operation: registry entry could in theory
# point at any directory.
if [ -d "$VAULT_DIR_POSIX" ] && ! vk_is_vault_like "$VAULT_DIR_POSIX"; then
  vk_error "$VAULT_DIR does not look like a vaultkit vault — refusing to delete."
  echo "  If this is correct, remove the directory manually." >&2
  exit 1
fi

echo ""
echo "This will remove:"
[ -d "$VAULT_DIR_POSIX" ] && echo "  Local: $VAULT_DIR" \
                          || echo "  Local: $VAULT_DIR (not found — will skip)"
echo "  MCP:   $VAULT_NAME server registration"
echo ""
echo "The GitHub repo will NOT be deleted."
echo ""
read -r -p "Type the vault name to confirm: " CONFIRM
if [ "$CONFIRM" != "$VAULT_NAME" ]; then
  echo "Aborted."
  exit 0
fi
echo ""

if command -v claude >/dev/null 2>&1; then
  echo "Removing MCP server..."
  claude mcp remove "$VAULT_NAME" --scope user 2>/dev/null \
    && true || echo "  (not registered — skipping)"
else
  vk_warning "Claude Code not found — MCP cleanup skipped."
  echo "  If registered, run: claude mcp remove $VAULT_NAME --scope user" >&2
fi

if [ -d "$VAULT_DIR_POSIX" ]; then
  echo "Deleting local vault..."
  rm -rf "$VAULT_DIR_POSIX"
else
  echo "Local directory not found — skipping."
fi

echo ""
echo "Done. $VAULT_NAME disconnected."
echo "Reconnect anytime with: vaultkit connect <owner/$VAULT_NAME>"
