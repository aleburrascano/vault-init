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

# Look up vault path from MCP registry first
VAULT_DIR=$(node -e "
const fs = require('fs');
const path = require('path');
const file = process.argv[1];
const name = process.argv[2];
if (!fs.existsSync(file)) process.exit(1);
let config;
try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { process.exit(1); }
const s = (config.mcpServers || {})[name];
if (!s || !s.args) process.exit(1);
const scriptArg = s.args.find(a => String(a).endsWith('.mcp-start.js'));
if (!scriptArg) process.exit(1);
console.log(path.dirname(scriptArg));
" "$CLAUDE_JSON" "$VAULT_NAME" 2>/dev/null) || VAULT_DIR=""

# Fall back to default location with identity check
if [ -z "$VAULT_DIR" ]; then
  VAULT_DIR="${VAULTKIT_HOME:-$HOME/vaults}/$VAULT_NAME"
  if ! [ -d "$VAULT_DIR" ]; then
    echo "Error: '$VAULT_NAME' not found in MCP registry or at $VAULT_DIR"
    echo "Run 'vaultkit list' to see registered vaults."
    exit 1
  fi
  if ! [ -f "$VAULT_DIR/CLAUDE.md" ] || ! [ -d "$VAULT_DIR/raw" ] || ! [ -d "$VAULT_DIR/wiki" ]; then
    if ! [ -d "$VAULT_DIR/.obsidian" ]; then
      echo "Error: $VAULT_DIR does not look like a vaultkit vault — aborting."
      exit 1
    fi
  fi
fi

# Convert Windows path to POSIX for bash file operations
if command -v cygpath >/dev/null 2>&1 && [[ "$VAULT_DIR" =~ ^[A-Za-z]: ]]; then
  VAULT_DIR_POSIX=$(cygpath -u "$VAULT_DIR")
else
  VAULT_DIR_POSIX="$VAULT_DIR"
fi

echo "Updating $VAULT_NAME at $VAULT_DIR..."

BEFORE_HASH=""
if [ -f "$VAULT_DIR_POSIX/.mcp-start.js" ]; then
  BEFORE_HASH=$(node -e "
const c=require('crypto'),fs=require('fs');
console.log(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'));
" "$VAULT_DIR_POSIX/.mcp-start.js" 2>/dev/null || echo "")
  echo "  Current .mcp-start.js SHA-256: $BEFORE_HASH"
fi
echo ""
read -r -p "Update .mcp-start.js to the latest version? [y/N] " _CONFIRM
if ! [[ "${_CONFIRM:-}" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi
echo ""

cat > "$VAULT_DIR_POSIX/.mcp-start.js" << 'JS'
#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');

// Pull latest changes silently — don't fail if offline or no remote.
// 5-second timeout prevents hanging on slow networks at startup.
spawnSync('git', ['pull', '--ff-only', '--quiet'], {
  cwd: __dirname,
  stdio: 'ignore',
  timeout: 5000,
});

// On Windows, npx ships as npx.cmd — a batch file that requires cmd.exe to
// run. spawnSync without shell:true passes the path directly to CreateProcess,
// which rejects .cmd files with EINVAL. Fix: prepend node's own directory to
// PATH (so cmd.exe can find npx) then spawn with shell:true.
if (process.platform === 'win32') {
  const nodeDir = path.dirname(process.execPath);
  process.env.PATH = nodeDir + ';' + (process.env.PATH || '');
}

const r = spawnSync('npx', ['-y', 'obsidian-mcp-pro', '--vault', __dirname], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (r.error) {
  process.stderr.write('[vaultkit] Failed to start MCP server: ' + r.error.message + '\n');
  process.stderr.write('[vaultkit] Check your Node.js installation and restart Claude Code.\n');
  process.exit(1);
}
process.exit(r.status ?? 1);
JS

AFTER_HASH=$(node -e "
const c=require('crypto'),fs=require('fs');
console.log(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'));
" "$VAULT_DIR_POSIX/.mcp-start.js" 2>/dev/null || echo "")

if [ "$AFTER_HASH" = "$BEFORE_HASH" ]; then
  echo "  .mcp-start.js is already up to date — nothing to commit."
  exit 0
fi

echo "  Updated .mcp-start.js"
echo "  New SHA-256: $AFTER_HASH"
echo ""

# Commit and push so git pull in .mcp-start.js doesn't revert the change
cd "$VAULT_DIR_POSIX"
git add .mcp-start.js
if git diff --cached --quiet; then
  echo "  Nothing staged — skipping commit."
  exit 0
fi

git commit -m "chore: update .mcp-start.js to latest vaultkit version"
echo ""

if git push 2>&1; then
  echo "Done. Restart Claude Code to apply the update."
else
  echo "  Push failed (branch may be protected). Open a pull request:"
  echo "  https://github.com/$(git remote get-url origin | sed 's|.*github.com[:/]||;s|\.git$||')/compare/main...$(git branch --show-current)"
fi
