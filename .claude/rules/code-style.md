---
paths:
  - "src/commands/*.ts"
  - "src/lib/*.ts"
  - "bin/vaultkit.ts"
---

# Code Style

## TypeScript (all bin/, src/, tests/)

- ESM only — `import`/`export`, no `require()`.
- Imports use `.js` extensions even when the target is `.ts` (NodeNext resolution requirement). `tsc` rewrites at compile time.
- Use `execa` (not `child_process`) for external process calls.
- Command modules export a single `async function run(params, options?: <Name>Options): Promise<...>`. Per-command options interfaces extend `RunOptions` from `src/types.ts`. Each command file ends with a `const _module: CommandModule<...> = { run }; void _module;` sentinel that type-checks the contract — keep it and update the type parameters when a new command's signature shape differs (1-arg, 0-arg, 2-arg).
- Validate vault names via `validateName` from `src/lib/vault.ts` before any operation. Or use `Vault.tryFromName(name, cfgPath)` which validates internally.
- Resolve vault directories via `Vault.tryFromName` / `Vault.requireFromName` or `getVaultDir` from `src/lib/registry.ts` — never from raw user input. Prefer `requireFromName` when the command has no meaningful unregistered code path; the inline `if (!vault) throw VaultkitError('NOT_REGISTERED', ...)` pattern stays only when the command appends a non-canonical hint to the message.
- Use `findTool` from `src/lib/platform.ts` — never assume `gh` or `claude` are on PATH.
- For MCP registration, always go through `runMcpAdd` / `runMcpRemove` / `runMcpRepin` from `src/lib/mcp.ts` — they are the single source of truth for the `claude mcp <verb>` argv shapes (including the `--expected-sha256=<hash>` security invariant on `add`). Never call `claude mcp <verb>` via raw `execa` from a command file. The same rule applies to `gh repo`/`gh api` shapes wrapped in `src/lib/github.ts` (`createRepo`, `deleteRepo`, `setRepoVisibility`, `enablePages`, `setPagesVisibility`, etc.) — go through the wrappers. For ad-hoc API calls without a wrapped surface (e.g. `refresh`'s `repos/<slug>/commits` lookup), import `ghJson` from `src/lib/gh-retry.ts` so the call inherits the same retry / rate-limit / auth-flag classification — never call `gh api` via raw `execa`.
- Throw on errors (the `wrap()` in `bin/vaultkit.ts` catches and exits non-zero).
- For known-category errors, throw `VaultkitError` (from `src/lib/errors.js`) with a `VaultkitErrorCode` so `wrap()` can map to a distinct exit code. Plain `Error` is fine for genuinely unexpected failures.
- No silent catch-and-continue — if you catch, either re-throw or log + throw.
- **Poll-after-mutate at eventual-consistency boundaries.** When wrapping a GitHub API mutation that another call will immediately depend on (e.g. `setRepoVisibility` followed by a Pages-auth check), the wrapper must `pollUntil` on the corresponding read endpoint before returning, so callers don't hit a propagation race. This is distinct from `gh-retry.ts`'s retry-on-failure behavior — the mutation already returned 200; the wait is for the change to be observable to other endpoints. Pattern: `await ghJson(...mutation); await pollUntil(() => readEndpoint(slug), (cur) => cur === target, { description: '...' });`. Only the mutation's owning wrapper should poll; downstream callers must not add a second-layer poll. The retry-on-failure in `gh-retry.ts` (e.g., the "current plan does not support GitHub Pages" 422 retry) is a backstop for the case where the wrapper's poll on its own read endpoint isn't enough because a different downstream endpoint has its own cache.

## User-facing strings

- Prompts that appear in 2+ command files belong in `src/lib/messages.ts` (`PROMPTS`, `LABELS`). One-shot prompts stay inline at the call site — extracting them forces meaningless names like `INSTALL_GH_WINGET` for a single use.
- Error message text follows the same rule: canonical phrasings in `DEFAULT_MESSAGES` (`src/lib/errors.ts`); command-specific hints stay inline. Pattern: `\`"${name}" ${DEFAULT_MESSAGES.NOT_REGISTERED}\nRun 'vaultkit status' to see what's registered.\``.
- Filenames and directory names that recur across files (`'.mcp-start.js'`, `'CLAUDE.md'`, etc.) belong in `src/lib/constants.ts` (`VAULT_FILES`, `VAULT_DIRS`, `WORKFLOW_FILES`). Don't extract Git refs (`'main'`, `'origin'`) — those are Git spec terms and inline reads honestly.

## Logging

- Commands receive a `Logger` (from `src/lib/logger.js`) via `RunOptions.log`. Default to `new ConsoleLogger()` in the destructure.
- Call `log.info(...)` for normal output (was: every `log(...)` call before v2.1.0). Use `log.warn(...)` for recoverable conditions; `log.error(...)` for fatal-but-handled. `log.debug(...)` is verbose-only.
- Don't prefix info messages with `Warning:` and route them through `log.info` — use `log.warn(...)` and drop the prefix; the level conveys it.
- Tests use `silent` (no-op singleton) or `arrayLogger(lines)` from `tests/helpers/logger.ts`. Don't pass inline `log: () => {}` or `log: (m) => arr.push(m)` — those don't satisfy the `Logger` interface.

## Type discipline

- Strict mode is on (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`).
- Prefer `interface` for object shapes, `type` for unions and aliases.
- Cast `JSON.parse(...)` output to a typed shape (e.g., `as ClaudeConfig`) at the boundary, then narrow as needed. Never leave `any` floating.
- For execa results: `String(result.stdout ?? '').trim()` is the standard pattern (execa types `stdout` as the wide `string | string[] | unknown[] | Uint8Array` because `Options` could enable line/buffer modes — narrowing once at the access site keeps the rest of the code clean).
- For RegExp matches and array indexing under `noUncheckedIndexedAccess`: use `?.[0] ?? defaultValue` or default destructure `[a = '', b = '']`.
- Catch blocks: `err` is `unknown`; narrow via `as { message?: string }` (or similar) at the access site, not via type assertion at the catch.
- Avoid `any`. If absolutely necessary, leave a comment explaining why.

## Templates (lib/mcp-start.js.tmpl, lib/deploy.yml.tmpl)

- The launcher template stays as raw JavaScript — every existing user vault SHA-256-verifies its bytes. **Never edit `lib/mcp-start.js.tmpl` casually.**
- Templates are copied verbatim via `copyFileSync` — no preprocessing.
- `mcp-start.js.tmpl` must parse as valid JavaScript when executed.
- Never inline template content into command files — always `copyFileSync` from the source path. After build, the post-build script copies them into `dist/lib/` so the same relative path works in both raw and compiled execution contexts.
