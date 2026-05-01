# Changelog

All notable changes to vaultkit are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Per-command `--help` examples.** Each command (`init`, `connect`, `destroy`, `pull`, etc.) now exposes a usage paragraph and example invocations via commander's `addHelpText('after', ...)`. Closes the gap where the README promised "detailed usage" via `--help` but each command's help printed only the one-line stub. Per-command help is now self-contained — users no longer need to grep the README for a working invocation. Examples include security-relevant context (`destroy` documents the `delete_repo` scope pre-grant; `connect` warns about the launcher's full-user-permission scope).

### Changed
- **`vaultkit --version` includes runtime info.** Output goes from `2.5.0` to `2.5.0 (node v22.x.x, <platform> <arch>)`, matching the README's existing promise of "version + runtime info". One-line bug-report-friendly format that also surfaces node-version mismatches when troubleshooting.

### Docs
- **README `connect` example now shows the SSH URL form** (`git@github.com:owner/repo`). The parser in [src/commands/connect.ts](src/commands/connect.ts) `_normalizeInput` already accepted SSH URLs and `.git` suffixes (covered by `tests/commands/connect.test.ts:72-73`); the README only documented two of three forms, so users copy-pasting from `gh repo view` thought they were getting away with something undocumented.
- **README Prerequisites now leads with "GitHub account required."** vaultkit cannot work without GitHub — every vault is a GitHub repo. The previous Prerequisites only listed Node and Git, leaving the GitHub dependency to be inferred from later mentions of `gh`, GitHub Pages, and `owner/repo`. Surfacing it explicitly lets GitHub-averse users bounce off the README in 30 seconds rather than after running `vaultkit setup`.
- **README defines [Quartz](https://quartz.jzhc.io/) on first prose mention.** Quartz appeared in the publish-mode prompt (`(y)` option) and in the vault tree (`.quartz/`) without ever being defined. New users had to guess; now there's a one-line gloss with link.
- **README Security & Trust section names `obsidian-mcp-pro`.** SECURITY.md mentioned that the launcher invokes [`obsidian-mcp-pro`](https://www.npmjs.com/package/obsidian-mcp-pro) via `npx`, but the README's own Security section only described the launcher abstractly. Trust-conscious users now see the actual MCP-server package name in the README's trust narrative — no need to dig into SECURITY.md to learn what code is actually running.
- **README adds a "Quick Start" section** between "What you'd use this for" and "Commands." Four numbered steps (install → init → drop in a note → query from Claude Code) walk a fresh user from zero to first answered question in 60 seconds. Closes the gap where the README jumped straight from value-prop to a 12-command reference, leaving readers to mentally splice the canonical first-use sequence themselves.
- **README annotates the vault folder convention.** The vault tree previously listed `raw/{articles,books,notes,papers,transcripts,assets}` and `wiki/{concepts,topics,people,sources}` without saying what each subfolder was for or whether the structure was enforced. New paragraph clarifies that subfolders are conventions (not requirements) and gives a one-liner per folder so users don't guess at "where does a research paper go" vs "where do I write a synthesis page".
- **README documents `npm update -g` for upgrading vaultkit itself.** Previously the README told users how to install but never how to update; new "**Updating**:" line points at `npm update -g @aleburrascano/vaultkit` and reminds users to re-run `vaultkit setup` and `vaultkit doctor` after major versions.

## [2.5.0] - 2026-05-01

### Fixed
- **`vaultkit destroy` now actually deletes the GitHub repo.** Three swallowed errors hid the failure: `ensureDeleteRepoScope` killed the interactive `gh auth refresh` after a 10s timeout (so the user never completed the device-code browser flow), the `gh repo delete` call ignored stderr, and a `.catch(() => {})` swallowed the scope-refresh error. The fix: `ensureDeleteRepoScope` inherits stdio (so the prompt is visible) and throws `VaultkitError('AUTH_REQUIRED')` on failure with the manual recovery command; a new `deleteRepoCapturing(slug)` wrapper in [src/lib/github.ts](src/lib/github.ts) returns `{ ok, stderr }` so destroy can log the gh error alongside the warning; the silent catch is gone — if scope refresh fails, destroy aborts before any destructive action so the user can fix the scope and retry with state intact. Also, when running under PAT auth (`GH_TOKEN` env var, used by CI), `ensureDeleteRepoScope` skips the refresh entirely since PAT scopes are fixed at creation time.

### Added
- **`vaultkit setup`** — one-time post-install onboarding command. Walks the user through every prerequisite vaultkit needs across all of its commands, fixing what it can in place: node 22+, gh CLI (auto-installed via winget/brew/apt/dnf), `gh auth login` with the `repo` and `workflow` scopes baked in, git config user.name and user.email, and the claude CLI. Idempotent and re-runnable. Output mirrors `doctor`'s vocabulary (`+ ok` / `! warn` / `x fail`); the difference is that `doctor` reports while `setup` actively fixes.
- **`src/lib/prereqs.ts`** — shared prerequisite-check lib (`checkNode`, `ensureGh`, `ensureGhAuth`, `ensureGitConfig`) used by both `setup` and `init`'s [1/6] preflight, so the two paths cannot drift. `ensureGhAuth` accepts an optional `scopes` list — `setup` passes `['repo', 'workflow']`; `init`'s preflight omits to preserve the original behavior.

### Security
- **`delete_repo` scope is still requested only at delete time, never preemptively.** Honors the `.claude/rules/security-invariants.md` rule that "delete_repo scope must be requested only when actually about to delete." Setup deliberately does not request it; users are prompted once on their first `vaultkit destroy`.

### Changed
- **Tests are always live** — removed the `VAULTKIT_LIVE_TEST=1` env-var gate that previously hid the live test suite from `npm test`. Every test run now hits the real GitHub API, creates ephemeral `vk-live-*` repos, and tears them down via `afterAll` hooks. Mocked unit tests in `*-mocked.test.ts` files are unaffected and continue to cover error paths that can't be reproduced live safely. The `npm run test:live` script and `cross-env` devDependency are dropped. Local prereq: `gh auth refresh -h github.com -s delete_repo` once.
- **`vitest.config.ts`** — `fileParallelism: false` is hardcoded (was conditional on the env var). Live tests must run sequentially to avoid `~/.claude.json` write races.
- **`init.ts` [1/6] preflight** — no behavior change, but the inline `ensureGhAuth` and `ensureGitConfig` private helpers are gone in favor of the shared lib.

### CI
- **CI now runs the live suite** with a `VAULTKIT_TEST_GH_TOKEN` repo secret (classic PAT with `repo` + `workflow` + `delete_repo` scopes on a dedicated test account). Pre-test cleanup removes `vk-live-*` orphans from prior runs; post-test cleanup with `if: always()` catches anything a crashed run leaked. Concurrency group `vaultkit-live-tests` prevents parallel CI runs from racing on the same test account. Job timeout raised to 15 minutes for the live workload.

## [2.4.1] - 2026-05-01

### Docs
- **README refresh.** Reframed the lede so the value prop lands without presupposing Obsidian familiarity (one-line tagline + a paragraph that explains what Obsidian is, what a vault is, and what vaultkit adds on top). New `## What you'd use this for` section enumerates four concrete scenarios — personal knowledge base, team wiki, public reference, reading notebook. Merged the previously-separate `## What a vault is` and `## Vault structure` into one `## Anatomy of a vault` (file tree + capabilities table together). Promoted the Claude Code payoff sentence to the top of `## Using with Claude Code`. Added `.mcp-start.js` to the file tree (was missing). Everything past the new sections is preserved verbatim.

### Fixed
- **Windows CI flake in [tests/lib/launcher-integration.test.ts](tests/lib/launcher-integration.test.ts).** The `afterEach` `rmSync(tmp, { recursive: true, force: true })` raced against spawned child processes still releasing file handles on GitHub Windows runners, surfacing as `EBUSY: resource busy or locked, rmdir`. Fix: 2-second retry budget (`maxRetries: 10, retryDelay: 200`) plus a try/catch on the cleanup itself — each test uses its own `mkdtempSync` so a residual leftover dir cannot leak into subsequent tests, and the runner reclaims `TMPDIR` at job end. Caught by the v2.4.0 Windows CI matrix (PR 6) firing on the first real run; v2.4.0 itself published cleanly via `release.yml` (ubuntu-latest), so the npm package is unaffected.

## [2.4.0] - 2026-05-01

### Refactor (polish batch — 7 small items from the architectural review)
- **Template path resolution centralized.** New `getLauncherTemplate()` and `getDeployTemplate()` helpers in [src/lib/platform.ts](src/lib/platform.ts) — one source of truth for the `'../../lib/<tmpl>'` offset that previously lived inline in three command files (`init.ts`, `update.ts`, `visibility.ts`). Same dev/post-build resolution semantics as before; removes a doc/path drift risk.
- **`requireAuthGatedEligible(extraHint?)` extracted to [src/lib/github.ts](src/lib/github.ts).** The two callers (`init` and `visibility`) previously duplicated the `getUserPlan()` → free-plan throw pattern with slightly different messages. The optional `extraHint` preserves init's "Choose Public or Private instead" guidance without dragging the visibility caller into init's interactive context. Visibility test mocks updated to mock the helper directly (avoids the same-module `vi.mock` bypass when the internal `getUserPlan()` call lives in github.ts).
- **`setDefaultBranch(dir, branch)` and `addRemote(dir, name, url)` added to [src/lib/git.ts](src/lib/git.ts).** Two `git` invocations in `init.ts` (the `git branch -M` and `git remote add`) now route through wrappers, raising the consistency floor toward the existing `gh`/`claude mcp` patterns.
- **`connect.ts` cleanup pattern inverted.** Replaced the `cloned` flag (set true after clone, reset to `false` at 5 success-completion sites, checked in `finally`) with a `try`/`catch` around the post-clone work. Successful early returns no longer need to reset anything; only thrown errors trigger cleanup. Eliminates the boolean variable and the 5 reset sites; future contributors can't forget one. All 13 `connect.test.ts` cases pass unchanged.
- **Magic string fix.** [update.ts:100](src/commands/update.ts#L100) `'.mcp-start.js'` literal replaced with `VAULT_FILES.LAUNCHER` (the file uses the constant elsewhere; this was the lone outlier).
- **5 weak `.toBeTruthy()` assertions strengthened** across `tests/lib/errors.test.ts`, `tests/lib/git.test.ts`, `tests/commands/connect.test.ts`, `tests/commands/init.test.ts` — replaced with `.not.toBeNull()` / `.toBeDefined()` / `.length > 0` / type assertions that fail on more reality-shaped regressions.
- **Stale planning doc flagged.** [docs/superpowers/plans/2026-04-29-unit-test-edge-cases.md](docs/superpowers/plans/2026-04-29-unit-test-edge-cases.md) gets a "STATUS: HISTORICAL" banner explaining the `.js` → `.ts` migration drift, so future sessions don't treat its "missing test" claims as current.

### CI
- **Windows added to the CI matrix.** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) now runs `check`/`build`/`test`/`npm publish --dry-run` on both `ubuntu-latest` and `windows-latest` with `fail-fast: false`. Closes the gap where vaultkit's explicit Windows code paths in [`src/lib/platform.ts`](src/lib/platform.ts) and [`src/lib/installGhForPlatform`](src/lib/platform.ts) were never exercised in CI. CONTRIBUTING.md updated to reflect the dual-OS gate.

### Refactor
- **`visibility.ts` planner/executor decomposition.** The original implementation duplicated the same three-mode (`public` / `private` / `auth-gated`) branch structure twice — once in the plan-building block (English strings appended to `actions: string[]`) and once in the apply block (imperative `await ...` calls). Adding a fourth mode required editing both. The new shape is a typed discriminated union (`VisibilityAction`), a pure planner (`_buildVisibilityPlan(state) → VisibilityAction[]`), a `describeAction(action) → string` for the user-facing plan output, and a single `executeAction(action, ctx)` switch. Each atomic operation (`setRepoVisibility`, `enablePages`, `disablePages`, `setPagesVisibility`, `addDeployWorkflow`) lives in exactly one place; the compiler enforces switch exhaustiveness. Behavior preserved end-to-end — all 13 existing `visibility.test.ts` cases pass unchanged. Auth-gated "enable Pages with private visibility" now logs as two atomic steps (more accurate plan output).

### Tests
- **`tests/commands/visibility-plan.test.ts`** — 14 unit tests pinning the planner's decisions across all (current state × target mode) combinations, plus ordering invariants (`addDeployWorkflow` always first; `setRepoVisibility` before any Pages action).

### Fixed
- **`--verbose` / `-v` flag now actually does something.** The flag was declared in [bin/vaultkit.ts](bin/vaultkit.ts) but never read; `ConsoleLogger.debug()` stayed a no-op even when the flag was passed, contradicting the README copy that promised trace output. The fix: a `preAction` hook on the commander program sets `process.env.VAULTKIT_VERBOSE='1'` when `--verbose` is passed, `ConsoleLogger`'s constructor reads the env var as a fallback for the `verbose` opt, and `wrap()` emits a start/end debug breadcrumb (`[debug] vaultkit <cmd> <args>` and `[debug] <cmd> ok|exit=N (<duration>ms)`) on stderr. Scripted callers can also pre-set `VAULTKIT_VERBOSE=1` directly without `--verbose`, matching the existing `VAULTKIT_LOG` pattern.

### Changed
- **`installGh` moved from [src/commands/init.ts](src/commands/init.ts) to [src/lib/platform.ts](src/lib/platform.ts) as `installGhForPlatform({ log, skipInstallCheck })`.** The 37-line winget/brew/apt/dnf bootstrap was platform-specific package-management logic living in a command file — it belongs next to `findTool` in the platform module. `init.ts` shrinks accordingly; the unused `isWindows` import in init.ts is dropped. No behavior change — tests pass unchanged through the same execa mocks.
- **Error categorization sweep — 11 plain `Error` throws → `VaultkitError`** across [backup.ts](src/commands/backup.ts), [status.ts](src/commands/status.ts), [update.ts](src/commands/update.ts), [verify.ts](src/commands/verify.ts), [init.ts](src/commands/init.ts), and [visibility.ts](src/commands/visibility.ts). These previously collapsed to exit code 1; they now map to the documented 2-12 range, so scripted callers can branch on category. No new error codes added — sites reuse existing codes, with `errors.ts` docstrings broadened to reflect the wider scope:
  - `NOT_VAULT_LIKE` — also covers registered vault dirs missing `.git` or the launcher (4 sites: backup, status, update, verify).
  - `TOOL_MISSING` — also covers Node.js below the minimum and `gh` install/PATH failures (3 sites in init).
  - `ALREADY_REGISTERED` — also covers a target directory already existing on disk (1 site in init).
  - `PERMISSION_DENIED` — also covers insufficient GitHub plan tier (auth-gated Pages on Free) (2 sites: init, visibility).
  - `AUTH_REQUIRED` — also covers a `gh` auth status check that fails to fetch the current user (1 site in init's GitHub username fetch).
  - `UNRECOGNIZED_INPUT` — also covers an invalid `publishMode` passed programmatically (1 site in init).
  - `PARTIAL_FAILURE` — covers `verify`'s `git pull --ff-only` failing after the user accepted upstream drift but before the re-pin completed (1 site in verify).

  All error messages preserved verbatim — purely a visible-to-shell categorization change.

### Tests
- **`tests/lib/logger.test.ts`** — closes the largest unit-test gap surfaced by the v2.3.0 architectural review. Covers `ConsoleLogger` level routing (info → stdout, warn/error/debug → stderr), debug gating (silent by default, emits with `{ verbose: true }` opt, emits with `VAULTKIT_VERBOSE=1` env, explicit opt overrides env, env captured at construction time), the `[debug]` prefix, and `SilentLogger` no-op behavior.
- **`tests/lib/vault-templates.test.ts`** — drift guard for the 8 static-content builders (`renderClaudeMd`, `renderReadme`, `renderDuplicateCheckYaml`, `renderVaultJson`, `renderGitignore`, `renderGitattributes`, `renderIndexMd`, `renderLogMd`) that ship into every newly-initialized vault. 30 new tests asserting interpolation correctness (vault name in CLAUDE.md/README titles, owner+repo in vault.json `baseUrl`), structural anchors (canonical section headings, GitHub Actions workflow shape, gitignore/gitattributes rules, JSON parsability), and the siteUrl-toggled README copy. Avoids full-text snapshots so harmless wording tweaks don't require test updates.

## [2.3.0] - 2026-05-01

### Added
- **`runMcpRemove(claudePath, name) → { removed }`** and **`manualMcpRemoveCommand(name)`** in [src/lib/mcp.ts](src/lib/mcp.ts) — single source of truth for the `claude mcp remove --scope user` argv shape, parallel to the existing `runMcpAdd` / `runMcpRepin` pattern. `runMcpRepin` and `manualMcpRepinCommands` now delegate to these helpers internally.
- **`setRepoVisibility(slug, 'public' | 'private')`** in [src/lib/github.ts](src/lib/github.ts) — wraps `gh repo edit --visibility=<v> --accept-visibility-change-consequences`. Parallel to the existing `setPagesVisibility` / `enablePages` / `disablePages` helpers.
- **`Vault.requireFromName(name, cfgPath?)`** in [src/lib/vault.ts](src/lib/vault.ts) — throw-on-missing variant of `tryFromName` that consolidates the canonical `"${name}" ${DEFAULT_MESSAGES.NOT_REGISTERED}` phrasing. Five commands collapse the four-line `tryFromName` + `if (!vault) throw …` preamble to a single line.
- **`PUBLISH_MODES` + `PublishMode` type + `isPublishMode` type guard** in [src/lib/constants.ts](src/lib/constants.ts) — single source of truth for the `'private' | 'public' | 'auth-gated'` enumeration. Replaces the previous three sources (a local `PublishMode` type in `init.ts`, an inline validation array in `init.ts`, and a separate `validTargets` array in `visibility.ts`). User-facing error messages now derive their valid-mode list from `PUBLISH_MODES.join(', ')`, so adding a new mode is one edit.

### Changed (internal — no user-facing behavior change)
- **`destroy`, `disconnect`, and the `init` rollback path** now route MCP removal through `runMcpRemove` / `manualMcpRemoveCommand` instead of inlining the `claude mcp remove` argv. Closes the architectural gap where mcp.ts was single source of truth for `mcp add` / `mcp repin` but not `mcp remove`.
- **`visibility.ts`** uses `setRepoVisibility` for the three `repo edit` call sites; the now-unused `execa` import is dropped.
- **`init.ts`** uses the existing `getCurrentUser`, `getUserPlan`, `createRepo`, `enablePages`, `setPagesVisibility`, and `deleteRepo` wrappers in place of six inline `gh api` / `gh repo` calls. Helper signatures lose the `ghPath` parameter where the wrappers resolve `gh` internally. `gh repo create` now also passes `--confirm` uniformly. Branch protection (`gh api …/branches/main/protection`) remains inline — no wrapper exists yet.
- **`visibility`, `verify`, `update`, `backup`, `status`** switched to `Vault.requireFromName`. `destroy` and `disconnect` keep their inline throws so command-specific user hints ('Run vaultkit status …', 'If you have an orphaned directory …') aren't lost.

### Style
- **`Warning:` prefix removed** from 13 log call sites across 8 commands (`disconnect`, `init`, `backup`, `connect`, `update`, `verify`, `destroy`, `visibility`). Per `code-style.md`: the `log.warn(…)` level conveys the warning; the prefix was redundant. Visible behavior change: warnings now go to stderr (via `console.warn` in `ConsoleLogger`) instead of stdout.

### Housekeeping
- Removed the deprecated `.claude/skills/code-auditor/SKILL.md` (was already staged for deletion before this refactor).
- Refreshed `.claude/MEMORY.md` to reflect the actual rule files. Dropped the stale `shell-conventions.md` ghost reference and the pre-TS-migration "bash, JavaScript, and template conventions" description; added the previously-missing `architecture.md`, `doc-sync.md`, and `security-invariants.md` index entries.

### Tests
- **`tests/helpers/registry.ts`** — shared `writeCfg(cfgPath, vaults)` helper replacing 14 near-identical local copies. Single signature accepts either `name → dir` shorthand or `name → { dir, hash? }`. 15 test files updated.
- **`tests/helpers/git.ts`** — shared `mockGitConfig({ name?, email? })`. The well-formed local helper in `doctor.test.ts` moves here; `init.test.ts` and `destroy-mocked.test.ts` keep their inline patterns (multi-handler `mockImplementation` doesn't extract cleanly).
- **`tests/lib/launcher-integration.test.ts`** — closes the largest test blind spot. Spawns `lib/mcp-start.js.tmpl` as a real Node process and asserts: (1) SHA-256 mismatch exits non-zero with the production diagnostic, (2) missing `--expected-sha256` warns but continues, (3) `.obsidian/` stub creation runs even when step 6 (npx) fails, (4) upstream launcher tampering triggers the refuse-to-auto-update abort against a real git topology (bare upstream + work + tamper clones).

### Internal
- Test count: 292 → 307 passing (15 new: 11 from Tier 1 / 2 helpers, 4 from launcher integration test).

## [2.2.0] - 2026-04-30

### Added
- **`src/lib/constants.ts`** — domain-meaningful literal constants: `VAULT_FILES` (LAUNCHER, CLAUDE_MD, README, INDEX, LOG, GITIGNORE, GITATTRIBUTES, VAULT_JSON, OBSIDIAN_DIR), `VAULT_DIRS` (RAW, WIKI, GITHUB_WORKFLOWS), `WORKFLOW_FILES` (DEPLOY, DUPLICATE_CHECK), `VAULT_CONSTRAINTS` (NAME_MAX_LENGTH, NAME_PATTERN). Replaces 100+ inline string literals across the codebase. Pinned by `tests/lib/constants.test.ts` so a typo in the launcher filename can't silently desync from user-vault SHA pins.
- **`src/lib/vault-layout.ts`** — single source of truth for the canonical vault file structure. `CANONICAL_LAYOUT_FILES`, `renderLayoutFile(path, ctx)`, `detectLayoutGaps(vaultDir)`, `createDirectoryTree(vaultDir)`, `writeLayoutFiles(vaultDir, ctx, files)`. Used by `init` (full creation) and `update` (gap repair) — replaces two divergent codepaths that each built the same layout differently.
- **`getRepoSlug(dir)`** in `src/lib/git.ts` — deduplicates the `git remote get-url origin` parser previously inlined in both `destroy.ts` and `visibility.ts`.
- **`DEFAULT_MESSAGES`** in `src/lib/errors.ts` — canonical sentence-fragment phrasings per `VaultkitErrorCode`. Pattern: `\`"${name}" ${DEFAULT_MESSAGES.NOT_REGISTERED}\``. Converged seven NOT_REGISTERED throw sites that previously phrased the same concept three ways.
- **`src/lib/messages.ts`** — `PROMPTS` (TYPE_NAME_TO_CONFIRM, TYPE_NAME_TO_CONFIRM_DELETION, PROCEED, INSTALL_CLAUDE, REGISTER_AS_MCP) and `LABELS` (ABORTED). Strings that appear in 2+ command files now live in one place; one-shot prompts deliberately stay inline.
- **GitHub URL builders** in `src/lib/github.ts`: `repoUrl(slug, path?)`, `repoCloneUrl(owner, repo)`, `pagesUrl(owner, repo)`. Replaces 6 inline `https://github.com/${...}` template literals — a single source of truth for github.com URL construction.
- **`tests/lib/constants.test.ts`** (11 tests), **`tests/lib/vault-layout.test.ts`** (14 tests).

### Changed
- **`src/commands/init.ts`** decomposed: `run()` shrank from ~220 lines to ~118 lines by extracting named phase helpers (`ensureGhAuth`, `ensureGitConfig`, `selectPublishMode`, `getGithubUser`, `createRemoteRepo`, `setupGitHubPages`, `setupBranchProtection`, `registerMcpForVault`, `printDoneSummary`). Each phase is now a scannable named function.

### Internal
- Test count: 260 → 292 passing (32 new tests). No behavior change visible to end users; all changes are additive new exports plus internal restructuring.

## [2.1.0] - 2026-04-30

### Added
- **`VaultkitError` with categorized exit codes** ([src/lib/errors.ts](src/lib/errors.ts)). Eleven error codes (`INVALID_NAME`, `NOT_REGISTERED`, `ALREADY_REGISTERED`, `NOT_VAULT_LIKE`, `HASH_MISMATCH`, `AUTH_REQUIRED`, `PERMISSION_DENIED`, `TOOL_MISSING`, `NETWORK_TIMEOUT`, `UNRECOGNIZED_INPUT`, `PARTIAL_FAILURE`) map to distinct process exit codes (2-12) via the new `EXIT_CODES` table. Shell scripts can now branch on category (`vaultkit init || handle "$?"`) without parsing message strings. Plain `Error` continues to exit 1 for unexpected failures.
- **`Logger` interface** ([src/lib/logger.ts](src/lib/logger.ts)) replacing the flat `LogFn` type. Four levels (`info` / `warn` / `error` / `debug`) plus two implementations: `ConsoleLogger` (stdout/stderr-aware, debug gated by verbose) and `SilentLogger` (no-op for tests). All command `log(...)` call sites converted to `log.info(...)` — no end-user behavior change today, but the level distinction unblocks structured CI output and future telemetry.
- **`CommandModule<TParams, TOptions, TResult>` interface** ([src/types.ts](src/types.ts)) codifying the lifecycle every command's `run` function shares. Each `src/commands/<name>.ts` ends with a `_module: CommandModule<...> = { run }` sentinel that fails the type check if a command's signature drifts from the contract. Tuple-rest types (`[...TParams, opts?: TOptions]`) handle the three positional-arg shapes (1-arg, 0-arg, 2-arg).
- **`tests/lib/github-mocked.test.ts`** — closes the largest test blind spot. github.ts had 14 exported functions but only 4 (the JSON parsers) had direct lib-level coverage; the rest were exercised only indirectly through command-level mocks. Now every gh-CLI wrapper has argv-shape tests parallel to what `tests/lib/mcp.test.ts` does for `runMcpAdd`. Adds 32 tests.
- **`tests/lib/errors.test.ts`** — locks in the EXIT_CODES contract: every documented error code has a mapping, codes are unique, and reserved values (0 = success, 1 = unknown) are not reused. Adds 10 tests.
- **`tests/helpers/logger.ts`** — `silent` singleton and `arrayLogger(lines)` factory bridge the pre-Logger test pattern of `log: (m) => lines.push(...)`.

### Changed
- **`src/commands/connect.ts`** uses `Vault.tryFromName` to detect existing registrations instead of calling `validateName` + `getVaultDir` directly. Behavior identical; consistency with the rest of the codebase.
- **High-leverage throw sites converted to `VaultkitError`**: `validateName` → `INVALID_NAME`; `connect.ts` `already-registered` → `ALREADY_REGISTERED`; all `if (!vault)` checks across commands → `NOT_REGISTERED`; vault-like checks → `NOT_VAULT_LIKE`; `verify.ts` Claude-not-found → `TOOL_MISSING`; `visibility.ts` non-admin → `PERMISSION_DENIED`. Plain `Error` remains the default for unexpected failures.
- **`tests/`**: bare `.rejects.toThrow()` assertions tightened to message-matcher regexes where the error category is known.

### Internal
- Test count: 250 → 260 passing (10 new in errors.test.ts; 32 new in github-mocked.test.ts already counted from 2.0.4 base).
- No user-facing CLI behavior change. All new exports are additive.

## [2.0.4] - 2026-04-30

### Changed
- **CONTRIBUTING.md** rewritten to match the post-2.0.3 TypeScript reality. The previous version still described the pre-migration shell-script architecture (`vault-*.sh`, `lib/_helpers.sh`, "zero npm dependencies", "no build step") and would have led new contributors to write code that doesn't compile or get loaded.
- **Internal: split `src/lib/vault.ts`.** The 8 `render*` template builders moved to `src/lib/vault-templates.ts`. `vault.ts` now contains only the `Vault` class plus its primitives (`validateName`, `isVaultLike`, `sha256`). No public API change — the same functions are still exported, just from their topic-appropriate file. Diffs to vault page content no longer pollute diffs to the snapshot class.
- **Internal: centralized MCP registration in `src/lib/mcp.ts`.** The four-times-duplicated `claude mcp add` argv (in `init`, `connect`, `update`, `verify`) now lives in `runMcpAdd` — a single source of truth for the security-critical `--expected-sha256=<hash>` flag. Re-pinning (`update`, `verify`) goes through `runMcpRepin`. Manual fallback strings come from `manualMcpAddCommand` / `manualMcpRepinCommands`. The shared "find Claude or offer to install" logic (used by `init` and `connect`) lives in `findOrInstallClaude`. New `tests/lib/mcp.test.ts` locks in the security invariant — every `mcp add` invocation must include `--expected-sha256`.

## [2.0.3] - 2026-04-30

### Changed
- **Migrated to TypeScript.** All source under `bin/`, `src/`, and `tests/` is now `.ts`. The package compiles to `dist/` at publish time and ships compiled output only — `package.json#bin` points at `dist/bin/vaultkit.js` and `files` is `["dist/"]`. No user-facing behavior change. The launcher template `lib/mcp-start.js.tmpl` deliberately stays as raw JavaScript because every existing user vault byte-pins its SHA-256; the post-build step copies it into `dist/lib/` so the installed package contains it.
- **Internal: `Vault` class** introduced in `src/lib/vault.ts` — wraps `name`, `dir`, and `expectedHash` and exposes the disk/path checks commands repeatedly need (`Vault.tryFromName`, `Vault.fromRecord`, `launcherPath`, `existsOnDisk`, `isVaultLike`, `hasGitRepo`, `hasLauncher`, `sha256OfLauncher`). Replaces ~50 lines of duplicated boilerplate across 8 commands.

## [2.0.2] - 2026-04-29

### Fixed
- **`vaultkit visibility` now works with gh ≥ 2.92.0** — `gh repo edit --yes` was removed in gh 2.92.0; replaced with `--accept-visibility-change-consequences`.
- **`vaultkit destroy` no longer hangs 60 s when scope refresh is needed** — added a 10 s timeout to the `gh auth refresh -s delete_repo` call so it fails fast instead of blocking interactively.

### Added
- **`npm run test:live`** — integration test script (`cross-env VAULTKIT_LIVE_TEST=1 vitest run`) that exercises all commands against the real GitHub API. Live test blocks run sequentially to avoid `~/.claude.json` write races. Gated behind `VAULTKIT_LIVE_TEST=1` so `npm test` remains fast and CI-safe.

## [2.0.1] - 2026-04-29

### Fixed
- **`vaultkit connect` now offers to install Claude Code CLI** — when the CLI is missing after cloning and the user confirms MCP registration, `connect` prompts to install via `npm install -g @anthropic-ai/claude-code` and registers on success. Previously it bailed with a manual `claude mcp add` command and left the vault unregistered (`vaultkit status` showed nothing).
- **`vaultkit init` gh auto-install works on Windows** — winget is an App Execution Alias and is not reachable via `command -v` in Git Bash. The install now runs via `cmd //c "winget install ..."`, matching the pattern already used for `where gh`. Previously fell through to "cannot auto-install gh" on all fresh Windows machines.

## [2.0.0] - 2026-04-29

### Added
- **Layout migration in `vaultkit update`** — `update` now restores any missing standard layout files (`CLAUDE.md`, `README.md`, `index.md`, `log.md`, `.gitignore`, `.gitattributes`, `raw/.gitkeep`, `wiki/.gitkeep`, `.github/workflows/duplicate-check.yml`) alongside its existing launcher refresh. Never overwrites existing files. Owners can now repair pre-current vaults forward without re-init. Combined commit message variants (launcher only / layout only / both).
- **Pages re-enable on notes-only vaults** — `vaultkit visibility <name> public` (or `auth-gated`) now generates `.github/workflows/deploy.yml` + `_vault.json` on the fly when promoting a notes-only vault. The workflow is committed and pushed *after* the visibility flip + Pages enable so the first run deploys cleanly. Falls back to a PR if `main` is branch-protected. Previously a hard error.
- **`raw/.gitkeep` + `wiki/.gitkeep` in `vaultkit init`** — empty dirs now survive a clone, so a freshly-init'd vault with no content satisfies the layout check.
- **`vaultkit doctor` flags missing layout** — per-vault `vk_is_vault_like` check; suggests `vaultkit update <name>` when failing.
- **`lib/deploy.yml.tmpl`** — single source of truth for the Pages deploy workflow. Mirrors the `lib/mcp-start.js.tmpl` pattern. Both `init` and `visibility` `cp` it into vaults.
- **`vk_render_*` helpers in `lib/_helpers.sh`** — `vk_render_claude_md`, `vk_render_readme`, `vk_render_duplicate_check_yaml`. Shared by `vault-init.sh` and `vault-update.sh` so the layout content lives in one place.

### Changed
- **`vaultkit connect` no longer fails on incomplete layout** — when a clone is missing the standard layout, `connect` now warns, keeps the clone, and registers MCP anyway. The warning suggests `vaultkit update` to the owner. Previously: hard error + clone rollback.
- **Help reorganized by intent** — `vaultkit help` and the README command table now group commands as `CREATE & CONNECT`, `EVERYDAY USE`, `WHEN SOMETHING'S WRONG`, `CHANGE OR REMOVE`. Descriptions rewritten to be scenario-driven ("vault is missing layout files") rather than mechanism-driven ("refresh launcher and re-pin SHA-256").
- **`vaultkit status` summary now shows registry data** — branch + dirty/ahead/behind, last commit, plus path, remote URL, and pinned SHA-256 per vault. Replaces the old per-line summary.
- **Deploy workflow extracted** — `vault-init.sh` no longer inlines the `deploy.yml` heredoc; copies from `lib/deploy.yml.tmpl` instead.

### Removed (BREAKING)
- **`vaultkit list`** — folded into `vaultkit status` (which now shows path, remote URL, pinned SHA, branch + state, and last commit per vault). `vaultkit list` now exits with `unknown command`.
- **`vaultkit version`** — replaced by the `vaultkit --version` flag (same output: version, node, platform, vault count). `vaultkit version` now exits with `unknown command`.

### Fixed
- **MCP vault path not passed to obsidian-mcp-pro.** The launcher was calling `obsidian-mcp-pro --vault <path>`, but the `--vault` flag is only used by obsidian-mcp-pro's `install` subcommand — it is silently ignored at runtime. The server only reads the vault path from `OBSIDIAN_VAULT_PATH` env var (checked first) or Obsidian's global `obsidian.json`. Vaults not registered in Obsidian (e.g. freshly cloned by collaborators who don't have Obsidian installed) always fell back to whatever Obsidian had configured — or got "vault path is not configured". The launcher now passes `OBSIDIAN_VAULT_PATH` as an environment variable instead.
- **`.obsidian/` stub created at launcher startup.** Cloned vaults don't include `.obsidian/` (gitignored by design). The launcher now creates it if absent so obsidian-mcp-pro's vault structure validation passes.

## [1.4.0] - 2026-04-28

### Added
- **`vaultkit verify <name>`** — inspect a vault's launcher state and re-pin its SHA-256 if you accept the change. Pairs cleanly with the security model: when the launcher refuses to start (hash mismatch) or refuses to merge an upstream launcher change, `verify` shows the diff, lets you decide, and re-registers the MCP server with the new pinned hash.
- **`vaultkit visibility <name> <public|private|auth-gated>`** — flip a vault's GitHub repo + Pages visibility. Calls `gh repo edit --visibility ...` and the Pages API. Refuses to promote a notes-only vault (no `deploy.yml`) — re-init for that.
- **`vaultkit status [name]`** — without args, one-line summary per vault (branch, ahead/behind, dirty flag, last commit). With a name, full `git status` for that vault.
- **`vaultkit backup <name>`** — local zip snapshot of tracked content via `git archive HEAD`. Lands in `$VAULTKIT_HOME/.backups/<name>-<timestamp>.zip`.
- **`vaultkit version`** — prints the installed vaultkit version, Node.js version, platform, and registered vault count.
- **Per-command `--help`** — every `vault-*.sh` now responds to `--help` / `-h` with its specific usage text. The dispatcher's `vaultkit help` lists all commands plus flags and environment variables.
- **`VAULTKIT_LOG`** env var — when set, the dispatcher appends one TSV line per command (timestamp, command, args, exit code, duration) to that path. No-op when unset.
- **`VAULTKIT_PULL_TIMEOUT`** env var — overrides the per-vault `git pull` timeout in `vaultkit pull` (default: 30000ms).
- **`--verbose` / `-v`** flag — sets `VAULTKIT_VERBOSE=1` in the spawned script's environment for opt-in trace output.

### Changed
- Dispatcher (`bin/vaultkit.js`) help text now lists all 13 commands, plus the new flags and env vars.

## [1.3.0] - 2026-04-28

### Added
- **Launcher self-verification.** `.mcp-start.js` now refuses to launch if its on-disk SHA-256 does not match the hash pinned at MCP registration time, and refuses to fast-forward if upstream introduces a changed launcher. This closes the auto-pull supply-chain hole — once a vault is connected, future upstream changes to the launcher require an explicit `vaultkit update` re-trust.
- **Publish prompt in `init`.** `vaultkit init` now asks whether the vault should be a public site, a private notes-only vault (no Pages, no deploy workflow — fully hidden), or a private repo with auth-gated Pages (Pro+ only). Default flipped from "public" to "private notes-only".
- **Ownership check in `destroy`.** Explicit `gh api repos/.../permissions.admin` lookup before promising deletion. Collaborators running `destroy` on a vault they don't own now get a clear "you don't own this repo" message instead of a misleading "repo not found" plus silent local-only deletion.
- **Branch + PR fallback in `update`.** When `git push` to `main` fails (branch protection or no write access), the launcher update is moved off `main` to a fresh feature branch and a PR is opened automatically. Previously, the local commit was left dangling ahead of upstream.
- **Vault structure validation in `connect`.** Refuses to register repos that lack the standard layout (`.obsidian/` or `CLAUDE.md` + `raw/` + `wiki/`).
- **Transactional rollback in `connect`.** Removes the partial clone if MCP registration fails mid-flight.
- `LICENSE` (MIT), `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `.gitignore` for public-release readiness.
- GitHub Actions: `ci.yml` (shellcheck, `node --check`, `npm publish --dry-run`) and `release.yml` (publish on tag).
- `package.json` metadata: `author`, `homepage`, `bugs`.
- `lib/` shipped in npm package: `mcp-start.js.tmpl` (single source of truth for the launcher) and `_helpers.sh` (shared bash functions).

### Changed
- **Filesystem fallback removed from `destroy` and `update`.** Both now require the vault to be in the MCP registry. This matches `disconnect`'s policy and prevents accidentally destroying or modifying directories that happen to live at the default path but were never connected.
- **`vaultkit init` no longer takes `--private`.** Replaced by the interactive publish prompt above. Backwards compatibility note: scripts that called `vaultkit init <name> --private` need updating.
- `vaultkit list` now shows the pinned SHA-256 (or a hint to run `update` if missing) and sorts vaults by name.
- `vaultkit doctor` now flags vaults registered without a pinned hash and detects pinned-hash drift (registered hash vs on-disk hash mismatch).
- Launcher template (`.mcp-start.js`) consolidated into `lib/mcp-start.js.tmpl` — previously duplicated across `vault-init.sh` and `vault-update.sh`.
- Shared bash helpers (`vk_resolve_vault_dir`, `vk_is_vault_like`, `vk_to_posix`, `vk_to_windows`, `vk_sha256`, `vk_validate_vault_name`) extracted into `lib/_helpers.sh` and sourced by every `vault-*.sh`.

### Fixed
- `vault-doctor.sh` now uses `set -euo pipefail` (was missing `-e`).
- `vault-init.sh` now sets `CREATED_REPO=true` only after both `gh repo create` and `git remote add` succeed, so cleanup correctly handles a half-wired repo.

## [1.2.1] - 2026-04-18

### Fixed
- MCP disconnection bug.
- `init` command not creating vault at root level on Windows.

### Security
- Show `.mcp-start.js` SHA-256 hash and require explicit `[y/N]` confirmation before MCP registration in `vaultkit connect`.
- Comprehensive security audit pass.

## [1.2.0]

### Added
- `vaultkit destroy` — fully delete a vault (local + GitHub + MCP).

### Fixed
- Robust `gh` detection on Windows (probes known install locations to work around stale PATH after registry changes).
- Node.js version check (requires 22+).

## [1.1.1]

### Fixed
- `vault-disconnect` looks up the vault path from the MCP registry rather than the current working directory.
- `vault-update` Windows path handling.

## [1.1.0]

### Added
- `disconnect`, `list`, `pull`, `update`, `doctor` commands.

## [1.0.0]

Initial public release. Single-command Obsidian wiki creation: GitHub repo + Pages site + branch protection + Claude Code MCP registration.
