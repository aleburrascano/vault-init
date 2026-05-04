# ADR-0006: Vitest `fileParallelism: false` for shared-state safety

**Status**: Accepted
**Date**: 2026-04 (v2.5.0, when the `VAULTKIT_LIVE_TEST` env-gate was removed)
**Related rules**: [.claude/rules/testing.md](../../.claude/rules/testing.md)
**Related ADRs**: [ADR-0005](0005-two-pat-round-robin-and-burst-rate-hardening.md)

## Context

vaultkit's live tests mutate shared state in two places:

- **`~/.claude.json`** — the user-home MCP registry. `vaultkit init`, `connect`, `disconnect`, `destroy`, and `update` write to it. Multiple test files writing concurrently race on the same file: a successful write from one test can be partially overwritten by a later read-then-write from another, leaving the registry in an inconsistent state mid-suite.
- **GitHub repos under the test PAT account.** Two test files trying to create the same `vk-live-*` name conflict; even disjoint names increase per-account burst rate (see ADR-0005).

Vitest's default behavior is to run test files in parallel across workers. That's correct for pure-unit-test suites but actively dangerous for vaultkit's live + mocked-with-real-fs mix. Pre-v2.5.0 the `VAULTKIT_LIVE_TEST` env var gated live tests on/off and the suite ran parallel because mocked tests don't share `~/.claude.json` state — that worked but created a two-tiered discipline (developers run mocked locally, live runs only in CI). v2.5.0 dropped the gate to make `npm test` honestly always-live. With the gate gone, parallelism is no longer safe.

## Decision

Set `fileParallelism: false` in [vitest.config.ts](../../vitest.config.ts). Test files run sequentially in a single vitest worker. Within a file, vitest still parallelizes individual `it()`s by default unless they share state — so well-isolated unit tests within a file are still concurrent.

The configuration also includes:

- `testTimeout: 15_000` — most tests complete in <2s; the budget covers GitHub API latency on CI.
- `hookTimeout: 60_000` — `beforeAll`/`afterAll` setup + cleanup (especially live-test teardown that destroys real repos) needs longer.
- `globalSetup: ['tests/global-teardown.ts', 'tests/global-fixture.ts']` — vitest runs setup in array order, teardown in REVERSE array order. The order here is intentional: `global-fixture`'s teardown destroys the shared `vk-live-shared-*` repo BEFORE `global-teardown`'s registry sweep would otherwise strip its entry. See ADR-0005 for the shared-fixture context.

## Consequences

**Easier:**
- `~/.claude.json` writes from live tests don't race. The registry's invariant (atomic `<path>.tmp` + rename writes) still holds across the suite.
- The 4-layer cleanup invariants from ADR-0005 are reasonable to reason about because there's no concurrent test pulling the rug.
- A single failing test produces a clean failure trace instead of a confused "two files raced and one corrupted the other's setup" symptom.

**Harder:**
- Wall-clock test time is roughly 2× longer than parallel would be. Acceptable: the suite runs in ~3 minutes on CI, which is well under any human-attention threshold.
- Adding a genuinely parallel-safe test file doesn't get the speedup. Acceptable: the parallelism dial is a global vitest setting; per-file opt-in to parallelism would require a different test-runner architecture (e.g. multiple suites with different configs), which is more complexity than the time saved warrants.

**Trade-offs accepted:**
- Sequential execution makes a slow GitHub API call hold up the entire suite. The ADR-0003 retry layer mitigates this by capping retry budgets; a genuinely-broken endpoint surfaces as a fast `fatal` rather than a 31s transient hang on every call.
- We deliberately accept that pure-unit-test files (e.g. `tests/lib/template-paths.test.ts`) pay the sequential cost despite not needing it. Reverting the choice for individual files would erode the safety property by accumulating exceptions.

## Alternatives considered

- **`fileParallelism: true` + per-test-worker `~/.claude.json` via `HOME=` override.** Rejected: vaultkit's commands hard-code `~/.claude.json` resolution via `claudeJsonPath()` reading `HOME`/`USERPROFILE`. Overriding HOME per-worker works, but every test that exercises a `claude` CLI subprocess (which itself reads `~/.claude.json`) needs the env override to propagate — fragile and error-prone vs. the obvious "run sequentially."
- **Move to a different test runner with first-class isolation per worker.** Rejected: vitest is well-served by every other dimension (TS-native, fast cold start, vi.mock ergonomics). Switching for this single property is disproportionate.
- **Drop live tests, rely on mocked tests + CI-only smoke run.** Rejected (see ADR-0005): the mocked-only era let argv-shape regressions slip; live tests caught them.
- **Per-file `vi.config` opt-in to parallelism.** Rejected: vitest's `fileParallelism` is a global setting at this version. Even if it weren't, the safety property is about the *whole suite*, not individual files — a single parallel-safe file doesn't change the overall race exposure if it lands next to a parallel-unsafe one.
