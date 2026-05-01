---
paths:
  - "bin/**/*.ts"
  - "src/**/*.ts"
  - "tests/**/*.ts"
  - "scripts/**/*"
  - "tsconfig*.json"
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
| init       | src/commands/init.ts       |
| connect    | src/commands/connect.ts    |
| disconnect | src/commands/disconnect.ts |
| destroy    | src/commands/destroy.ts    |
| pull       | src/commands/pull.ts       |
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
| `constants.ts` | Domain-meaningful literal constants: `VAULT_FILES` (LAUNCHER, CLAUDE_MD, README, INDEX, LOG, GITIGNORE, GITATTRIBUTES, VAULT_JSON, OBSIDIAN_DIR), `VAULT_DIRS` (RAW, WIKI, GITHUB_WORKFLOWS), `WORKFLOW_FILES` (DEPLOY, DUPLICATE_CHECK), `VAULT_CONSTRAINTS` (NAME_MAX_LENGTH, NAME_PATTERN), `PUBLISH_MODES` const tuple + derived `PublishMode` type + `isPublishMode` type guard (used by `init` and `visibility` for shared mode validation). Migrate inline `'.mcp-start.js'`/`'CLAUDE.md'`/etc. to these as you touch the call sites. |
| `mcp.ts` | `claude mcp` CLI helpers: `runMcpAdd` (single source of truth for the `--expected-sha256=<hash>` invariant), `runMcpRemove`, `runMcpRepin`, `manualMcpAddCommand`, `manualMcpRemoveCommand`, `manualMcpRepinCommands`, `findOrInstallClaude`. Every command that issues `claude mcp <verb>` must go through these helpers — never via raw `execa(['claude', 'mcp', ...])`. |
| `platform.ts` | `isWindows`, `claudeJsonPath`, `vaultsRoot`, `findTool`, `npmGlobalBin` |
| `git.ts` | `init`, `add`, `commit`, `push`, `pull`, `getStatus`, `pushOrPr`, `archiveZip`, `clone`, `getRepoSlug` (function form — `GitClient` class evaluated and rejected per Phase 6 stop signal) |
| `github.ts` | `createRepo`, `deleteRepo`, `repoExists`, `isAdmin`, `getVisibility`, `setRepoVisibility`, `enablePages`, `setPagesVisibility`, `disablePages`, `pagesExist`, `getPagesVisibility`, `getCurrentUser`, `getUserPlan`, `isAuthenticated`, `ensureDeleteRepoScope`. URL builders: `repoUrl(slug, path?)`, `repoCloneUrl(owner, repo)`, `pagesUrl(owner, repo)` — single source of truth for github.com URL construction. Every command that calls `gh <verb>` for a wrapped operation must go through these helpers — never via raw `execa(ghPath, ['repo', ...])` or `execa(ghPath, ['api', ...])`. |
| `errors.ts` | `VaultkitError` class, `VaultkitErrorCode` union (11 categories), `isVaultkitError` guard, `EXIT_CODES` table mapping each code to a process exit code (2-12), `DEFAULT_MESSAGES` template record (canonical phrasing per code; use as `"${name}" ${DEFAULT_MESSAGES.X}`). Public contract: scripted callers may rely on the codes. |
| `logger.ts` | `Logger` interface (`info` / `warn` / `error` / `debug`), `ConsoleLogger` (production), `SilentLogger` (test no-op). Replaced the flat `LogFn` type in v2.1.0. |
| `messages.ts` | Repeated user-facing strings: `PROMPTS` (TYPE_NAME_TO_CONFIRM, TYPE_NAME_TO_CONFIRM_DELETION, PROCEED, INSTALL_CLAUDE, REGISTER_AS_MCP), `LABELS` (ABORTED). One-shot prompts stay inline. |

[src/types.ts](../../src/types.ts) holds shared types: `ClaudeConfig`, `McpServerEntry`, `VaultRecord`, `RunOptions`, `CommandModule`, `GitPushResult`, `GitPullResult`, `GitStatus`, `GitPushOrPrResult`, `GhUserResponse`, `GhRepoResponse`, `GhPagesResponse`, `GhRepoInfo`, `Visibility`.

## Templates — `lib/`

| File | Purpose |
|---|---|
| [lib/mcp-start.js.tmpl](../../lib/mcp-start.js.tmpl) | Single source of truth for `.mcp-start.js`. SHA-256 self-verification on every Claude Code session. **Byte-immutable for backward compatibility.** Copied into `dist/lib/` by [scripts/post-build.mjs](../../scripts/post-build.mjs). |
| [lib/deploy.yml.tmpl](../../lib/deploy.yml.tmpl) | GitHub Actions workflow for Quartz/GitHub Pages deployment. |

Both ship inside `dist/lib/` after the post-build copy. Source `lib/` exists for in-repo dev (`src/commands/init.ts`'s `'../../lib/<tmpl>'` path resolves to `<repo>/lib/<tmpl>` from raw source and to `<install-root>/dist/lib/<tmpl>` from compiled output, because the post-build copy keeps the relative offset constant).

## Adding a New Command

(Use `/add-command` for the guided scaffold; this section is the manual checklist.)

1. Create `src/commands/<name>.ts`. Export `async function run(params, options?: <Name>Options): Promise<...>` where `<Name>Options extends RunOptions` adds command-specific fields.
2. Add `.command('<name> ...')` to the `program` in [bin/vaultkit.ts](../../bin/vaultkit.ts) with a dynamic `import('../src/commands/<name>.js')` inside `wrap()`. (The `.js` specifier is correct in TS source — Node ESM's `NodeNext` resolution maps it to the `.ts` file at compile time.)
3. `package.json#files` is `["dist/"]` and `bin` is `"dist/bin/vaultkit.js"` — no change needed for new commands.
4. Add a row to README.md.
5. Add an entry under `## [Unreleased]` in CHANGELOG.md.
6. Add `tests/commands/<name>.test.ts` covering happy path + key error cases.
