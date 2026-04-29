---
name: debug-command
description: Debug a vaultkit command for issues
---

Help me debug the vaultkit command "$ARGUMENTS".

1. Read `vault-$ARGUMENTS.sh` in full.
2. Check for these common issues:
   - Missing `set -euo pipefail` or missing `. "$SCRIPT_DIR/lib/_helpers.sh"`
   - Unhandled / un-validated arguments — should call `vk_validate_vault_name` for vault names
   - Vault path resolution uses `vk_resolve_vault_dir` (MCP registry), not raw user input or filesystem fallbacks for destructive ops
   - Windows paths converted via `vk_to_posix` / `vk_to_windows` (not raw `cygpath`)
   - MCP registration includes `--expected-sha256=<hash>` (re-check after `claude mcp add` calls)
   - `gh` or `claude` calls that assume the binary is on PATH — `vault-init.sh` shows the probe pattern for first-time `gh` discovery
   - Vault structure check (`vk_is_vault_like`) before any `rm -rf`
3. Show how to run the script directly for isolated testing:
   ```bash
   bash vault-$ARGUMENTS.sh [typical-args]
   ```
4. If `npm link` is not active, remind me to run `npm link` so I don't need to publish.
5. Report findings as a concise list: what's fine, what might be the issue.
