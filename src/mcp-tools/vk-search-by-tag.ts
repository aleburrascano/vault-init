import type { ToolDefinition, ToolResult } from '../lib/mcp-stdio.js';
import {
  validateOptionalInteger,
  validateOptionalString,
  validateString,
} from '../lib/json-rpc-validator.js';
import type { ToolContext } from './context.js';

/**
 * `vk_search_by_tag` — find every note carrying a given tag. Defaults
 * to the current vault; `vault: "*"` enumerates across all vaults.
 *
 * Tag matching is case-insensitive and exact-on-token (so tag "ai"
 * does not match a note tagged "ai-research"). Use `vk_get_tags` first
 * to discover which tags exist.
 */
export function vkSearchByTagDefinition(ctx: ToolContext): ToolDefinition {
  return {
    name: 'vk_search_by_tag',
    title: 'List notes by tag',
    description: [
      'Return every note tagged with the given tag. Useful when the LLM',
      'has asked the user about a topic and wants to enumerate the related',
      'notes deterministically (vs. relying on BM25 ranking).',
      '',
      `Defaults to scoping by the current vault ("${ctx.current.name}").`,
      'Pass `vault: "*"` for cross-vault, or a specific vault name to scope',
      'to that one. Tag match is case-insensitive and exact-on-token.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        tag: {
          type: 'string',
          description: 'Tag to look up (e.g. "ai", "auth").',
          minLength: 1,
        },
        vault: {
          type: 'string',
          description:
            'Vault name to scope to. Omit for current vault. Pass "*" for cross-vault.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum notes to return (default 50, max 200).',
          minimum: 1,
          maximum: 200,
          default: 50,
        },
      },
      required: ['tag'],
    },
    handler: async (args): Promise<ToolResult> => {
      const tag = validateString(args, 'tag', { minLength: 1 });
      const vault = validateOptionalString(args, 'vault');
      const limit = validateOptionalInteger(args, 'limit', { minimum: 1, maximum: 200 });

      const opts: { vault?: string; topK?: number } = {};
      opts.vault = vault ?? ctx.current.name;
      if (limit !== undefined) opts.topK = limit;

      const hits = ctx.index.notesByTag(tag, opts);
      if (hits.length === 0) {
        const where =
          opts.vault === '*'
            ? 'across any indexed vault'
            : `in vault "${opts.vault}"`;
        return {
          content: [
            {
              type: 'text',
              text: `No notes tagged "${tag}" ${where}. Run \`vk_get_tags\` to see which tags are available.`,
            },
          ],
        };
      }
      const lines: string[] = [];
      lines.push(
        `${hits.length} note${hits.length === 1 ? '' : 's'} tagged "${tag}":`,
        '',
      );
      for (const h of hits) {
        lines.push(`- **${h.title || h.path}** _(vault: ${h.vault}, path: \`${h.path}\`)_`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  };
}
