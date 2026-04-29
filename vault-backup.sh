#!/usr/bin/env bash
# Create a local zip snapshot of a vault's tracked content.
#
# Uses `git archive HEAD` so the zip is self-contained and reproducible.
# Uncommitted changes are NOT included — commit first if you want them.
#
# Usage: vaultkit backup <vault-name>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/_helpers.sh"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: vaultkit backup <vault-name>

Creates a zip snapshot at $VAULTKIT_HOME/.backups/<name>-<timestamp>.zip via
`git archive HEAD`. Uncommitted changes are NOT included — commit first.
EOF
  exit 0
fi

if [ $# -eq 0 ]; then
  echo "Usage: vaultkit backup <vault-name>"
  exit 1
fi

VAULT_NAME="$1"
vk_validate_vault_name "$VAULT_NAME" || exit 1

VAULT_DIR=$(vk_resolve_vault_dir "$VAULT_NAME") || {
  vk_error "'$VAULT_NAME' is not a registered vaultkit vault."
  exit 1
}
VAULT_DIR_POSIX=$(vk_to_posix "$VAULT_DIR")

if ! [ -d "$VAULT_DIR_POSIX/.git" ]; then
  vk_error "$VAULT_DIR_POSIX is not a git repository — cannot create archive."
  exit 1
fi

# Warn (don't fail) on uncommitted changes — backup may be intentional pre-commit safety net.
if [ -n "$(git -C "$VAULT_DIR_POSIX" status --porcelain)" ]; then
  vk_warning "Vault has uncommitted changes — they will NOT be in the backup."
  echo "  To include them, commit first: cd $VAULT_DIR_POSIX && git add -A && git commit" >&2
  echo ""
fi

VAULTS_ROOT="${VAULTKIT_HOME:-$HOME/vaults}"
BACKUP_DIR="$VAULTS_ROOT/.backups"
mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$BACKUP_DIR/$VAULT_NAME-$TIMESTAMP.zip"

echo "Archiving $VAULT_NAME → $BACKUP_FILE..."
git -C "$VAULT_DIR_POSIX" archive --format=zip --output="$BACKUP_FILE" HEAD

if [ -f "$BACKUP_FILE" ]; then
  SIZE=$(node -e "console.log(require('fs').statSync(process.argv[1]).size)" "$BACKUP_FILE")
  echo ""
  echo "Done."
  echo "  File: $BACKUP_FILE"
  echo "  Size: $SIZE bytes"
else
  vk_error "git archive completed but $BACKUP_FILE was not created."
  exit 1
fi
