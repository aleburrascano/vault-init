#!/usr/bin/env bash
# Permanently delete a vault: local directory, GitHub repo, and MCP registration.
#
# Usage: vaultkit destroy <vault-name>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/_helpers.sh"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: vaultkit destroy <vault-name>

Permanently delete a vault: local directory, GitHub repo (only if you own it),
and MCP registration. Verifies admin permissions before attempting the
GitHub deletion. Collaborators get a local-only cleanup (effectively a disconnect).
EOF
  exit 0
fi

if [ $# -eq 0 ]; then
  echo "Usage: vaultkit destroy <vault-name>"
  exit 1
fi

VAULT_NAME="$1"
vk_validate_vault_name "$VAULT_NAME" || exit 1

# Require the vault to be in the MCP registry — never fall back to a filesystem
# guess for destructive operations. If the user has an orphaned directory at
# the default location, they must `vaultkit connect` it first or `rm` manually.
VAULT_DIR=$(vk_resolve_vault_dir "$VAULT_NAME") || {
  vk_error "'$VAULT_NAME' is not a registered vaultkit vault."
  echo "Run 'vaultkit status' to see what's registered." >&2
  echo "If you have an orphaned directory, remove it manually." >&2
  exit 1
}

VAULT_DIR_POSIX=$(vk_to_posix "$VAULT_DIR")

# Refuse to destroy anything that doesn't look like an Obsidian vault.
if [ -d "$VAULT_DIR_POSIX" ] && ! vk_is_vault_like "$VAULT_DIR_POSIX"; then
  vk_error "$VAULT_DIR does not look like an Obsidian vault — aborting."
  exit 1
fi

# Resolve the GitHub repo from the vault's git remote (most reliable).
# Falls back to "$GITHUB_USER/$VAULT_NAME" only if remote can't be parsed.
GITHUB_USER=$(gh api user --jq '.login' 2>/dev/null || true)
REMOTE_URL=""
if [ -d "$VAULT_DIR_POSIX/.git" ]; then
  REMOTE_URL=$(git -C "$VAULT_DIR_POSIX" remote get-url origin 2>/dev/null || true)
fi
REPO_SLUG=""
if [ -n "$REMOTE_URL" ]; then
  REPO_SLUG=$(echo "$REMOTE_URL" | sed -E 's|.*github\.com[:/]([^/]+/[^/.]+)(\.git)?/?$|\1|')
fi
if [ -z "$REPO_SLUG" ] && [ -n "$GITHUB_USER" ]; then
  REPO_SLUG="$GITHUB_USER/$VAULT_NAME"
fi

# Verify ownership before promising deletion. A collaborator running destroy
# on someone else's vault would silently fail at the GitHub step otherwise.
REPO_DELETABLE=false
REPO_OWNER_NOTE=""
if [ -n "$REPO_SLUG" ]; then
  if gh repo view "$REPO_SLUG" >/dev/null 2>&1; then
    IS_ADMIN=$(gh api "repos/$REPO_SLUG" --jq '.permissions.admin' 2>/dev/null || echo "false")
    if [ "$IS_ADMIN" = "true" ]; then
      REPO_DELETABLE=true
    else
      REPO_OWNER_NOTE="(you don't own this repo — only local + MCP will be removed; this is effectively 'disconnect')"
    fi
  else
    REPO_OWNER_NOTE="(repo not found or not accessible — skipping GitHub step)"
  fi
fi

# Request delete_repo scope only if we actually intend to delete a repo.
if $REPO_DELETABLE; then
  if ! gh auth status 2>&1 | grep -q 'delete_repo'; then
    echo "Requesting delete_repo permission from GitHub..."
    gh auth refresh -h github.com -s delete_repo
  fi
fi

echo ""
echo "This will permanently delete:"
[ -d "$VAULT_DIR_POSIX" ] && echo "  Local:  $VAULT_DIR" \
                          || echo "  Local:  $VAULT_DIR (not found — will skip)"
if $REPO_DELETABLE; then
  echo "  GitHub: https://github.com/$REPO_SLUG"
elif [ -n "$REPO_OWNER_NOTE" ]; then
  echo "  GitHub: $REPO_SLUG  $REPO_OWNER_NOTE"
else
  echo "  GitHub: (not authenticated — will skip)"
fi
echo "  MCP:    $VAULT_NAME server registration"
echo ""
read -r -p "Type the vault name to confirm deletion: " CONFIRM
if [ "$CONFIRM" != "$VAULT_NAME" ]; then
  echo "Aborted."
  exit 0
fi
echo ""

# Track step outcomes so the final summary reflects reality.
GH_STATUS="skipped"
MCP_STATUS="skipped"
LOCAL_STATUS="skipped"

if $REPO_DELETABLE; then
  echo "Deleting GitHub repo..."
  if gh repo delete "$REPO_SLUG" --yes; then
    GH_STATUS="deleted"
  else
    GH_STATUS="failed"
    vk_warning "GitHub repo deletion failed — continuing with local + MCP cleanup."
  fi
fi

if command -v claude >/dev/null 2>&1; then
  echo "Removing MCP server..."
  if claude mcp remove "$VAULT_NAME" --scope user 2>/dev/null; then
    MCP_STATUS="removed"
  else
    MCP_STATUS="not-registered"
    echo "  (not registered — skipping)"
  fi
else
  vk_warning "Claude Code not found — MCP cleanup skipped."
  echo "  If registered, run: claude mcp remove $VAULT_NAME --scope user" >&2
fi

if [ -d "$VAULT_DIR_POSIX" ]; then
  echo "Deleting local vault..."
  rm -rf "$VAULT_DIR_POSIX"
  LOCAL_STATUS="deleted"
else
  echo "Local directory not found — skipping."
fi

echo ""
echo "Summary:"
echo "  GitHub: $GH_STATUS"
echo "  MCP:    $MCP_STATUS"
echo "  Local:  $LOCAL_STATUS"
