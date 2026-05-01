---
paths:
  - "src/commands/*.ts"
  - "src/lib/*.ts"
  - "bin/vaultkit.ts"
  - "src/types.ts"
  - "scripts/**/*"
  - "package.json"
  - "lib/*.tmpl"
  - ".github/workflows/*.yml"
---

# Documentation Sync — Update Rules When the Code Changes

The `.claude/rules/*.md` files are read by future Claude Code sessions to build their mental model of this codebase. They auto-load via the `paths:` frontmatter when matching files are touched, so a stale rule actively misleads. **The rule files are not optional documentation — they are part of the build product for AI agents.**

When you make a change, update the relevant rule file *in the same commit* as the code change. A separate "doc cleanup" pass weeks later does not happen reliably and produces drift like the pre-2.0.4 `CONTRIBUTING.md` that still described shell scripts long after the TS migration.

## What to update, when

| Change | File to update | What to add/edit |
|---|---|---|
| New `src/lib/<name>.ts` | [.claude/rules/architecture.md](architecture.md) | Add a row to "Shared Libraries" table; list key exports |
| Removed or renamed `src/lib/<name>.ts` | [.claude/rules/architecture.md](architecture.md) | Remove or rename the row |
| New command in `src/commands/` | [.claude/rules/architecture.md](architecture.md), [README.md](../../README.md), [bin/vaultkit.ts](../../bin/vaultkit.ts) help text, [CHANGELOG.md](../../CHANGELOG.md) under `## [Unreleased]` | Add a row everywhere; existing `/add-command` checklist covers this |
| New cross-cutting type or class (e.g. `VaultkitError`, `Logger`, `CommandModule`) | [.claude/rules/domain-language.md](domain-language.md) | Add a definition entry |
| New convention or breaking style change (e.g. `LogFn` → `Logger`, `console.log` → `log.info`) | [.claude/rules/code-style.md](code-style.md) | Update the relevant bullet; remove patterns that are no longer canonical |
| New security invariant or destructive-op pattern | [.claude/rules/security-invariants.md](security-invariants.md) | Add to the bullet list |
| New testing convention (helper, fixture, gating env var) | [.claude/rules/testing.md](testing.md) | Document the new pattern |
| New hook, skill, or slash command in `.claude/` | [CLAUDE.md](../../CLAUDE.md) (mention) and the relevant rule file | Cross-reference so it's discoverable |
| New runtime dependency in `package.json` | [.claude/rules/architecture.md](architecture.md) "Stack" section, [CONTRIBUTING.md](../../CONTRIBUTING.md) "Three runtime deps" line | Update the count and list |
| Architectural shift visible to contributors (build flow, file layout, Node version) | [CONTRIBUTING.md](../../CONTRIBUTING.md), [.claude/rules/architecture.md](architecture.md) | Rewrite affected sections |
| Hallucination caught after the fact | [.claude/rules/hallucination-patterns.md](hallucination-patterns.md) | Add the pattern (use `/ce-compound` for the workflow) |
| Recurring pattern that future sessions should remember (preference, workflow, decision) | `~/.claude/projects/.../memory/feedback_*.md` + `MEMORY.md` index | Use the auto memory system, not rule files |

## What does NOT belong in rule files

- **Temporary state** (in-progress work, current task context) → use plans, todos, or session notes.
- **Per-PR context** (why you renamed this variable) → use the commit message and CHANGELOG entry.
- **Code snippets that duplicate source** (e.g., copy-pasting a function definition) → reference the file:line instead.
- **End-user documentation** (how to install, command help) → README.md and bin help text.

## How to verify

After a substantive change, before committing, run a quick mental check:

1. Did I add or remove a file under `src/lib/` or `src/commands/`? → did I update [architecture.md](architecture.md)?
2. Did I introduce a new exported class, type, or interface that other code will need to know about? → did I add it to [domain-language.md](domain-language.md)?
3. Did I change a coding convention (default value, helper pattern, error-throwing style)? → did I update [code-style.md](code-style.md)?
4. Did I touch `~/.claude.json` writes, repo deletion, or vault-deletion logic? → did [security-invariants.md](security-invariants.md) capture the new invariant?
5. Did I add a new test helper or testing pattern? → does [testing.md](testing.md) reference it?
6. Did I add or remove an npm dependency? → does [CONTRIBUTING.md](../../CONTRIBUTING.md)'s dependency line still match?

If you answered "yes, but I haven't updated the doc," fix it before committing. The cost is 30 seconds; the cost of a future session reading a stale rule is much higher.
