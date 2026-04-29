# Testing Rules

Test runner: `npm test` (runs `check` + `lint`)
Test command breakdown:
- `node --check bin/vaultkit.js` — syntax check the dispatcher
- `node -e "..." lib/mcp-start.js.tmpl` — syntax check the launcher template
- `shellcheck -x vault-*.sh install.sh lib/_helpers.sh` — lint all bash scripts

## Testing discipline

- Syntax errors must be caught before submission — the CI gate runs `npm test`.
- Added bash scripts must pass `shellcheck` with no warnings.
- Node.js files must have valid syntax (`node --check`).
- Template files (`.tmpl`) must parse as valid JavaScript when executed.
- After any bash script edit: run `npm test` before committing.
- After any Node.js file edit: run `npm test` before committing.

## Sacred tests rule

The CI suite is read-only. Never skip tests or modify test logic to make something pass. Fix the implementation.
