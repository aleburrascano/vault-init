# ADR-0010: BM25 search MCP shipped with vaultkit

**Status**: Accepted
**Date**: 2026-05-04
**Related rules**: [.claude/rules/architecture.md](../../.claude/rules/architecture.md), [.claude/rules/domain-language.md](../../.claude/rules/domain-language.md)
**Supersedes**: nothing — first concrete commitment to vault search.

## Context

A user (let's call them Friend A) installed `obsidian-mcp-pro` on their laptop, registered an Obsidian vault, then asked Claude inside another project to search the vault for "claude code context token optimization CLAUDE.md". Four searches in a row returned zero hits, and Claude bailed — even though notes literally titled "Token Efficiency" and "Context Engineering" existed in the vault. The MCP's `search_notes` tool turned out to be **literal substring matching**, and the tool description didn't loudly warn against multi-word natural-language queries. Claude's default phrasing met the tool's worst-case input shape and found nothing.

The class of problem: every vaultkit user is one bad query away from this same dead-end. obsidian-mcp-pro is fine for file ops; its search behavior is the bottleneck. Three response options were considered:

1. **Tell users to phrase queries differently** — push a "use 1-3 word queries, prefer `list_notes` first" rule into every user's `~/.claude/CLAUDE.md`. Rejected: invasive for a distributed CLI; doesn't scale to N users.
2. **Recommend a different external MCP** — e.g. Obsidian Hybrid Search, which combines BM25 + fuzzy + semantic. Rejected: the bundled `multilingual-e5-small` model adds ~117 MB to user installs and the maintenance trajectory of small forum-thread MCPs is unclear.
3. **Ship search ourselves**, scoped to vaultkit-managed vaults — own the tool surface, own the dependencies, own the UX.

The user's stated constraints: "lightweight version that requires no cost on my end and nothing of the user." Pure-semantic embeddings were rejected upstream as RAG-flavored (defeats Obsidian's structural value); fuzzy-only doesn't fix paraphrase. The Obsidian-native answer is **BM25 with weighted fields** — it's basically how Obsidian's own search works, and it handles ~80% of natural-language queries by partial keyword overlap with title boosting.

## Decision

**Ship a BM25 search MCP server inside vaultkit, registered globally by `vaultkit setup`, indexed transparently by the existing lifecycle hooks.**

Concrete shape:

- **One global MCP server** registered as `vaultkit-search` in `~/.claude.json#mcpServers`. Not per-vault — keeps the registry clean and gives cross-vault search for free.
- **SQLite FTS5** at `~/.vaultkit-search.db`. Schema: `notes(vault, path, title, tags, body)` with BM25 weighting `(5, 3, 1)` — title 5x, tags 3x, body 1x. Title weighting is what fixes the friend's failure mode: a query `token optimization` against a note titled `Token Efficiency` ranks the title-bearing note highly even when the body never mentions "optimization."
- **Multi-token queries are OR-joined** after stripping FTS5 operators. AND semantics would recreate the original substring-finds-nothing failure mode (multi-word → must match all terms → zero hits). OR with BM25 ranking: any partial match returns; full-term matches rank highest.
- **Two tools exposed**: `vk_search(query, vault?, top_k?)` and `vk_list_vaults()`. `get_note` stays in obsidian-mcp-pro / per-vault MCPs — no overlap.
- **Byte-immutable launcher template** (`lib/search-launcher.js.tmpl`), copied to `~/.vaultkit/search-launcher.js`, SHA-pinned in the registry entry. Same threat model as ADR-0001 for the per-vault launcher: tampering refuses to start.
- **The actual MCP server** is a separate `bin` entry in vaultkit's `package.json` (`vaultkit-search-server`). The launcher self-verifies its hash, then `npx`-spawns the server. Keeping the heavy logic out of the byte-immutable launcher means we can iterate freely on search behavior without invalidating existing pin SHAs.
- **Lifecycle hooks**: `init` indexes new vaults; `update` re-indexes after layout reconcile; `pull` re-indexes every successfully-pulled vault (one DB open per pass); `destroy` and `disconnect` purge vault rows. All best-effort — failures log a warning but never block their host command (search is value-add, not critical-path).
- **Runtime dependencies added**: `better-sqlite3` (~6 MB binary, prebuilds for Windows/macOS/Linux), `@modelcontextprotocol/sdk` (~1 MB pure JS), `zod` (already transitive via the SDK; promoted to a direct dep). vaultkit's runtime deps go from 5 to 8.

## Consequences

**Easier:**
- Friend A's failure mode goes away for every vaultkit user with no per-user config. Run `vaultkit setup` once → search works in every Claude Code session in every project.
- Cross-vault search "just works" because the index is global. No per-vault MCP registration ceremony for users with multiple vaults.
- The tool surface is owned by us — bug fixes ship in vaultkit's npm releases, no waiting on upstream MCP authors.
- Indexing is transparent: every command that mutates vault content already runs the indexer as a best-effort tail step. Users don't need to know the index exists.
- BM25 + title weighting handles the most common natural-language failure modes (paraphrase via partial keyword overlap, missing words tolerated, title hits dominate). No embeddings required.

**Harder:**
- Three new runtime dependencies. `better-sqlite3` is a native binding — slower install than pure-JS deps, depends on prebuilds. The win is significant FTS5 performance and a proven query path; the alternative (Node 22's experimental `node:sqlite`) was rejected for stability reasons but stays a future migration path.
- Permanent maintenance of an indexing pipeline, a SQLite schema, and a byte-immutable launcher template. The launcher's SHA-pinned bytes are an immutability invariant we now own (mirrors ADR-0001's invariant for the per-vault launcher).
- One more `bin` entry (`vaultkit-search-server`) to keep working across Windows/macOS/Linux. The npm bin shim handles `.cmd` wrapping on Windows; tested locally.
- Build-pipeline complexity grows slightly: `scripts/post-build.mjs` now copies one more template into `dist/lib/` and chmod-s one more bin to 0o755 on Unix.

**Trade-offs accepted:**
- We ship 7 MB of bundled dependencies (better-sqlite3 binary + SDK + zod) instead of asking users to install one Obsidian MCP separately. Worth it because vaultkit's distribution model is "one npm install" — adding a second install step would invalidate that promise.
- BM25 alone won't catch true paraphrase ("efficiency" vs "optimization"). Friend A's specific case lands fine because "token" appears in both query and title; for queries with zero lexical overlap with the target title, BM25 misses. Acceptable: ~80% accuracy without RAG-flavored embeddings beats the current 0%.
- Search is best-effort everywhere. A failure during `init`'s indexing logs a warning but doesn't fail the init. Rationale: search is value-add — a vault that exists but isn't searchable yet is strictly better than a vault that didn't get created at all.
- The index is per-user only. No cross-user / shared-index story. vaultkit's threat model has the home directory as the trust boundary (per ADR-0001), and a shared index would punch a hole through it.

## Alternatives considered

- **Pure-semantic search (embeddings).** Rejected: defeats the structural value of Obsidian (wikilinks, tags, frontmatter, deliberate titles). If you're querying by cosine similarity over opaque text blobs, you didn't need Obsidian — you could've thrown PDFs in a vector DB. Plus: requires an embedding model (~25 MB ONNX with `all-MiniLM-L6-v2`, or 117 MB for multilingual variants), adds a warm-up cost on first query, and locks us into a model trajectory we'd have to maintain.
- **Fuzzy-only (trigram / Levenshtein).** Rejected: fuzzy handles typos and word-form variation (`idempotent` → `Idempotency`) but not paraphrase (`token optimization` → `Token Efficiency`). The friend's failure mode was paraphrase, not typo.
- **Hybrid Search MCP** (Obsidian Forum, March 2026). Considered. BM25 + fuzzy + semantic in one ranked result set, bundled `multilingual-e5-small` model. Rejected because (a) ~117 MB one-time download is friction for friends/teachers who care about install size; (b) maintenance is unclear (single forum post, recent but uncertain trajectory); (c) we don't control the tool surface or upgrade cadence; (d) shipping our own keeps everything in vaultkit's release cycle.
- **Recommend Hybrid Search in vaultkit's README.** Considered. Zero code from us, ~117 MB cost to users. Rejected because vaultkit's distribution promise is "one `npm i -g` and one `vaultkit setup`" — adding a second `npm i -g` for an external MCP breaks that.
- **Push a vault-search rule into every user's global CLAUDE.md.** Considered. Zero code, zero install. Rejected because invasively editing users' personal global config from a CLI is the wrong shape, even with consent. Doesn't scale beyond a small audience.
- **Per-vault search MCPs (one per vault).** Rejected: doubles the registry entry count (10 MCPs for 5 vaults), eliminates cross-vault search, and adds per-vault registration ceremony. The single global MCP gets all the wins for free.
- **Embedding the launcher in `vaultkit-search-server` itself (one `bin`, no separate launcher).** Rejected: ADR-0001 requires byte-immutability for security-pinning; bundling launcher + server into one TypeScript-compiled binary means every `tsc` upgrade churns the SHA. Separating them keeps the launcher template a few hundred bytes of plain JS that survives compiler upgrades.
- **Use Node 22's experimental `node:sqlite` instead of `better-sqlite3`.** Rejected for now — `node:sqlite` is experimental flag-gated until Node 24+, and many vaultkit users will be on 22 or 23. Migration stays open: the `SearchIndex` class wraps SQLite calls behind a stable interface, swapping the underlying driver is a one-file change.

## Trigger to revisit

This ADR commits to BM25-only search. A future ADR may supersede it if:

- **Vault sizes grow past ~5K notes per user.** BM25 + brute-force scan is O(N) on every query. Today vaults are ~100-500 notes — query latency is microseconds. At 5K, latency stays under 10 ms; at 50K, it crosses 100 ms and the user would notice. At that point, pre-computed inverted indexes (which FTS5 already does internally) might still be enough; if not, a vector index becomes worth the dependency cost.
- **A real semantic-search use case emerges.** The current bet is that vaultkit users curate enough structure (titles, tags, links) that BM25 + title weighting handles the long tail. If we see real queries failing in production that BM25 can't catch even in principle, we'd revisit — likely by ADD-ing a `vk_semantic_search` tool alongside `vk_search` rather than replacing.
- **Cross-user / shared-vault indexes become a feature.** Today the index is per-user, mirroring vaultkit's home-directory trust boundary. A shared-index story would need its own ADR (different threat model entirely).
