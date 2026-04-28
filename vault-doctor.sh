#!/usr/bin/env bash
# Check environment and vault health.
set -uo pipefail

ISSUES=0
ok()   { echo "  + $1"; }
warn() { echo "  ! $1"; }
fail() { echo "  x $1"; ISSUES=$((ISSUES + 1)); }

echo "Prerequisites"
echo "-------------"

if command -v git >/dev/null 2>&1; then
  ok "git $(git --version | awk '{print $3}')"
else
  fail "git not found — install from https://git-scm.com"
fi

if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node --version | tr -d 'v')
  MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  if [ "$MAJOR" -ge 22 ]; then
    ok "node v$NODE_VER"
  else
    fail "node v$NODE_VER — vaultkit requires Node.js 22+"
  fi
else
  fail "node not found — install from https://nodejs.org"
fi

if command -v gh >/dev/null 2>&1; then
  ok "gh $(gh --version | head -1 | awk '{print $3}')"
  if gh auth status >/dev/null 2>&1; then
    GH_USER=$(gh api user --jq '.login' 2>/dev/null || echo "unknown")
    ok "gh authenticated as $GH_USER"
  else
    fail "gh not authenticated — run: gh auth login"
  fi
else
  warn "gh not installed — required for vaultkit init and destroy"
fi

if command -v claude >/dev/null 2>&1; then
  ok "claude code CLI"
else
  warn "claude not installed — MCP registration will be skipped"
fi

if git config user.name >/dev/null 2>&1 && git config user.email >/dev/null 2>&1; then
  ok "git identity: $(git config user.name) <$(git config user.email)>"
else
  fail "git identity not configured — run: git config --global user.name 'Your Name'"
fi

echo ""
echo "Registered Vaults"
echo "-----------------"

if command -v cygpath >/dev/null 2>&1; then
  CLAUDE_JSON=$(cygpath -m "$HOME/.claude.json")
else
  CLAUDE_JSON="$HOME/.claude.json"
fi

VAULT_ISSUES=0
node -e "
const fs = require('fs');
const path = require('path');

const file = process.argv[1];
if (!fs.existsSync(file)) { console.log('  No vaults registered.'); process.exit(0); }

const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const servers = config.mcpServers || {};
const vaults = Object.entries(servers).filter(([, s]) =>
  s.args && s.args.some(a => String(a).endsWith('.mcp-start.js'))
);

if (vaults.length === 0) { console.log('  No vaults registered.'); process.exit(0); }

let issues = 0;
for (const [name, s] of vaults) {
  const scriptArg = s.args.find(a => String(a).endsWith('.mcp-start.js'));
  const vaultDir = path.dirname(scriptArg);
  if (!fs.existsSync(vaultDir)) {
    console.log('  x ' + name + ' — local directory missing');
    console.log('      Fix: vaultkit connect <owner/' + name + '>');
    issues++;
  } else if (!fs.existsSync(path.join(vaultDir, '.mcp-start.js'))) {
    console.log('  ! ' + name + ' — missing .mcp-start.js (created with old vault-init)');
    console.log('      Fix: vaultkit update ' + name);
    issues++;
  } else {
    console.log('  + ' + name + '  (' + vaultDir + ')');
  }
}
process.exit(issues);
" "$CLAUDE_JSON" || VAULT_ISSUES=$?

ISSUES=$((ISSUES + VAULT_ISSUES))

echo ""
if [ "$ISSUES" -eq 0 ]; then
  echo "Everything looks good."
else
  echo "$ISSUES issue(s) found — address the items marked with x above."
  exit 1
fi
