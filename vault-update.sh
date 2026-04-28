#!/usr/bin/env bash
# Update system files in a vault to the latest vaultkit version.
#
# Usage: vaultkit update <vault-name>
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: vaultkit update <vault-name>"
  exit 1
fi

VAULT_NAME="$1"

if command -v cygpath >/dev/null 2>&1; then
  CLAUDE_JSON=$(cygpath -m "$HOME/.claude.json")
else
  CLAUDE_JSON="$HOME/.claude.json"
fi

# Find vault path from MCP registration first, fall back to CWD/<name>
VAULT_DIR=$(node -e "
const fs = require('fs');
const path = require('path');
const file = process.argv[1];
const name = process.argv[2];
if (!fs.existsSync(file)) process.exit(1);
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const s = (config.mcpServers || {})[name];
if (!s || !s.args) process.exit(1);
const scriptArg = s.args.find(a => String(a).endsWith('.mcp-start.js'));
if (!scriptArg) process.exit(1);
console.log(path.dirname(scriptArg));
" "$CLAUDE_JSON" "$VAULT_NAME" 2>/dev/null) || VAULT_DIR="${VAULT_INIT_CWD:-$(pwd)}/$VAULT_NAME"

if ! [ -d "$VAULT_DIR" ]; then
  echo "Error: vault not found at $VAULT_DIR"
  exit 1
fi

echo "Updating $VAULT_NAME..."

cat > "$VAULT_DIR/.mcp-start.js" << 'JS'
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

echo "  Updated .mcp-start.js"
echo ""
echo "Commit and push to apply:"
echo "  cd \"$VAULT_DIR\" && git add .mcp-start.js && git commit -m 'chore: update mcp-start.js' && git push"
