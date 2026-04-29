#!/usr/bin/env bash
# Update system files in a vault to the latest vaultkit version.
#
# Usage: vaultkit update <vault-name>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/_helpers.sh"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: vaultkit update <vault-name>

Rewrite the vault's .mcp-start.js launcher to the latest version and re-pin
its SHA-256 in the MCP registration. Commits and pushes the change. If push
to main is rejected (branch protection), opens a PR from a feature branch.
EOF
  exit 0
fi

if [ $# -eq 0 ]; then
  echo "Usage: vaultkit update <vault-name>"
  exit 1
fi

VAULT_NAME="$1"
vk_validate_vault_name "$VAULT_NAME" || exit 1

# Require MCP-registry entry — same policy as disconnect/destroy.
VAULT_DIR=$(vk_resolve_vault_dir "$VAULT_NAME") || {
  vk_error "'$VAULT_NAME' is not a registered vaultkit vault."
  echo "Run 'vaultkit list' to see what's registered." >&2
  exit 1
}

VAULT_DIR_POSIX=$(vk_to_posix "$VAULT_DIR")

if ! vk_is_vault_like "$VAULT_DIR_POSIX"; then
  vk_error "$VAULT_DIR does not look like a vaultkit vault — aborting."
  exit 1
fi

echo "Updating $VAULT_NAME at $VAULT_DIR..."

BEFORE_HASH=""
if [ -f "$VAULT_DIR_POSIX/.mcp-start.js" ]; then
  BEFORE_HASH=$(vk_sha256 "$VAULT_DIR_POSIX/.mcp-start.js" 2>/dev/null || echo "")
  echo "  Current .mcp-start.js SHA-256: $BEFORE_HASH"
fi
echo ""
read -r -p "Update .mcp-start.js to the latest version? [y/N] " _CONFIRM
if ! [[ "${_CONFIRM:-}" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi
echo ""

# Copy from the single source-of-truth template.
cp "$SCRIPT_DIR/lib/mcp-start.js.tmpl" "$VAULT_DIR_POSIX/.mcp-start.js"

AFTER_HASH=$(vk_sha256 "$VAULT_DIR_POSIX/.mcp-start.js" 2>/dev/null || echo "")

# Re-pin the trusted hash in the MCP registration so the launcher's self-check
# passes on next session. Even if the file content didn't change, the registered
# hash may be missing on legacy registrations — re-running mcp add fixes that.
if command -v claude >/dev/null 2>&1; then
  MCP_VAULT_PATH=$(vk_to_windows "$VAULT_DIR_POSIX")
  echo "Re-pinning MCP registration with SHA-256 $AFTER_HASH..."
  claude mcp remove "$VAULT_NAME" --scope user >/dev/null 2>&1 || true
  claude mcp add --scope user "$VAULT_NAME" -- node "$MCP_VAULT_PATH/.mcp-start.js" "--expected-sha256=$AFTER_HASH"
else
  vk_warning "Claude Code not found — MCP re-registration skipped."
  echo "  Once installed, run:" >&2
  echo "    claude mcp remove $VAULT_NAME --scope user" >&2
  echo "    claude mcp add --scope user $VAULT_NAME -- node $VAULT_DIR_POSIX/.mcp-start.js --expected-sha256=$AFTER_HASH" >&2
fi

if [ "$AFTER_HASH" = "$BEFORE_HASH" ]; then
  echo ""
  echo "  .mcp-start.js content unchanged — nothing to commit."
  echo "Done. Restart Claude Code to apply the re-pinned registration."
  exit 0
fi

echo ""
echo "  Updated .mcp-start.js"
echo "  New SHA-256: $AFTER_HASH"
echo ""

# Commit and push so collaborators get the update.
cd "$VAULT_DIR_POSIX"
git add .mcp-start.js
if git diff --cached --quiet; then
  echo "  Nothing staged — skipping commit."
  echo "Done. Restart Claude Code to apply."
  exit 0
fi

COMMIT_MSG="chore: update .mcp-start.js to latest vaultkit version"
git commit -m "$COMMIT_MSG"
echo ""

# Try direct push to main; fall back to a feature branch + PR if blocked
# (branch protection or collaborator without write access on main).
if git push 2>&1; then
  echo "Done. Restart Claude Code to apply the update."
  exit 0
fi

vk_warning "Push to main was rejected (branch may be protected or you lack write access)."
echo ""
BRANCH="vaultkit-update-$(date +%Y%m%d%H%M%S)"
echo "Creating branch '$BRANCH' for a pull request..."

# Move the new commit off main so local main isn't ahead of upstream.
git branch "$BRANCH"
git reset --hard '@{u}'
git checkout "$BRANCH"

if git push -u origin "$BRANCH" 2>&1; then
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    echo "Opening pull request..."
    gh pr create \
      --title "$COMMIT_MSG" \
      --body "Updates \`.mcp-start.js\` to the latest vaultkit launcher (SHA-256 \`$AFTER_HASH\`)." \
      --base main \
      --head "$BRANCH" \
      || vk_warning "PR creation failed — open manually at the URL above."
  else
    REPO_SLUG=$(git remote get-url origin 2>/dev/null | sed -E 's|.*github\.com[:/]([^/]+/[^/.]+)(\.git)?/?$|\1|')
    echo "Open a pull request manually:"
    echo "  https://github.com/$REPO_SLUG/compare/main...$BRANCH"
  fi
  echo ""
  echo "Done. The launcher will start working after the PR is merged."
else
  vk_error "Could not push branch '$BRANCH'. Push manually with: git push -u origin $BRANCH"
  exit 1
fi
