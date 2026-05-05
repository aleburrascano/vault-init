#!/usr/bin/env node
/**
 * vaultkit-search MCP server.
 *
 * Spawned as a separate process by `lib/search-launcher.js.tmpl` (the
 * byte-immutable launcher registered via `claude mcp add`). Exposes
 * BM25-ranked search over `~/.vaultkit-search.db` to Claude Code via
 * the Model Context Protocol stdio transport.
 *
 * Lives in `bin/` (not `src/`) because it has its own `npm` bin entry
 * (`vaultkit-search-server`) — the launcher invokes it as
 * `npx vaultkit-search-server`. Keeping the heavy logic here, separate
 * from the byte-immutable launcher, means we can iterate freely on
 * search behavior without invalidating the launcher's SHA pin in
 * existing user registrations.
 *
 * Tools exposed:
 *   - vk_search(query, vault?, top_k?)  → BM25 hits across vaults
 *   - vk_list_vaults()                  → indexed vault names
 *
 * The server reads `~/.vaultkit-search.db` lazily on first tool call;
 * if the file doesn't exist yet (no vaults indexed), the server still
 * starts and returns empty results gracefully — `vaultkit init` /
 * `update` populates it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSearchIndex, defaultSearchDbPath, type SearchIndex } from '../src/lib/search-index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PackageJson {
  version: string;
}

function loadVersion(): string {
  // package.json is two levels up from dist/bin/ at install time, and
  // also two levels up from bin/ in source. Same relative path.
  try {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    return (JSON.parse(raw) as PackageJson).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Lazy index handle. Opening the SQLite file on every tool call is
 * cheap (microseconds), but we cache the handle so concurrent calls
 * within one server lifetime share it. Closed on process exit via
 * Node's normal teardown.
 */
let cachedIndex: SearchIndex | null = null;
function getIndex(): SearchIndex | null {
  if (cachedIndex) return cachedIndex;
  const dbPath = process.env.VAULTKIT_SEARCH_DB ?? defaultSearchDbPath();
  if (!existsSync(dbPath)) {
    return null;
  }
  cachedIndex = openSearchIndex(dbPath);
  return cachedIndex;
}

function emptyResultText(): string {
  return [
    'No results.',
    '',
    'Possible causes:',
    '  - The query did not match any indexed note.',
    '  - No vaults have been indexed yet (run `vaultkit init <name>` or',
    '    `vaultkit update <name>` to populate the index).',
    '  - The index database does not exist yet (~/.vaultkit-search.db).',
  ].join('\n');
}

const server = new McpServer({
  name: 'vaultkit-search',
  version: loadVersion(),
});

server.registerTool(
  'vk_search',
  {
    title: 'Search vaultkit-managed Obsidian vaults (BM25)',
    description: [
      'Full-text search across all vaultkit-managed Obsidian vaults using',
      'SQLite FTS5 + BM25 ranking. Title hits weight 5x, tags 3x, body 1x —',
      'so a query like "token optimization" against a note titled',
      '"Token Efficiency" still ranks the title-bearing note highly even',
      'when the body never mentions "optimization". Multi-token queries',
      'are OR-joined: any partial match returns, with full matches ranked',
      'highest.',
      '',
      'Use this for natural-language vault queries. After picking a result,',
      'use the obsidian-mcp / per-vault MCP tools to read the full note.',
    ].join('\n'),
    inputSchema: {
      query: z
        .string()
        .min(1)
        .describe('Search query in plain words (e.g. "eventual consistency saga")'),
      vault: z
        .string()
        .optional()
        .describe('Restrict to one vault by name. Omit for cross-vault search.'),
      top_k: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Maximum hits to return (default 5, max 50).'),
    },
  },
  async ({ query, vault, top_k }) => {
    const idx = getIndex();
    if (!idx) {
      return {
        content: [{ type: 'text' as const, text: emptyResultText() }],
      };
    }
    const opts: { vault?: string; topK?: number } = {};
    if (vault !== undefined) opts.vault = vault;
    if (top_k !== undefined) opts.topK = top_k;
    const hits = idx.query(query, opts);
    if (hits.length === 0) {
      return {
        content: [{ type: 'text' as const, text: emptyResultText() }],
      };
    }
    const lines = [
      `Found ${hits.length} hit${hits.length === 1 ? '' : 's'} for "${query}":`,
      '',
    ];
    for (const hit of hits) {
      lines.push(`### ${hit.title || hit.path}`);
      lines.push(`- **Vault**: ${hit.vault}`);
      lines.push(`- **Path**: \`${hit.path}\``);
      lines.push(`- **Score**: ${hit.score.toFixed(2)}`);
      if (hit.snippet) {
        // Snippet may be multi-line; collapse runs of whitespace for
        // a tidier display, but keep the [...]-bracketed match markers.
        const snippet = hit.snippet.replace(/\s+/g, ' ').trim();
        lines.push(`- **Snippet**: ${snippet}`);
      }
      lines.push('');
    }
    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    };
  },
);

server.registerTool(
  'vk_list_vaults',
  {
    title: 'List indexed vaultkit vaults',
    description: [
      'List the vault names currently present in the vaultkit search',
      'index. Use this to decide whether to scope a vk_search call by',
      'vault, or to confirm which vaults are searchable from the',
      'current Claude Code session.',
    ].join('\n'),
    inputSchema: {},
  },
  async () => {
    const idx = getIndex();
    if (!idx) {
      return {
        content: [{ type: 'text' as const, text: 'No vaults indexed yet. Run `vaultkit init <name>` or `vaultkit update <name>` to populate the index.' }],
      };
    }
    const vaults = idx.listVaults();
    if (vaults.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'No vaults indexed yet.' }],
      };
    }
    const total = idx.count();
    const lines = [
      `${vaults.length} vault${vaults.length === 1 ? '' : 's'} indexed (${total} note${total === 1 ? '' : 's'} total):`,
      '',
      ...vaults.map(v => `- **${v}** (${idx.count(v)} notes)`),
    ];
    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until stdin closes; no explicit shutdown.
}

main().catch((err) => {
  process.stderr.write(`[vaultkit-search] fatal: ${(err as Error).message ?? err}\n`);
  process.exit(1);
});
