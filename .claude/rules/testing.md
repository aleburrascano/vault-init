# Testing Rules

Test runner: `npm test` (runs vitest in single-pass mode against the TypeScript source directly — no build needed for tests).
Watch mode: `npm run test:watch`
Live (real GitHub API): `npm run test:live` — gated behind `VAULTKIT_LIVE_TEST=1`, runs sequentially to avoid `~/.claude.json` write races.

Test files live in `tests/` and mirror the source tree:
- `tests/lib/` — unit tests for `src/lib/*.ts` modules
- `tests/commands/` — integration tests for `src/commands/*.ts`. Many commands have both `<name>.test.ts` (real-world integration) and `<name>-mocked.test.ts` (vi.mock-based unit tests).
- `tests/helpers/` — shared test utilities. Currently `logger.ts` exposes `silent` (no-op `Logger` singleton) and `arrayLogger(lines: string[])` (capture-style `Logger` for assertion checks). Use these instead of inline `log: () => {}` or `log: (m) => arr.push(m)` — those don't satisfy the `Logger` interface added in v2.1.0.

## Testing discipline

- After any file edit: run `npm test` before committing.
- Type errors are caught by `npm run check` (`tsc --noEmit`). Run before committing on any TS change.
- Template files (`.tmpl`) are validated by their consumers — `mcp-start.js.tmpl` must parse as valid JavaScript when executed by the spawned Node process.
- Use vitest's built-in mocking (`vi.mock`, `vi.spyOn`) for external dependencies (git, gh, fs).
- For typed mocks, prefer `await importOriginal<typeof import('module')>()` so the `...real` spread is typed.
- For `vi.mocked(execa).mockImplementation(...)` and `mockResolvedValue(...)`, use `(async (...) => ({...})) as never` to satisfy execa's overloaded Result type.

## Sacred tests rule

Test files are read-only unless explicitly instructed. If a test is failing, fix the implementation, not the test. "The test was wrong" requires explicit human confirmation.
