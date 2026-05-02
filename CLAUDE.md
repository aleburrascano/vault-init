# vaultkit

CLI that connects Claude Code to Obsidian vaults via MCP. Public npm package: [@aleburrascano/vaultkit](https://www.npmjs.com/package/@aleburrascano/vaultkit). Node ≥22, ESM, TypeScript strict mode. Source under `bin/`, `src/`, `tests/`; ships compiled `dist/`.

Architecture details, command map, and shared-library reference live in [.claude/rules/architecture.md](.claude/rules/architecture.md) (auto-loads when source files are touched). Security rules for destructive ops live in [.claude/rules/security-invariants.md](.claude/rules/security-invariants.md). Doc-sync rules — what to update in `.claude/rules/*.md` when code changes — live in [.claude/rules/doc-sync.md](.claude/rules/doc-sync.md).

Slash commands in [.claude/commands/](.claude/commands/) for project workflows:
- `/add-command <name>` — scaffold a new vaultkit command (`src/commands/<name>.ts` + `bin/vaultkit.ts` wiring + README/CHANGELOG row + test stub)
- `/debug-command <name>` — investigate issues in a specific command against the security/Windows/style checklist
- `/security-audit [name]` — verify the security invariants ([.claude/rules/security-invariants.md](.claude/rules/security-invariants.md)) across all commands or one
- `/clarify-project [focus]` — fresh-user evaluation; adversarially compares docs against actual CLI behavior to surface drift
- `/release` — version bump, CHANGELOG rotation, tag, push (triggers `release.yml` → `npm publish`)

## Commands
build:      npm run build
check:      npm run check    (tsc --noEmit)
test:       npm test
test:watch: npm run test:watch

## Local Development

```bash
npm install && npm run build && npm link    # one-time
vaultkit <command>
```

`npm test` runs vitest against TS source directly (no build needed for tests). `npm run build` produces fresh `dist/` output.

## Hard Invariants

- **Public npm package.** The shipped `dist/` is a stability contract — defects in published versions reach real users. Never ship a release where any of `npm run check`, `npm run build`, or `npm test` fails.
- **Launcher template** [lib/mcp-start.js.tmpl](lib/mcp-start.js.tmpl) is byte-immutable — its SHA-256 is pinned in every existing user vault. Never edit casually. Never duplicate inline; `copyFileSync` from the template.
- **TypeScript source → `dist/` at publish.** Only `dist/` is shipped via `package.json#files`.
- **Windows compatibility is mandatory** — use [src/lib/platform.ts](src/lib/platform.ts) helpers; test Windows path branches.
- **ESM only** — no `require()`.

## Standing Workflows

- **Bug fix:** failing test first. Show it fail, fix it, show it pass. Run full suite.
- **Feature:** run full suite before and after.
- **Refactor:** all tests green before, all tests green after.
- **Change cadence:** small atomic commits, every commit independently shippable (`check`, `build`, `test` all green). Decompose multi-step changes into commits that each leave the world intact (introduce-new-then-remove-old, not rip-and-replace). The TypeScript migration (commits `a0a22f0` → `e0543a2`, 23 commits across 7 phases) is the canonical model.

## Known Hallucination Patterns
@.claude/rules/hallucination-patterns.md
