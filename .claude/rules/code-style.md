---
paths:
  - "vault-*.sh"
  - "lib/_helpers.sh"
  - "bin/vaultkit.js"
  - "install.sh"
---

# Code Style

## Bash (vault-*.sh, lib/_helpers.sh, install.sh)

- Use `set -euo pipefail` at the top of every script.
- Use UPPERCASE for internal variables; lowercase for function parameters.
- Quote all variables: `"$VAR"` not `$VAR` (prevents word splitting).
- Prefer helpers from `lib/_helpers.sh` over inline code — consistency saves bugs.
- Error messages go to stderr via `vk_error`, `vk_warning`, `vk_note`.
- Exit non-zero on errors; exit 0 on success.
- Use the vault structure check `vk_is_vault_like` before any `rm -rf`.
- Windows paths must go through `vk_to_posix` / `vk_to_windows` helpers.
- No `cygpath` calls directly — always use the helpers.

## JavaScript (bin/vaultkit.js)

- No npm dependencies — use Node.js built-ins only.
- Use `import` statements (module type is "module" in package.json).
- Command dispatch is a static COMMANDS map — no dynamic requires.
- Validate input (vault names) before spawning scripts.
- Probe for `gh` and `claude` tools; don't assume they're on PATH (especially Windows).
- Exit with non-zero status on error.

## Templates (lib/mcp-start.js.tmpl, lib/deploy.yml.tmpl)

- Templates are copied verbatim by scripts — no preprocessing.
- Keep them small and focused (they live in vaults).
- `.mcp-start.js.tmpl` must parse as valid JavaScript when executed.
- Never inline the template into scripts — always `cp` it from the source.
