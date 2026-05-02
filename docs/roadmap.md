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

## Live-test CI: stop tripping GitHub's abuse heuristics

On 2026-05-02 the `fluids2` test PAT's account was abuse-flagged after a burst of `vk-live-*` create/delete cycles across four Release attempts plus parallel CI runs. The test repos surfaced as `Repository ... is disabled` (HTTP 403) and the account stayed flagged for ~24–72h. Pre-existing mitigations (matrix `max-parallel: 1`, the `vaultkit-live-tests` concurrency group, pre/post-test orphan cleanup) help within a single workflow but don't help when many workflows fire in close succession.

**Source of truth for the fix surface:** [`gh api` reference](https://cli.github.com/manual/gh_api). The fix likely involves replacing the `gh repo create` / `gh repo delete` wrappers in [src/lib/github.ts](../src/lib/github.ts) with direct `gh api` calls so we can:
- Read `X-RateLimit-Remaining` / `X-RateLimit-Reset` response headers and back off proactively before GitHub flags us.
- Use the secondary rate-limit retry pattern (`Retry-After` + 60s baseline) per GitHub's documented abuse-rate-limit guidance.
- Reduce the per-test create/delete count — e.g., one shared sandbox repo per CI run that all tests reuse, instead of N timestamp-suffixed repos.

Symptom to watch for: any `gh` command output containing `Repository ... is disabled`, `secondary rate limit`, or unexplained 403 on a freshly-created repo. When the next burst-failure pattern surfaces, this is the work to do.
