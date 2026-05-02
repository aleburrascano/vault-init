---
name: test
description: Use when the user asks to write tests, mentions edge cases, coverage gaps, integration/unit/e2e tests, or TDD. Dispatches six parallel sub-reviewers (unit / mocked-integration / e2e / edge cases / security / cross-platform) and produces a priority-ranked coverage report; on user approval, writes tests and confirms they fail meaningfully before making them pass.
---

You are a testing expert. Your job is to break this code, not to praise it.

Target: "$ARGUMENTS".
- File path under `src/` → audit that file's tests.
- Command name (e.g. `init`, `destroy`) → audit `src/commands/<name>.ts` end-to-end.
- Free text description → identify the implementing files first, then audit them.
- Empty → audit `src/` and surface the highest-blast-radius gaps first.

Read [.claude/rules/testing.md](../rules/testing.md) before planning anything — it tells you the runner (vitest), the helpers in `tests/helpers/`, the live-test conventions (`vk-live-*` prefix, `liveDescribe` skips Windows, `makeLocalVault` for non-GitHub vaults), the sacred tests rule, and the cleanup invariants.

## Phase 1: Reconnaissance

Read in full:
- The source file(s) you're auditing.
- All matching test files: `tests/lib/<name>.test.ts`, `tests/commands/<name>.test.ts`, `tests/commands/<name>-mocked.test.ts`.
- Helpers the source imports.

State, in your head: what does this code do, what inputs does it take, what side effects does it produce, where does it fail?

## Phase 2: Six-aspect parallel review

Dispatch **six Explore subagents in parallel** (single message, multiple Agent tool calls). Each gets the same target context but a single concern. The split prevents one agent from trading concerns off against each other.

Hand each subagent: the target's source file paths, the existing test file paths, and the relevant rule file (`.claude/rules/testing.md` for all six; `.claude/rules/security-invariants.md` for sub-reviewer 5; `.claude/rules/architecture.md` for sub-reviewer 6).

**Important framing for every sub-reviewer:** the items listed under each concern are **starting points, not a closed checklist**. Use them to ground your thinking, then surface anything else within the concern's scope that the example list didn't anticipate — locale-specific bugs the boundary list missed, race conditions the state list didn't enumerate, security gaps the OWASP-style examples didn't cover, platform-specific failure modes nobody named yet. The examples are intentionally non-exhaustive. If a gap belongs in your concern's territory, surface it even if no example pointed at it. Conversely, don't pad findings with examples that don't actually apply to the target — speculative gaps degrade the report.

The six concerns:

1. **Unit-test gaps** — pure functions, library helpers in `src/lib/`. Branches and return shapes covered? Boundary returns (null, empty, undefined) covered? Async failure paths covered?
2. **Mocked-integration gaps** — command-level paths in `src/commands/` where execa / @inquirer / fs are mocked. Failure modes covered? Mock argv shapes match what the migrated `gh api` callers actually invoke (post-2.7.1)? Log-line assertions present?
3. **End-to-end gaps** — live tests, real GitHub round-trips. Anything that only manifests on a real round-trip not covered today? Should this scenario use `liveDescribe` (Ubuntu only) or `makeLocalVault` (no GitHub remote)?
4. **Edge-case enumeration** — adversarial. Boundary inputs (0, 1, max, max+1, NaN, null, undefined, empty string), invalid state transitions, race conditions, encoding (Unicode, BOM, locale), length (empty / single / very long / exactly-at-limit), timing, ordering.
5. **Security gaps** — path traversal in vault names (`../`, absolute paths), shell injection in execa args, hash mismatches (launcher modified outside vaultkit), privilege-escalation order (`delete_repo` requested before `isAdmin` check), JSON-unsafe content. Cross-reference [.claude/rules/security-invariants.md](../rules/security-invariants.md).
6. **Cross-platform gaps** — Windows path handling, `findTool` fallbacks, line endings, file locks, case sensitivity. Should the test wrap in `liveDescribe` (skip Windows) or run on both OSes?

Each subagent returns ≤200 words: a list of **specific scenarios that the target should but doesn't currently cover**. No test-type recommendations from subagents — that's the merge step's job.

## Phase 3: Merge + prioritize

Take the six findings and merge into a single coverage matrix. Deduplicate (multiple agents may surface the same gap from different angles — collapse them). Order by **blast radius**: production-impacting bugs first, latent code paths second, defense-in-depth third.

For each gap, recommend the cheapest test that would catch it, in this order:
- **Unit** in `tests/lib/<name>.test.ts` — pure function or library helper.
- **Mocked integration** in `tests/commands/<name>-mocked.test.ts` — `vi.mock` for execa / @inquirer / fs.
- **Local-vault integration** with `makeLocalVault` from `tests/helpers/local-vault.ts` — needs real vault layout, no GitHub remote.
- **Live test in `tests/commands/<name>.test.ts` wrapped in `liveDescribe`** — needs real GitHub (Ubuntu CI only).
- **Launcher integration** in `tests/lib/launcher-integration.test.ts` — spawns real Node against the byte-immutable template.

Never invent new test scaffolding when a helper exists.

## Phase 4: Coverage report

Output in this exact format:

```
Target: <file or command>
Existing tests: <list of test file paths + LOC>

Already covered:
  - <scenario> → <test name>

Marginal coverage (vacuous assertion or wrong path):
  - <scenario> → <test name>: <why it's marginal>

Missing (priority order, highest blast radius first):
  1. <scenario>: <why it matters> → recommended: <test type> in <file>
  2. ...

Sub-reviewer breakdown:
  Unit: <N> · Integration: <N> · E2E: <N> · Edges: <N> · Security: <N> · Cross-platform: <N>
```

Close with: **"Want me to write tests for items N–M?"**

## Phase 5: Implementation (only on user approval)

For each approved scenario in priority order:

1. Write the test asserting the expected behavior.
2. Run the targeted file: `npx vitest run <test-file>`.
3. Confirm the test fails for the **right** reason.
   - Wrong reason (mock missing, fixture wrong) → fix setup, rerun.
   - **Right** reason and the implementation doesn't handle the edge case → surface to user. **This is the gold** — a real bug found before users hit it. Ask whether to fix the implementation now or capture it as a follow-up.
4. Make the test pass.
5. After all scenarios: `npm run check && npm run build && npm test` for full-suite confirmation.

## Anti-patterns this command refuses

- **Editing existing tests** without explicit approval. Sacred tests rule per [CLAUDE.md](../../CLAUDE.md): if a test seems wrong, ask before changing it.
- **Vacuous assertions** — `expect(result).toBeDefined()` when you should assert the actual value; `await expect(p).rejects.toThrow()` on a no-throw path.
- **Mocking the function under test** — you're testing the mock, not the function.
- **Snapshot-pinning internal state** — assert observed behavior, not internal data structures.
- **Coverage theater** — adding tests that hit lines without exercising failure modes. Coverage % rises, bug-finding power doesn't.
- **Inventing new test scaffolding** when an existing helper covers the case (`liveDescribe`, `makeLocalVault`, `arrayLogger`, `writeCfg`, `mockGitConfig`).
