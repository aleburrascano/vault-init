#!/usr/bin/env bash
# Bring a vault up to the current vaultkit standard:
#   - refresh .mcp-start.js launcher and re-pin its SHA-256
#   - restore any missing standard layout files (CLAUDE.md, raw/, wiki/, etc.)
#
# Usage: vaultkit update <vault-name>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/_helpers.sh"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: vaultkit update <vault-name>

Bring a vault up to the current vaultkit standard:
  - rewrites .mcp-start.js to the latest launcher and re-pins its SHA-256 in
    the MCP registration
  - restores any missing standard layout files (CLAUDE.md, README.md, raw/,
    wiki/, .gitignore, .gitattributes, .github/workflows/duplicate-check.yml)
    — never overwrites existing files

Commits and pushes any changes. If push to main is rejected (branch
protection), opens a PR from a feature branch.
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
  echo "Run 'vaultkit status' to see what's registered." >&2
  exit 1
}

VAULT_DIR_POSIX=$(vk_to_posix "$VAULT_DIR")

# Soft precondition: must be a git repo. We deliberately do NOT call
# vk_is_vault_like here — repairing a non-vault-like layout is one of the
# things this command does. The MCP registry already gates which directories
# this command can touch.
if ! [ -d "$VAULT_DIR_POSIX/.git" ]; then
  vk_error "$VAULT_DIR is not a git repository — aborting."
  exit 1
fi

echo "Updating $VAULT_NAME at $VAULT_DIR..."

# --- Launcher refresh -------------------------------------------------------

BEFORE_HASH=""
if [ -f "$VAULT_DIR_POSIX/.mcp-start.js" ]; then
  BEFORE_HASH=$(vk_sha256 "$VAULT_DIR_POSIX/.mcp-start.js" 2>/dev/null || echo "")
fi
TMPL_HASH=$(vk_sha256 "$SCRIPT_DIR/lib/mcp-start.js.tmpl" 2>/dev/null || echo "")
LAUNCHER_WILL_CHANGE=false
if [ "$BEFORE_HASH" != "$TMPL_HASH" ]; then
  LAUNCHER_WILL_CHANGE=true
fi

# --- Layout-repair pass: detect missing standard files ----------------------

MISSING=()
[ -f "$VAULT_DIR_POSIX/CLAUDE.md" ]                             || MISSING+=("CLAUDE.md")
[ -f "$VAULT_DIR_POSIX/README.md" ]                             || MISSING+=("README.md")
[ -f "$VAULT_DIR_POSIX/index.md" ]                              || MISSING+=("index.md")
[ -f "$VAULT_DIR_POSIX/log.md" ]                                || MISSING+=("log.md")
[ -f "$VAULT_DIR_POSIX/.gitignore" ]                            || MISSING+=(".gitignore")
[ -f "$VAULT_DIR_POSIX/.gitattributes" ]                        || MISSING+=(".gitattributes")
[ -f "$VAULT_DIR_POSIX/.github/workflows/duplicate-check.yml" ] || MISSING+=(".github/workflows/duplicate-check.yml")

# raw/ and wiki/ — need a .gitkeep when the dir is missing or empty (git
# doesn't track empty dirs, so a clone wouldn't have them).
if ! [ -d "$VAULT_DIR_POSIX/raw" ] || [ -z "$(ls -A "$VAULT_DIR_POSIX/raw" 2>/dev/null)" ]; then
  MISSING+=("raw/.gitkeep")
fi
if ! [ -d "$VAULT_DIR_POSIX/wiki" ] || [ -z "$(ls -A "$VAULT_DIR_POSIX/wiki" 2>/dev/null)" ]; then
  MISSING+=("wiki/.gitkeep")
fi

# --- Summarize and confirm --------------------------------------------------

echo ""
if $LAUNCHER_WILL_CHANGE; then
  if [ -n "$BEFORE_HASH" ]; then
    echo "  .mcp-start.js: $BEFORE_HASH → $TMPL_HASH"
  else
    echo "  .mcp-start.js: (missing) → $TMPL_HASH"
  fi
else
  echo "  .mcp-start.js: up to date ($BEFORE_HASH)"
fi

if [ ${#MISSING[@]} -gt 0 ]; then
  echo "  Missing layout files (${#MISSING[@]}):"
  for f in "${MISSING[@]}"; do
    echo "    - $f"
  done
else
  echo "  Layout: complete."
fi

if ! $LAUNCHER_WILL_CHANGE && [ ${#MISSING[@]} -eq 0 ]; then
  echo ""
  echo "Already up to date. Re-pinning MCP registration anyway (idempotent)."
fi

echo ""
read -r -p "Proceed? [y/N] " _CONFIRM
if ! [[ "${_CONFIRM:-}" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi
echo ""

# --- Apply changes ----------------------------------------------------------

# Launcher (always copy to ensure file exists; re-pinning step below depends on it).
cp "$SCRIPT_DIR/lib/mcp-start.js.tmpl" "$VAULT_DIR_POSIX/.mcp-start.js"
AFTER_HASH=$(vk_sha256 "$VAULT_DIR_POSIX/.mcp-start.js" 2>/dev/null || echo "")

# Layout repair — only create files that were missing. Never overwrite existing.
ADDED=()
for f in "${MISSING[@]}"; do
  case "$f" in
    CLAUDE.md)
      vk_render_claude_md "$VAULT_NAME" > "$VAULT_DIR_POSIX/CLAUDE.md"
      ;;
    README.md)
      # Notes-only variant — owner can edit if their vault publishes a site.
      vk_render_readme "$VAULT_NAME" "" > "$VAULT_DIR_POSIX/README.md"
      ;;
    index.md)
      cat > "$VAULT_DIR_POSIX/index.md" <<EOF
# ${VAULT_NAME} Index

## Topics

## Concepts

## Sources
EOF
      ;;
    log.md)
      printf '# Log\n' > "$VAULT_DIR_POSIX/log.md"
      ;;
    raw/.gitkeep)
      mkdir -p "$VAULT_DIR_POSIX/raw"
      touch "$VAULT_DIR_POSIX/raw/.gitkeep"
      ;;
    wiki/.gitkeep)
      mkdir -p "$VAULT_DIR_POSIX/wiki"
      touch "$VAULT_DIR_POSIX/wiki/.gitkeep"
      ;;
    .gitignore)
      cat > "$VAULT_DIR_POSIX/.gitignore" <<'EOF'
.quartz/
.obsidian/
.DS_Store
EOF
      ;;
    .gitattributes)
      cat > "$VAULT_DIR_POSIX/.gitattributes" <<'EOF'
* text=auto
*.js text eol=lf
*.ts text eol=lf
*.json text eol=lf
*.yml text eol=lf
*.md text eol=lf
EOF
      ;;
    .github/workflows/duplicate-check.yml)
      mkdir -p "$VAULT_DIR_POSIX/.github/workflows"
      vk_render_duplicate_check_yaml > "$VAULT_DIR_POSIX/.github/workflows/duplicate-check.yml"
      ;;
  esac
  ADDED+=("$f")
done

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

LAUNCHER_CHANGED=false
[ "$AFTER_HASH" != "$BEFORE_HASH" ] && LAUNCHER_CHANGED=true

if ! $LAUNCHER_CHANGED && [ ${#ADDED[@]} -eq 0 ]; then
  echo ""
  echo "  Nothing to commit."
  echo "Done. Restart Claude Code to apply the re-pinned registration."
  exit 0
fi

# --- Commit and push --------------------------------------------------------

cd "$VAULT_DIR_POSIX"

# Stage launcher if it changed; stage all added layout files.
if $LAUNCHER_CHANGED; then
  git add .mcp-start.js
fi
for f in "${ADDED[@]}"; do
  git add "$f"
done

if git diff --cached --quiet; then
  echo "  Nothing staged — skipping commit."
  echo "Done. Restart Claude Code to apply."
  exit 0
fi

# Pick the commit message based on what actually changed.
if $LAUNCHER_CHANGED && [ ${#ADDED[@]} -gt 0 ]; then
  COMMIT_MSG="chore: update .mcp-start.js + restore standard layout files"
elif $LAUNCHER_CHANGED; then
  COMMIT_MSG="chore: update .mcp-start.js to latest vaultkit version"
else
  COMMIT_MSG="chore: restore standard vaultkit layout files"
fi

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
      --body "Brings the vault up to the current vaultkit standard." \
      --base main \
      --head "$BRANCH" \
      || vk_warning "PR creation failed — open manually at the URL above."
  else
    REPO_SLUG=$(git remote get-url origin 2>/dev/null | sed -E 's|.*github\.com[:/]([^/]+/[^/.]+)(\.git)?/?$|\1|')
    echo "Open a pull request manually:"
    echo "  https://github.com/$REPO_SLUG/compare/main...$BRANCH"
  fi
  echo ""
  echo "Done. Changes will take effect after the PR is merged."
else
  vk_error "Could not push branch '$BRANCH'. Push manually with: git push -u origin $BRANCH"
  exit 1
fi
