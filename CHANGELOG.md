# Changelog

All notable changes to vaultkit are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.8.0] - 2026-05-05

### Added
- **BM25 search index foundation (`src/lib/search-index.ts`).** SQLite FTS5 wrapper for the upcoming `vaultkit-search` MCP. Schema: `notes(vault, path, title, tags, body)` with BM25 weighting `(5, 3, 1)` — title hits dominate body hits, fixing the natural-language failure mode where queries like `"token optimization"` against a note titled `"Token Efficiency"` returned zero results under literal-substring search. User queries are OR-joined after sanitization so multi-token queries find any partial-match note (BM25 ranks all-term matches highest). Backed by Node's built-in `node:sqlite` (Node ≥22.13) — zero npm runtime dependency, identical FTS5 + BM25 behavior to `better-sqlite3` because both bind the same SQLite library. Lives at `~/.vaultkit-search.db` in WAL mode. 33 unit tests pinning BM25 weighting (title > tags > body), unicode handling, query sanitization, vault scoping, and the friend-failure-mode reproducer (`"token optimization"` → `"Token Efficiency"` via title BM25). Engine choice (node:sqlite vs. better-sqlite3 vs. sql.js-fts5) covered by ADR-0011 once written. Also adds `listTags(vault?)` and `notesByTag(tag, opts)` for the `vk_get_tags` / `vk_search_by_tag` MCP tools, and exports `ISearchIndex` interface + `NoteRef` type so MCP tool handlers and the indexer depend on the abstraction rather than the concrete SQLite-backed class. A second concrete implementation (`FakeSearchIndex`, backed by an in-memory `Map`) ships in `tests/helpers/search-index.ts` for unit-testing tool handlers without SQLite. `openSearchIndex()` now calls `openFts5Db()` from `src/lib/sqlite-backend.ts` instead of `new DatabaseSync()` directly — enabling the Windows FTS5 fallback described below.
- **Hand-rolled MCP stdio server (`src/lib/mcp-stdio.ts`).** Newline-delimited JSON-RPC 2.0 over stdio implementing the minimum surface Claude Code uses: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`. Replaces `@modelcontextprotocol/sdk` (~5.6 MB) with ~250 LOC we own. Tool exceptions surface as `{ isError: true, content }` per the spec; protocol-level errors follow JSON-RPC (-32601 unknown method, -32602 bad params, -32603 internal). 14 unit tests pin every protocol surface — initialize echo, version negotiation, notifications-don't-reply, tools/list shape, tool invocation, error wrapping for handler exceptions, unknown-tool-as-isError, malformed JSON resilience, sequential-request flow, tool-overwrite-on-duplicate-name.
- **Hand-rolled tool input validator (`src/lib/json-rpc-validator.ts`).** Replaces `zod` (~5.9 MB) for the per-vault MCP server's tool argument shape-checking with ~60 LOC of explicit checks — `validateString`, `validateOptionalString`, `validateOptionalInteger`, plus the `ValidationError` class. Per-tool handlers call them directly; failures surface to the LLM via `mcp-stdio.ts`'s tool-error wrapping. 14 unit tests cover required/optional, type checks, min/max/minLength/enum constraints.
- **Per-vault MCP server (`src/commands/mcp-server.ts`) — the long-running daemon.** Spawned by the byte-immutable per-vault launcher (`lib/mcp-start.js.tmpl`) on every Claude Code session start. Replaces `npx obsidian-mcp-pro <vault-dir>` as the launcher's spawn target. Reverse-looks-up the vault name from the registry by directory, opens `~/.vaultkit-search.db`, registers 6 tools, and serves stdio until the launcher exits. Added to `SETUP_BYPASS` (it's a long-lived daemon, not interactive). Wired into `bin/vaultkit.ts` as `vaultkit mcp-server --vault-dir <path>`. The launcher template still spawns `npx obsidian-mcp-pro` for now — Phase 3 of the rework switches it.
- **Six Claude-tuned MCP tools (`src/mcp-tools/`).** One file per tool plus `context.ts` (shared `ToolContext` carrying current vault + cross-vault accessors) and `index.ts` (`buildToolList(ctx)` factory):
  - `vk_search(query, vault?, top_k?)` — BM25 search. Defaults to current vault; `"*"` for cross-vault.
  - `vk_list_notes(vault?, prefix?, limit?)` — filesystem walk via the indexer's `_walkMarkdown`. Skips `.git`, `.obsidian`, `node_modules`, `wiki/_freshness`, etc.
  - `vk_get_note(path, vault?)` — reads a note + decomposes frontmatter / outline / body so Claude can pull only the part it needs. Path-traversal-defended.
  - `vk_get_tags(vault?)` — distinct tags via `SearchIndex.listTags`.
  - `vk_search_by_tag(tag, vault?, limit?)` — notes carrying the given tag via `SearchIndex.notesByTag`.
  - `vk_recent_notes(vault?, limit?)` — filesystem walk + mtime sort.
  Each tool's description is written for the LLM to read at `tools/list` time. Output formats are tuned for Claude's context budget (terse, structured, snippet-truncated). 16 integration tests against an on-disk vault fixture cover happy paths, friend's failure-case ranking, path traversal defense, prefix/limit filters, and cross-vault scoping. Replaces `obsidian-mcp-pro`'s 25-tool general-purpose surface with the 6 tools that cover ~95% of friends-and-teachers usage; Phase 5 of the rework deletes `obsidian-mcp-pro`'s npx-cached install.
- **`src/mcp-tools/` directory documented in `.claude/rules/architecture.md`.** New section "MCP Tool Surface — `src/mcp-tools/`" mirrors the existing `src/lib/` table format, lists each tool's signature + responsibility, and points future contributors at the one-file-per-tool extension pattern. Adding a 7th tool is one new file plus one line in `index.ts`.
- **Search indexer (`src/lib/search-indexer.ts`).** Walks a vault tree and populates `SearchIndex`. Exports `indexVault(vaultName, vaultDir, index)` (full re-index per call, returns `{ added, updated, removed }`) and `removeVaultFromIndex(vaultName, index)` (used by `destroy`/`disconnect`). Skips `.git`, `.obsidian`, `.github`, `node_modules`, `.vaultkit`, `.smart-env`, and `wiki/_freshness`. Title comes from frontmatter → first H1 → filename. Tags handle both YAML-list-as-string and comma/whitespace forms. 25 unit tests covering walk filtering, title/tag extraction, full lifecycle (add/update/remove across runs), cross-vault isolation, and graceful handling of missing directories. Filesystem walking delegates to `vault-walk.ts` (extracted later in this release — see below). Wired into `init` (initial index), `update` (re-index after layout reconcile), `pull` (re-index per pulled vault), and `destroy`/`disconnect` (index cleanup).
- **Vault walk module (`src/lib/vault-walk.ts`).** Extracted from `search-indexer.ts` per SRP — the indexer has one reason to change (indexing logic), the walk has another (exclusion rules). Exports `walkMarkdown(rootDir, currentRel?)` (generator yielding `{ rel, full }` for every `.md` file) and `SKIP_DIRS` (canonical set of excluded names: `.git`, `.obsidian`, `.github`, `node_modules`, `.vaultkit`, `.smart-env`, `wiki/_freshness`). Imported by `search-indexer.ts`, `vk-list-notes.ts`, and `vk-recent-notes.ts`; the latter two now reference the canonical source instead of the underscore-prefixed test export on the indexer.
- **Cross-platform FTS5 backend selector (`src/lib/sqlite-backend.ts`).** Exports `DbLike` / `StatementLike` interfaces (minimal common surface of `node:sqlite` and `better-sqlite3`), `hasFts5()` (probes FTS5 availability via a throw-away `:memory:` DB — never touches real files), and `openFts5Db(path)` (tries `node:sqlite` first; falls back to `better-sqlite3` when FTS5 is absent). On Linux/Mac, `node:sqlite` provides FTS5 at zero runtime cost. On Windows, Node 22.x's MSVC build omits `SQLITE_ENABLE_FTS5`; `better-sqlite3` (optionalDependency, ships prebuilt Windows binaries with FTS5) is used as the fallback. Both backends expose the same `.exec()` / `.prepare()` / `.close()` surface so `SearchIndex` is driver-agnostic.
- **`vaultkit-search` MCP server (`bin/vaultkit-search-server.ts`).** Standalone Node binary registered as a second `bin` entry in `package.json`. Connects to Claude Code via the MCP stdio transport and exposes two tools: `vk_search(query, vault?, top_k?)` (BM25-ranked search across indexed vaults) and `vk_list_vaults()` (lists indexed vault names + note counts). Reads `~/.vaultkit-search.db` lazily on first call; gracefully returns "no results" guidance when the index is empty. Adds runtime deps `@modelcontextprotocol/sdk` and `zod`.
- **Byte-immutable search launcher (`lib/search-launcher.js.tmpl`).** Self-verifying Node script that's installed at `~/.vaultkit/search-launcher.js` and registered via `claude mcp add` with an `--expected-sha256` pin. Mirrors `mcp-start.js.tmpl`'s threat model (per ADR-0001) — refuses to start on SHA mismatch, points the user at `vaultkit setup` for repair. Spawns `npx vaultkit-search-server` after verification.
- **Search MCP registration helper (`src/lib/search-mcp.ts`).** Exports `installSearchLauncher` (copies the byte-immutable template to `~/.vaultkit/search-launcher.js`), `runSearchMcpAdd` / `runSearchMcpRemove` / `runSearchMcpRepin` (delegate to `mcp.ts`'s ACL helpers — keeps the `claude mcp` fitness function passing), `manualSearchMcpAddCommand` (no-claude-CLI fallback), and `isSearchMcpRegistered(cfgPath?)` (used by `setup` for idempotent re-registration). 14 unit tests pinning the canonical argv shape, idempotence, registry detection, and launcher install/SHA stability. 3 integration tests spawning the launcher to verify SHA self-verification (correct pin, wrong pin, no pin → warn-but-proceed).
- **Build pipeline updates.** `scripts/post-build.mjs` copies `search-launcher.js.tmpl` into `dist/lib/` and chmod-s `dist/bin/vaultkit-search-server.js` to 0o755 on Unix. `template-paths.ts` adds `getSearchLauncherTemplate()` mirroring the existing `getLauncherTemplate()`. Build still produces a single npm package — no separate sidecar binary distribution.
- **`vaultkit setup` cleans up legacy vaultkit-search state (Phase 4 migration).** Step 6 in setup is now cleanup-only per ADR-0011: removes the obsolete global `vaultkit-search` MCP entry from `~/.claude.json` (search is now folded into the per-vault MCP server) and deletes the byte-pinned `~/.vaultkit/search-launcher.js`. Idempotent — missing state is a no-op; re-runs are safe. Best-effort throughout: failures log `! warn` but don't block setup. **Crucially keeps `~/.vaultkit-search.db` intact** — every per-vault `vaultkit mcp-server` instance reads from it, so the index data is still load-bearing. 6 mocked unit tests in `tests/commands/setup-search.test.ts` cover the cleanup/no-op/launcher-deletion/db-preservation/no-claude/failure paths.
- **Per-vault launcher template (`lib/mcp-start.js.tmpl`) now spawns `vaultkit mcp-server`** instead of `npx -y obsidian-mcp-pro`. The launcher's other safety properties — SHA-256 self-verification, git fetch/merge with refuse-on-launcher-tampering, `.obsidian/` stub creation, Windows `npx.cmd` workaround — are unchanged. This changes the launcher template's bytes, so existing vaults need a one-time `vaultkit update <name>` to re-pin the SHA-256. Per-vault MCP shape mandated by ADR-0001 stays intact (one MCP per vault, byte-pinned launcher) — only what the launcher spawns has changed. Drops the `OBSIDIAN_VAULT_PATH` env var pattern in favor of the explicit `--vault-dir <path>` CLI arg.

### Removed

- **`bin/vaultkit-search-server.ts`** — replaced by the per-vault `vaultkit mcp-server` daemon (folded under the existing `vaultkit` bin). The second `bin` entry in `package.json` (`vaultkit-search-server`) is gone with it.
- **`lib/search-launcher.js.tmpl`** — the byte-pinned launcher for the global search MCP is no longer needed. Its threat model (no git ops, no privilege amplification beyond what `~/.claude.json` write access already provides) didn't pay its weight.
- **`src/lib/search-mcp.ts`** — registration helpers for the global search MCP. The only post-2.8 caller was setup's legacy-cleanup, which now uses `getAllMcpServerNames` + `runMcpRemove` directly.
- **Runtime dependencies trimmed:** `@modelcontextprotocol/sdk` (~5.6 MB) replaced by the hand-rolled JSON-RPC stdio server in `src/lib/mcp-stdio.ts`; `zod` (~5.9 MB) replaced by hand-rolled validators in `src/lib/json-rpc-validator.ts`. `better-sqlite3` moved from `dependencies` to `optionalDependencies` — on Linux/Mac it is never installed (node:sqlite handles FTS5); on Windows it is installed automatically as an optional dep (prebuilt binaries, no compile step needed). Plus `obsidian-mcp-pro` is no longer downloaded into the npx cache (~12 MB with deps). Net: `@modelcontextprotocol/sdk`, `zod`, and their transitive graphs gone from every install; `better-sqlite3` is still present on Windows but is no longer a mandatory cost on other platforms.
- **`engines.node` floor bumped from `>=22` to `>=22.13`** for unflagged `node:sqlite`. December 2024+ Node releases are required.

### Fixed
- **`vaultkit mcp-server` threads `cfgPath` through `getAllVaults()`** so the registry seam (`RunOptions.cfgPath`) works correctly in tests — previously the call ignored the passed `cfgPath` and always read from the real `~/.claude.json`. Test isolation via an injected registry path now works without the mock touching the real file.

### Architecture

- **[ADR-0011: vaultkit owns the per-vault MCP — drops obsidian-mcp-pro and the global vaultkit-search MCP](docs/decisions/0011-vaultkit-mcp-replaces-obsidian-mcp-pro.md)** records the decision, the corrected accounting from ADR-0010 (24 MB → ~0 MB net for search-related deps), the engine choice (node:sqlite over MiniSearch / sql.js-fts5 / better-sqlite3), the cross-vault decision (one shared DB, vault-scoping via `vault?` arg), and the migration UX (vaultkit setup + vaultkit update). Supersedes ADR-0010, which is now flagged accordingly.
- **`vaultkit init` indexes the new vault into `~/.vaultkit-search.db`.** Runs after MCP registration but before the done-summary. Best-effort — failures log a `Search: indexing failed — …` warning but don't trigger init's transactional rollback. Cross-vault search "just works" the moment a vault is created.
- **`vaultkit update` re-indexes the vault.** After layout reconcile + CLAUDE.md merge — picks up any newly-added layout files and edited content. Best-effort.
- **`vaultkit pull` re-indexes every successfully-pulled vault.** Opens the search index ONCE per pull pass (not per vault) so the cost stays bounded. Skipped on pulls that timed out or failed (disk state is unknown). Best-effort — silent on failure to keep the per-vault log clean.
- **`vaultkit destroy` and `vaultkit disconnect` purge index rows for the removed vault.** Same helper (`removeVaultFromIndex`) called from both code paths. Idempotent — re-running on an already-purged vault is a no-op. Skipped silently when the index file doesn't exist (search MCP never registered).
- **Lifecycle integration tests** in new `tests/commands/search-lifecycle.test.ts`. 7 tests covering init/update/pull/destroy/disconnect call shapes against a real on-disk SQLite file in a temp dir (NOT `~/.vaultkit-search.db` — tests stay hermetic). Roundtrip test pins the full lifecycle (init → update → destroy ends with an empty index).
- **[ADR-0010: BM25 search MCP shipped with vaultkit](docs/decisions/0010-bm25-search-mcp.md)** records the design decision, the alternatives rejected (pure-semantic / fuzzy-only / external Hybrid Search recommendation / per-vault MCPs / embedded launcher / `node:sqlite` migration), and the trigger to revisit (vault size > ~5K notes, real semantic-search use case, shared-index requirement). Cross-linked from `.claude/rules/architecture.md` (lib rows for search-index, search-indexer, search-mcp), `.claude/rules/domain-language.md` (vaultkit-search definition), `.claude/rules/security-invariants.md` (search-launcher byte-immutability + SHA-pin), and the README install section.
- **`SETUP_REQUIRED` error code** (exit 14) and `requireSetup(log)` helper in `src/lib/prereqs.ts`. Check-only gate verifying Node ≥ 22, `gh` on PATH and authenticated, `gh` token has `repo` + `workflow` scopes, and `git config user.name`/`user.email` are set. First step of the bootstrap-UX track that gates non-setup commands when prereqs are missing, replacing the cryptic clone failures users hit on fresh installs.
- **Bootstrap gate wired into `bin/vaultkit.ts:wrap()`.** Every command except `setup` and `doctor` (the `SETUP_BYPASS` set) now runs `requireSetup` before its handler via the new `gateOrSkip(commandName, log)` helper in `prereqs.ts`. A fresh install that skips `vaultkit setup` and runs e.g. `vaultkit connect owner/repo` now fails fast with a clear `Run 'vaultkit setup'` pointer instead of silently falling back to plain `git clone` and emitting a generic git error. `--version` and `--help` are commander built-ins and don't reach `wrap()`, so they're naturally excluded.
- **Universal bootstrap-gate test sweep at `tests/bootstrap-gate.test.ts`.** Parameterized over every `src/commands/*.ts` file: 11 non-bypass commands × 3 failure modes (gh missing, gh unauthed, git config empty) + 1 healthy-prereqs path + 2 bypass commands × 1 unconditional-pass path = 47 assertions. Catches the class of bug where a new command added via `/add-command` forgets to declare its gate posture, or where the gate stops firing for one specific command without anyone noticing.
- **Architectural fitness functions for the bootstrap gate.** Two new checks in `tests/architecture.test.ts`: (1) `bin/vaultkit.ts:wrap()` actively calls `gateOrSkip(commandName, ...)` (not commented out, not behind a feature flag) and imports it from prereqs; (2) every `src/commands/*.ts` file's name appears in `bootstrap-gate.test.ts`'s `COMMANDS_THAT_MUST_BE_GATED` or `BYPASS` list. A new command added via `/add-command` cannot ship without declaring its gate posture — the fitness function fails CI until the contributor adds an entry.

### Improved
- **`clone()` failures translate to typed `VaultkitError` instead of raw git stderr.** Mirrors the pattern in `gh-retry.ts:_classifyGhFailure` for the gh-API path. Adds `_classifyCloneFailure(stderr, repo)` (test-only export, underscore prefix) covering: account-flagged (`AUTH_REQUIRED`), repo-not-found via gh or plain git (`UNRECOGNIZED_INPUT`), SSH publickey failure (`AUTH_REQUIRED`), HTTP 401 (`AUTH_REQUIRED`), DNS / connection / timeout (`NETWORK_TIMEOUT`). Unrecognized stderr re-throws as a plain `Error` with the original diagnostic preserved. Defense-in-depth alongside the bootstrap gate: even when prereqs are healthy, a typo'd repo slug or expired SSH key now surfaces a typed error pointing at `vaultkit setup` rather than dumping git stderr.
- **`bin/vaultkit.ts:wrap()` appends a `Hint:` line for setup-related failures.** When `SETUP_REQUIRED`, `TOOL_MISSING`, or `AUTH_REQUIRED` propagate to the catch block, a single line `Hint: run 'vaultkit setup' to bootstrap or repair prerequisites.` is appended after the `Error:` line. Only fires for those three codes (adding it for every category would dilute the signal) and is suppressed when the error message already mentions `vaultkit setup` (avoids double-printing for messages that already name the remedy).

### Documentation
- **README install section** now uses an `> [!IMPORTANT]` admonition naming the new failure mode (`Error: vaultkit isn't set up yet`) so fresh-install users discover the requirement before hitting it.
- **[ADR-0009: Bootstrap gate at the dispatch layer](docs/decisions/0009-bootstrap-gate-at-dispatch-layer.md)** records the decision, alternatives rejected (npm postinstall, per-command preflight, marker files), and the consequences. Cross-linked from `.claude/rules/architecture.md` and `domain-language.md`.

### Architecture
- **Git CLI Anti-Corruption Layer fitness function added — and now actually enforced.** Mirrors the gh-ACL check: no `src/commands/*.ts` file may invoke git via raw `execa('git', ...)`. The git ACL was always declared in `.claude/rules/architecture.md` and `security-invariants.md` but never enforced — six command files (`backup`, `doctor`, `init`, `status`, `update`, `verify`) had drifted into raw `execa('git', ...)` calls over time. Each was migrated one commit at a time (A3-A8); the EXCEPTIONS list is now empty. Also fixed a latent bug in the existing gh-ACL regex: a trailing `\b` after the literal-quote pattern never matched (quote characters aren't word characters), meaning the gh ACL would silently miss any future `execa('gh', ...)` regression. The git ACL inherited the same bug — both fixed.
- **Eight new wrapper verbs in `src/lib/git.ts`** added during the migration: `isWorktreeDirty`, `getConfig`, `getStatusText`, `getStagedFiles`, `fetch`, `hasUpstream`, `diffFileNames`, `diff`. Each is a thin one-purpose function that lets a command call git through a typed semantic verb instead of an inline argv shape. Cross-cutting changes (retry, classification, telemetry) are now one edit in `git.ts` instead of touching every call site.
- **[ADR-0007: Git CLI Anti-Corruption Layer via `src/lib/git.ts`](docs/decisions/0007-git-cli-acl-via-src-lib-git.md)** records the decision, the migration approach (Strangler Fig — grandfather, migrate one per commit, drain the EXCEPTIONS list), and the trade-offs accepted. Cross-linked from `.claude/rules/architecture.md`.
- **`refresh.ts` decomposed (SRP).** Two new lib modules under `src/lib/freshness/`: `sources.ts` (input half — frontmatter parsing, source classification, `raw/` walking) and `report.ts` (output half — `CheckResult` shapes, `SIMILARITY_THRESHOLD`, `formatReport`). `refresh.ts` shrunk from 285 to 105 lines and now changes for one reason: the orchestration of the freshness pipeline. Each lib changes for its own reason (input format vs. report format). Tests updated to import from the new paths. Companion improvement: the ad-hoc `ghJson('api', 'repos/<slug>/commits', …)` call in `refresh.ts` is now `getCommitsSince(slug, sinceISO)` in `github-repo.ts`, returning a typed `CommitInfo[]` instead of an untyped JSON string. Closes the last `ghJson` leak in command files — every command now talks to GitHub through one of the three github-* facades.
- **[ADR-0008: Module-level imports as the dependency-wiring strategy](docs/decisions/0008-module-imports-as-dependency-wiring.md)** records the deliberate choice not to introduce explicit port interfaces (GhClient/GitClient/McpClient) for the three ACLs despite the Hexagonal/Clean Architecture literature recommending it. KISS/YAGNI — interfaces add boilerplate every commit and pay back only at the second implementation, which doesn't exist. Logger remains the project's only DI seam (documented exception). Records the trigger to revisit (a second concrete implementation actually being needed) so future contributors can find the rationale.

### Tests
- **Property-based tests via `fast-check`.** Three new test files exercising algebraic invariants at scale (~100-200 generated cases per property):
  - `tests/lib/vault.property.test.ts` — `validateName` accepts any canonical-alphabet name 1-64 chars, throws `INVALID_NAME` for over-length / forbidden-character / `/`-containing strings (with the canonical "owner/repo" message preserved).
  - `tests/lib/text-compare.property.test.ts` — `similarity` is reflexive (`s, s == 1`), symmetric (`a,b == b,a`), and bounded (`[0, 1]`).
  - `tests/lib/claude-md-merge.property.test.ts` — `mergeManagedSection` is idempotent (apply twice = apply once), is a fixed-point on identical body content, and leaves user-edited sections without markers untouched (action: 'manual').
  - Implementation note: built arbitraries from `fc.constantFrom` over explicit alphabets instead of `fc.stringMatching` (the latter hangs during generation on this fast-check version when given quantified patterns). Total +10 tests, all running in <1s combined.
- **Three new architectural fitness functions in `tests/architecture.test.ts`:**
  - **Layer dependency rule** — no file in `src/lib/` may import from `src/commands/`. Catches the inverted-dependency mistake where a lib reaches into a command (would create a cycle or signal that the lib belongs at a different layer).
  - **Logger boundary** — no file in `src/` outside `src/lib/logger.ts` may use `console.*` directly. Routes all output through the `Logger` interface so tests can assert on `arrayLogger` capture without intercepting stdio. The bin layer (`bin/vaultkit.ts`) is intentionally out of scope: verbose-debug telemetry there has no Logger plumbed.
  - **Inter-command imports** — no `src/commands/*.ts` may import from a sibling command. Shared logic must live in a lib so commands stay decoupled. Both regression-tested by injecting violations and confirming the fitness function fails.
- **`ISearchIndex` architecture fitness test** in `tests/architecture.test.ts`: asserts that `src/mcp-tools/context.ts` imports `ISearchIndex` (not the concrete `SearchIndex` class), so the interface boundary cannot silently erode back to a class reference.
- **`FakeSearchIndex` test double** in `tests/helpers/search-index.ts`: in-memory, `Map`-backed implementation of `ISearchIndex`. Future unit tests of individual MCP tool handlers can inject it without running the real SQLite indexer.
- **Four security-invariant fitness functions** in `tests/architecture.test.ts`, machine-checking invariants previously enforced only by code review (Phase 1 of the architecture-vault improvement plan):
  - **`isVaultLike` guard before `rmSync`** — command files calling `rmSync` must also call `isVaultLike`/`vault.isVaultLike()`. `init.ts`'s rollback path is grandfathered in `EXCEPTIONS` (guarded by `createdDir && existsSync` — it removes a directory the command just created).
  - **Vault path from registry before `rmSync`** — directory deletion must resolve the path through `Vault.tryFromName`, `Vault.requireFromName`, or `getVaultDir`; raw user input is disallowed. Same `init.ts` exception.
  - **`SearchIndex.close()` whenever `openSearchIndex()` is called** — every opener must also close, preventing file-descriptor leaks in long-running commands.
  - **Catch blocks don't rethrow as plain `Error`** — rethrows in catch must preserve the `VaultkitError` type; wrapping in a plain `Error` loses the `VaultkitErrorCode` and breaks the exit-code contract.

## [2.7.4] - 2026-05-03

### Improved
- **GitHub API mutation wrappers now poll for confirmation of state propagation.** `setRepoVisibility` / `enablePages` / `setPagesVisibility` each poll their corresponding read endpoint (`getVisibility` / `pagesExist` / `getPagesVisibility`) post-mutation via the new `src/lib/poll.ts:pollUntil` helper. Bridges GitHub's eventual-consistency window between a mutation API returning success and the change being observable to the caller's next dependent call. Distinct from `gh-retry.ts`'s retry-on-failure layer (which fires when a call fails) — this fires when one call succeeded but its effect isn't visible yet.
- **`gh-retry.ts`'s transient retry schedule extended from `[1s, 2s, 4s]` (7s total) to `[1s, 2s, 4s, 8s, 16s]` (31s total).** The "current plan does not support GitHub Pages for this repository" 422 — which surfaces on `enablePages` after a private→public flip when GitHub's Pages-auth cache lags the repo metadata — is now classified as transient. Together with the longer schedule this covers most propagation windows on accounts that DO support Pages. (Note: on accounts where the visibility flip itself doesn't actually stick — see "Known limitations" below — no retry budget is enough; the error eventually surfaces, where `vaultkit visibility`'s graceful-fail handles it.)
- **`vaultkit visibility` graceful-fails Pages-related actions.** `enablePages` / `disablePages` / `setPagesVisibility` are now wrapped in `try` / `log.warn` / manual-recovery-URL — matching `init.ts:setupGitHubPages`'s existing pattern. The visibility flip itself is the user's primary intent; Pages is secondary. Aborting the whole command on a Pages 422 left the repo correctly flipped (or attempting to be) but the user staring at an error — better to log the gap and give them the recovery URL.

### Added
- **`src/lib/poll.ts`** — generic `pollUntil(read, predicate, opts?)` helper with `timeoutMs` (default 30s) and `intervalMs` (default 500ms). Throws `VaultkitError('NETWORK_TIMEOUT')` on timeout with the description and last-observed value embedded in the message. Captured as a project rule in `.claude/rules/code-style.md` ("Poll-after-mutate at eventual-consistency boundaries") so future wrappers around GitHub mutations follow the same pattern.

### Tests
- **`live: visibility toggles real GitHub repo` is now `describe.skip`** with a comment explaining why. The CI test PATs (Free-tier alt accounts) cannot reliably be flipped to public — GitHub's PATCH returns 200 but the underlying state doesn't actually change (or is reverted asynchronously by some account-level policy), and a subsequent `enablePages` POST returns 422 even though the wrapper's poll caught a transient `'public'` from the read endpoint. No retry / poll / graceful-fail on vaultkit's side fixes this because the test environment can't support what the test is asserting. The 14 mocked `describe`s above this block cover the command logic exhaustively. Re-enable by replacing `describe.skip` with `liveDescribe` once a Pro test PAT is available (GitHub Education pack or OSS Pro grant).

### Known limitations
- On accounts where the GitHub visibility PATCH appears to succeed but doesn't actually stick (Free-tier with restrictions, or abuse-flag artifacts), `vaultkit visibility public` will look successful but the repo will remain private. The graceful-fail-Pages change above means the user at least gets a clear "Could not auto-enable GitHub Pages" warning instead of a misleading "Done" — but vaultkit doesn't currently re-verify the visibility state at the end of the operation. A future fix could add a final `getVisibility` check to throw with "the visibility flip didn't stick — your account may have restrictions". Tracked separately.

## [2.7.3] - 2026-05-03

### Changed (CI)
- **CI now rotates between two GitHub PAT accounts round-robin per run.** `.github/workflows/main.yml` adds a "Select test PAT" step at the top of the `test` job that picks `VAULTKIT_TEST_GH_TOKEN_A` or `_B` via `GITHUB_RUN_NUMBER % 2` and exports it to `$GITHUB_ENV` as `GH_TOKEN`. Fail-closed if the chosen secret is missing — silent fallback to the other PAT would mask config drift. Pre- and post-test orphan-cleanup steps now sweep BOTH accounts (the previous run used the other PAT, so its orphans live on a different account than this run's). The chosen PAT label (`A` / `B`) is logged via `VAULTKIT_TEST_PAT_LABEL` so it's visible in the Actions UI without exposing the token. Halves per-account abuse-heuristic load — addresses the recurring 24-72h flag-out cycle described in `docs/roadmap.md` "Live-test CI". Operator note: re-runs of the same `run_number` reuse the same PAT; push a new commit to flip to the other account.
- **Dropped legacy `VAULTKIT_TEST_GH_TOKEN` secret.** No fallback. Repo Settings → Secrets must now define both `VAULTKIT_TEST_GH_TOKEN_A` and `VAULTKIT_TEST_GH_TOKEN_B`.

### Tests
- **Shared `vk-live-shared-*` fixture across `connect` / `disconnect` / `visibility` live tests.** `tests/global-fixture.ts` (vitest globalSetup) now creates one shared GitHub-backed vault per `npm test` run and tears it down at suite end. The three fixture-sharing live blocks read its name via `tests/helpers/live-fixture.ts:getFixtureName()` and reset to baseline (re-clone if disconnected, re-set visibility to private if drifted) in their `beforeEach`. Drops per-run live-repo creates/destroys from ~5 to 3 (the shared fixture + `init`'s own + `destroy`'s own — the lifecycle tests stay self-contained because they ARE the create/delete paths). Combined with the two-PAT rotation above, per-account abuse-heuristic load drops roughly 6x vs. 2.7.2.
- The visibility live block's two `it()` cases were collapsed into one (`toggles private vault to public and back`) — vitest's per-it execution order is implementation-defined within a describe, and the public→private→assert→public→assert sequence is one logical operation. Splitting it would have doubled the per-run mutation count without adding coverage.

## [2.7.2] - 2026-05-02

### Fixed
- **`vaultkit init` no longer leaks a GitHub repo when `git remote add` fails after `gh repo create` succeeded.** The previous `createRemoteRepo` helper bundled both calls into one await, and the `createdRepo = true` flag flipped only after the helper returned. A failure on the local-side `addRemote` (stale remote, perms hiccup) escaped while `createdRepo === false`, so rollback skipped `deleteRepo` and the just-created GitHub repo orphaned. The two calls are now inlined so the flag flips immediately after `createRepo` succeeds — any subsequent failure (including `addRemote`) now triggers `deleteRepo` in the catch block. Regression covered by `tests/commands/init.test.ts`'s I-13b describe block.
- **`compareSource` (text-compare) now rejects internal URLs before any HTTP fetch.** Frontmatter URLs in `raw/<file>.md` are direct attacker-controllable input that drive `vaultkit refresh`'s text-compare path. New `_rejectInternalUrl` blocks non-http(s) protocols, localhost / 0.0.0.0, IPv4 loopback (127.0.0.0/8), link-local (169.254.0.0/16 — covers AWS IMDS), RFC 1918 private (10/8, 172.16-31/12, 192.168/16), and IPv6 loopback / link-local / ULA. Does NOT defend against DNS rebinding (a public hostname resolving to an internal IP) — documented as an explicit non-goal in `.claude/rules/security-invariants.md`.
- **`vaultkit refresh --vault-dir <path>` now validates the path is vault-like before any filesystem read or write.** Previously a malicious or mistyped path (`--vault-dir /etc`) would walk arbitrary directories and `mkdirSync(<path>/wiki/_freshness)` into them. The path is now `resolve()`'d to absolute and `isVaultLike`-checked at command entry.
- **`gh-retry`'s rate-limit backoff is now capped at 60s** (was: honor `Retry-After` verbatim). A misbehaving GitHub response with a multi-hour `Retry-After` header could hang `vaultkit init` indefinitely on the secondary-rate-limit retry path; the cap bounds the worst case while still respecting normal rate-limit waits.
- **`ensureGhAuth` matches scope names as string literals, not regex patterns.** The pre-fix code used `new RegExp(\`'${s}'\`)` which interpreted `.`, `*`, `(`, `|` etc. in scope names as regex meta-chars. Today's scopes are hard-coded literals (`repo`, `workflow`, `gist`, `delete_repo`) so the bug was latent, but a future dynamic scope source containing `.` or `*` would either match too broadly (false-positive scope-present → no refresh) or match nothing (false-negative → unnecessary refresh loop). Now uses `output.includes(\`'${s}'\`)` literal substring match.
- **`vaultkit status` (and other registry consumers) now throw `UNRECOGNIZED_INPUT` on a corrupt `~/.claude.json` instead of silently proceeding with an empty registry.** Previously a malformed JSON file (e.g. truncated mid-write by a concurrent process) caused `JSON.parse` to throw and registry helpers to swallow the error and return `{}`. Users saw an empty vault list with no explanation. The new behavior surfaces the actual error so the user knows to inspect / restore the file.
- **`vaultkit visibility <slug>` hard-fails on a malformed repo slug** instead of writing partial state. The previous flow would call `setRepoVisibility` and only validate the slug shape inside `gh api`'s response handler — too late if the gh call returned an unexpected error format. Slug validation now happens at command entry.

### Changed (internal)
- **Extracted `src/lib/gh-retry.ts` from `src/lib/github.ts`.** The retry / classification layer is now shared by `github.ts`'s wrappers and any other consumer (e.g. `refresh`'s commit-since-clip check) without copying. `gh()`, `ghJson()`, `_parseGhIncludeOutput()`, `_classifyGhFailure()` are exported from the new module; `github.ts` re-imports them. Pure code-organization change — no behavior delta, and existing imports from `github.ts` continue to work.
- **`src/commands/refresh.ts` now exports `classifySource`** (pure URL → `SourceClassification` decision) so the no-url / git / web matrix can be unit-tested without mocking the network or `gh`.
- **`src/commands/init.ts` now exports `selectPublishMode`** and the `PublishConfig` interface so the publishMode → 4-tuple derivation matrix (private vs public vs auth-gated) can be unit-tested directly. Additive — the export does not change the public CLI surface.
- **Centralized `NO_VAULTS_REGISTERED` and `GIT_DIR` constants** to `src/lib/messages.ts` and `src/lib/constants.ts` respectively, replacing the inline strings that had drifted slightly across `status` / `setup` / `doctor`.

### Tests
- **+150+ new test cases** across init / errors / prereqs / platform / refresh / connect / verify / doctor / update-check / gh-retry, growing the suite from ~430 to ~635 passing tests. Highlights:
  - Full `vaultkit refresh run()` orchestration (mocked-integration via gh-retry + text-compare mocks, plus a new local-only live test using `makeLocalVault` against a stable public repo — zero `vk-live-*` repo creates).
  - `installGhForPlatform` branch matrix (winget / brew / apt / dnf / unsupported), `findTool` Windows fallback chain (PROGRAMFILES → LOCALAPPDATA WinGet Links → `probeWinGetGhPath` → `findOnPath`), template-path getter invariants.
  - `EXIT_CODES` and `DEFAULT_MESSAGES` per-code value pins (public contract — scripted callers depend on these specific integers).
  - Init Phase 2/6 mid-layout rollback, Phase 5/6 enablePages / setPagesVisibility reject swallowing, Phase 6/6 branch-protection argv shape.
  - Refresh edge cases: parseFrontmatter BOM / missing-newline / empty frontmatter, similarity-at-threshold boundary, `formatReport` section ordering, walkMarkdown no-symlink-follow safety.

### Slash commands (CLAUDE-internal, not shipped)
- New `/test` testing-expert command — sweeps the repo for test-debt by default (NO_TEST / THIN_COVERAGE / MARGINAL_TESTS / SKIPPED / UNDER_BRANCHED) and dispatches six parallel sub-reviewers (unit / mocked-integration / e2e / edge cases / security / cross-platform) on user-picked targets.
- New `/architecture` design-review command covering SOLID, DRY, FP, code-smells, patterns-and-coupling.
- Rewrote `/test` and tightened `/add-command` and `/debug-command` with explicit RED-GREEN TDD discipline.

## [2.7.1] - 2026-05-02

### Fixed
- **CI workflow no longer publishes to npm when any matrix leg is red.** The pre-2.7.1 split — separate `ci.yml` (Ubuntu + Windows matrix, push/PR-only) and `release.yml` (Ubuntu only, tag-triggered, runs `npm publish` after its own tests) — let a green Release ship even when the parallel CI was red on Windows or Ubuntu (e.g. v2.7.0 published despite the Ubuntu CI run hitting a GitHub abuse-flag 403). Replaced both files with a single `.github/workflows/main.yml` that runs the full Ubuntu + Windows matrix on every push/PR/tag, then a `publish` job with `needs: test` + `if: startsWith(github.ref, 'refs/tags/v')` so npm publish requires both matrix legs to be green. Bonus: cuts the per-tag-push GitHub-API burst footprint roughly in half (one matrix run instead of one matrix run + a separate Release run), reducing the chance of tripping GitHub's secondary rate limit / abuse detection on the test PAT account.
- **`ghJson` now classifies and reacts to the actual GitHub failure mode.** Previous retry logic only matched stderr text patterns (5xx / 429 / ECONN*). Reworked to four-way classification in `_classifyGhFailure(status, body, stderr, headers)`: `transient` (5xx / 429 / `previous visibility change is still in progress` 422 / network reset/timeout — retry 1s/2s/4s), `rate_limited` (`secondary rate limit` / `abuse detection` / HTTP 429 — wait `Retry-After` from response headers or 60s baseline, retry up to 3x more, then throw `VaultkitError('RATE_LIMITED')`), `auth_flagged` (`Repository '<x>' is disabled.` / `Please ask the owner to check their account.` — throw `VaultkitError('AUTH_REQUIRED')` immediately, no retry — won't recover in seconds), `fatal` (everything else — throw immediately). The high-volume operations (`createRepo`, `deleteRepo`, `setRepoVisibility`) migrated from `gh repo` shorthands to `gh api --include` so `_parseGhIncludeOutput` can read `X-RateLimit-*` / `Retry-After` headers and proactively sleep until reset (capped at 60s) when remaining quota drops below 50.
- **`pushNewRepo` and `pushOrPr` recognize the same abuse-flag stderr** in git push output and short-circuit to `VaultkitError('AUTH_REQUIRED')` instead of burning the retry budget on a 403 that won't clear in seconds. Fixes the v2.7.0 Ubuntu symptom where `gh repo create` succeeded, GitHub disabled the new repo a few seconds later (because the PAT account got abuse-flagged mid-burst), and the next `git push` returned an opaque `ExecaError` with `HTTP 403` for users to decode.

### Added
- **`VaultkitErrorCode.RATE_LIMITED`** — exit code 13. Surfaces from `ghJson` when the secondary-rate-limit retry budget is exhausted (3 retries with `Retry-After`-or-60s waits between). Distinct from `AUTH_REQUIRED` (which is the irrecoverable abuse-flag case).
- **Live-test burst reduction.** Two structural changes to keep CI under GitHub's secondary rate limit (~80 content-creating requests/minute):
  - **Live tests skip on Windows** via the new `liveDescribe` helper in [tests/helpers/live-describe.ts](tests/helpers/live-describe.ts) (`describe.skip` on win32, plain `describe` elsewhere). The 5 GitHub-touching live blocks (`init`, `destroy`, `connect`, `disconnect`, `visibility`) run only on Ubuntu in CI; Windows still runs the full mocked + check + build matrix legs. Cuts per-tag-push GH-API burst from two matrix legs to one.
  - **`status` and `verify` live tests converted to local-only** via the new `makeLocalVault` helper in [tests/helpers/local-vault.ts](tests/helpers/local-vault.ts). `status` now uses a local bare git repo as `origin` (it only needs a real remote URL to answer ahead/behind/clean — doesn't care that it's GitHub); `verify` runs entirely off the byte-copied launcher template (no remote needed at all). Removes ~20 GH-API calls per CI run and lets these two tests run on Windows alongside Ubuntu, broadening OS coverage. Net: from 7 GitHub-touching live tests to 5, only on the Ubuntu leg.

## [2.7.0] - 2026-05-02

### Added
- **`vaultkit refresh [name]`** — new command that checks every source in `raw/` for upstream changes and writes a dated freshness report to `wiki/_freshness/<YYYY-MM-DD>.md`. Walks `raw/` recursively, reads each markdown file's frontmatter URL + clip date, and classifies: GitHub URLs go through `gh api repos/<owner>/<repo>/commits?since=<sourceDate>` (commit-since-clip count); other URLs go through HTTP fetch + Mozilla Readability text-only compare against the local clip's plain-text projection (similarity threshold 0.95); paywalls / SPAs / 4xx / 5xx route to a "manual review" section. Output is skipped entirely when there are no findings. Accepts `--vault-dir <path>` to bypass the registry for CI use.
- **`.github/workflows/freshness.yml`** — scheduled GitHub Action installed at vault scaffold time. Weekly cron (Sundays 12:00 UTC) plus `workflow_dispatch`. Runs `npx -y @aleburrascano/vaultkit refresh --vault-dir .`, commits the new report under `wiki/_freshness/`, opens a PR. No Anthropic secrets — uses default `GITHUB_TOKEN` only.
- **`.claude/settings.json`** — project-scoped Claude Code settings installed at vault scaffold time, pinning `model: "sonnet"` and `permissions.additionalDirectories: ["raw", "wiki"]`. Applies when collaborators `cd` into the vault for a refresh session.
- **`.github/pull_request_template.md`** — PR description scaffold installed at vault scaffold time, asking contributors to declare their Claude Code session config (model, thinking, effort) and which sources they incorporated. Visibility for reviewers, not enforcement.
- **CLAUDE.md template** gains a "Wiki Style & Refresh Policy" section wrapped in `<!-- vaultkit:wiki-style:start/end -->` markers. Carries the patch-flow constraint ("never regenerate a wiki page from sources"), the `WebFetch` handoff for non-git sources, the cd-into-vault refresh-session workflow note, and a recommended-settings stub for collaborator convergence.
- **Marker-based merge for vaultkit-managed CLAUDE.md sections.** New `src/lib/claude-md-merge.ts` with `renderManagedSection(id, body)` and `mergeManagedSection(existingMd, id, body, headingName)` returning `{ merged, action: 'replaced' | 'appended' | 'manual' }`. `vaultkit update` uses this to evolve the wiki-style section across releases without disturbing user edits — three branches: markers present → replace; markers absent + heading absent → append; heading present without markers → don't touch, print a copy-paste snippet.
- **`src/lib/text-compare.ts`** — non-git source freshness check helper. Exports `plainTextFromMarkdown` (frontmatter + markdown formatting → plain text), `similarity` (Jaccard over word sets), and `compareSource` (HTTP fetch + Readability extraction → comparison). Dynamically imports `jsdom` + `@mozilla/readability` so the load cost lands only on `vaultkit refresh`.

### Changed
- **`vaultkit update`** now also reconciles the CLAUDE.md "Wiki Style & Refresh Policy" section via `mergeManagedSection`. Existing vaults without the section get it appended; vaults whose section content has drifted from the template get the managed region replaced (markers preserve the boundaries); vaults where a user has hand-edited a `## Wiki Style & Refresh Policy` heading without markers see a paste-snippet log and no rewrite.

### Dependencies
- New runtime: `@mozilla/readability` ^0.6, `jsdom` ^29 (used only by `vaultkit refresh`'s non-git compare path; dynamically imported so non-refresh commands don't pay the JSDOM startup tax). Dev: `@types/jsdom`.

## [2.6.1] - 2026-05-02

### Fixed
- **All `gh` API calls now retry on transient GitHub failures.** HTTP 5xx (server errors), 429 (rate limit), the visibility-specific 422 "previous visibility change is still in progress," and network errors (ECONNRESET / ETIMEDOUT / ECONNREFUSED / EHOSTUNREACH) now retry with exponential backoff (1s/2s/4s, 4 attempts total). The retry lives in the central `ghJson` helper in [src/lib/github.ts](src/lib/github.ts), so every wrapper (`createRepo`, `setRepoVisibility`, `getVisibility`, `enablePages`, etc.) gains the retry without per-call code. Visible to users of `vaultkit init` (e.g. HTTP 504 on `gh repo create`), `vaultkit visibility` (back-to-back 422), and any other command whose gh API call lands on a transient hiccup. Surfaced across multiple CI runs — fast runners hit GitHub during instability windows; slower runners gave the API time to settle.
- **`vaultkit init` retries the initial `git push` on any non-zero exit** with the same backoff via a new `pushNewRepo` helper in [src/lib/git.ts](src/lib/git.ts). Separate retry surface from `ghJson` because the failure is in the git push HTTP layer, not the gh API — GitHub has eventual consistency between `gh repo create` returning and the new repo's git endpoint accepting pushes, and the race surfaces through many shapes (`Repository not found`, `RPC failed; HTTP 404`, `unexpected disconnect`, `the remote end hung up`). Rather than enumerate transient stderr patterns, treat any failure on a brand-new repo's push as transient — real misconfigurations still surface after the retry budget.

### CI
- **`.github/workflows/release.yml`** now matches `ci.yml`'s setup: job-level `GH_TOKEN` env wired to the `VAULTKIT_TEST_GH_TOKEN` PAT secret, "Authenticate gh CLI" + "Configure git for live tests" preflight steps, pre-test orphan cleanup, post-test cleanup with `if: always()`, and the `vaultkit-live-tests` concurrency group shared with `ci.yml`. Without this, the release workflow's live tests hung on interactive device-code auth on the runner — v2.6.0 had to be re-tagged after the workflow was patched.

## [2.6.0] - 2026-05-02

### Added
- **Per-command `--help` examples.** Each command (`init`, `connect`, `destroy`, `pull`, etc.) now exposes a usage paragraph and example invocations via commander's `addHelpText('after', ...)`. Closes the gap where the README promised "detailed usage" via `--help` but each command's help printed only the one-line stub. Per-command help is now self-contained — users no longer need to grep the README for a working invocation. Examples include security-relevant context (`destroy` documents the `delete_repo` scope pre-grant; `connect` warns about the launcher's full-user-permission scope).
- **`vaultkit init --mode <public|private|auth-gated>`** — non-interactive flag that skips the publish-mode prompt. Lets teams script onboarding (`vaultkit init team-wiki --mode private`) without piping an answer through a TTY. The value flows through to `InitOptions.publishMode`, which already had the validation surface (`isPublishMode` in [src/commands/init.ts:41](src/commands/init.ts#L41) throws `UNRECOGNIZED_INPUT` with the valid-modes list); the new flag is a thin CLI binding around plumbing that already existed and is exercised by every `publishMode: 'private'` live test (7 files).
- **Update notification on stale versions.** New `src/lib/update-check.ts` wires into `bin/vaultkit.ts:wrap()` and prints a one-line stderr warning on the next invocation after the npm registry reports a newer `@aleburrascano/vaultkit` version. Cache lives at `~/.vaultkit-update-check.json` with a 24h TTL; the registry poll runs as a background `https.request` with the underlying socket `unref`'d so the CLI exits as fast as before -- the cache update is best-effort and the warning shows on the *next* invocation. Skipped entirely when `VAULTKIT_NO_UPDATE_CHECK=1` (useful in CI or for callers that parse stderr). No new runtime dependencies -- uses native `node:https`.

### Tests
- **`tests/lib/update-check.test.ts`** -- 7 cases pinning the `_isNewer` 3-component-dot-version comparison: latest > current at each component (patch, minor, major), equal versions, current > latest, missing components default to 0, and non-numeric components return `false` rather than throwing.

### Docs (continued)
- **FAQ and Troubleshooting moved out of the README** into [docs/faq.md](docs/faq.md) and [docs/troubleshooting.md](docs/troubleshooting.md). Each retains its content verbatim plus a backlink to the README; the README keeps a 2-line summary pointing at each. The README shrinks by ~85 lines without losing any topical depth -- npm visitors still see a complete picture (lede, install, quick start, command reference, anatomy, security, configuration, FAQ pointer, troubleshooting pointer), while users who want the deep reference content reach it directly via `docs/`. Pure-content move; the only delta is the README pointers.
- **`docs/roadmap.md`** -- new lightweight append-only file for known-but-not-done work. First entry is the public sample vault (`aleburrascano/vaultkit-demo`) -- the demo experience that fresh users would benefit from but that requires editorial choices and a separate public repo.
- **`/clarify-project` slash command** in [.claude/commands/clarify-project.md](.claude/commands/clarify-project.md) -- codifies the fresh-user evaluation workflow used to produce this Unreleased section. Runs the actual CLI, tests falsifiable doc claims, checks git state for hidden signals, and writes findings to a plan file under fixed section headings (What Works Well / Pain Points / Missing Pieces / Quick Wins / Larger Improvements / Specific Suggestions / Honest Caveats). Designed adversarially -- the anti-patterns section explicitly bans "the README is comprehensive" praise responses.
- **CLAUDE.md surfaces all five slash commands.** Previously only `/add-command` was mentioned; `/debug-command`, `/security-audit`, `/clarify-project`, and `/release` are now listed with one-line descriptions of what each does and when to reach for it. Closes the discoverability gap a long-time contributor pointed out (had used `/release` but never the others, didn't know what they did).

### Changed
- **`vaultkit --version` includes runtime info.** Output goes from `2.5.0` to `2.5.0 (node v22.x.x, <platform> <arch>)`, matching the README's existing promise of "version + runtime info". One-line bug-report-friendly format that also surfaces node-version mismatches when troubleshooting.
- **`vaultkit help` (and `vaultkit --help`) now show the README's categorized command list** (FIRST-TIME SETUP / CREATE & CONNECT / EVERYDAY USE / WHEN SOMETHING'S WRONG / CHANGE OR REMOVE) instead of commander's flat alphabetical-by-registration default. Aligns the CLI's first-impression help with the README's first-impression help so users see the same mental model on either surface. Implementation overrides `program.helpInformation` only on the root command; per-subcommand `--help` (init, connect, etc.) is unaffected and continues to use the `addHelpText` blocks added in this release.

### Docs
- **README `connect` example now shows the SSH URL form** (`git@github.com:owner/repo`). The parser in [src/commands/connect.ts](src/commands/connect.ts) `_normalizeInput` already accepted SSH URLs and `.git` suffixes (covered by `tests/commands/connect.test.ts:72-73`); the README only documented two of three forms, so users copy-pasting from `gh repo view` thought they were getting away with something undocumented.
- **README Prerequisites now leads with "GitHub account required."** vaultkit cannot work without GitHub — every vault is a GitHub repo. The previous Prerequisites only listed Node and Git, leaving the GitHub dependency to be inferred from later mentions of `gh`, GitHub Pages, and `owner/repo`. Surfacing it explicitly lets GitHub-averse users bounce off the README in 30 seconds rather than after running `vaultkit setup`.
- **README defines [Quartz](https://quartz.jzhc.io/) on first prose mention.** Quartz appeared in the publish-mode prompt (`(y)` option) and in the vault tree (`.quartz/`) without ever being defined. New users had to guess; now there's a one-line gloss with link.
- **README Security & Trust section names `obsidian-mcp-pro`.** SECURITY.md mentioned that the launcher invokes [`obsidian-mcp-pro`](https://www.npmjs.com/package/obsidian-mcp-pro) via `npx`, but the README's own Security section only described the launcher abstractly. Trust-conscious users now see the actual MCP-server package name in the README's trust narrative — no need to dig into SECURITY.md to learn what code is actually running.
- **README adds a "Quick Start" section** between "What you'd use this for" and "Commands." Four numbered steps (install → init → drop in a note → query from Claude Code) walk a fresh user from zero to first answered question in 60 seconds. Closes the gap where the README jumped straight from value-prop to a 12-command reference, leaving readers to mentally splice the canonical first-use sequence themselves.
- **README annotates the vault folder convention.** The vault tree previously listed `raw/{articles,books,notes,papers,transcripts,assets}` and `wiki/{concepts,topics,people,sources}` without saying what each subfolder was for or whether the structure was enforced. New paragraph clarifies that subfolders are conventions (not requirements) and gives a one-liner per folder so users don't guess at "where does a research paper go" vs "where do I write a synthesis page".
- **README documents `npm update -g` for upgrading vaultkit itself.** Previously the README told users how to install but never how to update; new "**Updating**:" line points at `npm update -g @aleburrascano/vaultkit` and reminds users to re-run `vaultkit setup` and `vaultkit doctor` after major versions.
- **README Troubleshooting entry for first-time `destroy` browser flow.** The `delete_repo` scope is requested on first `destroy` (deliberate -- never preemptive), which opens a device-code browser tab that surprises users running `destroy` from a script. New entry explains the trade-off, gives the pre-grant command (`gh auth refresh -h github.com -s delete_repo`), and notes that PAT-authenticated runs skip the refresh and require the scope at PAT-creation time.
- **`SECURITY.md` trust-surface paragraph corrected.** Two pre-TS-migration claims were stale: (a) "no third-party npm dependencies" -- the project has three permissive ones (`commander`, `execa`, `@inquirer/prompts`); (b) "only the bash scripts, `lib/`, the dispatcher, and `install.sh` ship" -- the `files` allowlist is `["dist/"]`, so what actually ships is the TypeScript-compiled CLI plus the byte-immutable launcher template under `dist/lib/`. Both edits make the trust surface honest.

### Removed
- **`install.sh`** -- the 16-line bash wrapper around `npm install -g @aleburrascano/vaultkit`. Not in `package.json#files`, not referenced from README, duplicated by the README's standard install line. Pure dead code post-TS-migration; SECURITY.md's mention of it was the only thing keeping it semi-discoverable, and that mention is now corrected.

### Docs (continued)
- **README now displays npm version, CI status, license, and Node-version badges** at the top. A fresh user landing on the README previously had no quick visual signal that the package was alive, maintained, or tested. Standard shields.io badges via the existing scoped-npm-package metadata and the `ci.yml` workflow.
- **README adds an FAQ section** between Platform support and Troubleshooting. Eight common questions a fresh user actually has but had to infer from prose elsewhere -- can I use this without GitHub (no), does it cost money (no, except auth-gated Pages requires Pro+), where does my data go, can I use the vault with non-Claude-Code MCP clients (yes, manually -- vaultkit only registers with Claude Code), what's the difference between disconnect and destroy, can I have many vaults at once (yes, namespaced), what's `_vault.json` (Quartz config), where do vaults live on disk (`~/vaults/<name>` by default).
- **README adds an end-to-end trust-chain diagram** in Security & Trust. ASCII flow showing how `~/.claude.json`'s pinned SHA-256 hands off to the launcher, what the launcher actually does on session start (self-check / git fetch / fast-forward / npx-spawn), and how `obsidian-mcp-pro` exposes the per-vault namespaced MCP tools to Claude Code. Closes the gap where a tool wiring together five systems (local FS, GitHub repo, gh CLI, Claude Code MCP registry, obsidian-mcp-pro) was described in prose only.

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
