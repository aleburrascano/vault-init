#!/usr/bin/env bash
# Create a new Obsidian wiki vault with Quartz + GitHub Pages, fully automated.
#
# Usage:   vaultkit init <vault-name> [--private]
# Example: vaultkit init my-cooking-wiki
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: vaultkit init <vault-name> [--private]"
  exit 1
fi

VAULT_NAME="$1"
REPO_VISIBILITY="public"
[ "${2:-}" = "--private" ] && REPO_VISIBILITY="private"

if ! [[ "$VAULT_NAME" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Error: vault name must contain only letters, numbers, hyphens, and underscores."
  exit 1
fi
if [ ${#VAULT_NAME} -gt 64 ]; then
  echo "Error: vault name must be 64 characters or less."
  exit 1
fi

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
  [ -z "${GH_WIN:-}" ] && GH_WIN=$(cmd //c "where gh 2>nul" 2>/dev/null | tr -d '\r' | head -1) || true
  [ -z "${GH_WIN:-}" ] && return 1
  GH_DIR=$(cygpath -u "$(dirname "$GH_WIN")" 2>/dev/null) || return 1
  export PATH="$GH_DIR:$PATH"
  command -v gh >/dev/null 2>&1
}

echo "[1/6] Checking prerequisites..."

# Node.js version (vaultkit requires 22+)
NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Error: Node.js 22+ required (found v$(node --version | tr -d v))."
  echo "  Update at: https://nodejs.org"
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
      echo "  Error: cannot auto-install gh. Install from https://cli.github.com and re-run."
      exit 1
    fi
    command -v gh >/dev/null 2>&1 || {
      echo "  Error: gh was installed but could not be found in PATH."
      echo "  Open a new terminal window, then re-run vaultkit init."
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

mkdir -p "$VAULTS_ROOT"
[ -d "$VAULT_DIR" ] && { echo "Error: $VAULT_DIR already exists"; exit 1; }

GITHUB_USER=$(gh api user --jq '.login' 2>/dev/null) || {
  echo "Error: Could not fetch your GitHub username."
  echo "  Run: gh auth status   — then re-run vaultkit init."
  exit 1
}
[ -z "$GITHUB_USER" ] && {
  echo "Error: GitHub returned an empty username. Try: gh auth refresh"
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
    claude mcp remove "$VAULT_NAME" --scope user 2>/dev/null && \
      echo "  MCP registration removed." || true
  fi
  if $CREATED_REPO; then
    if gh repo delete "$GITHUB_USER/$VAULT_NAME" --yes 2>/dev/null; then
      echo "  GitHub repo deleted."
    else
      echo "  Warning: could not delete GitHub repo — run manually:"
      echo "    gh repo delete $GITHUB_USER/$VAULT_NAME --yes"
    fi
  fi
  if $CREATED_DIR && [ -d "${VAULT_DIR}" ]; then
    rm -rf "${VAULT_DIR}"
    echo "  Local directory removed."
  fi
}
trap cleanup EXIT

echo "[2/6] Creating vault: $VAULT_NAME"
mkdir -p "$VAULT_DIR"
CREATED_DIR=true
cd "$VAULT_DIR"

# Vault structure
mkdir -p raw/{articles,books,papers,notes,transcripts,assets}
mkdir -p wiki/{concepts,topics,people,sources}
mkdir -p .github/workflows

# CLAUDE.md
cat > CLAUDE.md << EOF
# CLAUDE.md — ${VAULT_NAME}

You maintain this personal knowledge wiki. Read this at session start, then search-first — see Session start below.

## Layers
1. \`raw/\` — immutable source material. Read; never modify.
2. \`wiki/\` — your domain. Author and maintain pages here.

## Page conventions
- Frontmatter every page: \`type\`, \`created\`, \`updated\`, \`sources\`, \`tags\`
- Cross-references: Obsidian wikilinks \`[[Page Name]]\`
- Source pages in \`wiki/sources/\` with \`source_path\`, \`source_date\`, \`source_author\`
- Never invent facts. Use \`> [!question] Unverified\` for uncertain claims.

## Operations

### Ingest (adding a source)
1. Read raw source fully.
2. Discuss takeaways before writing pages.
3. Create source page in \`wiki/sources/\`.
4. Update or create pages in \`wiki/topics/\` (synthesis) and \`wiki/concepts/\` touched.
5. Update \`index.md\` (one line per page: \`- [[Page]] — summary\`). Append \`log.md\` entry (\`## [YYYY-MM-DD] ingest | title\`).

### Query
Use \`search_notes\` (folder: \`wiki\`) first → \`get_note\` on top 1–3 hits → synthesize.
\`wiki/topics/\` = synthesis pages (start here). \`wiki/sources/\` = per-source detail.

### Lint (on request)
Find: orphans, contradictions, missing cross-refs, index drift. Discuss before bulk edits.

## Session start
- **Queries**: read this → \`search_notes\` directly → respond.
- **Ingest / lint**: read this → read \`index.md\` → skim tail of \`log.md\` → proceed.
- **Always** scope \`search_notes\` to \`folder: "wiki"\` or \`folder: "raw"\` — unscoped searches can hit \`.quartz\` noise.

## You do NOT
- Modify \`raw/\` (immutable).
- Delete wiki pages without confirmation.
- Fabricate sources or citations.
- Skip the log.
EOF

# README.md
cat > README.md << EOF
# ${VAULT_NAME}

A personal knowledge wiki powered by [vaultkit](https://github.com/aleburrascano/vaultkit).

**Site**: https://${BASE_URL} *(live after first deploy)*

## Structure

\`\`\`
raw/    ← source material (immutable — never edit directly)
wiki/   ← authored knowledge pages
\`\`\`

## Contributing

1. Fork this repo on GitHub
2. Add sources to \`raw/\` and pages to \`wiki/\`
3. Open a pull request — CI checks for duplicate sources automatically
4. The maintainer reviews and merges
EOF

# index.md
cat > index.md << EOF
# ${VAULT_NAME} Index

## Topics

## Concepts

## Sources
EOF

# log.md
printf '# Log\n' > log.md

# MCP server launcher — pulled into the vault so collaborators get it via git clone.
# Uses __dirname so it works regardless of where the vault was cloned.
cat > .mcp-start.js << 'JS'
#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');

// Pull latest changes silently — don't fail if offline or no remote.
spawnSync('git', ['pull', '--ff-only', '--quiet'], {
  cwd: __dirname,
  stdio: 'ignore',
});

// Derive npx from the node binary that launched this script — avoids PATH
// issues when Claude Code starts as a desktop app and npm isn't in system PATH.
const npx = process.platform === 'win32'
  ? path.join(path.dirname(process.execPath), 'npx.cmd')
  : 'npx';
const r = spawnSync(npx, ['-y', 'obsidian-mcp-pro', '--vault', __dirname], {
  stdio: 'inherit',
});
if (r.error) {
  process.stderr.write('[vaultkit] Failed to start MCP server: ' + r.error.message + '\n');
  process.stderr.write('[vaultkit] Check your internet connection and try restarting Claude Code.\n');
}
process.exit(r.status ?? 0);
JS

# Duplicate source check workflow
cat > .github/workflows/duplicate-check.yml << 'YAML'
name: Duplicate Source Check

on:
  pull_request:
    paths:
      - 'raw/**'

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Check for duplicate filenames in raw/
        run: |
          DUPES=$(find raw/ -type f -printf '%f\n' | sort | uniq -d)
          if [ -n "$DUPES" ]; then
            echo "Duplicate filenames found in raw/:"
            echo "$DUPES"
            exit 1
          fi
          echo "No duplicate source filenames found."
YAML

# Deploy workflow — Quartz is cloned and configured in CI, never locally
cat > .github/workflows/deploy.yml << 'YAML'
name: Deploy Wiki

on:
  push:
    branches: [main]

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Clone and configure Quartz
        run: |
          git clone --depth 1 https://github.com/jackyzha0/quartz .quartz
          node - <<'PATCH'
          const fs = require('fs');
          const cfg = JSON.parse(fs.readFileSync('_vault.json', 'utf8'));
          const p = '.quartz/quartz.config.ts';
          let t = fs.readFileSync(p, 'utf8');
          t = t.replace(/pageTitle: "[^"]+"/, `pageTitle: "${cfg.pageTitle}"`);
          t = t.replace(/baseUrl: "[^"]+"/, `baseUrl: "${cfg.baseUrl}"`);
          t = t.replace(/ignorePatterns: \[[^\]]+\]/, 'ignorePatterns: ["raw", ".quartz", ".github", "CLAUDE.md", "*.sh"]');
          fs.writeFileSync(p, t);
          PATCH
      - name: Build
        run: cd .quartz && npm ci && chmod +x quartz/bootstrap-cli.mjs && npx quartz build --directory ../
      - uses: actions/upload-pages-artifact@v3
        with:
          path: .quartz/public

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
YAML

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

# Vault config — read by the deploy workflow to configure Quartz
cat > _vault.json << EOF
{
  "pageTitle": "${VAULT_NAME}",
  "baseUrl": "${BASE_URL}"
}
EOF

# Git init + commit
echo "[3/6] Committing initial files..."
git init
git branch -M main
git add .
git commit -m "chore: initialize ${VAULT_NAME}"

# Create GitHub repo (no push yet — Pages must be enabled first)
echo "[4/6] Creating GitHub repo: $VAULT_NAME ($REPO_VISIBILITY)..."
gh repo create "$VAULT_NAME" --"$REPO_VISIBILITY"
CREATED_REPO=true
git remote add origin "https://github.com/$GITHUB_USER/$VAULT_NAME.git"

# Enable GitHub Pages before the push triggers the deploy workflow
echo "[5/6] Enabling Pages and pushing..."
if ! gh api "repos/$GITHUB_USER/$VAULT_NAME/pages" \
  --method POST -f build_type=workflow \
  >/dev/null 2>&1; then
  echo "  Note: Could not auto-enable GitHub Pages."
  echo "  Enable manually: https://github.com/$GITHUB_USER/$VAULT_NAME/settings/pages"
  echo "    -> Under 'Build and deployment', set Source to 'GitHub Actions'"
fi

# Push — triggers deploy
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
  echo "  Note: Branch protection not applied (may require a paid plan for private repos)."
  echo "  Set up manually: https://github.com/$GITHUB_USER/$VAULT_NAME/settings/branches"
fi

# Compute MCP vault path once (Windows needs a Windows-format path for Claude)
if command -v cygpath >/dev/null 2>&1; then
  MCP_VAULT_PATH=$(cygpath -m "$VAULT_DIR")
else
  MCP_VAULT_PATH="$VAULT_DIR"
fi

# Offer to install Claude Code CLI if missing, then register MCP server
if ! command -v claude >/dev/null 2>&1; then
  read -r -p "Claude Code CLI not found. Install it now? [y/N] " INSTALL_CLAUDE
  if [[ "${INSTALL_CLAUDE:-}" =~ ^[Yy]$ ]]; then
    echo "Installing Claude Code CLI..."
    if ! npm install -g @anthropic-ai/claude-code; then
      echo "  Install failed — run manually: npm install -g @anthropic-ai/claude-code"
    fi
  fi
fi

if command -v claude >/dev/null 2>&1; then
  echo "Registering MCP server: $VAULT_NAME"
  claude mcp add --scope user "$VAULT_NAME" -- node "$MCP_VAULT_PATH/.mcp-start.js"
  REGISTERED_MCP=true
else
  echo "Note: Claude Code CLI not installed — skipping MCP registration."
  echo "      Once installed, run:"
  echo "      claude mcp add --scope user $VAULT_NAME -- node $MCP_VAULT_PATH/.mcp-start.js"
fi

echo ""
echo "Done."
echo "  Repo:  https://github.com/$GITHUB_USER/$VAULT_NAME"
echo "  Site:  https://$BASE_URL  (live after CI finishes, ~1 min)"
echo "  Vault: $MCP_VAULT_PATH"
