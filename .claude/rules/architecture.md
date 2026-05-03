---
paths:
  - "bin/**/*.ts"
  - "src/**/*.ts"
  - "tests/**/*.ts"
  - "scripts/**/*"
  - "tsconfig*.json"
  - "lib/**/*.tmpl"
  - "package.json"
  - "package.json"
  - "lib/*.tmpl"
---

# vaultkit Architecture

## Stack

**Runtime**: Node.js ≥22, ESM (`"type": "module"`), TypeScript source under [bin/](../../bin/), [src/](../../src/), [tests/](../../tests/).

**Dispatch flow**: `vaultkit <cmd>` → [bin/vaultkit.ts](../../bin/vaultkit.ts) (commander) → [src/commands/](../../src/commands/)`<cmd>.ts`. The compiled package ships `dist/bin/vaultkit.js` → `dist/src/commands/<cmd>.js`.

**Build**: `npm run build` runs `tsc -p tsconfig.build.json` then [scripts/post-build.mjs](../../scripts/post-build.mjs) (which copies `lib/*.tmpl` into `dist/lib/` and chmods the bin executable on Unix). `prepublishOnly` runs the build before `npm publish`.

**State**: `~/.claude.json` — the `mcpServers` object is the vault registry. Commands read it via [src/lib/registry.ts](../../src/lib/registry.ts).

**Launcher template**: [lib/mcp-start.js.tmpl](../../lib/mcp-start.js.tmpl) is the single source of truth for the per-vault `.mcp-start.js`. **It stays as raw JavaScript** — every existing user vault verifies its SHA-256 on every Claude Code session, so the byte content is immutable. `init.ts` and `update.ts` `copyFileSync` it from `<repo>/lib/` (in dev) or `<install-root>/dist/lib/` (post-install — populated by the post-build script).

**Windows**: [src/lib/platform.ts](../../src/lib/platform.ts) provides `findTool`, `isWindows`, `vaultsRoot`, `claudeJsonPath`. Never assume `gh` or `claude` are on PATH — use `findTool`.

**Audit logging**: Set `VAULTKIT_LOG=<path>` to append TSV rows (timestamp, command, args, exit code, duration) to a file.

## Command → Module Map

| Command    | Module                     |
|-----------|----------------------------|
| setup      | src/commands/setup.ts      |
| init       | src/commands/init.ts       |
| connect    | src/commands/connect.ts    |
| disconnect | src/commands/disconnect.ts |
| destroy    | src/commands/destroy.ts    |
| pull       | src/commands/pull.ts       |
| refresh    | src/commands/refresh.ts    |
| update     | src/commands/update.ts     |
| doctor     | src/commands/doctor.ts     |
| verify     | src/commands/verify.ts     |
| status     | src/commands/status.ts     |
| backup     | src/commands/backup.ts     |
| visibility | src/commands/visibility.ts |

To scaffold a new command: `/add-command`.

## Shared Libraries — `src/lib/`

| File | Key Exports |
|---|---|
| `registry.ts` | `getAllVaults`, `getVaultDir`, `getExpectedHash`, `addToRegistry`, `removeFromRegistry` — reads/writes `~/.claude.json` |
| `vault.ts` | `Vault` class (`tryFromName`, `requireFromName`, `fromRecord`, `launcherPath`, `existsOnDisk`, `isVaultLike`, `hasGitRepo`, `hasLauncher`, `sha256OfLauncher`); `validateName`, `isVaultLike`, `sha256`. Use `requireFromName` (throws `VaultkitError('NOT_REGISTERED')` on miss) for commands that have no meaningful unregistered code path; reserve `tryFromName` for the inverse check (`if (existing) throw ALREADY_REGISTERED`) or when an extra command-specific hint must be appended to the canonical message. |
| `vault-templates.ts` | Static-content builders for new vault scaffolding: `renderClaudeMd`, `renderReadme`, `renderDuplicateCheckYaml`, `renderVaultJson`, `renderGitignore`, `renderGitattributes`, `renderIndexMd`, `renderLogMd`. Used by `vault-layout.ts` and `visibility.ts` (for `_vault.json`). |
| `vault-layout.ts` | Shared layout machinery: `CANONICAL_LAYOUT_FILES` (deterministic creation order), `renderLayoutFile(path, ctx)`, `detectLayoutGaps(vaultDir)`, `createDirectoryTree(vaultDir)`, `writeLayoutFiles(vaultDir, ctx, files)`. Used by `init.ts` (full creation) and `update.ts` (gap repair). |
| `constants.ts` | Domain-meaningful literal constants: `VAULT_FILES` (LAUNCHER, CLAUDE_MD, README, INDEX, LOG, GITIGNORE, GITATTRIBUTES, VAULT_JSON, OBSIDIAN_DIR, CLAUDE_SETTINGS, PR_TEMPLATE), `VAULT_DIRS` (RAW, WIKI, GITHUB_WORKFLOWS), `WORKFLOW_FILES` (DEPLOY, DUPLICATE_CHECK, FRESHNESS), `VAULT_CONSTRAINTS` (NAME_MAX_LENGTH, NAME_PATTERN), `PUBLISH_MODES` const tuple + derived `PublishMode` type + `isPublishMode` type guard (used by `init` and `visibility` for shared mode validation). Migrate inline `'.mcp-start.js'`/`'CLAUDE.md'`/etc. to these as you touch the call sites. |
| `mcp.ts` | `claude mcp` CLI helpers: `runMcpAdd` (single source of truth for the `--expected-sha256=<hash>` invariant), `runMcpRemove`, `runMcpRepin`, `manualMcpAddCommand`, `manualMcpRemoveCommand`, `manualMcpRepinCommands`, `findOrInstallClaude`. Every command that issues `claude mcp <verb>` must go through these helpers — never via raw `execa(['claude', 'mcp', ...])`. |
| `platform.ts` | `isWindows`, `claudeJsonPath`, `vaultsRoot`, `findTool`, `npmGlobalBin`, `installGhForPlatform` (winget/brew/apt/dnf bootstrap for `gh`; throws `VaultkitError('TOOL_MISSING')` on unsupported platforms — used by `setup` and `init` when `findTool('gh')` returns null), `getLauncherTemplate()` / `getDeployTemplate()` / `getFreshnessTemplate()` / `getPrTemplate()` / `getClaudeSettingsTemplate()` (single source of truth for the byte-immutable template paths under `lib/`; resolves to `<repo>/lib/...` in dev and `<install>/dist/lib/...` after build because the post-build script keeps the relative offset constant — used by `init`, `update`, `visibility`) |
| `prereqs.ts` | Shared prerequisite checks: `checkNode()`, `ensureGh({ log, skipInstallCheck })` (locate or install via `installGhForPlatform`), `ensureGhAuth({ ghPath, log, scopes? })` (run `gh auth login`/`refresh`; pass `scopes: ['repo','workflow']` from `setup`, omit from `init`'s [1/6]), `ensureGitConfig({ nameOpt?, emailOpt? })` (prompt + `git config --global` if missing). Single source of truth so `vaultkit setup` and `init`'s preflight cannot drift. Per the `delete_repo` security invariant, `ensureGhAuth` must NEVER be called with `delete_repo` in its scopes — that scope is granted on demand by `destroy` via `ensureDeleteRepoScope` in `github.ts`. |
| `git.ts` | `init`, `setDefaultBranch`, `addRemote`, `add`, `commit`, `push`, `pull`, `getStatus`, `pushNewRepo` (retries on transient first-push races), `pushOrPr`, `archiveZip`, `clone`, `getRepoSlug` (function form — `GitClient` class evaluated and rejected per Phase 6 stop signal). `pushNewRepo` and `pushOrPr` recognize the GitHub abuse-flag stderr (`Repository '<x>' is disabled.` / `Please ask the owner to check their account.`) and short-circuit to `VaultkitError('AUTH_REQUIRED')` instead of burning the retry budget — same surface as `gh-retry.ts:_classifyGhFailure` for the gh-API path. |
| `gh-retry.ts` | The retry / classification layer for `gh` calls — extracted from `github.ts` so the same retry semantics serve `github.ts`'s wrappers and any other consumer (e.g. `refresh.ts`'s commit-since-clip check) without copying. Exports: `gh(...args)` (raw, never throws — returns `{ stdout, stderr, exitCode, headers, body, status }` with response headers parsed when `--include` is used), `ghJson(...args)` (throwing variant with classification-aware retry: transient = 1s/2s/4s backoff, rate_limited = honor `Retry-After` up to 3 retries then throw `VaultkitError('RATE_LIMITED')`, auth_flagged = throw `VaultkitError('AUTH_REQUIRED')` immediately, fatal = throw immediately). Pure helpers (exported with `_` prefix for unit tests): `_parseGhIncludeOutput(raw)` parses status + headers + body from a `--include` blob; `_classifyGhFailure(status, body, stderr, headers)` returns `{ kind: 'transient' \| 'rate_limited' \| 'auth_flagged' \| 'fatal', backoffMs?, reason }`. The transient bucket also covers two visibility-propagation 422 races: "previous visibility change is still in progress" (on the source PATCH) and "your current plan does not support GitHub Pages" (on a downstream `/pages` POST after a private→public flip — Pages-auth lag). |
| `poll.ts` | `pollUntil(read, predicate, opts?)` — generic poll-for-confirmation helper. Calls `read()` repeatedly with `intervalMs` between attempts (default 500ms) until the predicate returns true or `timeoutMs` elapses (default 30s). Throws `VaultkitError('NETWORK_TIMEOUT')` on timeout with the description and last-observed value embedded in the message. Used by `github.ts:setRepoVisibility` / `enablePages` / `setPagesVisibility` to bridge GitHub's eventual-consistency window between a mutation API returning success and the change being observable to the caller's next read or downstream endpoint. Distinct from `gh-retry.ts`'s retry-on-failure layer — this fires when one call succeeded but its effect isn't visible yet, not when a call failed. `read()` errors propagate immediately (not a retry-on-error helper); pair with `ghJson` if the read itself can be flaky. |
| `github.ts` | Live `gh` wrappers + JSON parsers + URL builders. `createRepo` / `deleteRepo` / `setRepoVisibility` use `gh api --include` (POST `/user/repos`, DELETE `/repos/<slug>`, PATCH `/repos/<slug>`) so the retry layer (`gh-retry.ts:ghJson`) can read `X-RateLimit-*` / `Retry-After` response headers. `setRepoVisibility`, `enablePages`, and `setPagesVisibility` each poll their corresponding read endpoint (`getVisibility`, `pagesExist`, `getPagesVisibility`) post-mutation via `poll.ts:pollUntil` — bridges GitHub's eventual-consistency window so a caller's next dependent call sees the new state instead of a 422 from stale Pages-auth. `deleteRepoCapturing` returns `{ ok, stderr }` for callers that want to log on failure rather than throw — used by `destroy`. Read-only wrappers: `repoExists`, `isAdmin`, `getVisibility`, `enablePages`, `setPagesVisibility`, `disablePages`, `pagesExist`, `getPagesVisibility`, `getCurrentUser`, `getUserPlan`, `requireAuthGatedEligible(extraHint?)` (throws `VaultkitError('PERMISSION_DENIED')` on Free plan), `isAuthenticated`, `ensureDeleteRepoScope(log?)` (interactive `gh auth refresh -s delete_repo`; throws `VaultkitError('AUTH_REQUIRED')` if the user declines). Pure JSON parsers (exported with `_` prefix for tests): `_parseUserJson`, `_parsePlanJson`, `_parseRepoJson`, `_parsePagesJson`. URL builders: `repoUrl(slug, path?)`, `repoCloneUrl(owner, repo)`, `pagesUrl(owner, repo)`. Every command that calls `gh <verb>` for a wrapped operation must go through these helpers (or `gh-retry.ts` directly for ad-hoc API calls like `refresh`'s commit-since-clip check) — never via raw `execa(ghPath, ['repo', ...])` or `execa(ghPath, ['api', ...])`. |
| `errors.ts` | `VaultkitError` class, `VaultkitErrorCode` union (12 categories — `RATE_LIMITED` added 2.7.1 for `ghJson` exhausting the secondary-rate-limit retry budget), `isVaultkitError` guard, `EXIT_CODES` table mapping each code to a process exit code (2-13), `DEFAULT_MESSAGES` template record (canonical phrasing per code; use as `"${name}" ${DEFAULT_MESSAGES.X}`). Public contract: scripted callers may rely on the codes. |
| `logger.ts` | `Logger` interface (`info` / `warn` / `error` / `debug`), `ConsoleLogger` (production), `SilentLogger` (test no-op). Replaced the flat `LogFn` type in v2.1.0. |
| `messages.ts` | Repeated user-facing strings: `PROMPTS` (TYPE_NAME_TO_CONFIRM, TYPE_NAME_TO_CONFIRM_DELETION, PROCEED, INSTALL_CLAUDE, REGISTER_AS_MCP), `LABELS` (ABORTED). One-shot prompts stay inline. |
| `update-check.ts` | `checkForUpdate(currentVersion, log)` — best-effort once-per-24h npm registry poll for newer vaultkit versions. Reads/writes `~/.vaultkit-update-check.json` (cache with TTL); fires a background `https.request` with `unref`'d socket so the CLI exits without waiting. Skipped when `VAULTKIT_NO_UPDATE_CHECK=1`. Wired into `bin/vaultkit.ts:wrap()` after successful action. Pure-function `_isNewer(latest, current)` is exported for testing — handles 3-component dot-version strings, returns `false` on non-numeric components rather than throwing. |
| `text-compare.ts` | Non-git source freshness check helper. Exports `plainTextFromMarkdown(md)` (strip frontmatter + markdown formatting → plain text), `similarity(a, b)` (Jaccard over word sets, [0,1]), and `compareSource(url, localMarkdownText) => Promise<CompareResult>` where `CompareResult` is either `{ kind: 'compared', similarity }` or `{ kind: 'unfetchable', reason }`. Dynamically imports `jsdom` + `@mozilla/readability` so the runtime cost lands only on `vaultkit refresh`. Used by `refresh.ts` (Topic 2). |
| `claude-md-merge.ts` | Marker-based merge for vaultkit-managed sections in CLAUDE.md. Exports `renderManagedSection(id, body)` (wraps body in `<!-- vaultkit:<id>:start/end -->` markers) and `mergeManagedSection(existingMd, id, body, headingName) => { merged, action: 'replaced' \| 'appended' \| 'manual' }`. Three cases: markers present → replace; markers absent + no heading → append; heading present without markers → user has hand-edited, return original. Reusable for any future vaultkit-managed CLAUDE.md region. Used by `update.ts` (Topic 2) for the wiki-style policy section. |

[src/types.ts](../../src/types.ts) holds shared types: `ClaudeConfig`, `McpServerEntry`, `VaultRecord`, `RunOptions`, `CommandModule`, `GitPushResult`, `GitPullResult`, `GitStatus`, `GitPushOrPrResult`, `GhUserResponse`, `GhRepoResponse`, `GhPagesResponse`, `GhRepoInfo`, `Visibility`.

## Templates — `lib/`

| File | Purpose |
|---|---|
| [lib/mcp-start.js.tmpl](../../lib/mcp-start.js.tmpl) | Single source of truth for `.mcp-start.js`. SHA-256 self-verification on every Claude Code session. **Byte-immutable for backward compatibility.** Copied into `dist/lib/` by [scripts/post-build.mjs](../../scripts/post-build.mjs). |
| [lib/deploy.yml.tmpl](../../lib/deploy.yml.tmpl) | GitHub Actions workflow for Quartz/GitHub Pages deployment. |
| [lib/freshness.yml.tmpl](../../lib/freshness.yml.tmpl) | GitHub Actions workflow for the scheduled `vaultkit refresh` (Topic 2). Weekly cron + `workflow_dispatch`. Runs `npx -y @aleburrascano/vaultkit refresh --vault-dir .`, commits the new report under `wiki/_freshness/`, opens a PR. Uses default `GITHUB_TOKEN`; no Anthropic secrets. |
| [lib/pr-template.md.tmpl](../../lib/pr-template.md.tmpl) | PR description scaffold installed at `.github/pull_request_template.md` in scaffolded vaults. Asks contributors to declare their Claude Code session config (model, thinking, effort) and which sources from the freshness report they incorporated. Visibility, not enforcement. |
| [lib/claude-settings.json.tmpl](../../lib/claude-settings.json.tmpl) | Project-scoped `.claude/settings.json` with `model: "sonnet"` and a `permissions.additionalDirectories: ["raw", "wiki"]` default. Applies when collaborators `cd` into the vault and run `claude` there for a refresh session. |

All ship inside `dist/lib/` after the post-build copy. Source `lib/` exists for in-repo dev (`src/commands/init.ts`'s `'../../lib/<tmpl>'` path resolves to `<repo>/lib/<tmpl>` from raw source and to `<install-root>/dist/lib/<tmpl>` from compiled output, because the post-build copy keeps the relative offset constant).

## Adding a New Command

(Use `/add-command` for the guided scaffold; this section is the manual checklist.)

1. Create `src/commands/<name>.ts`. Export `async function run(params, options?: <Name>Options): Promise<...>` where `<Name>Options extends RunOptions` adds command-specific fields.
2. Add `.command('<name> ...')` to the `program` in [bin/vaultkit.ts](../../bin/vaultkit.ts) with a dynamic `import('../src/commands/<name>.js')` inside `wrap()`. (The `.js` specifier is correct in TS source — Node ESM's `NodeNext` resolution maps it to the `.ts` file at compile time.)
3. `package.json#files` is `["dist/"]` and `bin` is `"dist/bin/vaultkit.js"` — no change needed for new commands.
4. Add a row to README.md.
5. Add an entry under `## [Unreleased]` in CHANGELOG.md.
6. Add `tests/commands/<name>.test.ts` covering happy path + key error cases.
