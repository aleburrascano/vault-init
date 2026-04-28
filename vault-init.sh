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

# VAULT_INIT_CWD is injected by the Node.js wrapper as the user's real working
# directory (bash's own pwd returns the npm package dir, not where the user ran the command).
VAULT_DIR="${VAULT_INIT_CWD:-$(pwd)}/$VAULT_NAME"

IS_WINDOWS=false
[ -n "${WINDIR:-}" ] && IS_WINDOWS=true

# On Windows, bash's PATH doesn't pick up system PATH changes made by installers.
# Ask cmd.exe — which sees the live system PATH — to locate any pre-existing gh.
_win_find_gh() {
  command -v cygpath >/dev/null 2>&1 || return 1
  local GH_WIN GH_DIR
  GH_WIN=$(cmd //c "where gh 2>nul" 2>/dev/null | tr -d '\r' | head -1) || return 1
  [ -z "$GH_WIN" ] && return 1
  GH_DIR=$(cygpath -u "$(dirname "$GH_WIN")" 2>/dev/null) || return 1
  export PATH="$GH_DIR:$PATH"
  command -v gh >/dev/null 2>&1
}

echo "[1/8] Checking prerequisites..."

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
          "${LOCALAPPDATA:-}/Microsoft/WinGet/Links"; do
          POSIX_DIR=$(cygpath -u "$WIN_DIR" 2>/dev/null || true)
          [ -n "$POSIX_DIR" ] && [ -d "$POSIX_DIR" ] && export PATH="$POSIX_DIR:$PATH"
        done
        _win_find_gh || true  # final fallback via cmd.exe
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
      echo "  Error: gh not found after install."
      echo "  Install manually: https://cli.github.com — then re-run vaultkit init."
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

[ -d "$VAULT_DIR" ] && { echo "Error: $VAULT_DIR already exists"; exit 1; }

GITHUB_USER=$(gh api user --jq '.login')
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

echo "[2/8] Creating vault: $VAULT_NAME"
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

// Pull latest changes silently — don't fail if offline or no remote.
spawnSync('git', ['pull', '--ff-only', '--quiet'], {
  cwd: __dirname,
  stdio: 'ignore',
});

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const r = spawnSync(npx, ['-y', 'obsidian-mcp-pro', '--vault', __dirname], {
  stdio: 'inherit',
});
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

# Deploy workflow
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
          cache: npm
          cache-dependency-path: .quartz/package-lock.json
      - name: Build Quartz
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
.quartz/node_modules/
.quartz/public/
.quartz/.quartz-cache/
.obsidian/
.DS_Store
EOF

# Clone and configure Quartz
echo "[3/8] Cloning Quartz (may take ~30s)..."
git clone --depth 1 https://github.com/jackyzha0/quartz .quartz
rm -rf .quartz/.git

echo "[4/8] Installing Quartz dependencies (may take ~60s)..."
(cd .quartz && npm install --silent)

node -e "
const fs = require('fs');
const p = '.quartz/quartz.config.ts';
let t = fs.readFileSync(p, 'utf8');
t = t.replace(/pageTitle: \"[^\"]+\"/, 'pageTitle: \"${VAULT_NAME}\"');
t = t.replace(/baseUrl: \"[^\"]+\"/, 'baseUrl: \"${BASE_URL}\"');
t = t.replace(
  /ignorePatterns: \[[^\]]+\]/,
  'ignorePatterns: [\"raw\", \".quartz\", \".github\", \"CLAUDE.md\", \"*.sh\"]'
);
fs.writeFileSync(p, t);
"

# Git init + commit
echo "[5/8] Committing initial files..."
git init
git branch -M main
git add .
git commit -m "chore: initialize ${VAULT_NAME}"

# Create GitHub repo (no push yet — Pages must be enabled first)
echo "[6/8] Creating GitHub repo: $VAULT_NAME ($REPO_VISIBILITY)..."
gh repo create "$VAULT_NAME" --"$REPO_VISIBILITY"
CREATED_REPO=true
git remote add origin "https://github.com/$GITHUB_USER/$VAULT_NAME.git"

# Enable GitHub Pages before the push triggers the deploy workflow
echo "[7/8] Enabling Pages and pushing..."
gh api "repos/$GITHUB_USER/$VAULT_NAME/pages" \
  --method POST -f build_type=workflow \
  >/dev/null 2>&1 || true

# Push — triggers deploy
git push -u origin main

# Protect main branch — force contributions through PRs
echo "[8/8] Protecting main branch..."
gh api "repos/$GITHUB_USER/$VAULT_NAME/branches/main/protection" \
  --method PUT \
  --input - >/dev/null << 'JSON'
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": {"required_approving_review_count": 1, "dismiss_stale_reviews": false},
  "restrictions": null
}
JSON

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
