# ADR-0013: ISearchIndex interface for MCP tool context

**Status**: Accepted  
**Date**: 2026-05-05  
**Related rules**: [.claude/rules/architecture.md](../../.claude/rules/architecture.md)  
**Related**: [ADR-0008](0008-module-imports-as-dependency-wiring.md) (the dependency-wiring strategy this extends), [ADR-0011](0011-vaultkit-mcp-replaces-obsidian-mcp-pro.md) (introduced SearchIndex into ToolContext)

## Context

After ADR-0011, `ToolContext.index` was typed as the concrete `SearchIndex` class. Each MCP tool uses at most two of the class's nine methods:

| Tool | Methods used |
|---|---|
| `vk_search` | `query` |
| `vk_list_notes` | (none — uses filesystem walk) |
| `vk_get_note` | (none — reads file directly) |
| `vk_get_tags` | `listTags` |
| `vk_search_by_tag` | `notesByTag` |
| `vk_recent_notes` | (none — uses filesystem walk) |

Typing `index` as the concrete class couples all tool handlers to all nine methods, even though they use at most one. This has two practical consequences:

1. **Test isolation**: a unit test for an individual tool handler must construct a real `SearchIndex` (backed by `:memory:` SQLite and populated via `indexVault`). This pulls in `node:sqlite`, the indexer, and frontmatter parsing — significant coupling for what should be a 5-line test.

2. **ADR-0008's trigger condition**: ADR-0008 deferred port interfaces for the ACL boundaries because each has one production implementation. `SearchIndex` is different: it is not an ACL (it is a domain service, not an external CLI boundary) and it already has a meaningful second form — `:memory:` vs file-backed WAL-mode SQLite. These differ in lifecycle (no WAL pragma, no `mkdirSync` on parent path) and I/O characteristics.

ADR-0008's stated trigger — "the second concrete implementation is genuinely needed" — is met.

## Decision

Extract `ISearchIndex` as a named interface in `src/lib/search-index.ts`. The `SearchIndex` class implements it. `ToolContext.index` is retyped to `ISearchIndex`. The `indexVault`, `removeVaultFromIndex`, and `_listVaultPaths` helpers in `search-indexer.ts` accept `ISearchIndex` as their parameter type.

Add `NoteRef` as a named interface (`{ vault, path, title }`) and use it as the return type for `notesByTag` in both the interface and the class method, removing an anonymous inline struct.

Add `FakeSearchIndex implements ISearchIndex` in `tests/helpers/search-index.ts`: a Map-backed in-memory double. Its `query()` does substring matching (not BM25 ranked); `notesByTag()` does case-insensitive token matching. These differences are intentional — tool unit tests assert on handler logic, not ranking accuracy.

Add an architecture fitness function asserting that `src/mcp-tools/context.ts` imports `ISearchIndex` (the interface type), not the concrete `SearchIndex` class. This makes the interface boundary machine-enforced rather than convention-only.

## Consequences

- **Positive**: tool unit tests can inject `FakeSearchIndex` without SQLite, enabling truly isolated handler tests.
- **Positive**: ISP-compliant — `vk_get_tags` depends only on `listTags`, not on the full `SearchIndex` surface.
- **Positive**: architecture fitness test enforces the boundary so it cannot silently erode.
- **No change to production behavior**: `mcp-server.ts` still constructs `SearchIndex` (the concrete class via `openSearchIndex()`) and passes it into `ToolContext.index`; the narrowing to `ISearchIndex` happens at the ToolContext type level.
- **Explicitly not**: a `GhClient`/`GitClient`/`McpClient` interface for the ACL boundaries. ADR-0008's reasoning still holds there — those have one production implementation each, and `vi.mock` is the right test-substitution mechanism for them.
