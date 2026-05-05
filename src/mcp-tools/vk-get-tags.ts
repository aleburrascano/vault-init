import type { ToolDefinition, ToolResult } from '../lib/mcp/mcp-stdio.js';
import { validateOptionalString } from '../lib/mcp/json-rpc-validator.js';
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
    description: 'List all tags in vault. vault: name or * for all vaults.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string' },
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
