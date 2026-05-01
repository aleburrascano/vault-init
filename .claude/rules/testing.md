# Testing Rules

Test runner: `npm test` (runs vitest in single-pass mode against the TypeScript source directly — no build needed for tests).
Watch mode: `npm run test:watch`

**Tests are always live.** As of v2.5.0 there is no `VAULTKIT_LIVE_TEST` env-gate — every `npm test` run hits the real GitHub API and creates ephemeral `vk-live-*` repos against the authenticated `gh` account. Files are run sequentially (`fileParallelism: false` in `vitest.config.ts`) to avoid `~/.claude.json` write races. CI runs the same suite using a dedicated PAT (`VAULTKIT_TEST_GH_TOKEN`) — see `.github/workflows/ci.yml`.

Local prerequisites for `npm test` to pass:
- `gh auth status` works (run `gh auth login` if not).
- `gh` has `delete_repo` scope, otherwise the destroy live test will throw `AUTH_REQUIRED`. One-time fix: `gh auth refresh -h github.com -s delete_repo`.

Test files live in `tests/` and mirror the source tree:
- `tests/lib/` — unit tests for `src/lib/*.ts` modules
- `tests/commands/` — integration tests for `src/commands/*.ts`. Many commands have both `<name>.test.ts` (real-world integration) and `<name>-mocked.test.ts` (vi.mock-based unit tests).
- `tests/helpers/` — shared test utilities:
  - `logger.ts` — `silent` (no-op `Logger` singleton) and `arrayLogger(lines: string[])` (capture-style `Logger` for assertion checks). Use instead of inline `log: () => {}` or `log: (m) => arr.push(m)` — those don't satisfy the `Logger` interface.
  - `registry.ts` — `writeCfg(cfgPath, vaults)` writes a fake `~/.claude.json` with populated `mcpServers`. Accepts either `name → dir` shorthand or `name → { dir, hash? }` per vault. Use instead of hand-rolling `mcpServers` JSON in each test.
  - `git.ts` — `mockGitConfig({ name?, email? })` swaps the execa mock with a stub that responds to `git config user.name` / `user.email` and treats `gh auth status` as authenticated. Use only when those calls are the test's full execa surface; multi-handler tests keep their own inline `mockImplementation`.

## Testing discipline

- After any file edit: run `npm test` before committing.
- Type errors are caught by `npm run check` (`tsc --noEmit`). Run before committing on any TS change.
- Template files (`.tmpl`) are validated by their consumers — `mcp-start.js.tmpl` must parse as valid JavaScript when executed by the spawned Node process. End-to-end behavior of the launcher (SHA-256 self-verification, refuse-to-merge on upstream tampering, `.obsidian/` stub creation) is covered by `tests/lib/launcher-integration.test.ts`, which spawns the template as a real Node process against fixture vaults.
- Use vitest's built-in mocking (`vi.mock`, `vi.spyOn`) for external dependencies (git, gh, fs).
- For typed mocks, prefer `await importOriginal<typeof import('module')>()` so the `...real` spread is typed.
- For `vi.mocked(execa).mockImplementation(...)` and `mockResolvedValue(...)`, use `(async (...) => ({...})) as never` to satisfy execa's overloaded Result type.

## Sacred tests rule

Test files are read-only unless explicitly instructed. If a test is failing, fix the implementation, not the test. "The test was wrong" requires explicit human confirmation.
