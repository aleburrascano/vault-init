#!/usr/bin/env bash
# Clone an existing vaultkit vault from GitHub and register it as an MCP server.
#
# Usage: vaultkit connect <owner/repo>
#        vaultkit connect https://github.com/owner/repo
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: vaultkit connect <owner/repo>"
  echo "       vaultkit connect https://github.com/owner/repo"
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
VAULTS_ROOT="${VAULTKIT_HOME:-$HOME/vaults}"
VAULT_DIR="$VAULTS_ROOT/$VAULT_NAME"
mkdir -p "$VAULTS_ROOT"

[ -d "$VAULT_DIR" ] && { echo "Error: $VAULT_DIR already exists."; exit 1; }

# Check if MCP name already registered
if command -v cygpath >/dev/null 2>&1; then
  CLAUDE_JSON=$(cygpath -m "$HOME/.claude.json")
else
  CLAUDE_JSON="$HOME/.claude.json"
fi

ALREADY_REGISTERED=$(node -e "
const fs = require('fs');
const file = process.argv[1];
const name = process.argv[2];
if (!fs.existsSync(file)) { console.log('no'); process.exit(0); }
let config;
try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { console.log('no'); process.exit(0); }
console.log((config.mcpServers || {})[name] ? 'yes' : 'no');
" "$CLAUDE_JSON" "$VAULT_NAME" 2>/dev/null) || ALREADY_REGISTERED="no"

if [ "$ALREADY_REGISTERED" = "yes" ]; then
  echo "Error: an MCP server named '$VAULT_NAME' is already registered."
  echo "Run 'vaultkit list' to see what's registered, or 'vaultkit disconnect $VAULT_NAME' first."
  exit 1
fi

# gh handles auth for private repos; fall back to plain git for public
if command -v gh >/dev/null 2>&1; then
  echo "Cloning $REPO into $VAULT_DIR..."
  gh repo clone "$REPO" "$VAULT_DIR"
else
  echo "Cloning $REPO into $VAULT_DIR (gh not found — private repos require credentials)..."
  git clone "https://github.com/$REPO.git" "$VAULT_DIR"
fi

if ! [ -f "$VAULT_DIR/.mcp-start.js" ]; then
  echo ""
  echo "Warning: $VAULT_NAME is missing .mcp-start.js — it may have been created"
  echo "  with an older version. MCP registration skipped."
  echo "  Ask the owner to run 'vaultkit update $VAULT_NAME' and push, then reconnect."
  exit 0
fi

# Show hash so the user can verify the script before trusting it
MCP_HASH=$(node -e "
const crypto = require('crypto');
const fs = require('fs');
console.log(crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'));
" "$VAULT_DIR/.mcp-start.js")

echo ""
echo "This vault's .mcp-start.js will run with your full user permissions on every"
echo "Claude Code session start. Only connect vaults from authors you trust."
echo ""
echo "  File:    $VAULT_DIR/.mcp-start.js"
echo "  SHA-256: $MCP_HASH"
echo ""
read -r -p "Register as MCP server? [y/N] " _CONFIRM
if ! [[ "${_CONFIRM:-}" =~ ^[Yy]$ ]]; then
  echo ""
  echo "MCP registration skipped. Vault cloned to: $VAULT_DIR"
  echo "To register later, re-run: vaultkit connect $REPO"
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
echo "  Vault: $MCP_VAULT_PATH"
