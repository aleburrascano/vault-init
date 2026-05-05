/**
 * Tool registry for the per-vault MCP server. `buildToolList(ctx)`
 * returns the canonical 6-tool surface in stable order; the order
 * matters because `tools/list` ships them to Claude in this order, and
 * Claude's tool-selection bias correlates weakly with position.
 */

import type { ToolDefinition } from '../lib/mcp/mcp-stdio.js';
import type { ToolContext } from './context.js';
import { vkSearchDefinition } from './vk-search.js';
import { vkListNotesDefinition } from './vk-list-notes.js';
import { vkGetNoteDefinition } from './vk-get-note.js';
import { vkGetTagsDefinition } from './vk-get-tags.js';
import { vkSearchByTagDefinition } from './vk-search-by-tag.js';
import { vkRecentNotesDefinition } from './vk-recent-notes.js';

export function buildToolList(ctx: ToolContext): ToolDefinition[] {
  return [
    vkSearchDefinition(ctx),
    vkListNotesDefinition(ctx),
    vkGetNoteDefinition(ctx),
    vkGetTagsDefinition(ctx),
    vkSearchByTagDefinition(ctx),
    vkRecentNotesDefinition(ctx),
  ];
}

export type { ToolContext, VaultRef } from './context.js';
