#!/usr/bin/env bash
# Create a new Obsidian wiki vault with optional Quartz + GitHub Pages.
#
# Usage:   vaultkit init <vault-name>
# Example: vaultkit init my-cooking-wiki
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/_helpers.sh"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: vaultkit init <vault-name>

Create a new Obsidian wiki vault: GitHub repo + Quartz Pages site (optional) +
branch protection + Claude Code MCP registration.

Asks how to publish:
  (y) Public repo + public Quartz site
  (n) Private repo, no Pages, no public URL  [default]
  (a) Private repo + auth-gated Pages site (GitHub Pro+ only)
EOF
  exit 0
fi

if [ $# -eq 0 ]; then
  echo "Usage: vaultkit init <vault-name>"
  exit 1
fi

VAULT_NAME="$1"
vk_validate_vault_name "$VAULT_NAME" || exit 1

VAULTS_ROOT="${VAULTKIT_HOME:-$HOME/vaults}"
VAULT_DIR="$VAULTS_ROOT/$VAULT_NAME"

IS_WINDOWS=false
[ -n "${WINDIR:-}" ] && IS_WINDOWS=true

# On Windows, PATH changes written to the registry by installers are never visible to
# processes already running — cmd //c inherits the same stale env as bash.
# Probe known MSI / WinGet install locations directly instead.
_win_find_gh() {
  command -v cygpath >/dev/null 2>&1 || return 1
  local GH_WIN GH_DIR CHECK_WIN CHECK_POSIX
  for CHECK_WIN in \
    "${PROGRAMFILES:-C:/Program Files}/GitHub CLI/gh.exe" \
    "C:/Program Files/GitHub CLI/gh.exe" \
    "${LOCALAPPDATA:-}/Microsoft/WinGet/Links/gh.exe" \
    "${LOCALAPPDATA:-}/Microsoft/WinGet/Packages/GitHub.cli_Microsoft.Winget.Source_8wekyb3d8bbwe/tools/gh.exe"; do
    CHECK_POSIX=$(cygpath -u "$CHECK_WIN" 2>/dev/null || true)
    [ -n "$CHECK_POSIX" ] && [ -f "$CHECK_POSIX" ] && { GH_WIN="$CHECK_WIN"; break; }
  done
  # Fall back to cmd.exe (works when PATH was inherited from a post-install shell)
  if [ -z "${GH_WIN:-}" ]; then
    GH_WIN=$(cmd //c "where gh 2>nul" 2>/dev/null | tr -d '\r' | head -1 || true)
  fi
  [ -z "${GH_WIN:-}" ] && return 1
  GH_DIR=$(cygpath -u "$(dirname "$GH_WIN")" 2>/dev/null) || return 1
  export PATH="$GH_DIR:$PATH"
  command -v gh >/dev/null 2>&1
}

echo "[1/6] Checking prerequisites..."

# Node.js version (vaultkit requires 22+)
NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
if [ "$NODE_MAJOR" -lt 22 ]; then
  vk_error "Node.js 22+ required (found v$(node --version | tr -d v))."
  echo "  Update at: https://nodejs.org" >&2
  exit 1
fi

# Auto-install gh if missing
if ! command -v gh >/dev/null 2>&1; then
  # On Windows, first try to locate an existing install that bash can't yet see
  if $IS_WINDOWS && _win_find_gh; then
    : # found via cmd.exe PATH lookup — no install needed
  else
    echo "  GitHub CLI not found — installing..."
    if $IS_WINDOWS && command -v winget >/dev/null 2>&1; then
      winget install --id GitHub.cli -e --accept-package-agreements --accept-source-agreements
      # Refresh PATH — gh MSI lands in Program Files; WinGet may also create a shim
      if command -v cygpath >/dev/null 2>&1; then
        for WIN_DIR in \
          "${PROGRAMFILES:-C:/Program Files}/GitHub CLI" \
          "C:/Program Files/GitHub CLI" \
          "${LOCALAPPDATA:-}/Microsoft/WinGet/Links" \
          "${LOCALAPPDATA:-}/Microsoft/WinGet/Packages/GitHub.cli_Microsoft.Winget.Source_8wekyb3d8bbwe/tools"; do
          POSIX_DIR=$(cygpath -u "$WIN_DIR" 2>/dev/null || true)
          [ -n "$POSIX_DIR" ] && [ -d "$POSIX_DIR" ] && export PATH="$POSIX_DIR:$PATH"
        done
        _win_find_gh || true
      fi
    elif command -v brew >/dev/null 2>&1; then
      brew install gh
    elif command -v apt-get >/dev/null 2>&1; then
      curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
      sudo apt-get update -qq && sudo apt-get install gh -y
    elif command -v dnf >/dev/null 2>&1; then
      sudo dnf install 'dnf-command(config-manager)' -y
      sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo
      sudo dnf install gh --repo gh-cli -y
    else
      vk_error "cannot auto-install gh. Install from https://cli.github.com and re-run."
      exit 1
    fi
    command -v gh >/dev/null 2>&1 || {
      vk_error "gh was installed but could not be found in PATH."
      echo "  Open a new terminal window, then re-run vaultkit init." >&2
      exit 1
    }
  fi
fi

# Authenticate with GitHub if needed
if ! gh auth status >/dev/null 2>&1; then
  echo "  GitHub authentication required — a browser window will open..."
  gh auth login
fi

# Prompt for git user config if not set (needed for git commit)
if ! git config user.name >/dev/null 2>&1; then
  read -r -p "  Enter your name for git commits: " GIT_NAME
  git config --global user.name "$GIT_NAME"
fi
if ! git config user.email >/dev/null 2>&1; then
  read -r -p "  Enter your email for git commits: " GIT_EMAIL
  git config --global user.email "$GIT_EMAIL"
fi

# Publishing prompt — drives repo visibility, deploy workflow, and Pages settings.
# Public is opt-in. (n) is foolproof: no Pages, no deploy workflow, no public URL.
echo ""
echo "Publish this vault as a public knowledge site?"
echo "  (y) Public repo + public Quartz site at https://<user>.github.io/$VAULT_NAME"
echo "  (n) Private repo, notes-only — no Pages, no deploy workflow, no public URL  [default]"
echo "  (a) Private repo + auth-gated Pages site (requires GitHub Pro+)"
read -r -p "Choice [y/n/a]: " PUBLISH_CHOICE
PUBLISH_CHOICE="${PUBLISH_CHOICE:-n}"

case "$PUBLISH_CHOICE" in
  y|Y) PUBLISH_MODE="public" ;;
  a|A) PUBLISH_MODE="auth-gated" ;;
  n|N|"") PUBLISH_MODE="private" ;;
  *) vk_error "invalid choice: $PUBLISH_CHOICE"; exit 1 ;;
esac

if [ "$PUBLISH_MODE" = "auth-gated" ]; then
  PLAN_NAME=$(gh api user --jq '.plan.name' 2>/dev/null || echo "free")
  if [ "$PLAN_NAME" = "free" ]; then
    vk_error "auth-gated Pages requires GitHub Pro or higher (you're on Free)."
    echo "  Choose (y) for a public site or (n) for a notes-only private vault." >&2
    exit 1
  fi
fi

case "$PUBLISH_MODE" in
  public)     REPO_VISIBILITY="public";  WRITE_DEPLOY=true;  ENABLE_PAGES=true;  PAGES_PRIVATE=false ;;
  auth-gated) REPO_VISIBILITY="private"; WRITE_DEPLOY=true;  ENABLE_PAGES=true;  PAGES_PRIVATE=true  ;;
  private)    REPO_VISIBILITY="private"; WRITE_DEPLOY=false; ENABLE_PAGES=false; PAGES_PRIVATE=false ;;
esac

mkdir -p "$VAULTS_ROOT"
[ -d "$VAULT_DIR" ] && { vk_error "$VAULT_DIR already exists"; exit 1; }

GITHUB_USER=$(gh api user --jq '.login' 2>/dev/null) || {
  vk_error "Could not fetch your GitHub username."
  echo "  Run: gh auth status   — then re-run vaultkit init." >&2
  exit 1
}
[ -z "$GITHUB_USER" ] && {
  vk_error "GitHub returned an empty username. Try: gh auth refresh"
  exit 1
}
BASE_URL="$GITHUB_USER.github.io/$VAULT_NAME"

# Transactional rollback — undo exactly what was created, in reverse order.
CREATED_DIR=false
CREATED_REPO=false
REGISTERED_MCP=false

cleanup() {
  local code=$?
  [ $code -eq 0 ] && return
  echo ""
  echo "Setup failed — rolling back..."
  if $REGISTERED_MCP && command -v claude >/dev/null 2>&1; then
    if claude mcp remove "$VAULT_NAME" --scope user 2>/dev/null; then
      echo "  MCP registration removed."
    fi
  fi
  if $CREATED_REPO; then
    if gh repo delete "$GITHUB_USER/$VAULT_NAME" --yes 2>/dev/null; then
      echo "  GitHub repo deleted."
    else
      vk_warning "could not delete GitHub repo — run manually:"
      echo "    gh repo delete $GITHUB_USER/$VAULT_NAME --yes" >&2
    fi
  fi
  if $CREATED_DIR && [ -d "${VAULT_DIR}" ]; then
    rm -rf "${VAULT_DIR}"
    echo "  Local directory removed."
  fi
}
trap cleanup EXIT

echo ""
echo "[2/6] Creating vault: $VAULT_NAME ($PUBLISH_MODE)"
mkdir -p "$VAULT_DIR"
CREATED_DIR=true
cd "$VAULT_DIR"

# Vault structure
mkdir -p raw/{articles,books,papers,notes,transcripts,assets}
mkdir -p wiki/{concepts,topics,people,sources}
mkdir -p .github/workflows

# .gitkeep — keep raw/ and wiki/ tracked even when empty, so a clone of a
# fresh vault still satisfies vk_is_vault_like.
touch raw/.gitkeep wiki/.gitkeep

# CLAUDE.md
vk_render_claude_md "$VAULT_NAME" > CLAUDE.md

# README.md — site URL only when Pages is enabled
if $ENABLE_PAGES; then
  vk_render_readme "$VAULT_NAME" "$BASE_URL" > README.md
else
  vk_render_readme "$VAULT_NAME" "" > README.md
fi

# index.md
cat > index.md << EOF
# ${VAULT_NAME} Index

## Topics

## Concepts

## Sources
EOF

# log.md
printf '# Log\n' > log.md

# MCP server launcher — single source of truth lives in lib/mcp-start.js.tmpl.
cp "$SCRIPT_DIR/lib/mcp-start.js.tmpl" "$VAULT_DIR/.mcp-start.js"

# Duplicate source check workflow — useful for any vault with collaborators
vk_render_duplicate_check_yaml > .github/workflows/duplicate-check.yml

# Deploy workflow — only generated when the vault publishes a site.
if $WRITE_DEPLOY; then
  cp "$SCRIPT_DIR/lib/deploy.yml.tmpl" .github/workflows/deploy.yml

  # _vault.json is read by the deploy workflow to configure Quartz
  cat > _vault.json << EOF
{
  "pageTitle": "${VAULT_NAME}",
  "baseUrl": "${BASE_URL}"
}
EOF
fi

# .gitignore
cat > .gitignore << 'EOF'
.quartz/
.obsidian/
.DS_Store
EOF

# .gitattributes — normalise line endings; suppresses CRLF warnings on Windows
cat > .gitattributes << 'EOF'
* text=auto
*.js text eol=lf
*.ts text eol=lf
*.json text eol=lf
*.yml text eol=lf
*.md text eol=lf
EOF

# Git init + commit
echo "[3/6] Committing initial files..."
git init
git branch -M main
git add .
git commit -m "chore: initialize ${VAULT_NAME}"

# Create GitHub repo
echo "[4/6] Creating GitHub repo: $VAULT_NAME ($REPO_VISIBILITY)..."
gh repo create "$VAULT_NAME" --"$REPO_VISIBILITY"
git remote add origin "https://github.com/$GITHUB_USER/$VAULT_NAME.git"
# Mark CREATED_REPO only after both creation and remote-add succeed; if remote-add
# failed, we'd want cleanup to delete the repo, so set this here (after the wire-up).
CREATED_REPO=true

# Enable + configure GitHub Pages (only when publishing).
if $ENABLE_PAGES; then
  echo "[5/6] Enabling Pages and pushing..."
  if ! gh api "repos/$GITHUB_USER/$VAULT_NAME/pages" \
    --method POST -f build_type=workflow \
    >/dev/null 2>&1; then
    vk_warning "Could not auto-enable GitHub Pages."
    echo "  Enable manually: https://github.com/$GITHUB_USER/$VAULT_NAME/settings/pages" >&2
    echo "    -> Under 'Build and deployment', set Source to 'GitHub Actions'" >&2
  elif $PAGES_PRIVATE; then
    # Lock site visibility to authenticated users — independent of repo visibility.
    if ! gh api "repos/$GITHUB_USER/$VAULT_NAME/pages" \
      --method PUT -f visibility=private \
      >/dev/null 2>&1; then
      vk_warning "Could not set Pages visibility to private — site may be publicly accessible."
      echo "  Set manually: https://github.com/$GITHUB_USER/$VAULT_NAME/settings/pages" >&2
    fi
  fi
else
  echo "[5/6] Pushing (no Pages — notes-only vault)..."
fi

# Push — triggers deploy if the workflow exists
git push -u origin main

# Protect main branch — force contributions through PRs
echo "[6/6] Protecting main branch..."
if ! gh api "repos/$GITHUB_USER/$VAULT_NAME/branches/main/protection" \
  --method PUT \
  --input - >/dev/null 2>&1 << 'JSON'
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": {"required_approving_review_count": 1, "dismiss_stale_reviews": false},
  "restrictions": null
}
JSON
then
  vk_note "Branch protection not applied (may require a paid plan for private repos)."
  echo "  Set up manually: https://github.com/$GITHUB_USER/$VAULT_NAME/settings/branches"
fi

# Compute MCP vault path once (Windows needs a Windows-format path for Claude)
MCP_VAULT_PATH=$(vk_to_windows "$VAULT_DIR")
MCP_HASH=$(vk_sha256 "$VAULT_DIR/.mcp-start.js")

# Offer to install Claude Code CLI if missing, then register MCP server
if ! command -v claude >/dev/null 2>&1; then
  read -r -p "Claude Code CLI not found. Install it now? [y/N] " INSTALL_CLAUDE
  if [[ "${INSTALL_CLAUDE:-}" =~ ^[Yy]$ ]]; then
    echo "Installing Claude Code CLI..."
    if ! npm install -g @anthropic-ai/claude-code; then
      vk_warning "Install failed — run manually: npm install -g @anthropic-ai/claude-code"
    fi
  fi
fi

if command -v claude >/dev/null 2>&1; then
  echo "Registering MCP server: $VAULT_NAME"
  claude mcp add --scope user "$VAULT_NAME" -- node "$MCP_VAULT_PATH/.mcp-start.js" "--expected-sha256=$MCP_HASH"
  REGISTERED_MCP=true
else
  vk_note "Claude Code CLI not installed — skipping MCP registration."
  echo "      Once installed, run:"
  echo "      claude mcp add --scope user $VAULT_NAME -- node $MCP_VAULT_PATH/.mcp-start.js --expected-sha256=$MCP_HASH"
fi

echo ""
echo "Done."
echo "  Repo:  https://github.com/$GITHUB_USER/$VAULT_NAME"
if [ "$PUBLISH_MODE" = "public" ]; then
  echo "  Site:  https://$BASE_URL  (live after CI finishes, ~1 min)"
elif [ "$PUBLISH_MODE" = "auth-gated" ]; then
  echo "  Site:  https://$BASE_URL  (auth-gated — visible only to authorized GitHub users)"
fi
echo "  Vault: $MCP_VAULT_PATH"
