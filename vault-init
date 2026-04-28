#!/usr/bin/env bash
# Create a new Obsidian wiki vault with Quartz + GitHub Pages, fully automated.
#
# Usage:   vault-init <vault-name> [--private]
# Example: vault-init my-cooking-wiki
#
# Install: bash <(curl -fsSL https://raw.githubusercontent.com/aleburrascano/vault-init/main/install.sh)
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: vault-init <vault-name> [--private]"
  exit 1
fi

VAULT_NAME="$1"
REPO_VISIBILITY="public"
[ "${2:-}" = "--private" ] && REPO_VISIBILITY="private"

VAULT_DIR="$(pwd)/$VAULT_NAME"

for cmd in git node npm gh; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Error: '$cmd' not found"; exit 1; }
done
gh auth status >/dev/null 2>&1 || { echo "Not logged in. Run: gh auth login"; exit 1; }
[ -d "$VAULT_DIR" ] && { echo "Error: $VAULT_DIR already exists"; exit 1; }

GITHUB_USER=$(gh api user --jq '.login')
BASE_URL="$GITHUB_USER.github.io/$VAULT_NAME"

echo "Creating vault: $VAULT_NAME"
mkdir -p "$VAULT_DIR"
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
- **Always** scope \`search_notes\` to \`folder: "wiki"\` or \`folder: "raw"\` — unscoped searches hit \`site/node_modules\` noise.

## You do NOT
- Modify \`raw/\` (immutable).
- Delete wiki pages without confirmation.
- Fabricate sources or citations.
- Skip the log.
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
          cache-dependency-path: site/package-lock.json
      - name: Build Quartz
        run: cd site && npm ci && npx quartz build --directory ../
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site/public

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
site/node_modules/
site/public/
site/.quartz-cache/
.obsidian/
.DS_Store
EOF

# Clone and configure Quartz
echo "Cloning Quartz..."
git clone --depth 1 https://github.com/jackyzha0/quartz site
rm -rf site/.git

echo "Installing Quartz dependencies..."
(cd site && npm install --silent)

node -e "
const fs = require('fs');
const p = 'site/quartz.config.ts';
let t = fs.readFileSync(p, 'utf8');
t = t.replace(/pageTitle: \"[^\"]+\"/, 'pageTitle: \"${VAULT_NAME}\"');
t = t.replace(/baseUrl: \"[^\"]+\"/, 'baseUrl: \"${BASE_URL}\"');
t = t.replace(
  /ignorePatterns: \[[^\]]+\]/,
  'ignorePatterns: [\"raw\", \"site\", \".github\", \"CLAUDE.md\", \"*.sh\"]'
);
fs.writeFileSync(p, t);
"

# Git init + commit
git init
git branch -M main
git add .
git commit -m "chore: initialize ${VAULT_NAME}"

# Create GitHub repo (no push yet — Pages must be enabled first)
echo "Creating GitHub repo: $VAULT_NAME"
gh repo create "$VAULT_NAME" --"$REPO_VISIBILITY"
git remote add origin "https://github.com/$GITHUB_USER/$VAULT_NAME.git"

# Enable GitHub Pages before the push triggers the deploy workflow
echo "Enabling GitHub Pages..."
gh api "repos/$GITHUB_USER/$VAULT_NAME/pages" \
  --method POST -f build_type=workflow \
  2>/dev/null || true

# Push — triggers deploy
git push -u origin main

# Protect main branch — force contributions through PRs
echo "Protecting main branch..."
gh api "repos/$GITHUB_USER/$VAULT_NAME/branches/main/protection" \
  --method PUT \
  --input - << 'JSON'
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": {"required_approving_review_count": 1, "dismiss_stale_reviews": false},
  "restrictions": null
}
JSON

# Register as a user-level MCP server (Claude Code users only)
if command -v claude >/dev/null 2>&1; then
  echo "Registering MCP server: $VAULT_NAME"
  claude mcp add "$VAULT_NAME" npx -y obsidian-mcp-pro --vault "$VAULT_DIR" -s user
else
  echo "Note: Claude Code not found — skipping MCP registration."
  echo "      Once installed, run:"
  echo "      claude mcp add $VAULT_NAME npx -y obsidian-mcp-pro --vault $VAULT_DIR -s user"
fi

echo ""
echo "Repository: https://github.com/$GITHUB_USER/$VAULT_NAME"
echo "Site (live in ~1 min): https://$BASE_URL"
echo "Vault created at: $VAULT_DIR"
