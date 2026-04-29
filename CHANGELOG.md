# Changelog

All notable changes to vaultkit are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
