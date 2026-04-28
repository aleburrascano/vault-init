#!/usr/bin/env bash
# List all vaultkit-managed MCP servers.
set -euo pipefail

# Resolve .claude.json (Windows needs a Windows-format path for Node.js)
if command -v cygpath >/dev/null 2>&1; then
  CLAUDE_JSON=$(cygpath -m "$HOME/.claude.json")
else
  CLAUDE_JSON="$HOME/.claude.json"
fi

node -e "
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const file = process.argv[1];
if (!fs.existsSync(file)) { console.log('No vaults registered.'); process.exit(0); }

const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const servers = config.mcpServers || {};

const vaults = Object.entries(servers).filter(([, s]) =>
  s.args && s.args.some(a => String(a).endsWith('.mcp-start.js'))
);

if (vaults.length === 0) { console.log('No vaults registered.'); process.exit(0); }

console.log('');
for (const [name, s] of vaults) {
  const scriptArg = s.args.find(a => String(a).endsWith('.mcp-start.js'));
  const vaultDir = path.dirname(scriptArg);
  const exists = fs.existsSync(vaultDir);
  let remote = '';
  if (exists) {
    try {
      remote = execSync('git remote get-url origin', {
        cwd: vaultDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {}
  }
  console.log(name + (exists ? '' : '  [DIR MISSING]'));
  console.log('  ' + vaultDir);
  if (remote) console.log('  ' + remote);
  console.log('');
}
" "$CLAUDE_JSON"
