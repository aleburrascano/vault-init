import type { ToolDefinition, ToolResult } from '../lib/mcp-stdio.js';
import {
  validateOptionalInteger,
  validateOptionalString,
} from '../lib/json-rpc-validator.js';
import { resolveVaults, type ToolContext } from './context.js';
import { _walkMarkdown } from '../lib/search-indexer.js';
import { statSync } from 'node:fs';

/**
 * `vk_recent_notes` — list the most recently modified notes in scope,
 * by filesystem mtime. Defaults to the current vault. Useful when
 * resuming work or surfacing whatever was edited most recently.
 *
 * Reads filesystem mtime directly (not the search index) so the result
 * reflects current disk state even if the index is mid-rebuild.
 */
export function vkRecentNotesDefinition(ctx: ToolContext): ToolDefinition {
  return {
    name: 'vk_recent_notes',
    title: 'List recently modified notes',
    description: [
      'Return the most recently modified markdown notes in scope, sorted by',
      'filesystem mtime descending (newest first). Useful for "what did I',
      'work on recently" questions or resuming a session.',
      '',
      `Defaults to the current vault ("${ctx.current.name}"). Pass`,
      '`vault: "*"` for cross-vault, or a specific vault name. Optional',
      '`limit` caps the result set (default 10, max 100).',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        vault: {
          type: 'string',
          description:
            'Vault name to scope to. Omit for current vault. Pass "*" for cross-vault.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum notes to return (default 10, max 100).',
          minimum: 1,
          maximum: 100,
          default: 10,
        },
      },
    },
    handler: async (args): Promise<ToolResult> => {
      const vault = validateOptionalString(args, 'vault');
      const limit =
        validateOptionalInteger(args, 'limit', { minimum: 1, maximum: 100 }) ?? 10;

      const vaults = resolveVaults(ctx, vault);
      if (vaults.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `Vault "${vault}" not found in registry.`,
            },
          ],
        };
      }

      const all: Array<{ vault: string; path: string; mtimeMs: number }> = [];
      for (const v of vaults) {
        for (const entry of _walkMarkdown(v.dir)) {
          let mtimeMs: number;
          try {
            mtimeMs = statSync(entry.full).mtimeMs;
          } catch {
            continue;
          }
          all.push({ vault: v.name, path: entry.rel, mtimeMs });
        }
      }
      all.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const top = all.slice(0, limit);

      if (top.length === 0) {
        return { content: [{ type: 'text', text: 'No notes found.' }] };
      }

      const isCrossVault = vaults.length > 1;
      const lines: string[] = [];
      lines.push(
        `${top.length} most recently modified note${top.length === 1 ? '' : 's'}:`,
        '',
      );
      for (const n of top) {
        const when = new Date(n.mtimeMs).toISOString();
        lines.push(
          isCrossVault
            ? `- \`${n.vault}/${n.path}\`  _(${when})_`
            : `- \`${n.path}\`  _(${when})_`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  };
}
