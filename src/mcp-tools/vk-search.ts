import type { ToolDefinition, ToolResult } from '../lib/mcp/mcp-stdio.js';
import {
  validateOptionalInteger,
  validateOptionalString,
  validateString,
} from '../lib/mcp/json-rpc-validator.js';
import type { ToolContext } from './context.js';

/**
 * `vk_search` — BM25 full-text search across the vaultkit search
 * index. Defaults to scoping by the current vault (the one this MCP
 * server is bound to); pass `vault: "*"` for cross-vault search or a
 * specific vault name to scope to that one.
 *
 * Title 5x, tags 3x, body 1x weighting. Multi-token natural-language
 * queries are OR-joined after stripping FTS5 operators, so a query
 * like `token optimization` against a note titled `Token Efficiency`
 * still ranks the title-bearing note highly via partial keyword
 * overlap.
 */
export function vkSearchDefinition(ctx: ToolContext): ToolDefinition {
  return {
    name: 'vk_search',
    description: 'BM25 full-text search in vault notes. vault: name or * for all vaults.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        vault: { type: 'string' },
        top_k: { type: 'integer' },
      },
      required: ['query'],
    },
    handler: async (args): Promise<ToolResult> => {
      const query = validateString(args, 'query', { minLength: 1 });
      const vault = validateOptionalString(args, 'vault');
      const topK = validateOptionalInteger(args, 'top_k', { minimum: 1, maximum: 50 });

      const opts: { vault?: string; topK?: number } = {};
      if (vault !== undefined) {
        opts.vault = vault;
      } else {
        opts.vault = ctx.current.name;
      }
      if (topK !== undefined) opts.topK = topK;

      const hits = ctx.index.query(query, opts);
      if (hits.length === 0) {
        return { content: [{ type: 'text', text: emptyResultText(vault, ctx.current.name) }] };
      }

      const lines: string[] = [];
      lines.push(
        `Found ${hits.length} hit${hits.length === 1 ? '' : 's'} for "${query}":`,
        '',
      );
      for (const hit of hits) {
        lines.push(`### ${hit.title || hit.path}`);
        lines.push(`- **Vault**: ${hit.vault}`);
        lines.push(`- **Path**: \`${hit.path}\``);
        lines.push(`- **Score**: ${hit.score.toFixed(2)}`);
        if (hit.snippet) {
          const snippet = hit.snippet.replace(/\s+/g, ' ').trim();
          lines.push(`- **Snippet**: ${snippet}`);
        }
        lines.push('');
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  };
}

function emptyResultText(scope: string | undefined, currentVault: string): string {
  const where =
    scope === '*'
      ? 'across all indexed vaults'
      : scope !== undefined
        ? `in vault "${scope}"`
        : `in vault "${currentVault}"`;
  return [
    `No matches ${where}.`,
    '',
    'Possible causes:',
    '  - The query did not match any indexed note.',
    '  - The vault has not been indexed yet (run `vaultkit init <name>` or',
    '    `vaultkit doctor <name> --fix` to populate the index).',
    '  - The vault is not registered (run `vaultkit list` to check).',
  ].join('\n');
}
