#!/usr/bin/env bash
# Pull latest changes in all registered vaults.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/_helpers.sh"

CLAUDE_JSON=$(vk_claude_json)

node -e "
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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

let synced = 0;
let skipped = 0;

for (const [name, s] of vaults) {
  const scriptArg = s.args.find(a => String(a).endsWith('.mcp-start.js'));
  const vaultDir = path.dirname(scriptArg);

  if (!fs.existsSync(vaultDir)) {
    console.log(name + ': directory missing — run: vaultkit connect <owner/' + name + '>');
    skipped++;
    continue;
  }

  const r = spawnSync('git', ['pull', '--ff-only', '--quiet'], {
    cwd: vaultDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
  });

  if (r.signal === 'SIGTERM' || (r.error && r.error.code === 'ETIMEDOUT')) {
    console.log(name + ': pull timed out — check your network connection');
    skipped++;
    continue;
  }

  if (r.status === 0) {
    const out = (r.stdout || '').trim();
    console.log(name + ': ' + (out || 'already up to date'));
    synced++;
  } else {
    const err = (r.stderr || '').trim();
    console.log(name + ': pull failed');
    if (err) console.log('  ' + err);
    console.log('  Fix: cd \"' + vaultDir + '\" && git status');
    skipped++;
  }
}

console.log('');
console.log(synced + ' vault(s) synced, ' + skipped + ' skipped.');
" "$CLAUDE_JSON"
