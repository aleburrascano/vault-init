# ADR-0011: vaultkit owns the per-vault MCP — drops obsidian-mcp-pro and the global vaultkit-search MCP

**Status**: Accepted
**Date**: 2026-05-04
**Related rules**: [.claude/rules/architecture.md](../../.claude/rules/architecture.md), [.claude/rules/domain-language.md](../../.claude/rules/domain-language.md), [.claude/rules/security-invariants.md](../../.claude/rules/security-invariants.md)
**Supersedes**: [ADR-0010](0010-bm25-search-mcp.md) (BM25 search MCP shipped as a separate global server).
**Related**: [ADR-0001](0001-launcher-byte-immutability-and-sha-pin.md) (per-vault launcher byte-immutability — preserved unchanged).

## Context

Two weeks after ADR-0010 shipped, while validating the search MCP against real friend-and-teacher use cases, the design choice was re-examined under a sharper framing: **the consumer of every vault tool is Claude, not the human.** vaultkit's CLI surface is for the human (manage vaults). The MCP surface is for Claude (use vault content). ADR-0010 split search into a *separate* global MCP because that was the smallest delta from the existing per-vault `obsidian-mcp-pro` setup. But that choice asked Claude to reason about two MCPs per session (one for reading content, one for searching) and added meaningful weight to every user's machine.

Two corrections to ADR-0010's accounting pushed a reset:

- **The footprint was 3.5x heavier than ADR-0010 estimated.** Re-measured: `better-sqlite3` ~12 MB native binary (not ~6 MB), `@modelcontextprotocol/sdk` ~5.6 MB (not ~1 MB), `zod` ~5.9 MB (not "already transitive"). Total search-related runtime weight was ~24 MB, not the 7 MB the ADR claimed. For a friends-and-teachers audience where install size is part of the trust contract, that's unacceptable.
- **`node:sqlite` is no longer experimental-flag-gated.** ADR-0010 rejected `node:sqlite` as "experimental flag-gated until Node 24+". The flag was removed in Node 22.13.0 (December 2024). It ships with Node, has FTS5 + BM25 built in, is synchronous (same shape as `better-sqlite3`), and is actively maintained by the Node core team. Zero npm dependency for the search engine.

The combination unlocked a different shape: **one MCP per vault, owned end-to-end, with search as a tool on it rather than a separate registration.** This is what users get with this ADR.

## Decision

**Replace `obsidian-mcp-pro` as the per-vault launcher's spawn target with vaultkit's own MCP server.** The per-vault launcher (`lib/mcp-start.js.tmpl`, byte-pinned per ADR-0001) keeps its safety properties unchanged — only the binary it spawns changes from `npx -y obsidian-mcp-pro` to `vaultkit mcp-server --vault-dir <path>`. Search becomes one of six tools on this server, not a separate MCP. The global `vaultkit-search` registration and its byte-pinned `~/.vaultkit/search-launcher.js` are retired.

Concrete shape:

- **One MCP per vault.** Same registration shape as today (one entry in `~/.claude.json#mcpServers` per vault, byte-pinned launcher). The launcher's spawn target changes; nothing else.
- **`vaultkit mcp-server` subcommand** ([src/commands/mcp-server.ts](../../src/commands/mcp-server.ts)) is the long-running daemon. Reverse-looks-up the vault name from the registry by directory, opens the shared search index, registers six tools, and serves stdio until the launcher exits.
- **Hand-rolled JSON-RPC 2.0 stdio MCP** ([src/lib/mcp-stdio.ts](../../src/lib/mcp-stdio.ts), ~250 LOC). Replaces `@modelcontextprotocol/sdk`'s `McpServer` + `StdioServerTransport`. Implements the minimum surface Claude Code uses: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`. Tool exceptions surface as `{isError: true, content}` per the spec; protocol-level errors follow JSON-RPC `-32601` / `-32602` / `-32603`.
- **Hand-rolled input validator** ([src/lib/json-rpc-validator.ts](../../src/lib/json-rpc-validator.ts), ~60 LOC). Replaces `zod` for tool argument shape-checking.
- **Six tools, designed for Claude** (under [src/mcp-tools/](../../src/mcp-tools/)):
  - `vk_search(query, vault?, top_k?)` — BM25 + title-weighting (5x/3x/1x). The bug-fixing tool.
  - `vk_list_notes(vault?, prefix?, limit?)` — filesystem walk via the indexer's existing `_walkMarkdown`.
  - `vk_get_note(path, vault?)` — frontmatter + outline + body decomposition. Path-traversal-defended.
  - `vk_get_tags(vault?)` — distinct tags via `SearchIndex.listTags`.
  - `vk_search_by_tag(tag, vault?, limit?)` — `SearchIndex.notesByTag`.
  - `vk_recent_notes(vault?, limit?)` — filesystem walk + mtime sort.
  Each tool's description and output shape are tuned for Claude's context budget. Each defaults to scoping by the current vault; pass `vault: "*"` for cross-vault, or a specific vault name to scope to one. Cross-vault search via the `vault?` arg replaces the previous design's separate global MCP.
- **`node:sqlite` (Node ≥22.13)** as the search engine. Same SQLite, same FTS5, same BM25, same `(5, 3, 1)` column weights, same `~/.vaultkit-search.db` schema and path as ADR-0010 — just bound by Node core instead of the `better-sqlite3` native add-on. WAL mode preserved for concurrent indexer-vs-MCP-reader access.
- **Migration UX**: `vaultkit setup` step 6 cleans up legacy state — removes the `vaultkit-search` MCP entry, deletes `~/.vaultkit/search-launcher.js`, **keeps `~/.vaultkit-search.db`** intact (every per-vault MCP server reads from it). For each existing vault, users run `vaultkit update <name>` once to re-pin the launcher SHA (the launcher's bytes changed from "spawn `obsidian-mcp-pro`" to "spawn `vaultkit mcp-server`"). The existing `vaultkit update` command handles re-pinning without modification.
- **Drops** as runtime dependencies: `better-sqlite3` (~12 MB native binary), `@modelcontextprotocol/sdk` (~5.6 MB), `zod` (~5.9 MB). Drops `obsidian-mcp-pro` from npx-cached install (~12 MB with deps).
- **Drops** from the codebase: `bin/vaultkit-search-server.ts`, `lib/search-launcher.js.tmpl`, `src/lib/search-mcp.ts`, the second `vaultkit-search-server` `bin` entry in `package.json`. Test pairs: `tests/lib/search-mcp.test.ts`, `tests/lib/search-launcher-integration.test.ts`.
- **`node` engine floor bumps from `>=22` to `>=22.13`.** Node 22.13 was released December 2024; almost every Node 22 user is past the floor.

## Consequences

**Easier:**
- **One MCP per vault, end-to-end ownership.** Bug fixes ship in vaultkit's npm releases — no upstream PR coordination with `obsidian-mcp-pro`. Tool descriptions, output formats, and parameter shapes are tunable for Claude specifically.
- **Net mass on the user's machine drops by ~36 MB** vs. ADR-0010's shipped state, ~12 MB vs. the pre-search baseline (the implicit `obsidian-mcp-pro` npx cache). vaultkit + Node.js stdlib is the entire footprint. No native binaries → no platform-specific install failures.
- **Discoverability is preserved.** Claude in any vault session sees the per-vault MCP's tools auto-loaded by Claude Code. Search is just another tool on that surface, not a CLI Claude has to know about.
- **Cross-vault search preserved.** `vk_search(query, vault: "*")` searches across every registered vault from any vault's MCP — the `vault?` argument replaces what ADR-0010 had as a separate global MCP.
- **Search ranking identical to today** because both `better-sqlite3` and `node:sqlite` bind the same SQLite library. Users on the previous build see no behavioral drift in `vk_search` results.
- **Easily extensible.** Adding a 7th tool is one new file under `src/mcp-tools/<name>.ts` and one registration line in `index.ts`. Same release cadence as the rest of vaultkit.

**Harder:**
- **vaultkit now owns the entire vault-MCP surface.** `obsidian-mcp-pro`'s long-tail tools (canvas reading, link-graph extraction, daily-note helpers, write tools) are dropped in v1. The realistic impact for a friends-and-teachers audience is near-zero — they list, get, and search; they don't read canvases programmatically. Signal-driven re-additions can land later if real users hit the gap, but each one becomes vaultkit's perpetual maintenance.
- **Hand-rolled JSON-RPC stdio is forever maintenance.** ~250 LOC we own. Justified by the ~5.6 MB savings on every install plus the ability to tune the protocol surface for Claude specifically (e.g., token-optimized error messages, structured frontmatter/outline/body separation in `vk_get_note`).
- **Existing-user migration cost.** Every existing vault needs `vaultkit update <name>` once to re-pin its launcher SHA. The path is automatic but not silent — users will see one prompt per vault. For our audience size (5-20 users with 1-3 vaults each) this is a few minutes of one-time interaction, comparable to a normal vaultkit upgrade.
- **`node:sqlite` carries an "experimental" warning at startup.** It's a forward-compatibility label (the API may change in future Node versions), not an implementation-stability concern. The warning is one line on stderr per MCP session start. Suppressing it would require either a global warning override (heavy hammer) or bumping the Node floor again to a future stable release. Acceptable as-is.
- **Replacing `obsidian-mcp-pro` is irreversible without another migration.** If we regret the choice, "go back to `obsidian-mcp-pro`" requires another launcher SHA churn for every user. Mitigated by Phase 0 prototypes that validated the underlying decisions before commits landed (FTS5 + BM25 ranking, hand-rolled MCP-over-stdio compatibility with Claude Code).

**Trade-offs accepted:**
- **The `experimental` label on `node:sqlite`** is real but low-stakes for vaultkit. The Node core SQLite implementation is mature; what's experimental is the API stability guarantee. We accept that a future Node version may rename `DatabaseSync` or add stricter parameter typing, in which case `src/lib/search-index.ts` is a one-file edit.
- **No write tools on the new MCP surface.** Claude already has `Edit`, `Write`, and `Bash` for direct vault edits — exposing duplicate tools through MCP would just split decision authority. Users who want template-driven note creation can build it as a vaultkit subcommand rather than an MCP tool.
- **Cross-vault search returns mixed results from one tool call** — Claude has to interpret "vault" labels in the response to know which vault each hit came from. The output format makes this explicit (every hit lists `vault:` and `path:`). This was already the contract under ADR-0010.

## Alternatives considered

- **Keep ADR-0010's shape but slim the engine.** Considered: `MiniSearch` (~0.8 MB pure JS) or `sql.js-fts5` (~1.5 MB WASM SQLite). Rejected: with `node:sqlite` available unflagged, neither pays its weight. MiniSearch also has subtle ranking differences from FTS5 BM25 that would create migration risk. `sql.js-fts5` is a stale 2022 single-maintainer fork — less solid than `node:sqlite`'s Node-core maintenance.
- **Wrapper MCP that proxies obsidian-mcp-pro.** A vaultkit-owned MCP that spawns `obsidian-mcp-pro` as a subprocess and intercepts/replaces the broken `search_notes` tool while passing everything else through. Rejected: doesn't reduce mass (we still ship `obsidian-mcp-pro` via npx), adds proxy complexity that's hard to test, and gives us none of the token-optimization wins of owning the surface. The whole point of replacing `obsidian-mcp-pro` was to own the tool descriptions and output shapes.
- **Drop the search MCP and ship `vaultkit search` as a CLI subcommand only.** Rejected because the consumer is Claude — pushing search to Bash means asking Claude to discover a CLI rather than auto-loading an MCP tool. The friend's failure mode (search bug discovered in another project's Claude session) is exactly the discoverability case CLI-only fails to solve cleanly.
- **Recommend a third-party Obsidian MCP** (e.g., mcpvault). Rejected for the same reasons ADR-0010 rejected it: maintenance trajectory of small forum-thread MCPs is unclear, breaks the "one `npm i -g`" install promise, and gives us no control over the tool surface or upgrade cadence.
- **Add semantic / embedding search on top of BM25.** Rejected unchanged from ADR-0010: ships ~25–117 MB of model weights, requires warm-up, locks us into a model trajectory we'd have to maintain. BM25 + title weighting handles the failure mode (and ~80% of natural-language queries) at zero dependency cost. ADR-0010's "trigger to revisit" language carries forward.

## Trigger to revisit

This ADR commits to vaultkit-owned MCP + `node:sqlite` + 6 tools. A future ADR may supersede it if:

- **Long-tail tools become missed at the user level.** If real friends-and-teachers usage signals demand for canvas reading, link-graph traversal, or daily-note helpers, add them targeted (one tool at a time) — not by re-introducing `obsidian-mcp-pro`.
- **Vault sizes grow past the per-process WAL-readability budget** (likely 50K+ notes per vault, well beyond current usage). At that scale we'd evaluate moving the search index to a multi-process daemon rather than reading from per-vault MCP servers.
- **The `node:sqlite` API breaks unexpectedly** in a future Node version. The `SearchIndex` class wraps the API behind a stable interface, so the swap is one file. The trigger here is "we got bitten by an experimental-API change," not "the warning bothers users."
- **MCP protocol version negotiation tightens** in a way our hand-rolled implementation can't keep up with. Today's surface (initialize / tools/list / tools/call) is stable across the 2025-06-18 and 2025-11-25 specs; if a future spec introduces required server-side notifications we don't currently emit, we'd revisit by either implementing them in `mcp-stdio.ts` or returning to the SDK.
