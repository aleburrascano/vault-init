#!/usr/bin/env bash
# Show registered vaults — registry data (path, remote, pinned SHA) plus git
# state (branch, dirty, ahead/behind, last commit).
#
# Usage: vaultkit status            (multi-line summary per vault)
#        vaultkit status <name>     (detailed `git status` for one vault)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/_helpers.sh"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: vaultkit status [<vault-name>]

Without args: per-vault summary — directory, remote, pinned SHA-256, branch
              + dirty/ahead/behind state, and last commit.
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

console.log('');
for (const [name, s] of vaults) {
  const scriptArg = s.args.find(a => String(a).endsWith('.mcp-start.js'));
  const dir = path.dirname(scriptArg);
  const exists = fs.existsSync(dir);
  const pinnedArg = s.args.find(a => typeof a === 'string' && a.startsWith('--expected-sha256='));
  const pinned = pinnedArg ? pinnedArg.slice('--expected-sha256='.length) : null;

  console.log(name + (exists ? '' : '  [DIR MISSING]'));
  console.log('  ' + dir);

  if (!exists) { console.log(''); continue; }

  let remote = '';
  try {
    remote = git(dir, ['remote', 'get-url', 'origin']);
  } catch {}
  if (remote) console.log('  ' + remote);

  if (!fs.existsSync(path.join(dir, '.git'))) {
    console.log('  branch:  [not a git repo]');
  } else {
    const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) || '?';
    const dirty = git(dir, ['status', '--porcelain']).length > 0 ? 'dirty' : 'clean';
    let trail = '';
    if (git(dir, ['rev-parse', '--abbrev-ref', '@{u}'])) {
      const ahead = git(dir, ['rev-list', '--count', '@{u}..HEAD']) || '0';
      const behind = git(dir, ['rev-list', '--count', 'HEAD..@{u}']) || '0';
      if (ahead !== '0' || behind !== '0') {
        trail = ' [ahead ' + ahead + ', behind ' + behind + ']';
      }
    } else {
      trail = ' [no upstream]';
    }
    console.log('  branch:  ' + branch + ' (' + dirty + ')' + trail);
    const last = git(dir, ['log', '-1', '--format=%h %s']);
    if (last) console.log('  last:    ' + last);
  }

  if (pinned) {
    console.log('  pinned:  ' + pinned);
  } else {
    console.log('  pinned:  (none — run \`vaultkit update ' + name + '\`)');
  }
  console.log('');
}
" "$CLAUDE_JSON"
