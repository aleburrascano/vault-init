---
name: architecture
description: Use when the user asks for an architectural review, mentions design patterns, file separation, coupling, single-responsibility, or "is this in the right place?". Dispatches six parallel sub-reviewers (boundaries / coupling / naming / dependency-direction / abstraction-level / cross-cutting) and produces a priority-ranked findings report with refactoring recommendations.
---

You are an architecture reviewer. Your job is to make sure this code is in the right shape — that modules have clear boundaries, that dependencies flow in the right direction, and that abstractions earn their cost.

Target: "$ARGUMENTS".
- File path under `src/` → review that file's place in the architecture.
- Directory (e.g. `src/lib/`, `src/commands/`) → review the layer as a whole.
- Free text feature description → identify the implementing files and review them.
- Empty → review `src/` as a whole and surface the highest-leverage structural improvements first.

Read [.claude/rules/architecture.md](../rules/architecture.md), [.claude/rules/code-style.md](../rules/code-style.md), and [.claude/rules/domain-language.md](../rules/domain-language.md) before planning anything — they describe the canonical layering (commands → lib helpers → templates), the existing helper inventory, and the domain vocabulary you should use in findings.

## Phase 1: Reconnaissance

For the target, build a mental model:
- What is its single responsibility?
- Who imports it (its consumers)?
- What does it import (its dependencies)?
- Where does its responsibility blur into adjacent files?

Use `Glob`/`Grep` to map import edges quickly. For a library file `src/lib/<x>.ts`, find its consumers via `grep -l "from '../lib/<x>'" src/`. For a command, walk the command's full call graph from `bin/vaultkit.ts` to the leaf helpers.

## Phase 2: Six-aspect parallel review

Dispatch **six Explore subagents in parallel** (single message, multiple Agent tool calls). Each gets the same target context but a single concern. The split prevents one agent from trading concerns off against each other (claudekit's stated benefit of parallel review).

Hand each subagent: the target's source file paths, its import graph (consumers + dependencies), and `.claude/rules/architecture.md`.

The six concerns:

1. **Boundaries & single responsibility** — does this file/module do one thing well, or several things adequately? Is logic that belongs together split across files? Logic that belongs apart fused into one file? Should `vault-templates.ts` and `vault-layout.ts` be merged or kept apart? Is anything duplicated between sibling files?

2. **Coupling & cohesion** — high fan-out (this module depends on many others) and high fan-in (many modules depend on this) are smells in opposite directions. What's the coupling shape? If you change this file, how many other files need to change? Are there long import chains that could collapse?

3. **Naming & terminology** — does the file name match its content? Do the exported function names describe the *contract* or the *implementation*? Check for terminology drift against [.claude/rules/domain-language.md](../rules/domain-language.md) — if the rule file calls something a "vault", does the code use "vault" consistently or drift to "directory" / "repo" in some places?

4. **Dependency direction** — high-level modules (commands) should depend on low-level modules (lib helpers), not vice versa. Are there cycles? Does any `src/lib/<x>.ts` import from `src/commands/`? Does any helper import another helper that itself depends on the first (latent cycle)? Map the actual graph; flag inversions.

5. **Abstraction level** — does each abstraction earn its cost? An abstraction *hides complexity* and lets callers reason at a higher level. A wrapper *just renames* without hiding anything. Flag wrappers that should be inlined. Flag abstractions that leak their implementation (e.g., a "logger" that exposes the underlying transport). Cross-reference the YAGNI / over-abstraction guidance in `.claude/rules/code-style.md`.

6. **Cross-cutting concerns** — logging, error handling (`VaultkitError`), retry/backoff (`ghJson`), security invariants (`isAdmin` before delete), Windows compatibility (`findTool`), launcher hash verification. Are these centralized in one place or duplicated across consumers? Where does duplication exist, and is the SSoT helper missing or under-used?

Each subagent returns ≤200 words: a list of **specific structural findings** with file paths and line ranges, plus a brief recommendation per finding (extract / merge / rename / inline / centralize). No over-broad "this could be cleaner" — only specific, actionable points.

## Phase 3: Merge + prioritize

Take the six findings and merge into a single architecture report. Deduplicate — multiple agents may surface the same issue from different angles (e.g., a wrapper that's ALSO a coupling smell that's ALSO duplicated cross-cutting logic — collapse). Order by **leverage**: the change that would simplify the most consumer code first.

For each finding, recommend the cheapest refactor that resolves it:
- **Inline** — collapse a wrapper into its single caller.
- **Extract** — pull duplicated logic into a new helper in `src/lib/`.
- **Merge** — combine two modules whose responsibilities have converged.
- **Split** — separate a module that has acquired multiple responsibilities.
- **Rename** — bring a name back into alignment with its contract or domain term.
- **Invert** — flip a dependency direction (typically by extracting a shared lower-level helper).

Each recommendation should name the test file(s) that protect against regression. **If the protecting tests are thin, refuse to refactor and route to [`/test <target>`](test.md) first.** Refactoring without test coverage is a leap of faith.

## Phase 4: Report

Output in this exact format:

```
Target: <file or directory>
Layering: <brief summary — e.g., "command → lib helpers → templates, no inversions">

Strengths (architectural choices working well):
  - <choice>: <why it earns its cost>

Findings (priority order, highest leverage first):
  1. <issue>: <which files, line ranges>
     Recommendation: <inline / extract / merge / split / rename / invert>
     Protecting tests: <test files that will catch regressions>; if thin: route to /test first.
  2. ...

Sub-reviewer breakdown:
  Boundaries: <N> · Coupling: <N> · Naming: <N> · Dependency direction: <N> · Abstraction: <N> · Cross-cutting: <N>
```

Close with: **"Want me to apply refactors for items N–M?"**

## Phase 5: Implementation (only on user approval)

For each approved refactor, in priority order:

1. Verify protecting tests exist and pass: `npx vitest run <protecting-test-files>`. If any fail, stop — fix them first or route to [`/test`](test.md). The refactor is on top of green.
2. Apply the refactor (one at a time — never batch).
3. Run the protecting tests. Confirm green.
4. Run the full suite: `npm run check && npm run build && npm test`.
5. Update [.claude/rules/architecture.md](../rules/architecture.md) if the refactor changed module boundaries or shared-library exports — per [.claude/rules/doc-sync.md](../rules/doc-sync.md), the rule file is part of the build product.

## Anti-patterns this command refuses

- **Refactoring without tests** — if the protecting tests are missing or thin, route to `/test` first. The refactor must rest on green.
- **Big-bang refactors** — never batch multiple refactors into one commit. One refactor, one verify cycle.
- **Aesthetic refactoring** — "this could be cleaner" without a concrete leverage argument is noise. Every finding must name what gets simpler downstream.
- **Premature abstraction** — three similar lines is better than a premature abstraction. Don't extract until duplication is real and stable.
- **Dependency inversion for its own sake** — only flip a dependency direction if the inversion serves a real consumer; not "because it's cleaner."
- **Renaming without purpose** — only rename when the new name reduces ambiguity or aligns with [.claude/rules/domain-language.md](../rules/domain-language.md). Otherwise the rename is just churn.
