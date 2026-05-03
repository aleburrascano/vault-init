# Roadmap

Things known but not yet done. Append-only — when an item ships, move it to the appropriate `## [X.Y.Z]` section in [CHANGELOG.md](../CHANGELOG.md) and remove it here.

## Public sample vault — `aleburrascano/vaultkit-demo`

A small, public, deliberately curated example vault that fresh users can `vaultkit connect aleburrascano/vaultkit-demo` to and immediately query from Claude Code. Closes the largest narrative-to-experience gap in the README — right now the connection model is described abstractly, with no working public exemplar.

Shape:
- 3–5 wiki pages in `wiki/concepts/` and `wiki/topics/` covering things vaultkit users actually care about (Obsidian + Claude Code workflow notes, knowledge-graph patterns, MCP basics).
- 1–2 `raw/` sources to demonstrate the source-vs-synthesis split.
- Public Quartz site so non-Claude users see what the published rendering looks like.

Bootstrap (now that `vaultkit init --mode public` exists per v[Unreleased]):
```bash
vaultkit init vaultkit-demo --mode public
# add curated content under wiki/ and raw/
cd ~/vaults/vaultkit-demo
git add -A && git commit -m "seed: initial sample content" && git push
```

Once it exists, add a one-liner to README's Quick Start or "What you'd use this for":

```markdown
**Try it without committing**: `vaultkit connect aleburrascano/vaultkit-demo`
opens a small example wiki in Claude Code so you can see search_notes /
get_note in action against real content before creating your own.
```

## Live-test CI: residual mitigations

The 2026-05-02 abuse-flag incidents (PAT `fluids2` flagged for ~24-72h after v2.7.0's tag-push burst; new PAT flagged within minutes after the first 2.7.1-attempt CI run) were addressed across two patches in 2.7.1:

1. Merged `ci.yml` + `release.yml` into a single `main.yml` that gates `npm publish` on the full Ubuntu+Windows matrix.
2. Header-aware retry in `ghJson`: parses `X-RateLimit-*` / `Retry-After` from `gh api --include`, classifies failures into transient / rate-limited / auth-flagged / fatal. `Repository ... is disabled` short-circuits to `VaultkitError('AUTH_REQUIRED')` instead of burning the retry budget.
3. Same disabled-repo recognition in `pushNewRepo` and `pushOrPr` (git-push path).
4. **Burst reduction:** live tests skip on Windows via `liveDescribe` (5 GitHub-touching blocks run only on Ubuntu); `status` and `verify` converted to local-only via `makeLocalVault` (local bare git repo as `origin` for `status`, no remote for `verify`). Net: from ~14 live-test repo creates per tag push (7 × 2 matrix legs) down to ~5, all on Ubuntu only.

Done in 2.7.3:
- **Two-PAT round-robin in CI.** `main.yml` selects `VAULTKIT_TEST_GH_TOKEN_A` / `_B` per run via `GITHUB_RUN_NUMBER % 2`, fail-closed if the chosen secret is missing. Pre- and post-test orphan cleanup sweeps both accounts. The legacy `VAULTKIT_TEST_GH_TOKEN` secret was dropped (no fallback — silent fallback would mask config drift). Operator note: re-runs of a failed run reuse the same `run_number` and therefore the same PAT; push a new commit to flip to the other account.
- **Shared fixture for `connect`/`disconnect`/`visibility` live tests.** `tests/global-fixture.ts` (vitest globalSetup) creates one `vk-live-shared-*` repo at suite start; the three live blocks reset it to baseline in `beforeEach` and reuse it. Drops per-CI-run creates/destroys from 5 → 3. `init`/`destroy` stay self-contained because the test IS the create/delete path.

Residual mitigations to consider if flake recurs:
- **Stop running live tests on every push.** If rotation + fixture-sharing still aren't enough, gate live tests to tag-pushes and PRs that touch `src/lib/github.ts` or `src/commands/{init,destroy,connect,disconnect,visibility}.ts`. Big drop in throughput, modest signal loss.
- **Add a Pro test PAT to re-enable the live visibility test.** As of 2.7.4 the `live: visibility toggles real GitHub repo` block is `describe.skip` because the Free-tier test PATs (`fluids2`, `aleburrascano-alt`) cannot reliably be flipped to public — PATCH returns 200 but the change doesn't stick, surfacing as Pages-auth 422 rejections downstream. A Pro PAT (GitHub Education pack / OSS Pro grant / paid account) used as a third secret + opt-in would re-enable end-to-end coverage of the public/auth-gated paths. Until then, the 14 mocked describes in `visibility.test.ts` are the only source of truth for that command's logic.

Symptom to watch for: `Repository ... is disabled` in CI logs even after rotation + fixture-sharing land — that would suggest GitHub's heuristic is keying on the runner-pool IP range or org-level history, not just per-account, and the per-push gating above is the right next move.
