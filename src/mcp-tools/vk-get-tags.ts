import type { ToolDefinition, ToolResult } from '../lib/mcp-stdio.js';
import { validateOptionalString } from '../lib/json-rpc-validator.js';
import type { ToolContext } from './context.js';

/**
 * `vk_get_tags` — list every distinct tag in scope. Defaults to the
 * current vault; `vault: "*"` enumerates across all registered vaults.
 *
 * Tags are case-folded (deduped) but the first-seen casing is
 * preserved in the output so the user sees their original tag style.
 */
export function vkGetTagsDefinition(ctx: ToolContext): ToolDefinition {
  return {
    name: 'vk_get_tags',
    title: 'List vault tags',
    description: [
      'Enumerate every distinct tag present in the indexed notes. Returns a',
      'sorted list (case-insensitive) preserving first-seen casing.',
      '',
      `Defaults to the current vault ("${ctx.current.name}"). Pass`,
      '`vault: "*"` to enumerate across every registered vault, or a specific',
      'vault name to scope to that one. Use this before `vk_search_by_tag` to',
      'discover which tags are available.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        vault: {
          type: 'string',
          description:
            'Vault name to scope to. Omit for current vault. Pass "*" for cross-vault.',
        },
      },
    },
    handler: async (args): Promise<ToolResult> => {
      const vault = validateOptionalString(args, 'vault');
      const scope = vault ?? ctx.current.name;
      const tags = ctx.index.listTags(scope === '*' ? '*' : scope);
      if (tags.length === 0) {
        const where = scope === '*' ? 'across any indexed vault' : `in vault "${scope}"`;
        return {
          content: [{ type: 'text', text: `No tags found ${where}.` }],
        };
      }
      const where = scope === '*' ? '(across all indexed vaults)' : `(vault "${scope}")`;
      const lines = [
        `${tags.length} tag${tags.length === 1 ? '' : 's'} ${where}:`,
        '',
        ...tags.map((t) => `- ${t}`),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  };
}
