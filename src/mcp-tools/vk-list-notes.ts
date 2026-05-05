import type { ToolDefinition, ToolResult } from '../lib/mcp-stdio.js';
import {
  validateOptionalInteger,
  validateOptionalString,
} from '../lib/json-rpc-validator.js';
import { walkMarkdown } from '../lib/vault-walk.js';
import { resolveVaults, type ToolContext } from './context.js';

/**
 * `vk_list_notes` — enumerate markdown notes under a vault. Defaults
 * to the current vault. Skips the same hidden / non-content
 * directories the indexer skips (`.git`, `.obsidian`, `node_modules`,
 * `wiki/_freshness`, etc.).
 *
 * Useful when Claude wants a deterministic enumeration of vault
 * content (vs. BM25-ranked search), or when filtering by path prefix
 * (e.g. `prefix: "wiki/"` to skip the `raw/` mirror directory).
 */
export function vkListNotesDefinition(ctx: ToolContext): ToolDefinition {
  return {
    name: 'vk_list_notes',
    title: 'List vault notes',
    description: [
      'Enumerate every markdown note under a vault. Returns paths relative',
      'to the vault root, sorted alphabetically. Skips Git, Obsidian, and',
      'vaultkit-internal directories.',
      '',
      `Defaults to the current vault ("${ctx.current.name}"). Pass`,
      '`vault: "*"` for cross-vault enumeration, or a specific vault name to',
      'scope to that one. Optional `prefix` filters by path prefix (e.g.',
      '"wiki/" to skip the raw mirror, or "wiki/concepts/" to scope further).',
      'Optional `limit` caps the result set.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        vault: {
          type: 'string',
          description:
            'Vault name to scope to. Omit for current vault. Pass "*" for cross-vault.',
        },
        prefix: {
          type: 'string',
          description: 'Optional path prefix filter (e.g. "wiki/").',
        },
        limit: {
          type: 'integer',
          description: 'Maximum notes to return (default 100, max 1000).',
          minimum: 1,
          maximum: 1000,
          default: 100,
        },
      },
    },
    handler: async (args): Promise<ToolResult> => {
      const vault = validateOptionalString(args, 'vault');
      const prefix = validateOptionalString(args, 'prefix');
      const limit =
        validateOptionalInteger(args, 'limit', { minimum: 1, maximum: 1000 }) ?? 100;

      const vaults = resolveVaults(ctx, vault);
      if (vaults.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `Vault "${vault}" not found in registry. Run \`vaultkit status\` to list registered vaults.`,
            },
          ],
        };
      }

      const collected: Array<{ vault: string; path: string }> = [];
      for (const v of vaults) {
        for (const entry of walkMarkdown(v.dir)) {
          if (prefix !== undefined && !entry.rel.startsWith(prefix)) continue;
          collected.push({ vault: v.name, path: entry.rel });
          if (collected.length >= limit) break;
        }
        if (collected.length >= limit) break;
      }
      collected.sort((a, b) => {
        if (a.vault !== b.vault) return a.vault.localeCompare(b.vault);
        return a.path.localeCompare(b.path);
      });

      if (collected.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text:
                prefix !== undefined
                  ? `No notes match prefix "${prefix}".`
                  : 'No notes found.',
            },
          ],
        };
      }

      const isCrossVault = vaults.length > 1;
      const lines: string[] = [];
      lines.push(
        `${collected.length} note${collected.length === 1 ? '' : 's'}${prefix ? ` (prefix "${prefix}")` : ''}:`,
        '',
      );
      for (const c of collected) {
        lines.push(isCrossVault ? `- \`${c.vault}/${c.path}\`` : `- \`${c.path}\``);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  };
}
