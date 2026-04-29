#!/usr/bin/env bash
# Flip a vault's GitHub repo + Pages visibility.
#
# Modes:
#   public      Public repo, public Quartz site
#   private     Private repo, no Pages (notes-only)
#   auth-gated  Private repo, auth-gated Pages site (requires GitHub Pro+)
#
# Caveat: if the vault was init'd with mode "private" (notes-only), it has no
# .github/workflows/deploy.yml. Switching to public/auth-gated would require
# adding that workflow — this command will not generate it. Re-init instead.
#
# Usage: vaultkit visibility <vault-name> <public|private|auth-gated>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/_helpers.sh"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: vaultkit visibility <vault-name> <public|private|auth-gated>

Flip a vault's GitHub repo + Pages visibility:
  public      Public repo, public Quartz site
  private     Private repo, no Pages (notes-only)
  auth-gated  Private repo + auth-gated Pages (requires GitHub Pro+)

Limitation: cannot promote a notes-only vault (no deploy.yml) to public —
re-init instead of trying to flip.
EOF
  exit 0
fi

if [ $# -lt 2 ]; then
  echo "Usage: vaultkit visibility <vault-name> <public|private|auth-gated>"
  exit 1
fi

VAULT_NAME="$1"
TARGET="$2"
vk_validate_vault_name "$VAULT_NAME" || exit 1

case "$TARGET" in
  public|private|auth-gated) ;;
  *)
    vk_error "invalid mode '$TARGET'. Choose one of: public, private, auth-gated."
    exit 1
    ;;
esac

VAULT_DIR=$(vk_resolve_vault_dir "$VAULT_NAME") || {
  vk_error "'$VAULT_NAME' is not a registered vaultkit vault."
  exit 1
}
VAULT_DIR_POSIX=$(vk_to_posix "$VAULT_DIR")

if ! command -v gh >/dev/null 2>&1; then
  vk_error "GitHub CLI (gh) is required for vaultkit visibility."
  exit 1
fi

# Resolve owner/repo from git remote — same approach destroy uses.
REMOTE_URL=$(git -C "$VAULT_DIR_POSIX" remote get-url origin 2>/dev/null || true)
if [ -z "$REMOTE_URL" ]; then
  vk_error "vault has no 'origin' remote — cannot determine GitHub repo."
  exit 1
fi
REPO_SLUG=$(echo "$REMOTE_URL" | sed -E 's|.*github\.com[:/]([^/]+/[^/.]+)(\.git)?/?$|\1|')
if [ -z "$REPO_SLUG" ]; then
  vk_error "could not parse 'owner/repo' from remote: $REMOTE_URL"
  exit 1
fi

# Verify ownership — flipping visibility requires admin.
IS_ADMIN=$(gh api "repos/$REPO_SLUG" --jq '.permissions.admin' 2>/dev/null || echo "false")
if [ "$IS_ADMIN" != "true" ]; then
  vk_error "you don't have admin rights on $REPO_SLUG."
  exit 1
fi

# Detect current state.
CURRENT_VIS=$(gh api "repos/$REPO_SLUG" --jq '.visibility' 2>/dev/null || echo "unknown")
PAGES_EXISTS=false
PAGES_PUBLIC="?"
if gh api "repos/$REPO_SLUG/pages" >/dev/null 2>&1; then
  PAGES_EXISTS=true
  # Newer API exposes .visibility ("public" | "private"); older only has .public bool.
  PAGES_VISIBILITY=$(gh api "repos/$REPO_SLUG/pages" --jq '.visibility // (if .public then "public" else "private" end)' 2>/dev/null || echo "?")
  PAGES_PUBLIC="$PAGES_VISIBILITY"
fi

if $PAGES_EXISTS; then
  CURRENT_MODE="$CURRENT_VIS-pages-$PAGES_PUBLIC"
else
  CURRENT_MODE="$CURRENT_VIS-no-pages"
fi

echo "Vault: $VAULT_NAME ($REPO_SLUG)"
echo "Current: repo=$CURRENT_VIS, pages=$( $PAGES_EXISTS && echo "$PAGES_PUBLIC" || echo "disabled" )"
echo "Target:  $TARGET"
echo ""

# Sanity check for promoting a notes-only vault.
HAS_DEPLOY=false
[ -f "$VAULT_DIR_POSIX/.github/workflows/deploy.yml" ] && HAS_DEPLOY=true

if { [ "$TARGET" = "public" ] || [ "$TARGET" = "auth-gated" ]; } && ! $HAS_DEPLOY; then
  vk_error "$VAULT_NAME has no .github/workflows/deploy.yml — it was init'd as notes-only."
  echo "  Promoting it to a published vault requires the deploy workflow." >&2
  echo "  Easiest path: 'vaultkit destroy $VAULT_NAME' then 'vaultkit init $VAULT_NAME' and pick the desired mode." >&2
  exit 1
fi

# Plan check for auth-gated.
if [ "$TARGET" = "auth-gated" ]; then
  PLAN=$(gh api user --jq '.plan.name' 2>/dev/null || echo "free")
  if [ "$PLAN" = "free" ]; then
    vk_error "auth-gated Pages requires GitHub Pro+ (your plan: $PLAN)."
    exit 1
  fi
fi

# Build the action list, then confirm before executing.
ACTIONS=()
case "$TARGET" in
  public)
    [ "$CURRENT_VIS" != "public" ]   && ACTIONS+=("flip repo to public")
    if $PAGES_EXISTS; then
      [ "$PAGES_PUBLIC" != "public" ] && ACTIONS+=("set Pages visibility to public")
    else
      ACTIONS+=("enable Pages (workflow source)")
    fi
    ;;
  private)
    [ "$CURRENT_VIS" != "private" ]  && ACTIONS+=("flip repo to private")
    $PAGES_EXISTS && ACTIONS+=("disable Pages site")
    ;;
  auth-gated)
    [ "$CURRENT_VIS" != "private" ]  && ACTIONS+=("flip repo to private")
    if $PAGES_EXISTS; then
      [ "$PAGES_PUBLIC" != "private" ] && ACTIONS+=("set Pages visibility to private")
    else
      ACTIONS+=("enable Pages + set visibility to private")
    fi
    ;;
esac

if [ ${#ACTIONS[@]} -eq 0 ]; then
  echo "Already $TARGET — nothing to do."
  exit 0
fi

echo "Plan:"
for a in "${ACTIONS[@]}"; do
  echo "  - $a"
done
echo ""
read -r -p "Proceed? [y/N] " _CONFIRM
if ! [[ "${_CONFIRM:-}" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi
echo ""

# Execute.
case "$TARGET" in
  public)
    if [ "$CURRENT_VIS" != "public" ]; then
      echo "Flipping repo visibility → public..."
      gh repo edit "$REPO_SLUG" --visibility public --accept-visibility-change-consequences
    fi
    if $PAGES_EXISTS; then
      if [ "$PAGES_PUBLIC" != "public" ]; then
        echo "Setting Pages visibility → public..."
        gh api "repos/$REPO_SLUG/pages" --method PUT -F visibility=public >/dev/null
      fi
    else
      echo "Enabling Pages..."
      gh api "repos/$REPO_SLUG/pages" --method POST -f build_type=workflow >/dev/null
    fi
    ;;
  private)
    if [ "$CURRENT_VIS" != "private" ]; then
      echo "Flipping repo visibility → private..."
      gh repo edit "$REPO_SLUG" --visibility private --accept-visibility-change-consequences
    fi
    if $PAGES_EXISTS; then
      echo "Disabling Pages site..."
      gh api "repos/$REPO_SLUG/pages" --method DELETE >/dev/null
      vk_note "deploy.yml workflow file is still in the repo. Remove it manually if you want."
    fi
    ;;
  auth-gated)
    if [ "$CURRENT_VIS" != "private" ]; then
      echo "Flipping repo visibility → private..."
      gh repo edit "$REPO_SLUG" --visibility private --accept-visibility-change-consequences
    fi
    if ! $PAGES_EXISTS; then
      echo "Enabling Pages..."
      gh api "repos/$REPO_SLUG/pages" --method POST -f build_type=workflow >/dev/null
    fi
    if [ "$PAGES_PUBLIC" != "private" ]; then
      echo "Setting Pages visibility → private..."
      gh api "repos/$REPO_SLUG/pages" --method PUT -F visibility=private >/dev/null
    fi
    ;;
esac

echo ""
echo "Done. Repo: https://github.com/$REPO_SLUG"
