#!/usr/bin/env bash
# Print vaultkit version, runtime info, and registered vault count.
#
# Usage: vaultkit version
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/_helpers.sh"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: vaultkit version

Prints the installed vaultkit version, Node.js version, platform, and the
number of registered vaults. Useful for bug reports.
EOF
  exit 0
fi

CLAUDE_JSON=$(vk_claude_json)

node -e "
const fs = require('fs');
const path = require('path');

const pkgPath = path.join(process.argv[1], 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const cfgPath = process.argv[2];
let count = 0;
if (fs.existsSync(cfgPath)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const servers = cfg.mcpServers || {};
    count = Object.values(servers).filter(s =>
      s && s.args && s.args.some(a => String(a).endsWith('.mcp-start.js'))
    ).length;
  } catch {}
}

console.log('vaultkit  ' + pkg.version);
console.log('node      ' + process.version);
console.log('platform  ' + process.platform + ' ' + process.arch);
console.log('vaults    ' + count + ' registered');
" "$SCRIPT_DIR" "$CLAUDE_JSON"
