---
paths:
  - "tests/**/*.ts"
  - "src/**/*.ts"
  - "vitest.config.ts"
  - "package.json"
---

# Testing Rules

Test runner: `npm test` (runs vitest in single-pass mode against the TypeScript source directly — no build needed for tests).
Watch mode: `npm run test:watch`

For coverage audits and finding missing tests across this codebase, invoke [`/test [target]`](../commands/test.md) — the testing-expert command/skill that dispatches six parallel sub-reviewers (unit / mocked-integration / e2e / edge cases / security / cross-platform) and produces a priority-ranked coverage report. It auto-triggers on prompts about edge cases, coverage gaps, or test types, so most of the time you don't need to invoke it explicitly.

**Tests are always live.** As of v2.5.0 there is no `VAULTKIT_LIVE_TEST` env-gate — every `npm test` run hits the real GitHub API and creates ephemeral `vk-live-*` repos against the authenticated `gh` account. Files are run sequentially (`fileParallelism: false` in `vitest.config.ts`) to avoid `~/.claude.json` write races. CI rotates between two dedicated PATs (`VAULTKIT_TEST_GH_TOKEN_A` / `_B`) round-robin via `GITHUB_RUN_NUMBER % 2` — see `.github/workflows/main.yml`'s "Select test PAT" step. The `vaultkit-live-tests` concurrency group ensures only one CI run touches either account at a time.

**Burst-rate hardening.** GitHub's secondary rate limit (~80 content-creating requests/minute) is the hard ceiling for live-test throughput. Three structural defenses keep us under it:
- **Live tests skip on Windows** via `liveDescribe` (from `tests/helpers/live-describe.ts`). The 5 GitHub-touching live blocks (`init`, `destroy`, `connect`, `disconnect`, `visibility`) run only on the Ubuntu CI leg — Windows still gets the full mocked + check + build coverage.
- **`status` and `verify` live tests are local-only** via `makeLocalVault` (from `tests/helpers/local-vault.ts`). They scaffold a vaultkit-shaped vault in a tmp dir + (for `status`) a local bare git repo as `origin` — no GitHub round-trip. Removed ~20 GH-API calls per CI run.
- **Two-PAT round-robin in CI (2.7.3).** `.github/workflows/main.yml` picks `VAULTKIT_TEST_GH_TOKEN_A` or `_B` per run via `GITHUB_RUN_NUMBER % 2`, fail-closed if the chosen secret is missing. Pre- and post-test orphan-cleanup steps sweep BOTH accounts (the previous run used the other PAT, so its orphans live on the other account). The `VAULTKIT_TEST_PAT_LABEL` env var is logged so the chosen PAT is visible in the Actions UI without exposing the token. Operator note: re-runs of a failed run reuse the same `run_number` and therefore the same PAT — push a new commit to flip to the other account.
- **Single shared fixture for `connect` / `disconnect` / `visibility` (2.7.3).** `tests/global-fixture.ts`'s vitest globalSetup creates one `vk-live-shared-${pid}-${ts}` repo at suite start and tears it down at suite end. The fixture-sharing live blocks read its name via `tests/helpers/live-fixture.ts:getFixtureName()` and reset to baseline state in `beforeEach` (re-clone if disconnected). The `init` and `destroy` live tests stay self-contained because they ARE the create / delete paths — coupling that coverage to fixture lifecycle would muddy what those tests validate. **As of 2.7.4 the visibility live block is `describe.skip`** because the available CI test PATs (Free-tier) cannot reliably be flipped to public (PATCH returns 200 but the underlying state doesn't stick); the fixture is currently consumed only by `connect` and `disconnect`.

Net per CI run: 3 `vk-live-*` GitHub repo creates (1 shared fixture + `init`'s own + `destroy`'s own) split across two PATs (~1.5 per account averaged), down from 7 across both matrix legs in 2.7.0 all on one PAT.

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
  - `live-describe.ts` — `liveDescribe` is `describe.skip` on Windows and `describe` everywhere else. Use it for `live: ...` blocks that touch real GitHub so they run only on the Ubuntu CI leg. Live blocks that DON'T touch GitHub (status, verify) use plain `describe` and run on both OSes.
  - `local-vault.ts` — `makeLocalVault({ name, withRemote?, hashOverride? })` builds a vaultkit-shaped vault in a tmp dir, byte-copies the launcher template (so its SHA-256 matches `expected-sha256`), optionally wires up a local bare git repo as `origin`, and registers the vault in the real `~/.claude.json`. Returns `{ vaultDir, launcherHash, bareRepoDir, cleanup }`. Use it in live blocks that need a real vault layout but DON'T need a real GitHub remote — e.g. `status` (just reads `git status`) and `verify` (just hashes the launcher locally). The `name` MUST start with `vk-live-` so `tests/global-teardown.ts` sweeps the registry entry on crash.
  - `live-fixture.ts` — `getFixtureName()` returns the name of the shared `vk-live-shared-*` GitHub-backed vault that's created once per `npm test` run by `tests/global-fixture.ts`'s vitest globalSetup. Use it in `liveDescribe` blocks for `connect` / `disconnect` / `visibility` to operate on the shared fixture instead of creating each test's own throwaway repo. Each consuming block must include a `beforeEach` that resets the fixture to its required start state (e.g., re-clone if disconnected, re-set visibility to private if drifted) — fixtures are NOT auto-reset between tests. Throws if the env var is unset (which means globalSetup was skipped — Windows — or failed).

## Testing discipline

- After any file edit: run `npm test` before committing.
- Type errors are caught by `npm run check` (`tsc --noEmit`). Run before committing on any TS change.
- Template files (`.tmpl`) are validated by their consumers — `mcp-start.js.tmpl` must parse as valid JavaScript when executed by the spawned Node process. End-to-end behavior of the launcher (SHA-256 self-verification, refuse-to-merge on upstream tampering, `.obsidian/` stub creation) is covered by `tests/lib/launcher-integration.test.ts`, which spawns the template as a real Node process against fixture vaults.
- Use vitest's built-in mocking (`vi.mock`, `vi.spyOn`) for external dependencies (git, gh, fs).
- For typed mocks, prefer `await importOriginal<typeof import('module')>()` so the `...real` spread is typed.
- For `vi.mocked(execa).mockImplementation(...)` and `mockResolvedValue(...)`, use `(async (...) => ({...})) as never` to satisfy execa's overloaded Result type.

## Cleanup invariants

The `vk-live-*` prefix in `~/.claude.json#mcpServers` and on GitHub repos is the **test-owned namespace** — vaultkit's tests own it, nothing else should write keys with that prefix. Four layers of cleanup defend against leaks:

0. **Vitest `globalSetup` shared fixture (preventive).** [tests/global-fixture.ts](../../tests/global-fixture.ts) creates one `vk-live-shared-*` GitHub repo + registry entry at suite start (skipped on Windows) and tears them down at suite end. Three live blocks (`connect`, `disconnect`, `visibility`) operate against this fixture instead of creating their own throwaway repos. Per-test `beforeEach` blocks re-stage the fixture's baseline (re-connect if disconnected; flip visibility back to private if a previous test left it public). Wired via `globalSetup: ['tests/global-teardown.ts', 'tests/global-fixture.ts']` in `vitest.config.ts` — order matters because vitest teardown runs in REVERSE array order, so the fixture's destroy runs BEFORE the registry sweep would otherwise strip its entry.

1. **Per-test `afterAll` (primary).** Each live `describe('live: ...', ...)` block that owns its own repo (today: `init`, `destroy`) has an `afterAll` hook that calls `destroy` (or its slug-only equivalent for files that don't register in the registry). Hooks wrap `restoreReal()` in `try/catch` so a mock-restoration failure doesn't skip the actual cleanup. Cleanup chains use `.catch(() => {})` per step and `reject: false` on `execa` calls so one failure doesn't cascade. Plenty of test files pass `skipMcp: true` to `destroy` deliberately (avoids invoking the `claude` CLI subprocess); the registry entries are then swept by layer 2.

2. **Vitest `globalTeardown` (secondary).** [tests/global-teardown.ts](../../tests/global-teardown.ts) (wired via `globalSetup` in `vitest.config.ts`) sweeps every `vk-live-*` key from `~/.claude.json#mcpServers` once after the entire suite finishes. Atomic write (`<path>.tmp` + rename); no-op if the file or `mcpServers` key is missing; throws (never silently rewrites) on corrupt JSON.

3. **`npm run test:cleanup` (tertiary, manual).** [scripts/test-cleanup.mjs](../../scripts/test-cleanup.mjs) runs the same sweep standalone. Use when the test process gets `SIGKILL`'d before vitest can fire its globalTeardown, or after a CI run leaks artifacts to a developer's local registry.

GitHub repo orphans are handled by `main.yml`'s pre- and post-test cleanup steps (which sweep both PAT accounts) plus per-test `afterAll` `gh repo delete --yes` with `reject: false`. The local equivalent is `gh repo list <user> --json name --jq '.[] | select(.name | startswith("vk-live-")) | .name' | xargs -I{} gh repo delete <user>/{} --yes`.

## Sacred tests rule

Test files are read-only unless explicitly instructed. If a test is failing, fix the implementation, not the test. "The test was wrong" requires explicit human confirmation.
