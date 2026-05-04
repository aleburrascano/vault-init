# ADR-0008: Module-level imports as the dependency-wiring strategy

**Status**: Accepted
**Date**: 2026-05-04
**Related rules**: [.claude/rules/architecture.md](../../.claude/rules/architecture.md), [.claude/rules/code-style.md](../../.claude/rules/code-style.md)

## Context

vaultkit's three Anti-Corruption Layers ([gh-retry.ts](../../src/lib/gh-retry.ts), [git.ts](../../src/lib/git.ts), [mcp.ts](../../src/lib/mcp.ts)) and three github-* facades function as ports in the Hexagonal-Architecture sense — they wrap external CLIs and translate their native shapes into vaultkit's domain vocabulary. The Hexagonal/Clean Architecture literature (e.g., Cockburn's original ports-and-adapters paper, Uncle Bob's *Clean Architecture*) prescribes **explicit port interfaces** at the boundary:

```ts
interface GhClient {
  ghJson<T>(...args: string[]): Promise<T>;
}
interface GitClient {
  push(dir: string): Promise<GitPushResult>;
  pull(dir: string, opts?: PullOptions): Promise<GitPullResult>;
  // …
}
```

Consumers depend on the interface; concrete implementations are supplied via constructor injection or a DI container. Tests pass fakes/mocks satisfying the same interface. Production wires up the real implementations once at the entry point.

vaultkit does **not** do this. Commands import the concrete modules directly:

```ts
import { ghJson } from '../lib/gh-retry.js';
import { clone } from '../lib/git.js';
import { runMcpAdd } from '../lib/mcp.js';
```

Tests use `vi.mock` to swap modules at the test-loader level:

```ts
vi.mock('../../src/lib/gh-retry.js', async (importOriginal) => {
  const real = await importOriginal<…>();
  return { ...real, ghJson: vi.fn(), gh: vi.fn() };
});
```

The architecture review (May 2026, plan: `can-you-go-through-inherited-squirrel.md`) raised this discrepancy as Finding 6. The vault literature consulted (Hexagonal Architecture, Clean Architecture, DIP, DI, KISS, YAGNI) gave conflicting prescriptions. This ADR records the deliberate choice.

## Decision

**Module-level imports are the dependency-wiring strategy. Explicit port interfaces are not introduced.**

The current pattern stays:

- Commands import concrete `src/lib/<name>.ts` modules.
- Tests use `vi.mock(...)` to swap module bindings at the test-loader level.
- The Logger interface remains the project's only DI seam — the documented exception, captured in `.claude/rules/code-style.md`'s "Logger is the project's dependency-injection seam" paragraph. Logger is injected because tests want process-free assertion on captured output (`arrayLogger`), not because we anticipate multiple implementations of "where does output go."

The trigger to revisit this decision: **the second concrete implementation of any ACL is genuinely needed**. Not "would be nice to have" — needed for a real, current requirement. Examples that would qualify:

- A `FakeGhClient` for offline development (`vaultkit status` / `pull` against locally-mocked GitHub state) — only if multiple users actually want this.
- A `RemoteGitClient` that wraps a different git implementation (e.g., libgit2-node) — only if a real porting need arises.
- A `WindowsMcpClient` differing from the Unix shape — only if `claude mcp` argv truly diverges per-OS.

When any of these lands, this ADR is superseded by a new one introducing the port/adapter shape for that ACL specifically. No big-bang interface migration; one ACL at a time, when the second implementation forces it.

## Consequences

**Easier:**
- **No interface boilerplate.** A function added to `git.ts` is one declaration. With explicit interfaces, the same change touches the interface file plus the implementation, plus possibly any DI registrations. For a 13-command, single-developer CLI, the boilerplate cost compounds without payback.
- **Imports are honest.** A reader sees `import { ghJson } from '../lib/gh-retry.js'` and knows exactly what code runs. With an injected interface, the reader has to find where the binding is registered — which can require chasing through a container config or `main()` wiring.
- **Tests stay simple.** `vi.mock` at the module level replaces the binding for every consumer; no constructor threading. New tests don't need to know about a separate fakes layer.
- **The architectural fitness functions still work.** They grep for `execa('gh', …)` / `execa('git', …)` / `execa([…, 'mcp', …])` — those textual checks don't care whether the call goes through a concrete import or an interface. Architecture erosion is prevented at the same layer either way.

**Harder:**
- **Tests bind to module paths, not abstractions.** Renaming `gh-retry.ts` would require updating every `vi.mock('../../src/lib/gh-retry.js', …)` site. Today this isn't a problem (the file hasn't been renamed since extraction); if it becomes one, that's a signal to revisit.
- **Adding a second implementation is a refactor, not a configuration change.** A `FakeGhClient` would require introducing the interface AND migrating every call site to inject through it AND updating tests. The cost is paid once, when a real second implementation actually arrives, instead of paid up-front speculatively.
- **One specific kind of test is harder than ideal.** "Run the entire flow with a fake gh that records every call and replays canned responses" would need an end-to-end module mock that's fiddly to set up. Today's tests live below that level (mock single calls per test, not entire conversations) — if integration recording becomes valuable, it's evidence the second implementation is needed.

**Trade-offs accepted:**
- We deliberately depart from the Hexagonal/Clean Architecture literature's prescription. The vault notes on KISS and YAGNI explicitly warn against premature abstraction; the canonical "introduce extension seams when you have two implementations, not one" rule applies. We have one implementation per ACL and a working test strategy. Adding interfaces now would be the speculative kind of design YAGNI rejects.
- The Logger DI exception is **not** a precedent. Logger has multiple concrete shapes today (`ConsoleLogger` for production, `SilentLogger` and `arrayLogger` for tests) AND the test-time substitution is on the hot path of every test that asserts on captured output. The other ACLs have neither condition: one production implementation, mock-based test substitution that doesn't need a separate fake.

## Alternatives considered

- **Introduce explicit port interfaces (`GhClient`, `GitClient`, `McpClient`) now.** Rejected: KISS / YAGNI. The benefits land only at the second implementation; today there's no second implementation. The boilerplate cost is paid every commit until that day arrives.
- **Use a DI container (e.g., Awilix, InversifyJS).** Rejected: same KISS argument plus the framework cost. A 13-command CLI does not need a container that's designed for enterprise-scale dependency graphs. Logger is the only injected dependency today, and its DI works fine through plain constructor parameters (`RunOptions.log`).
- **Module-level imports + a thin "fake module" parallel tree under `tests/fakes/`.** Considered. Would centralize the test-substitution logic, but `vi.mock` already does this per-test with less ceremony. Adoptable later if the test surface grows enough that ad-hoc mocking duplicates effort across files.
- **Convert just the gh ACL to interfaces, leave git/mcp as module imports.** Rejected: introduces inconsistency for no reason. The three ACLs have similar shapes and similar substitution needs; treating one specially without a forcing function adds cognitive load every time someone wonders "wait, why is gh different?"
