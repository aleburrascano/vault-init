# Contributing to vaultkit

Thanks for your interest. vaultkit is intentionally small — a TypeScript codebase under [`bin/`](./bin/), [`src/`](./src/), and [`tests/`](./tests/) that compiles to `dist/` at publish time. Three runtime dependencies (`commander`, `execa`, `@inquirer/prompts`); ESM only; Node ≥22. Keep contributions in that spirit: minimal deps, no framework lock-in, every commit independently shippable.

## Local setup

```bash
git clone https://github.com/aleburrascano/vaultkit
cd vaultkit
npm install         # installs deps (incl. dev)
npm run build       # tsc + post-build (copies lib/*.tmpl into dist/lib/)
npm link            # makes the `vaultkit` binary point at this checkout
vaultkit doctor     # sanity check
```

When you're done:

```bash
npm unlink -g @aleburrascano/vaultkit
```

After editing `.ts` source, run `npm run build` again — `npm link` points at `dist/bin/vaultkit.js`, so the binary picks up changes only after a rebuild. (`npm test` runs vitest directly against TypeScript source, so tests don't need a build.)

## Repo layout

```
bin/vaultkit.ts         Entry point — commander dispatch + audit logging
src/commands/<cmd>.ts   One module per command, exports async function run()
src/lib/                Shared modules: registry, vault, platform, git, github
src/types.ts            Shared type definitions (RunOptions, ClaudeConfig, …)
lib/mcp-start.js.tmpl   Per-vault MCP launcher template (byte-immutable)
lib/deploy.yml.tmpl     GitHub Actions workflow for Quartz deployment
tests/                  vitest tests, mirrors src/ structure
scripts/post-build.mjs  Copies lib/*.tmpl into dist/lib/ after tsc
.claude/commands/       Slash commands for development workflows
.claude/rules/          Architecture, security, and style references
CLAUDE.md               Top-level project guidance for Claude Code sessions
```

Read [.claude/rules/architecture.md](./.claude/rules/architecture.md) and [.claude/rules/security-invariants.md](./.claude/rules/security-invariants.md) before changing anything — they document the invariants every command must respect.

## Adding a new command

The repo ships a `/add-command` slash command for Claude Code that scaffolds the boilerplate. Manually:

1. Create `src/commands/<name>.ts`. Export `async function run(params, options?: <Name>Options): Promise<...>` where `<Name>Options extends RunOptions` adds command-specific fields.
2. Add `.command('<name> ...')` to the `program` in [bin/vaultkit.ts](./bin/vaultkit.ts) with a dynamic `import('../src/commands/<name>.js')` inside `wrap()`. (The `.js` specifier is correct in TS source — Node ESM's `NodeNext` resolution maps it to the `.ts` file at compile time.)
3. Add a row to README.md and the help text in `bin/vaultkit.ts`.
4. Add an entry under `## [Unreleased]` in CHANGELOG.md.
5. Add `tests/commands/<name>.test.ts` covering happy path + key error cases. For commands with non-trivial branching, also add `tests/commands/<name>-mocked.test.ts` for unit-level coverage.

`package.json#files` is `["dist/"]` and `bin` is `"dist/bin/vaultkit.js"` — no change needed for new commands.

## Security invariants

These are non-negotiable. Every PR is checked against them — see [.claude/rules/security-invariants.md](./.claude/rules/security-invariants.md):

- **Vault names** must match `^[a-zA-Z0-9_-]+$` and be ≤64 chars. Use `validateName` from [src/lib/vault.ts](./src/lib/vault.ts) — also enforced internally by `Vault.tryFromName`.
- **Vault paths** for destructive ops must come from the MCP registry (`Vault.tryFromName` or `getVaultDir` from [src/lib/registry.ts](./src/lib/registry.ts)), never from raw user input or filesystem fallbacks.
- **MCP registration** must include `--expected-sha256=<hash>` so the launcher can self-verify on every Claude Code session.
- **`gh repo delete`** must be preceded by an explicit ownership check (`isAdmin` from [src/lib/github.ts](./src/lib/github.ts)) and a typed-name confirmation.
- **`isVaultLike`** must be checked before any directory deletion — use `Vault.isVaultLike()` or the standalone helper from `src/lib/vault.ts`.

## Windows compatibility

Every command must work on Windows. Specifically:

- Use `findTool` from [src/lib/platform.ts](./src/lib/platform.ts) — never assume `gh` or `claude` are on PATH (Windows PATH changes on install don't reach already-running processes).
- Use `isWindows`, `claudeJsonPath`, `vaultsRoot` for OS-specific path resolution.
- Use `execa` (already a dependency) for external process calls — it handles Windows shell quoting correctly.
- CI runs the full check/build/test gauntlet on both `ubuntu-latest` and `windows-latest` ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)) with `fail-fast: false`, so platform-specific regressions surface on the PR. You don't need a Windows machine to contribute, but if a CI run fails only on Windows the fix typically lives in `src/lib/platform.ts` or in a path-separator assumption inside a test.

## Running checks

The same checks that run in CI ([.github/workflows/ci.yml](./.github/workflows/ci.yml)) on both `ubuntu-latest` and `windows-latest`:

```bash
npm run check                # tsc --noEmit (type-only verification)
npm run build                # tsc + copy templates into dist/lib/
npm test                     # vitest run (unit + integration)
npm publish --dry-run        # verify dist/ contains the published files
```

**`npm test` is always live as of v2.5.0** — no env-var gate. Every run hits the real GitHub API and creates ephemeral `vk-live-*` repos against your authenticated `gh` account. Tests run sequentially to avoid `~/.claude.json` races and clean up after themselves in `afterAll` hooks.

One-time prerequisite: `gh` must hold the `delete_repo` scope, otherwise the destroy live test fails. Fix with:

```bash
gh auth refresh -h github.com -s delete_repo
```

CI runs the same suite using a dedicated PAT secret (`VAULTKIT_TEST_GH_TOKEN`) — see `.github/workflows/ci.yml`.

## Pull requests

- Keep changes focused. One logical change per PR; one logical concern per commit. Every commit should leave the world intact (`check`, `build`, `test` all green) — see CLAUDE.md for the change-cadence rule.
- Update `CHANGELOG.md` under `## [Unreleased]` with what you changed and why.
- Keep new npm dependencies minimal — justify any additions in the PR description.
- Don't edit [lib/mcp-start.js.tmpl](./lib/mcp-start.js.tmpl) casually; existing user vaults pin its SHA-256 and a byte change breaks all their registrations.
- The PR will run CI automatically — make sure type-check, build, tests, and the publish dry-run all pass.

## Reporting bugs

Open an issue at <https://github.com/aleburrascano/vaultkit/issues>. Include:

- `vaultkit doctor` output (redact any private vault names if needed).
- Your platform (`uname -a` on macOS/Linux, `ver` on Windows).
- The exact command that failed and any error output.

## Reporting security issues

See [SECURITY.md](./SECURITY.md) — please do not file public issues for security vulnerabilities.
