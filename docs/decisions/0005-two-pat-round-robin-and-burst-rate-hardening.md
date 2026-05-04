# ADR-0005: Two-PAT round-robin and burst-rate hardening in CI

**Status**: Accepted
**Date**: 2026-05-03 (v2.7.3, building on 2.7.1 burst reductions)
**Related rules**: [.claude/rules/testing.md](../../.claude/rules/testing.md)
**Builds on**: [ADR-0003](0003-gh-retry-four-way-failure-classification.md), [ADR-0004](0004-deleteRepo-via-gh-api-for-header-aware-retry.md)

## Context

vaultkit's test suite runs **live** against GitHub — `npm test` creates real ephemeral `vk-live-*` repos using a dedicated PAT account, then deletes them in `afterAll`. Mocked tests give command-shape coverage; live tests give "the real GitHub API actually accepts this argv" coverage. Without live tests, vaultkit shipped argv-shape regressions repeatedly (e.g. `gh repo edit --visibility` deprecation).

Live testing has two structural problems:

1. **GitHub's secondary rate limit and abuse detection.** A burst of repo creates / deletes / visibility flips from one PAT account in a short window trips secondary rate limits (~80 content-creating requests/minute) or, worse, lands the account in a **24–72h abuse-flag cooldown** during which every API call returns "Repository '<x>' is disabled. Please ask the owner to check their account." This actually happened on v2.7.0's Ubuntu CI leg.
2. **Race conditions on shared `~/.claude.json`.** Live tests mutate the registry; parallel test files race on the same file. Pre-v2.5.0 vaultkit used a `VAULTKIT_LIVE_TEST` env var to gate live tests, but the gate created a two-tiered test discipline (everyone runs mocked locally; live runs only in CI) which let live regressions slip through PR review.

The forces by v2.7.3:

- The classification + retry layer (ADR-0003) handles the *visible* rate-limit symptoms gracefully but doesn't *prevent* the abuse-flag from happening. Once flagged, all retries are wasted — the account is out for days.
- The CI run footprint matters: full Ubuntu + Windows matrix × pre-test cleanup × post-test cleanup × live tests = many gh API calls per push.
- vaultkit is a public npm package: a release blocked by a flagged test PAT delays user fixes.

## Decision

Five structural defenses, applied together:

1. **Two-PAT round-robin per CI run** ([.github/workflows/main.yml](../../.github/workflows/main.yml) "Select test PAT" step). Pick `VAULTKIT_TEST_GH_TOKEN_A` or `VAULTKIT_TEST_GH_TOKEN_B` via `GITHUB_RUN_NUMBER % 2` and export it as `GH_TOKEN`. Pre- and post-test orphan-cleanup steps sweep BOTH accounts. Halves per-account abuse-heuristic load.
2. **Live tests skip on Windows** via `liveDescribe` (in [tests/helpers/live-describe.ts](../../tests/helpers/live-describe.ts)). The 5 GitHub-touching live blocks (`init`, `destroy`, `connect`, `disconnect`, `visibility`) run only on the Ubuntu CI leg. Windows still gets the full mocked + check + build coverage. Cuts the matrix's per-tag-push burst from 2 legs to 1.
3. **`status` and `verify` live tests are local-only** via `makeLocalVault` (in [tests/helpers/local-vault.ts](../../tests/helpers/local-vault.ts)). They scaffold a vault in a tmp dir + (for `status`) a local bare git repo as `origin` — no GitHub round-trip. Removed ~20 GH-API calls per CI run.
4. **Single shared fixture across `connect` / `disconnect` / `visibility`** via [tests/global-fixture.ts](../../tests/global-fixture.ts). One `vk-live-shared-${pid}-${ts}` repo at suite start, torn down at suite end. The fixture-sharing live blocks read its name via `getFixtureName()` and reset to baseline in `beforeEach`. `init` and `destroy` stay self-contained because they ARE the create/delete paths.
5. **Vitest `fileParallelism: false`** so test files run sequentially against the shared `~/.claude.json` (covered separately in ADR-0006).

Net per CI run: ~3 `vk-live-*` repo creates (1 shared fixture + `init`'s + `destroy`'s) split across 2 PATs ≈ 1.5 per account averaged, down from ~7 in v2.7.0 all on one PAT.

## Consequences

**Easier:**
- A flagged PAT no longer blocks vaultkit releases — the round-robin keeps the other PAT cool.
- Local developer experience is honest: live tests run on every `npm test`, not gated by an env var. Argv-shape regressions are caught on the developer's machine, not at PR merge time.
- Adding a new live test now has a clear pattern: use `makeLocalVault` if no GitHub round-trip is genuinely needed; use `liveDescribe` + the shared fixture if the test reads/writes against an existing repo; only `init`/`destroy` create their own throwaway repos.

**Harder:**
- Operators (post-vaultkit-release pushes) must remember that re-runs of a failed run reuse the same `run_number` and therefore the same PAT. To flip to the other account, push a new commit. `VAULTKIT_TEST_PAT_LABEL` (`A`/`B`) is logged in the Actions UI so the operator can see which PAT is in play.
- The shared-fixture pattern requires `beforeEach` discipline: each consuming block resets the fixture to its baseline (re-clone if disconnected, re-set visibility to private). Documented in testing.md so the discipline doesn't drift.
- Cleanup invariants now span 4 layers (per-test `afterAll`, shared-fixture teardown via `globalSetup`'s reverse-order teardown, vitest `globalTeardown`, manual `npm run test:cleanup`). The complexity is justified by the cost of orphaned `vk-live-*` repos compounding across runs.

**Trade-offs accepted:**
- Two PAT secrets to manage and keep in sync. Acceptable because the alternative (one PAT + 24-72h flag-out windows) is materially worse for release velocity.
- Live tests don't run on Windows in CI. Acceptable because (a) Windows gets full mocked + build + check coverage on every run, (b) the live tests are GitHub-API correctness, not Windows-platform correctness — `findTool` Windows branches and platform paths are tested via mocked tests separately.
- The visibility live block is currently `describe.skip` (v2.7.4) because the available test PATs are Free-tier and visibility flips don't reliably stick. Acceptable trade against the alternative of buying a Pro plan for a test PAT solely to exercise one live block.

## Alternatives considered

- **Mock all live tests.** Rejected: the v2.7.0 argv-shape regressions slipped past mocked tests. Live coverage is the only place that catches "the gh CLI doesn't accept this argv anymore."
- **One PAT + manual operator wait when flagged.** Rejected: 24-72h windows are unacceptable for a public package's release cadence.
- **Run live tests only on tag-push, not every PR.** Rejected (post-v2.7.1 unification): pre-v2.7.1 had a similar split — `ci.yml` (PR matrix) + `release.yml` (tag-only with live tests + `npm publish`) — and v2.7.0 shipped a green Release while CI was red. The fix was unifying both into one `main.yml` with `publish` requiring `needs: test`. We accept the live-test cost on every push as the price of consistency.
- **Use GitHub Apps with bigger rate-limit budgets.** Rejected for now: PATs are simpler, the round-robin is sufficient at current scale, and a GitHub App would need its own infrastructure (secrets rotation, app installation per test repo).
