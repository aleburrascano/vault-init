---
name: add-command
description: Scaffold a new vaultkit command
---

Scaffold a new vaultkit command called "$ARGUMENTS".

1. Read `vault-list.sh` as the reference (simplest script that uses the shared helpers).
2. Create `vault-$ARGUMENTS.sh` at the repo root with this header:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
   . "$SCRIPT_DIR/lib/_helpers.sh"
   ```
3. If the command takes a vault name, validate it via `vk_validate_vault_name "$VAULT_NAME" || exit 1`.
4. If the command needs the vault directory, resolve via `VAULT_DIR=$(vk_resolve_vault_dir "$VAULT_NAME") || { vk_error "..."; exit 1; }`. Don't fall back to filesystem guesses for destructive ops.
5. Add a `# TODO: implement $ARGUMENTS logic` placeholder.
6. In `bin/vaultkit.js`:
   - Add `"$ARGUMENTS": 'vault-$ARGUMENTS.sh'` to the `COMMANDS` object.
   - Add a row describing the new command to the `HELP` constant.
7. In `package.json`, add `"vault-$ARGUMENTS.sh"` to the `files` array.
8. Update `README.md` with the new command in the Commands table.
9. Add an entry under `## [Unreleased]` in `CHANGELOG.md`.
10. Show a summary of all changes made.
11. Remind: if `npm link` is active, `vaultkit $ARGUMENTS` is immediately testable. Run `npm test` to lint + parse-check before committing.
