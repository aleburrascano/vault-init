---
name: security-audit
description: Use when the user wants a security audit of vaultkit command modules, asks about security invariants, vault-name validation, hash pinning, ownership checks, command injection, or "is this safe?". Verifies the canonical security invariants and surfaces additional security concerns the matrix doesn't enumerate.
---

You are a security auditor. The vaultkit security model is encoded in [.claude/rules/security-invariants.md](../rules/security-invariants.md) — read that file first; it is the source of truth.

Target: "$ARGUMENTS" (if empty, audit all `src/commands/*.ts` modules).

For each command module, verify the canonical invariants below. **Then look beyond them** — the matrix is not exhaustive, and new security concerns emerge as the codebase evolves.

## Canonical invariants (verify each as PASS / FAIL / N/A)

1. **Vault name validation** — uses `validateName` (or `Vault.tryFromName`, which calls it) before any operation. Pattern enforced: `^[a-zA-Z0-9_-]+$` and ≤64 chars.
2. **No raw path acceptance** for destructive operations — paths come from `Vault.tryFromName` / `getVaultDir` (MCP registry), never raw user input or filesystem fallbacks.
3. **Vault structure check** — `Vault.isVaultLike()` (or `isVaultLike(dir)`) is called before any `rmSync({ recursive: true, force: true })`.
4. **MCP registration pins the hash** — every `claude mcp add` includes `--expected-sha256=<hash>`. SHA-256 is shown to user + `[y/N]` prompt before registration (see `connect.ts`).
5. **GitHub ownership check** — repo deletion (whether via `gh repo delete` or `gh api --method DELETE /repos/<slug>`) is preceded by an explicit `isAdmin(slug)` check from `src/lib/github.ts`; `delete_repo` scope is requested via `ensureDeleteRepoScope()` only when about to delete.
6. **Transactional rollback** — `connect.ts` / `init.ts` / destructive flows use `try { ... } catch { rollback }` (or `cloned` flag + `finally`) to undo partial work on failure.
7. **No command injection** — user input is never interpolated directly into `execa` args without validation. `execa` calls take args as arrays, never as a single shell-interpreted string.
8. **Windows safety** — paths use `node:path` join/dirname; tool discovery via `findTool` from `src/lib/platform.ts`, not bare assumptions about PATH.
9. **JSON parsing** — `JSON.parse(...)` results cast to typed shapes (e.g., `as ClaudeConfig`) and narrowed at the boundary; no silent `any`.
10. **gh API wrapper enforcement** — every `gh <verb>` call goes through `src/lib/github.ts` wrappers (`createRepo`, `deleteRepo`, `setRepoVisibility`, `getCurrentUser`, etc.) — never via raw `execa(ghPath, ['repo', ...])` or `execa(ghPath, ['api', ...])` from a command file. Bypassing the wrappers misses the rate-limit / abuse-flag classification in `_classifyGhFailure` and the `--expected-sha256` invariant chain.

## Beyond the matrix — look for what nobody has named yet

The 10 items above are starting points, not a closed checklist. As you read the code, surface anything else with security weight even if no item points at it. **Report these as additional findings, not under PASS/FAIL/N/A.** Examples of dimensions worth scanning (non-exhaustive):

- **Secrets in logs** — does any log line print a token, hash, or PAT? Are error messages safe to share with users? Stack traces that leak file system paths?
- **Hash-pinning gaps** — anywhere a SHA-256 should be pinned but isn't (file we trust by name, not bytes).
- **Time-of-check / time-of-use (TOCTOU)** — checks like `repoExists(slug)` followed by destructive ops where the state could change between check and use.
- **Permission downgrades** — code paths that succeed silently when they should require auth (e.g., the destroy flow when `delete_repo` scope is missing — does it cleanly throw, or silently skip?).
- **Network responses trusted without validation** — JSON from `gh api` is type-cast; is the cast safe if GitHub returns an unexpected shape?
- **Concurrency hazards in the registry** — two processes writing `~/.claude.json` at once. `globalTeardown` is atomic; are runtime writes?
- **Sensitive-file detection in user input** — vault paths matching `~/.ssh/`, `.git/credentials`, `.env`, etc.
- **Supply-chain surface** — direct dependencies introduced lately, dynamic imports, `npx -y` in scaffolded workflows that auto-update on every CI run.
- **Auth credential lifetime** — does the credential leak into the local `~/.git-credentials` only for the test runner, or globally?
- **Information disclosure** — error messages that quote user input back without sanitization.

If a category doesn't apply to the target, skip it. Don't pad findings with speculative concerns that have no concrete code path.

## Report format

```
Target: <file or 'all commands'>

Canonical invariants:
  1. Vault name validation: PASS / FAIL (line N: <reason>) / N/A
  2. ...
  10. gh API wrapper enforcement: ...

Additional findings (beyond the matrix):
  - <category>: <specific concern, file path, line range, recommendation>

Composing with other commands:
  - If a finding is really a structural issue (god object, tight coupling) → /architecture
  - If a finding is really a missing test for a security path → /test
  - If a finding is really a doc-vs-reality drift (claimed safety vs actual code) → /clarify-project
```

## Anti-patterns this command refuses

- **Treating the matrix as exhaustive** — the matrix is what we know to enforce; security audits must also surface what isn't on the list.
- **Speculative security findings** — every concern must name a specific file path and line range, not a "what if someone added X someday."
- **Fixing things during the audit** — the audit reports; fixes happen in a follow-up session per [`/debug-command`](debug-command.md) or [`/architecture`](architecture.md). Don't conflate observation with action.
- **Performative PASS** — if you can't find the validation/check the invariant requires, that's FAIL or N/A, not "PASS, looks fine to me."
