#!/usr/bin/env bash
# Clone an existing vaultkit vault from GitHub and register it as an MCP server.
#
# Usage: vaultkit connect <owner/repo>
#        vaultkit connect https://github.com/owner/repo
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/_helpers.sh"

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
  vk_error "unrecognized format. Use owner/repo or a GitHub URL."
  exit 1
fi

VAULT_NAME=$(basename "$REPO")
vk_validate_vault_name "$VAULT_NAME" || exit 1

VAULTS_ROOT="${VAULTKIT_HOME:-$HOME/vaults}"
VAULT_DIR="$VAULTS_ROOT/$VAULT_NAME"
mkdir -p "$VAULTS_ROOT"

[ -d "$VAULT_DIR" ] && { vk_error "$VAULT_DIR already exists."; exit 1; }

# Reject if MCP name already registered
if vk_resolve_vault_dir "$VAULT_NAME" >/dev/null; then
  vk_error "an MCP server named '$VAULT_NAME' is already registered."
  echo "Run 'vaultkit list' to see what's registered, or 'vaultkit disconnect $VAULT_NAME' first." >&2
  exit 1
fi

# Transactional rollback — if anything below fails, undo the clone.
CLONED=false
cleanup() {
  local code=$?
  [ $code -eq 0 ] && return
  if $CLONED && [ -d "$VAULT_DIR" ]; then
    echo "" >&2
    echo "Connect failed — removing partial clone at $VAULT_DIR" >&2
    rm -rf "$VAULT_DIR"
  fi
}
trap cleanup EXIT

# gh handles auth for private repos; fall back to plain git for public
if command -v gh >/dev/null 2>&1; then
  echo "Cloning $REPO into $VAULT_DIR..."
  if ! gh repo clone "$REPO" "$VAULT_DIR" 2>&1; then
    echo ""
    vk_error "Could not clone '$REPO'."
    echo "  If the repo is private, check access: gh auth status" >&2
    exit 1
  fi
else
  vk_warning "GitHub CLI (gh) not installed — private repos will not be accessible."
  echo "  Install gh for full functionality: https://cli.github.com" >&2
  echo ""
  echo "Cloning $REPO into $VAULT_DIR..."
  if ! git clone "https://github.com/$REPO.git" "$VAULT_DIR" 2>&1; then
    echo ""
    vk_error "Could not clone '$REPO'."
    echo "  If it's a private repo, install gh and authenticate: gh auth login" >&2
    exit 1
  fi
fi
CLONED=true

# Validate this is actually a vaultkit vault — not just any repo with .mcp-start.js
if ! [ -f "$VAULT_DIR/.mcp-start.js" ]; then
  echo ""
  vk_warning "$VAULT_NAME is missing .mcp-start.js — it may have been created"
  echo "  with an older version. MCP registration skipped." >&2
  echo "  Ask the owner to run 'vaultkit update $VAULT_NAME' and push, then reconnect." >&2
  CLONED=false  # don't roll back; vault is cloned, just not registered
  exit 0
fi
if ! vk_is_vault_like "$VAULT_DIR"; then
  echo ""
  vk_error "$VAULT_DIR is missing the standard vault layout (.obsidian/ or CLAUDE.md+raw/+wiki/)."
  echo "  This does not appear to be a vaultkit vault." >&2
  exit 1
fi

# Show hash so the user can verify the script before trusting it
MCP_HASH=$(vk_sha256 "$VAULT_DIR/.mcp-start.js")

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
  CLONED=false  # don't roll back; user opted out
  exit 0
fi

MCP_VAULT_PATH=$(vk_to_windows "$VAULT_DIR")

if ! command -v claude >/dev/null 2>&1; then
  echo ""
  echo "Claude Code not found. Once installed, run:"
  echo "  claude mcp add --scope user $VAULT_NAME -- node $MCP_VAULT_PATH/.mcp-start.js --expected-sha256=$MCP_HASH"
  CLONED=false  # cloned successfully; user does manual MCP add
  exit 0
fi

echo "Registering MCP server: $VAULT_NAME"
claude mcp add --scope user "$VAULT_NAME" -- node "$MCP_VAULT_PATH/.mcp-start.js" "--expected-sha256=$MCP_HASH"
CLONED=false  # success — disable rollback

echo ""
echo "Done. $VAULT_NAME is now available in Claude Code."
echo "  Vault: $MCP_VAULT_PATH"
