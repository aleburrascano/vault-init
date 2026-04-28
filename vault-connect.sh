#!/usr/bin/env bash
# Clone an existing vault-init vault from GitHub and register it as an MCP server.
#
# Usage: vault-connect <owner/repo>
#        vault-connect https://github.com/owner/repo
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: vault-connect <owner/repo>"
  echo "       vault-connect https://github.com/owner/repo"
  exit 1
fi

INPUT="$1"

# Normalize input to owner/repo
if [[ "$INPUT" =~ ^https://github\.com/([^/]+/[^/.]+)(\.git)?(/.*)?$ ]]; then
  REPO="${BASH_REMATCH[1]}"
elif [[ "$INPUT" =~ ^git@github\.com:([^/]+/[^/.]+)(\.git)?$ ]]; then
  REPO="${BASH_REMATCH[1]}"
elif [[ "$INPUT" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  REPO="$INPUT"
else
  echo "Error: unrecognized format. Use owner/repo or a GitHub URL."
  exit 1
fi

VAULT_NAME=$(basename "$REPO")
VAULT_DIR="${VAULT_INIT_CWD:-$(pwd)}/$VAULT_NAME"

[ -d "$VAULT_DIR" ] && { echo "Error: $VAULT_DIR already exists."; exit 1; }

# gh handles auth for private repos; fall back to plain git for public
if command -v gh >/dev/null 2>&1; then
  echo "Cloning $REPO..."
  gh repo clone "$REPO" "$VAULT_DIR"
else
  echo "Cloning $REPO (gh not found, using git — private repos require credentials)..."
  git clone "https://github.com/$REPO.git" "$VAULT_DIR"
fi

if ! [ -f "$VAULT_DIR/.mcp-start.js" ]; then
  echo ""
  echo "Warning: $VAULT_NAME is missing .mcp-start.js — it may have been created"
  echo "  with an older version of vault-init. MCP registration skipped."
  echo "  Ask the owner to upgrade and re-push, then re-run vault-connect."
  exit 0
fi

if command -v cygpath >/dev/null 2>&1; then
  MCP_VAULT_PATH=$(cygpath -m "$VAULT_DIR")
else
  MCP_VAULT_PATH="$VAULT_DIR"
fi

if ! command -v claude >/dev/null 2>&1; then
  echo ""
  echo "Claude Code not found. Once installed, run:"
  echo "  claude mcp add --scope user $VAULT_NAME -- node $MCP_VAULT_PATH/.mcp-start.js"
  exit 0
fi

echo "Registering MCP server: $VAULT_NAME"
claude mcp add --scope user "$VAULT_NAME" -- node "$MCP_VAULT_PATH/.mcp-start.js"

echo ""
echo "Done. $VAULT_NAME is now available in Claude Code."
echo "  Vault: $VAULT_DIR"
