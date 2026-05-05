# Phase 0 findings — vaultkit MCP rework validation

**Date**: 2026-05-04
**Plan**: [`~/.claude/plans/i-want-to-rework-encapsulated-whistle.md`](../../../.claude/plans/i-want-to-rework-encapsulated-whistle.md)

## TL;DR

Both gates pass. Material course-correction: **drop `sql.js-fts5` from the plan and use `node:sqlite` instead** (built into Node 22.13+, zero npm dependency). All other plan elements stand; the plan gets *simpler*, not more complex.

## P1 — Hand-rolled JSON-RPC stdio MCP server

**Status:** PASS at protocol level. Real Claude Code session validation deferred to Phase 2 end-to-end test.

- Prototype: [`mcp-prototype.mjs`](mcp-prototype.mjs) (74 lines).
- Test driver: [`test-mcp-prototype.mjs`](test-mcp-prototype.mjs).
- 16/16 protocol-shape assertions pass against the [MCP 2025-11-25 spec](https://modelcontextprotocol.io/specification/2025-11-25):
  - `initialize` returns `protocolVersion`, `capabilities.tools`, `serverInfo`.
  - `notifications/initialized` correctly produces no reply.
  - `tools/list` returns the tool array with `inputSchema`.
  - `tools/call` returns `content[].text` with `isError: false`.
  - Unknown tool name and unknown method both return `error` responses with `id` echoed.
- **Cleared to drop `@modelcontextprotocol/sdk`** (~5.6 MB) — protocol surface is small enough to maintain in ~150 LOC.

**Residual risk:** Claude Code-specific behavior (e.g., notification ordering, capability extensions) only verifiable end-to-end. Mitigated by Phase 2's end-to-end test against a real Claude Code session before merging Phase 2.

## P2 — node:sqlite FTS5 latency + ranking

**Status:** PASS, with a course-correction. Original gate was `sql.js-fts5`; while writing the benchmark, discovered that `node:sqlite` (Node ≥22.13.0) ships SQLite with FTS5 + BM25 built in.

### What we found

`node:sqlite` is built into Node since v22.5.0 (initially `--experimental-sqlite` flag-gated, unflagged since v22.13.0 in December 2024). ADR-0010 rejected `node:sqlite` as "experimental flag-gated until Node 24+" — that's no longer accurate.

- **Has FTS5 + BM25:** confirmed by [`test-node-sqlite-fts5.mjs`](test-node-sqlite-fts5.mjs). Creates an FTS5 virtual table with the same `notes(vault, path, title, tags, body)` schema used today; BM25 with column weighting `(5,3,1)` works exactly as in `better-sqlite3`. Same SQLite, same FTS5, same BM25 — different binding.
- **Synchronous API** (`DatabaseSync`, `prepare`, `run`, `all`, `get`) — same shape as `better-sqlite3`. No async refactor of callers needed.
- **Real SQLite, not in-memory WASM** — WAL mode works for concurrent multi-process access. The mtime-reload pattern from the plan is unnecessary.
- **Zero install size.** It's part of Node itself.

### Latency benchmark (500-note fixture, 3 vaults)

[`bench-node-sqlite-fts5.mjs`](bench-node-sqlite-fts5.mjs) — 500 notes inserted with random non-query-overlapping text, plus two salted "anchor" notes ("Token Efficiency" and "Context Engineering") that match the friend's failure-case query.

- Fixture build: 45 ms (500 inserts inside a transaction).
- DB file size: 348,160 bytes (~340 KB for 500 notes — very compact).
- **Cold-load + query** (open DB, prepare, query, close — worst case): p50 = 0.79 ms, p95 = 0.89 ms, max = 1.06 ms (n=50).
- **Warm query** (DB open, prepared statement reused — typical MCP server hot path): p50 = 0.33 ms, p95 = 0.35 ms, max = 0.50 ms (n=1000).
- **Target was 50 ms p95.** We are 50–150x under that target.

### Ranking validation (friend's failure case)

Query: `claude OR code OR context OR token OR optimization OR CLAUDE OR md` (the same OR-joined token shape today's `_sanitizeQuery` produces from "claude code context token optimization CLAUDE.md").

Top hits in the 500-note fixture:

| Rank | Score | Vault   | Title                  |
|------|-------|---------|------------------------|
| 1    | -15.535 | vault1 | Token Efficiency       |
| 2    | -9.253  | vault1 | Context Engineering    |
| 3    | -0.000  | vault2 | (noise — ranked at floor) |

(FTS5 BM25 ranks ascending — lower score is better.)

The 5x title weighting separates the anchor notes from the noise floor by a wide margin. The friend's failure case resolves correctly. Identical to today's behavior because it *is* today's SQLite + FTS5 + BM25, just bound differently.

### Concurrency

`node:sqlite` exposes real SQLite, so WAL mode (`PRAGMA journal_mode = WAL`) works. Multiple per-vault MCP processes can read concurrently while a CLI process writes; SQLite handles the coordination. **The mtime-reload strategy in the plan is unnecessary and gets removed.**

## P3 — `obsidian-mcp-pro` size (informational)

For ADR-0011's accounting:

- Package itself: ~415 KB unpacked (`npm view obsidian-mcp-pro dist.unpackedSize` = 424,893 bytes).
- Runtime deps: `@modelcontextprotocol/sdk` (~5.6 MB), `zod` v3 (~smaller than the v4 we currently bundle), `gray-matter` (~50 KB).
- Total install footprint: ~11–12 MB when `npx`-cached.

Replacing `obsidian-mcp-pro` removes that ~12 MB from the user's machine.

## Course-corrections to the plan

### Engine

- **Was:** `sql.js-fts5` (1.5 MB WASM, async API, in-memory store with mtime-reload).
- **Is now:** `node:sqlite` (0 MB, synchronous API, real SQLite with WAL).

Effects on Phase 1:
- `src/lib/search-index.ts` rewrite is *simpler* than planned. No async migration. No `await` annotations rippling through callers (`search-indexer.ts`, lifecycle hooks in commands). API matches today's `better-sqlite3` shape almost exactly.
- No mtime-reload method. SQLite WAL handles concurrent access.
- `package.json#dependencies`: drop `better-sqlite3`. **Do not add `sql.js-fts5`.** (Net deps go *down* by one.)
- `engines.node` bumps from `>=22.0.0` to `>=22.13.0` in `package.json` (small bump; the unflag landed almost a year and a half ago).

### Concurrency strategy

- Plan mentioned mtime-based reload. Drop it. WAL mode suffices.

### Net effect on user-machine mass

Recomputed:

| Item                            | Today    | After plan   |
|---------------------------------|----------|--------------|
| `better-sqlite3` (native)       | 12 MB    | 0            |
| `@modelcontextprotocol/sdk`     | 5.6 MB   | 0            |
| `zod`                           | 5.9 MB   | 0            |
| `obsidian-mcp-pro` + deps (npx) | ~12 MB   | 0            |
| **vaultkit search adds**        | n/a      | 0            |
| **Total (search/MCP-related)**  | **~36 MB** | **0**     |

The plan's "−22 MB" estimate becomes "**~−36 MB**" once `obsidian-mcp-pro`'s npx cache is also gone. Vaultkit + Node.js stdlib is the entire footprint.

### "Solid" implications

`node:sqlite` is more solid than either alternative — actively maintained by the Node core team, ships with the runtime, no community fork rot risk. The `Experimental` warning is a forward-compatibility label (API may change between major Node versions); the underlying SQLite is mature. We silence the warning cleanly via `process.removeAllListeners('warning')` or `--no-warnings`.

## What changes downstream

- **Phase 1:** simpler. Drop async refactor. Drop `sql.js-fts5` add. Add `process.removeAllListeners('warning')` at MCP server entry. Bump `engines.node`.
- **Phase 2:** unchanged.
- **Phase 3:** unchanged.
- **Phase 4:** unchanged.
- **Phase 5:** ADR-0011 reflects this finding (corrects ADR-0010's outdated rejection of `node:sqlite`).

## Verdict

Both gates pass. Engine choice is upgraded from "good" (sql.js-fts5) to "best available" (node:sqlite). Proceeding to Phase 1.
