#!/usr/bin/env bash
# Remove a connected vault locally and from MCP — does NOT delete the GitHub repo.
#
# Usage: vaultkit disconnect <vault-name>
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: vaultkit disconnect <vault-name>"
  exit 1
fi

VAULT_NAME="$1"

if ! [[ "$VAULT_NAME" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Error: vault name must contain only letters, numbers, hyphens, and underscores."
  exit 1
fi

VAULT_DIR="${VAULT_INIT_CWD:-$(pwd)}/$VAULT_NAME"

if [ -d "$VAULT_DIR" ]; then
  if ! [ -d "$VAULT_DIR/.obsidian" ] && \
     ! { [ -f "$VAULT_DIR/CLAUDE.md" ] && [ -d "$VAULT_DIR/raw" ] && [ -d "$VAULT_DIR/wiki" ]; }; then
    echo "Error: $VAULT_DIR does not look like a vaultkit vault — aborting."
    exit 1
  fi
fi

echo ""
echo "This will remove:"
[ -d "$VAULT_DIR" ]  && echo "  Local: $VAULT_DIR" \
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

# Remove MCP registration
if command -v claude >/dev/null 2>&1; then
  echo "Removing MCP server..."
  claude mcp remove "$VAULT_NAME" --scope user 2>/dev/null \
    && true || echo "  (not registered — skipping)"
else
  echo "Claude Code not found — MCP cleanup skipped."
  echo "  If registered, run: claude mcp remove $VAULT_NAME --scope user"
fi

# Delete local directory
if [ -d "$VAULT_DIR" ]; then
  echo "Deleting local vault..."
  rm -rf "$VAULT_DIR"
else
  echo "Local directory not found — skipping."
fi

echo ""
echo "Done. $VAULT_NAME disconnected."
echo "The GitHub repo is still available — reconnect anytime with:"
echo "  vaultkit connect <owner/$VAULT_NAME>"
