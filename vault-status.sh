#!/usr/bin/env bash
# Show per-vault git state: branch, ahead/behind, dirty flag, last commit.
#
# Usage: vaultkit status            (one line per vault)
#        vaultkit status <name>     (detailed status for one vault)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/_helpers.sh"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: vaultkit status [<vault-name>]

Without args: one-line summary per registered vault (branch, ahead/behind, dirty).
With a name:  detailed `git status` for that vault.
EOF
  exit 0
fi

CLAUDE_JSON=$(vk_claude_json)

if [ $# -ge 1 ]; then
  VAULT_NAME="$1"
  vk_validate_vault_name "$VAULT_NAME" || exit 1
  VAULT_DIR=$(vk_resolve_vault_dir "$VAULT_NAME") || {
    vk_error "'$VAULT_NAME' is not a registered vaultkit vault."
    exit 1
  }
  VAULT_DIR_POSIX=$(vk_to_posix "$VAULT_DIR")
  if ! [ -d "$VAULT_DIR_POSIX/.git" ]; then
    vk_error "$VAULT_DIR_POSIX is not a git repository."
    exit 1
  fi
  echo "Vault: $VAULT_NAME"
  echo "Path:  $VAULT_DIR_POSIX"
  echo ""
  git -C "$VAULT_DIR_POSIX" status
  exit 0
fi

# Summary mode — iterate via node so JSON parsing stays consistent.
node -e "
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const file = process.argv[1];
if (!fs.existsSync(file)) { console.log('No vaults registered.'); process.exit(0); }

let config;
try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch { console.error('Error: could not parse .claude.json'); process.exit(1); }

const servers = config.mcpServers || {};
const vaults = Object.entries(servers).filter(([, s]) =>
  s.args && s.args.some(a => String(a).endsWith('.mcp-start.js'))
);
if (vaults.length === 0) { console.log('No vaults registered.'); process.exit(0); }
vaults.sort(([a], [b]) => a.localeCompare(b));

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

const w = Math.max(...vaults.map(([n]) => n.length));
console.log('');
for (const [name, s] of vaults) {
  const scriptArg = s.args.find(a => String(a).endsWith('.mcp-start.js'));
  const dir = path.dirname(scriptArg);
  if (!fs.existsSync(dir)) {
    console.log(name.padEnd(w) + '  [DIR MISSING]');
    continue;
  }
  if (!fs.existsSync(path.join(dir, '.git'))) {
    console.log(name.padEnd(w) + '  [not a git repo]');
    continue;
  }
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) || '?';
  const dirty = git(dir, ['status', '--porcelain']).length > 0 ? 'dirty' : 'clean';
  let trail = '';
  if (git(dir, ['rev-parse', '--abbrev-ref', '@{u}'])) {
    const ahead = git(dir, ['rev-list', '--count', '@{u}..HEAD']) || '0';
    const behind = git(dir, ['rev-list', '--count', 'HEAD..@{u}']) || '0';
    if (ahead !== '0' || behind !== '0') {
      trail = '  [ahead ' + ahead + ', behind ' + behind + ']';
    }
  } else {
    trail = '  [no upstream]';
  }
  const last = git(dir, ['log', '-1', '--format=%h %s']) || '(no commits)';
  console.log(name.padEnd(w) + '  ' + branch + '  ' + dirty + trail + '  — ' + last);
}
console.log('');
" "$CLAUDE_JSON"
