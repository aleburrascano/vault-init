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
