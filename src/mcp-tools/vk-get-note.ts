import type { ToolDefinition, ToolResult } from '../lib/mcp/mcp-stdio.js';
import {
  validateOptionalString,
  validateString,
} from '../lib/mcp/json-rpc-validator.js';
import { resolveVaults, type ToolContext } from './context.js';
import { parseFrontmatter } from '../lib/freshness/sources.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * `vk_get_note` — read a note's full contents from disk. Returns the
 * frontmatter, headings, and body separately so the LLM can pull just
 * the part it needs (e.g. only the headings outline) without burning
 * tokens on the full body when that isn't relevant.
 *
 * Path traversal defense: the requested path is rejected if it
 * normalizes to a location outside the vault directory. The vault
 * directory comes from the registry, never from the caller, so the
 * trust boundary is `<vault-dir>/...` ⊂ vault-dir.
 */
export function vkGetNoteDefinition(ctx: ToolContext): ToolDefinition {
  return {
    name: 'vk_get_note',
    description: 'Read a vault note by path. Returns frontmatter, outline, and body.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        vault: { type: 'string' },
      },
      required: ['path'],
    },
    handler: async (args): Promise<ToolResult> => {
      const path = validateString(args, 'path', { minLength: 1 });
      const vaultArg = validateOptionalString(args, 'vault');

      const vaults = resolveVaults(ctx, vaultArg);
      if (vaults.length !== 1) {
        return {
          content: [
            {
              type: 'text',
              text:
                vaultArg === '*'
                  ? '`vk_get_note` requires a single vault. Pass an explicit `vault` name or omit it for the current vault.'
                  : `Vault "${vaultArg}" not found in registry.`,
            },
          ],
          isError: true,
        };
      }
      const vault = vaults[0]!;

      // Path-traversal defense: reject anything that escapes the
      // vault dir. We don't allow absolute paths, leading slashes, or
      // ".." segments at any point in the relative path.
      if (
        path.startsWith('/') ||
        path.startsWith('\\') ||
        /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path)
      ) {
        return {
          content: [
            { type: 'text', text: `Path "${path}" rejected (must be vault-relative, no .. segments).` },
          ],
          isError: true,
        };
      }

      const absPath = join(vault.dir, path);
      let content: string;
      try {
        content = await readFile(absPath, 'utf8');
      } catch (e) {
        const code = (e as { code?: string })?.code;
        if (code === 'ENOENT') {
          return {
            content: [
              { type: 'text', text: `Note not found: \`${path}\` in vault "${vault.name}".` },
            ],
            isError: true,
          };
        }
        throw e;
      }

      const { fm, body } = parseFrontmatter(content);
      const headings = collectHeadings(body);

      const lines: string[] = [];
      lines.push(`# ${vault.name}/${path}`, '');
      if (Object.keys(fm).length > 0) {
        lines.push('## Frontmatter', '');
        for (const [k, v] of Object.entries(fm)) {
          lines.push(`- **${k}**: ${v}`);
        }
        lines.push('');
      }
      if (headings.length > 0) {
        lines.push('## Outline', '');
        for (const h of headings) {
          lines.push(`${'  '.repeat(h.level - 1)}- ${h.text}`);
        }
        lines.push('');
      }
      lines.push('## Body', '', body);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  };
}

interface Heading {
  level: number;
  text: string;
}

function collectHeadings(body: string): Heading[] {
  const out: Heading[] = [];
  for (const line of body.split('\n')) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      out.push({ level: m[1].length, text: m[2] });
    }
  }
  return out;
}
