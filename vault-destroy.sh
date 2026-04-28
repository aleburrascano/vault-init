#!/usr/bin/env bash
# Permanently delete a vault: local directory, GitHub repo, and MCP registration.
#
# Usage: vault-destroy <vault-name>
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: vault-destroy <vault-name>"
  exit 1
fi

VAULT_NAME="$1"

if ! [[ "$VAULT_NAME" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Error: vault name must contain only letters, numbers, hyphens, and underscores."
  exit 1
fi

VAULT_DIR="${VAULT_INIT_CWD:-$(pwd)}/$VAULT_NAME"
GITHUB_USER=$(gh api user --jq '.login' 2>/dev/null || true)

if [ -n "$GITHUB_USER" ]; then
  if ! gh auth status 2>&1 | grep -q 'delete_repo'; then
    echo "Requesting delete_repo permission from GitHub..."
    gh auth refresh -h github.com -s delete_repo
  fi
fi

echo ""
echo "This will permanently delete:"
[ -d "$VAULT_DIR" ]  && echo "  Local:  $VAULT_DIR" \
                     || echo "  Local:  $VAULT_DIR (not found — will skip)"
[ -n "$GITHUB_USER" ] && echo "  GitHub: https://github.com/$GITHUB_USER/$VAULT_NAME" \
                      || echo "  GitHub: (not authenticated — will skip)"
echo "  MCP:    $VAULT_NAME server registration"
echo ""
read -r -p "Type the vault name to confirm deletion: " CONFIRM
if [ "$CONFIRM" != "$VAULT_NAME" ]; then
  echo "Aborted."
  exit 0
fi
echo ""

# Delete GitHub repo
if [ -n "$GITHUB_USER" ]; then
  if gh repo view "$GITHUB_USER/$VAULT_NAME" >/dev/null 2>&1; then
    echo "Deleting GitHub repo..."
    gh repo delete "$GITHUB_USER/$VAULT_NAME" --yes
  else
    echo "GitHub repo not found — skipping."
  fi
fi

# Remove MCP registration
if command -v claude >/dev/null 2>&1; then
  echo "Removing MCP server..."
  claude mcp remove "$VAULT_NAME" -s user 2>/dev/null \
    && true || echo "  (not registered — skipping)"
else
  echo "Claude Code not found — MCP cleanup skipped."
  echo "  If registered, run: claude mcp remove $VAULT_NAME -s user"
fi

# Delete local directory last (safest order: remote first, local last)
if [ -d "$VAULT_DIR" ]; then
  echo "Deleting local vault..."
  rm -rf "$VAULT_DIR"
else
  echo "Local directory not found — skipping."
fi

echo ""
echo "Done. $VAULT_NAME has been fully removed."
