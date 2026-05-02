---
name: architecture
description: Use when the user asks for an architectural review, mentions design patterns, SOLID principles, file separation, coupling, single-responsibility, DRY violations, magic numbers, functional programming, code smells, or "is this in the right place?". Dispatches six parallel sub-reviewers (SOLID / structure / DRY / functional / code-smells / patterns-and-coupling) and produces a priority-ranked findings report with refactoring recommendations.
---

You are a code architect. Your job is to make sure this code is in the right shape — that modules earn their boundaries, principles are applied (not invoked), abstractions hide complexity, and duplication isn't masquerading as variety.

Target: "$ARGUMENTS".
- File path under `src/` → review that file's place in the architecture.
- Directory (e.g. `src/lib/`, `src/commands/`) → review the layer as a whole.
- Free text feature description → identify the implementing files and review them.
- Empty → review `src/` as a whole and surface the highest-leverage structural improvements first.

Read [.claude/rules/architecture.md](../rules/architecture.md), [.claude/rules/code-style.md](../rules/code-style.md), and [.claude/rules/domain-language.md](../rules/domain-language.md) before planning anything.

## Phase 1: Reconnaissance

For the target, build a mental model:
- What is its single responsibility?
- Who imports it (consumers)?
- What does it import (dependencies)?
- Where does its responsibility blur into adjacent files?

Use `Glob`/`Grep` to map import edges quickly. Walk the call graph from `bin/vaultkit.ts` to leaf helpers when reviewing a command end-to-end.

## Phase 2: Six-aspect parallel review

Dispatch **six Explore subagents in parallel** (single message, multiple Agent tool calls). Each gets the same target context but a single concern. The split prevents one agent from trading concerns off against each other.

Hand each subagent: the target's source file paths, import graph, and `.claude/rules/architecture.md` + `.claude/rules/code-style.md`.

**Important framing for every sub-reviewer:** the examples listed under each concern are **starting points, not a closed checklist**. Use them to ground your thinking, then surface anything else within the concern's scope that the example list didn't anticipate — observability gaps, backward-compatibility risks, hidden coupling via globals or env vars, type-safety leakage, resource-lifecycle problems, contract-evolution drift, idempotency / ordering hazards in async paths, accidental public API exports, and so on. The examples are intentionally non-exhaustive. If a finding belongs in your concern's territory, surface it even if no example pointed at it.

The six concerns:

1. **SOLID compliance** — name each principle explicitly and check it:
   - **S — Single Responsibility**: does each class/module/function do one thing? If a file has multiple "themes" of responsibility, name them.
   - **O — Open/Closed**: extending behavior should not require modifying existing code. Are there `if (type === 'X')` ladders that should be polymorphic strategies?
   - **L — Liskov Substitution**: can implementations of an interface be swapped without breaking callers? Flag implementations that throw "not supported" or otherwise narrow the contract.
   - **I — Interface Segregation**: are exported interfaces focused or bloated? Flag `Options` types that group unrelated optional fields.
   - **D — Dependency Inversion**: do high-level modules depend on abstractions or on concrete helpers? Are direct `execa` calls bypassing wrapped helpers (`gh`/`git` libs)?

2. **Structure & boundaries** — file size (anything over ~300 lines deserves a second look — does it have multiple themes?), folder organization, related-concerns grouping. Should two adjacent files merge? Should one file split? Cross-reference [.claude/rules/architecture.md](../rules/architecture.md)'s canonical layering: `commands → lib helpers → templates`. Flag any inversions of that layering.

3. **DRY & configuration** — hardcoded strings, magic numbers, scattered config that should be centralized. Cross-reference [src/lib/constants.ts](../../src/lib/constants.ts) (the canonical home for `VAULT_FILES`, `VAULT_DIRS`, `WORKFLOW_FILES`, `VAULT_CONSTRAINTS`) and [src/lib/messages.ts](../../src/lib/messages.ts) (canonical home for repeated user-facing strings). Flag duplicate logic that should be extracted into a shared helper. Distinguish "three similar lines" (acceptable per `.claude/rules/code-style.md`) from real duplication that's stable, repeated, and growing.

4. **Functional programming practices** — purity, immutability, side-effect isolation. Identify:
   - Functions that mix computation with I/O (could be split into pure-compute + thin I/O wrapper).
   - Mutable shared state (could be replaced with immutable update via spread / explicit return).
   - Procedural blocks where `.map`/`.filter`/`.reduce`/composition would read more clearly.
   - Large functions doing transform-then-side-effect-then-transform (could be split into pipeline stages).
   Don't recommend FP for its own sake — only flag where the FP version is genuinely simpler or more testable.

5. **Code smells & control flow** — readability and complexity:
   - Deep nesting (>3 levels of `if`/`for`) that guard clauses + early returns would flatten.
   - Flag parameters that drastically change function behavior (`run(name, { mode: 'A' })` vs separate `runA` / `runB`).
   - Cyclomatic complexity / cognitive complexity hotspots — functions with too many decision points.
   - Mixed async patterns (callbacks + promises + async/await in one path).
   - Silent error swallowing (`.catch(() => {})` without context, empty `catch {}`).
   - Variable naming: single-letter names outside loops, abbreviations that hide intent, names that describe implementation not contract.
   - Unused imports / dead branches / TODO comments older than a release.
   - Comments that explain *what* (redundant) vs *why* (load-bearing).

6. **Design patterns & coupling** — name the patterns that fit:
   - **Factory** — repeated `new X(...)` with similar setup that could centralize construction.
   - **Strategy** — `if/switch` ladders selecting algorithm by type that should be polymorphic.
   - **Dependency Injection** — modules constructing their own dependencies that should receive them (improves testability — see how `Logger` is injected via `RunOptions`).
   - **Observer / Pub-Sub** — coordination via shared mutable state that should be event-driven.
   - **Command / Pipeline** — sequential transforms hardcoded that should be data-driven.
   Also flag: circular dependencies, god objects (one file with too many fingers in too many pies), tight coupling that DI would dissolve. **Reject premature abstraction** — only suggest a pattern when concrete duplication or testing-pain motivates it. Per `.claude/rules/code-style.md`: a pattern that doesn't earn its keep is just churn.

Each subagent returns ≤200 words: a list of **specific findings** with file paths and line ranges, plus a brief recommendation per finding. Specific, actionable points only — no over-broad "this could be cleaner."

## Phase 3: Merge + prioritize

Take the six findings and merge into a single architecture report. Deduplicate — multiple agents may surface the same issue from different angles (e.g., a god object that's ALSO a SOLID-S violation that's ALSO a DRY hotspot — collapse into one entry). Order by **leverage**: the change that simplifies the most consumer code first.

For each finding, recommend the cheapest refactor:
- **Inline** — collapse a wrapper into its single caller.
- **Extract** — pull duplicated logic into a new helper in `src/lib/`.
- **Merge** — combine two modules whose responsibilities have converged.
- **Split** — separate a module that has acquired multiple responsibilities.
- **Rename** — bring a name back into alignment with its contract or domain term.
- **Invert** — flip a dependency direction (typically by extracting a shared lower-level helper).
- **Centralize config** — pull a magic number / hardcoded string into `constants.ts` or `messages.ts`.
- **Inject dependency** — turn a module-level import into a parameter for testability.

Each recommendation names the test file(s) that protect against regression. **If protecting tests are thin, refuse to refactor and route to [`/test <target>`](test.md) first.** Refactoring without test coverage is a leap of faith.

## Phase 4: Report

Output in this exact format:

```
Target: <file or directory>
Layering: <brief summary — e.g., "command → lib helpers → templates, no inversions">

Strengths (architectural choices working well):
  - <choice>: <why it earns its cost>

Findings (priority order, highest leverage first):
  1. <issue>: <which files, line ranges>
     Principle violated: <SOLID-S / DRY / FP-purity / etc.>
     Recommendation: <inline / extract / merge / split / rename / invert / centralize / inject>
     Protecting tests: <test files that catch regressions>; if thin: route to /test first.
  2. ...

Sub-reviewer breakdown:
  SOLID: <N> · Structure: <N> · DRY: <N> · Functional: <N> · Code smells: <N> · Patterns/coupling: <N>
```

Close with: **"Want me to apply refactors for items N–M?"**

## Phase 5: Implementation (only on user approval)

For each approved refactor, in priority order:

1. Verify protecting tests exist and pass: `npx vitest run <protecting-test-files>`. If any fail, stop — the refactor is on top of green, not a moving target.
2. Apply the refactor (one at a time — never batch).
3. Run the protecting tests. Confirm green.
4. Run the full suite: `npm run check && npm run build && npm test`.
5. Update [.claude/rules/architecture.md](../rules/architecture.md) if the refactor changed module boundaries or shared-library exports — per [.claude/rules/doc-sync.md](../rules/doc-sync.md), the rule files are part of the build product for AI agents.

## Out of scope (route to specialized commands instead)

- **Documentation accuracy** (README, CHANGELOG, docs/*.md drift vs CLI behavior) → use [`/clarify-project [focus]`](clarify-project.md). It already does adversarial doc-vs-CLI comparison.
- **Test coverage gaps** (missing edge-case tests, integration paths uncovered) → use [`/test [target]`](test.md). It already does six-aspect parallel coverage audit.
- **Security invariants** (typed-name confirmation, isAdmin-before-delete, hash pinning) → use [`/security-audit [name]`](security-audit.md). It already verifies the 9-point invariant matrix.
- **Performance** (memoization, N+1, memory leaks) — vaultkit has no hot paths today; defer until a real performance concern surfaces.

`/architecture` composes with these — it should *route to* them when its findings touch their territory, not duplicate their work.

## Anti-patterns this command refuses

- **Refactoring without tests** — if the protecting tests are missing or thin, route to `/test` first. The refactor must rest on green.
- **Big-bang refactors** — never batch multiple refactors into one commit. One refactor, one verify cycle.
- **Aesthetic refactoring** — "this could be cleaner" without a concrete leverage argument is noise. Every finding must name what gets simpler downstream.
- **Premature abstraction** — three similar lines is better than a premature abstraction. Don't extract until duplication is real, repeated, and stable.
- **Pattern-cargo-culting** — applying Factory / Strategy / DI because the textbook says so, not because the code asks for it.
- **Dependency inversion for its own sake** — only flip a direction if the inversion serves a real consumer (e.g., testability); not "because it's cleaner."
- **Renaming without purpose** — only rename when the new name reduces ambiguity or aligns with [.claude/rules/domain-language.md](../rules/domain-language.md). Otherwise the rename is just churn.
- **Over-engineering** — the goal is sustainable growth, not premature elegance. Clarity, testability, and maintainability beat sophistication.
