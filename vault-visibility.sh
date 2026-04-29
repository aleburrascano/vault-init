#!/usr/bin/env bash
# Flip a vault's GitHub repo + Pages visibility.
#
# Modes:
#   public      Public repo, public Quartz site
#   private     Private repo, no Pages (notes-only)
#   auth-gated  Private repo, auth-gated Pages site (requires GitHub Pro+)
#
# Promoting a notes-only vault (no deploy.yml) to public/auth-gated will
# generate the Pages deploy workflow + _vault.json and commit them after
# flipping visibility / enabling Pages, so the workflow's first run executes
# against an already-configured Pages site.
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

Promoting a notes-only vault to public/auth-gated will add the Pages deploy
workflow automatically (commits + pushes before flipping visibility).
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

echo "Vault: $VAULT_NAME ($REPO_SLUG)"
echo "Current: repo=$CURRENT_VIS, pages=$( $PAGES_EXISTS && echo "$PAGES_PUBLIC" || echo "disabled" )"
echo "Target:  $TARGET"
echo ""

# If we're promoting a notes-only vault → published, we'll need to add the
# deploy workflow + _vault.json before flipping. Tracked here so it shows up
# in the action plan and in the execute block below.
HAS_DEPLOY=false
[ -f "$VAULT_DIR_POSIX/.github/workflows/deploy.yml" ] && HAS_DEPLOY=true

NEED_DEPLOY=false
if { [ "$TARGET" = "public" ] || [ "$TARGET" = "auth-gated" ]; } && ! $HAS_DEPLOY; then
  NEED_DEPLOY=true
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
if $NEED_DEPLOY; then
  ACTIONS+=("add .github/workflows/deploy.yml + _vault.json")
fi
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

# If promoting notes-only → published, write deploy.yml + _vault.json now,
# but don't commit yet. We push them after flipping visibility / enabling
# Pages so the workflow's first run executes against an already-configured
# Pages site (clean first deploy, no transient failure).
if $NEED_DEPLOY; then
  echo "Writing .github/workflows/deploy.yml + _vault.json..."
  mkdir -p "$VAULT_DIR_POSIX/.github/workflows"
  cp "$SCRIPT_DIR/lib/deploy.yml.tmpl" "$VAULT_DIR_POSIX/.github/workflows/deploy.yml"

  REPO_NAME="${REPO_SLUG##*/}"
  REPO_OWNER="${REPO_SLUG%%/*}"
  cat > "$VAULT_DIR_POSIX/_vault.json" <<EOF
{
  "pageTitle": "${REPO_NAME}",
  "baseUrl": "${REPO_OWNER}.github.io/${REPO_NAME}"
}
EOF
  echo ""
fi

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

# Push the deploy workflow last — by now the repo is in its target visibility
# and Pages is configured, so the workflow's first run will deploy cleanly.
if $NEED_DEPLOY; then
  echo ""
  cd "$VAULT_DIR_POSIX"
  git add .github/workflows/deploy.yml _vault.json
  if git diff --cached --quiet; then
    echo "Workflow already committed — nothing to push."
  else
    git commit -m "chore: add Pages deploy workflow"
    echo "Pushing workflow to main..."
    if ! git push 2>&1; then
      vk_warning "Push to main was rejected (branch may be protected)."
      echo ""
      BRANCH="vaultkit-pages-$(date +%Y%m%d%H%M%S)"
      echo "Creating branch '$BRANCH' for a pull request..."
      git branch "$BRANCH"
      git reset --hard '@{u}'
      git checkout "$BRANCH"
      if git push -u origin "$BRANCH" 2>&1; then
        if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
          gh pr create \
            --title "chore: add Pages deploy workflow" \
            --body "Adds the deploy workflow needed to publish this vault as a Pages site." \
            --base main \
            --head "$BRANCH" \
            || vk_warning "PR creation failed — open one manually."
        else
          echo "Open a pull request manually:"
          echo "  https://github.com/$REPO_SLUG/compare/main...$BRANCH"
        fi
      else
        vk_error "Could not push branch '$BRANCH'."
        exit 1
      fi
      echo ""
      vk_note "Repo + Pages are configured, but the workflow is on a PR."
      echo "      The site will deploy after you merge the PR." >&2
    fi
  fi
fi

echo ""
echo "Done. Repo: https://github.com/$REPO_SLUG"
