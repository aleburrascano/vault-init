# Changelog

All notable changes to vaultkit are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
