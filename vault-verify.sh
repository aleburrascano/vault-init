#!/usr/bin/env bash
# Inspect a vault's launcher state and re-pin the SHA-256 if you accept the change.
#
# Use this when:
#   - The launcher refused to start because the on-disk SHA doesn't match the pinned hash.
#   - Upstream pushed a new .mcp-start.js that the launcher refused to merge.
#
# Usage: vaultkit verify <vault-name>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/_helpers.sh"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: vaultkit verify <vault-name>

Inspect a vault's launcher (.mcp-start.js) and re-pin its SHA-256 if you accept it.

Use after the launcher refused to start (pinned hash mismatch) or refused to merge
an upstream launcher change. Shows the diff, lets you decide, then re-registers
the MCP server with the new hash.
EOF
  exit 0
fi

if [ $# -eq 0 ]; then
  echo "Usage: vaultkit verify <vault-name>"
  exit 1
fi

VAULT_NAME="$1"
vk_validate_vault_name "$VAULT_NAME" || exit 1

VAULT_DIR=$(vk_resolve_vault_dir "$VAULT_NAME") || {
  vk_error "'$VAULT_NAME' is not a registered vaultkit vault."
  echo "Run 'vaultkit status' to see what's registered." >&2
  exit 1
}
VAULT_DIR_POSIX=$(vk_to_posix "$VAULT_DIR")

if ! [ -f "$VAULT_DIR_POSIX/.mcp-start.js" ]; then
  vk_error "$VAULT_DIR_POSIX/.mcp-start.js does not exist."
  echo "  Run 'vaultkit update $VAULT_NAME' to install the launcher." >&2
  exit 1
fi

PINNED=$(vk_resolve_expected_hash "$VAULT_NAME" || echo "")
ON_DISK=$(vk_sha256 "$VAULT_DIR_POSIX/.mcp-start.js")

echo "Vault:    $VAULT_NAME"
echo "Path:     $VAULT_DIR_POSIX"
echo ""
echo "Pinned SHA-256:  ${PINNED:-(none registered)}"
echo "On-disk SHA-256: $ON_DISK"
echo ""

# Check for an upstream change too — same logic the launcher uses.
UPSTREAM_DRIFT=false
if [ -d "$VAULT_DIR_POSIX/.git" ]; then
  git -C "$VAULT_DIR_POSIX" fetch --quiet 2>/dev/null || true
  if git -C "$VAULT_DIR_POSIX" rev-parse '@{u}' >/dev/null 2>&1; then
    DIFF_FILES=$(git -C "$VAULT_DIR_POSIX" diff --name-only 'HEAD..@{u}' -- .mcp-start.js 2>/dev/null || true)
    if [ "$DIFF_FILES" = ".mcp-start.js" ]; then
      UPSTREAM_DRIFT=true
      echo "Upstream has a different .mcp-start.js — diff:"
      echo "----------------------------------------"
      git -C "$VAULT_DIR_POSIX" --no-pager diff 'HEAD..@{u}' -- .mcp-start.js || true
      echo "----------------------------------------"
      echo ""
    fi
  fi
fi

if [ -n "$PINNED" ] && [ "$PINNED" = "$ON_DISK" ] && ! $UPSTREAM_DRIFT; then
  echo "Verified — pinned hash matches on-disk and upstream."
  exit 0
fi

if $UPSTREAM_DRIFT; then
  echo "If you accept the upstream version, vaultkit will:"
  echo "  1. git pull --ff-only (applies the upstream .mcp-start.js)"
  echo "  2. Re-pin the new SHA-256 in your MCP registration"
  echo ""
  read -r -p "Pull upstream and re-pin? [y/N] " _CONFIRM
  if ! [[ "${_CONFIRM:-}" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
  if ! git -C "$VAULT_DIR_POSIX" pull --ff-only --quiet; then
    vk_error "git pull failed. Resolve manually and re-run vaultkit verify $VAULT_NAME."
    exit 1
  fi
  ON_DISK=$(vk_sha256 "$VAULT_DIR_POSIX/.mcp-start.js")
  echo "  Pulled. New on-disk SHA-256: $ON_DISK"
else
  echo "On-disk launcher does not match the pinned hash."
  echo "Inspect the file before trusting it:"
  echo "  cat \"$VAULT_DIR_POSIX/.mcp-start.js\""
  echo ""
  read -r -p "Re-pin the on-disk SHA-256 ($ON_DISK)? [y/N] " _CONFIRM
  if ! [[ "${_CONFIRM:-}" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

if ! command -v claude >/dev/null 2>&1; then
  vk_warning "Claude Code not found — re-pin manually:"
  MCP_VAULT_PATH=$(vk_to_windows "$VAULT_DIR_POSIX")
  echo "  claude mcp remove $VAULT_NAME --scope user" >&2
  echo "  claude mcp add --scope user $VAULT_NAME -- node $MCP_VAULT_PATH/.mcp-start.js --expected-sha256=$ON_DISK" >&2
  exit 1
fi

MCP_VAULT_PATH=$(vk_to_windows "$VAULT_DIR_POSIX")
echo "Re-pinning MCP registration with SHA-256 $ON_DISK..."
claude mcp remove "$VAULT_NAME" --scope user >/dev/null 2>&1 || true
claude mcp add --scope user "$VAULT_NAME" -- node "$MCP_VAULT_PATH/.mcp-start.js" "--expected-sha256=$ON_DISK"

echo ""
echo "Done. Restart Claude Code to apply the new pin."
