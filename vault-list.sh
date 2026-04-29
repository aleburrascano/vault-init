#!/usr/bin/env bash
# List all vaultkit-managed MCP servers.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/_helpers.sh"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: vaultkit list

Show every registered vaultkit vault with its directory, remote URL, and
pinned launcher SHA-256.
EOF
  exit 0
fi

CLAUDE_JSON=$(vk_claude_json)

node -e "
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const file = process.argv[1];
if (!fs.existsSync(file)) { console.log('No vaults registered.'); process.exit(0); }

let config;
try {
  config = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {
  console.error('Error: could not parse .claude.json');
  process.exit(1);
}

const servers = config.mcpServers || {};
const vaults = Object.entries(servers).filter(([, s]) =>
  s.args && s.args.some(a => String(a).endsWith('.mcp-start.js'))
);

if (vaults.length === 0) { console.log('No vaults registered.'); process.exit(0); }

vaults.sort(([a], [b]) => a.localeCompare(b));

console.log('');
for (const [name, s] of vaults) {
  const scriptArg = s.args.find(a => String(a).endsWith('.mcp-start.js'));
  const vaultDir = path.dirname(scriptArg);
  const exists = fs.existsSync(vaultDir);
  const pinnedArg = s.args.find(a => typeof a === 'string' && a.startsWith('--expected-sha256='));
  const pinned = pinnedArg ? pinnedArg.slice('--expected-sha256='.length) : null;
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
  if (pinned) {
    console.log('  pinned SHA-256: ' + pinned);
  } else if (exists) {
    console.log('  pinned SHA-256: (none — run \`vaultkit update ' + name + '\` to enable verification)');
  }
  console.log('');
}
" "$CLAUDE_JSON"
