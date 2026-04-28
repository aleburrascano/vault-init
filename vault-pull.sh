#!/usr/bin/env bash
# Pull latest changes in all registered vaults.
set -euo pipefail

if command -v cygpath >/dev/null 2>&1; then
  CLAUDE_JSON=$(cygpath -m "$HOME/.claude.json")
else
  CLAUDE_JSON="$HOME/.claude.json"
fi

node -e "
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const file = process.argv[1];
if (!fs.existsSync(file)) { console.log('No vaults registered.'); process.exit(0); }

const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const servers = config.mcpServers || {};
const vaults = Object.entries(servers).filter(([, s]) =>
  s.args && s.args.some(a => String(a).endsWith('.mcp-start.js'))
);

if (vaults.length === 0) { console.log('No vaults registered.'); process.exit(0); }

let synced = 0;
let skipped = 0;

for (const [name, s] of vaults) {
  const scriptArg = s.args.find(a => String(a).endsWith('.mcp-start.js'));
  const vaultDir = path.dirname(scriptArg);

  if (!fs.existsSync(vaultDir)) {
    console.log(name + ': directory missing — skipping');
    skipped++;
    continue;
  }

  const r = spawnSync('git', ['pull', '--ff-only', '--quiet'], {
    cwd: vaultDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (r.status === 0) {
    const out = (r.stdout || '').trim();
    console.log(name + ': ' + (out || 'already up to date'));
    synced++;
  } else {
    console.log(name + ': pull failed — ' + (r.stderr || '').trim());
    skipped++;
  }
}

console.log('');
console.log(synced + ' vault(s) synced, ' + skipped + ' skipped.');
" "$CLAUDE_JSON"
