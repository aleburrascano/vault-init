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

The 2026-05-02 abuse-flag incident (PAT `fluids2` flagged for ~24-72h after v2.7.0's tag-push burst) was addressed in 2.7.1 by:
- Merging `ci.yml` + `release.yml` into a single `main.yml` that gates `npm publish` on the full Ubuntu+Windows matrix, halving the per-tag-push GitHub-API burst.
- Header-aware retry in `ghJson`: parses `X-RateLimit-*` / `Retry-After` from `gh api --include` responses, classifies failures into transient / rate-limited / auth-flagged / fatal, and reacts appropriately. `Repository ... is disabled` short-circuits to `VaultkitError('AUTH_REQUIRED')` instead of burning the retry budget.
- Same disabled-repo recognition in `pushNewRepo` and `pushOrPr` (git-push path).

Residual mitigations to consider if flake recurs:
- **Reduce per-CI-run repo count.** Today each live test creates + deletes its own `vk-live-${COMMAND}-${Date.now()}` repo. Tests that only need a remote to push to (visibility / status / verify / refresh) could share a single `vk-live-shared-${runId}` repo. Cuts create count from ~7 to ~4 per matrix slot.
- **Rotate the test PAT account periodically.** GitHub may keep heuristic memory of an account that has previously been flagged; a fresh PAT roughly every 6 months is cheap insurance.

Symptom to watch for: `Repository ... is disabled` in CI logs even after waiting through a flag-clear window — that would suggest the account has accumulated heuristic weight and is worth rotating.
