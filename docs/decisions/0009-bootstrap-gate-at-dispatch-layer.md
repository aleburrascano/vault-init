# ADR-0009: Bootstrap gate at the dispatch layer

**Status**: Accepted
**Date**: 2026-05-04
**Related rules**: [.claude/rules/architecture.md](../../.claude/rules/architecture.md), [.claude/rules/domain-language.md](../../.claude/rules/domain-language.md)

## Context

A user installed `@aleburrascano/vaultkit` via `npm i -g` on a fresh Mac, skipped `vaultkit setup`, and ran `vaultkit connect owner/repo`. The clone failed with raw `git` stderr — no pointer to setup, no diagnostic of *why* (gh wasn't installed, fell back to plain git, hit auth or network). Reproducible. The class of bug (commands silently failing on un-set-up systems) had been present in every command except `init` since 2.0; `init` happens to run a `[1/6] Checking prerequisites...` phase via `prereqs.ts:ensureGh` that auto-installs gh, but every other command — `connect`, `pull`, `visibility`, `update`, `verify`, `destroy`, `refresh`, `backup`, `disconnect`, `status` — assumed the user had already run `setup` and produced cryptic errors when they hadn't.

The forces:

- **Cryptic errors are the actual failure mode** — not "the tool is broken" but "the user can't tell what to do next." A clear pointer at `vaultkit setup` is the entire fix.
- **`init`'s [1/6] auto-install path is not the answer for every command.** It works because `init` is itself a long interactive flow; a quick `vaultkit status` shouldn't bootstrap Homebrew. The check needs to be a check, not an installer.
- **The vaultkit CLI is not a typical Node server-process app.** Twelve-Factor's "explicit dependencies" applies: a CLI that needs `gh`, `git`, and `claude` should fail-fast when they're missing, not paper over the gap.
- **A single user-reported failure is usually the visible tip of a class.** The same bug would surface differently on every command — no central place fixed, ten places half-fixed.

## Decision

**Wire a check-only gate (`requireSetup`) into `bin/vaultkit.ts:wrap()` so every command except `setup` and `doctor` (the `SETUP_BYPASS` set) verifies prerequisites before its handler runs.** Implementation lives in `src/lib/prereqs.ts`:

```ts
export const SETUP_BYPASS: ReadonlySet<string> = new Set(['setup', 'doctor']);

export async function gateOrSkip(commandName: string, log: Logger): Promise<void> {
  if (SETUP_BYPASS.has(commandName)) return;
  await requireSetup(log);
}

export async function requireSetup(_log: Logger): Promise<void> {
  // checks, in order: Node ≥ 22, gh on PATH, gh auth status, repo+workflow
  // scopes present, git config user.name + user.email set. throws
  // VaultkitError('SETUP_REQUIRED') (exit 14) on first miss.
}
```

`bin/vaultkit.ts:wrap()` calls `await gateOrSkip(commandName, new ConsoleLogger())` before `await fn()`. `--version` / `--help` are commander built-ins and don't reach `wrap()`, so they're naturally excluded with no extra carve-outs.

The gate is **enforced by tests**, not just convention:

- `tests/bootstrap-gate.test.ts` — universal sweep parameterized over every `src/commands/*.ts` file: 11 non-bypass commands × 4 scenarios (3 failure modes + 1 healthy) + 2 bypass commands × 1 unconditional-pass = 47 assertions.
- `tests/architecture.test.ts` — two new fitness functions: (a) `bin/vaultkit.ts:wrap()` actively calls `gateOrSkip(commandName, ...)` (regression-tested by commenting out the call and confirming the check fails), and (b) every `src/commands/*.ts` file's name appears in `bootstrap-gate.test.ts`'s `COMMANDS_THAT_MUST_BE_GATED` or `BYPASS` list. A new command added via `/add-command` cannot ship without declaring its gate posture.

## Consequences

**Easier:**
- Fresh installs that skip `setup` get a clear `Error: vaultkit isn't set up yet. Run 'vaultkit setup'…` pointing them at the fix. The `bin/vaultkit.ts:wrap()` catch also appends `Hint: run 'vaultkit setup' to bootstrap or repair prerequisites.` for the three error codes (`SETUP_REQUIRED`, `TOOL_MISSING`, `AUTH_REQUIRED`) whose remedy genuinely is the same.
- Adding a new command auto-inherits the gate. The `/add-command` skill's checklist + the architecture fitness function together ensure no command ships gateless.
- Defense in depth alongside `_classifyCloneFailure` in `git.ts` (added the same day): even when prereqs are healthy, a typo'd repo slug or expired SSH key surfaces a typed error pointing at `vaultkit setup`.

**Harder:**
- Every non-bypass command pays a small extra cost on the happy path: one `findTool('gh')`, one `gh auth status`, two `git config` reads. Measured ~30-80ms total on a configured machine. Acceptable for a CLI; would be unacceptable for a hot loop.
- Tests that drive a command through `bin/vaultkit.ts` now must either mock the gate, run on a system with prereqs set up, or use the bypass set. Existing tests sidestep this: they import `run()` from each command directly — the gate lives at the bin layer, not inside `run()`. Live integration tests (`init`, `destroy`, `connect`, `disconnect`) run in CI on Ubuntu where `gh` and `git` are configured by the workflow.
- A user with `gh`, `git`, `claude` installed manually (not via `vaultkit setup`) is still required to run `setup` once — but `setup` is idempotent and prints `+ ok` lines for everything already in place, so the cost is one extra invocation, not a redo.

**Trade-offs accepted:**
- The gate's required scopes are `repo` + `workflow` (no `delete_repo`). This matches what `setup` itself grants and what every command except `destroy` needs. `destroy` requests `delete_repo` on demand via `ensureDeleteRepoScope` — the gate doesn't pre-grant a destructive scope users may never use. See [.claude/rules/security-invariants.md](../../.claude/rules/security-invariants.md).
- The gate is **not** a separate marker file ("setup completed"). The truth is "are the tools present and authed?" — that's what `setup` verifies, that's what the gate verifies. A separate marker would be a second source of truth that could drift from reality (e.g., user uninstalled `gh` after running `setup`). The check is the truth.

## Alternatives considered

- **Auto-run setup on `npm install` via `postinstall` script.** Rejected: violates Twelve-Factor's explicit-dependency contract, breaks CI / Docker / `--ignore-scripts` users, can't run interactively, and `postinstall` failures (no Homebrew, no winget) leave the install in a half-broken state. A global package install should not prompt, sudo, or fork to a different package manager.
- **Per-command preflight checks** (each command file calls `requireSetup` itself). Rejected: (a) more places to forget, (b) inconsistent — different commands would inevitably diverge in their checks, (c) the wide-sweep test would have to grep N command files, vs. one `wrap()` for the centralized version. The user explicitly asked for the global fix: *"anything that seems like an error or might affect something globally should be fixed globally and tested on everything."* The dispatch-layer gate fits that brief.
- **First-run marker file at `~/.vaultkit-setup.json`.** Rejected: redundant with the tool-presence check. The marker would say "setup ran" but the actual question is "are the tools present right now" — a user who uninstalled `gh` after running `setup` would have a stale marker but a broken install. The check IS the truth.
- **Gate inside `program.hook('preAction', ...)`.** Considered. Equivalent to the wrap() approach functionally; chose `wrap()` because it's already the central audit-log + checkForUpdate + error-translation point — co-locating the gate keeps the "things that happen around every command" all in one place.
- **Make `setup` and `doctor` the only bypassed commands, and ALSO bypass `status` because it reads only the registry.** Rejected: `status` benefits from the gate too. A fresh-install user running `vaultkit status` to see what's registered should get the setup pointer immediately, not a confusing "no vaults found" that hides the fact they haven't authed yet. One mental model — "first thing after install, run setup" — is worth the trivial extra invocation cost.
