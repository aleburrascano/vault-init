import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSearchIndex, type SearchIndex } from '../../src/lib/search/search-index.js';
import { indexVault } from '../../src/lib/search/search-indexer.js';
import { buildToolList, type ToolContext, type VaultRef } from '../../src/mcp-tools/index.js';

/**
 * Integration tests for the 6 MCP tools. Builds an on-disk vault
 * fixture with seeded notes, indexes it via the real indexer, then
 * invokes each tool's handler through `buildToolList` to verify the
 * end-to-end behavior the launcher will see in production.
 */

interface Fixture {
  index: SearchIndex;
  ctx: ToolContext;
  vaultDir: string;
  vaultName: string;
  cleanup: () => void;
}

function setupFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'vk-tools-test-'));
  const vaultName = 'fixture';
  const vaultDir = join(root, vaultName);
  mkdirSync(join(vaultDir, 'wiki'), { recursive: true });
  mkdirSync(join(vaultDir, 'wiki', 'concepts'), { recursive: true });
  mkdirSync(join(vaultDir, 'raw'), { recursive: true });

  // Seed three notes. The first two are the friend's-failure-case
  // anchor notes; the third is unrelated noise.
  writeFileSync(
    join(vaultDir, 'wiki', 'concepts', 'Token Efficiency.md'),
    '---\ntitle: Token Efficiency\ntags: [ai, llm]\n---\n\n# Token Efficiency\n\n## Why\n\nReducing tokens.\n',
  );
  writeFileSync(
    join(vaultDir, 'wiki', 'concepts', 'Context Engineering.md'),
    '---\ntitle: Context Engineering\ntags: [prompts]\n---\n\n# Context Engineering\n\n## Curating context\n\nFor downstream models.\n',
  );
  writeFileSync(
    join(vaultDir, 'wiki', 'Mountains.md'),
    '---\ntitle: Mountains\ntags: [hobby]\n---\n\n# Mountains\n\nNothing technical here.\n',
  );

  // Make the third note older so vk_recent_notes ranks it last.
  const past = new Date('2020-01-01T00:00:00Z');
  utimesSync(join(vaultDir, 'wiki', 'Mountains.md'), past, past);

  const index = openSearchIndex(':memory:');

  const ctx: ToolContext = {
    current: { name: vaultName, dir: vaultDir },
    getVaultDir: (n) => (n === vaultName ? vaultDir : undefined),
    listVaults: (): VaultRef[] => [{ name: vaultName, dir: vaultDir }],
    index,
  };

  return {
    index,
    ctx,
    vaultDir,
    vaultName,
    cleanup: () => {
      index.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

let fix: Fixture;
beforeEach(async () => {
  fix = setupFixture();
  await indexVault(fix.vaultName, fix.vaultDir, fix.index);
});
afterEach(() => fix.cleanup());

function findTool(ctx: ToolContext, name: string) {
  const t = buildToolList(ctx).find((t) => t.name === name);
  if (!t) throw new Error(`tool not registered: ${name}`);
  return t;
}

describe('vk_search', () => {
  it("ranks the friend's failure-case query top-hit on Token Efficiency", async () => {
    const tool = findTool(fix.ctx, 'vk_search');
    const r = await tool.handler({ query: 'claude code context token optimization CLAUDE.md' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).toMatch(/Token Efficiency/);
  });

  it('returns no-result message when nothing matches', async () => {
    const tool = findTool(fix.ctx, 'vk_search');
    const r = await tool.handler({ query: 'zzz_nothing_here_xyz' });
    expect(r.content[0]!.text).toMatch(/No matches/);
  });

  it('rejects empty query (validator throws — wrapped to isError by McpStdioServer in production)', async () => {
    // The handler throws ValidationError directly; mcp-stdio.ts:tools/call
    // catches it and surfaces it as `{ isError: true, content }`. Calling
    // the handler directly here bypasses that wrapper, so we assert the
    // throw at this layer. The wrapping path is covered by mcp-stdio
    // tests' "isError:true with descriptive text on tool handler exception"
    // test.
    const tool = findTool(fix.ctx, 'vk_search');
    await expect(tool.handler({ query: '' })).rejects.toThrowError(
      /at least 1 character/,
    );
  });

  it('respects top_k', async () => {
    const tool = findTool(fix.ctx, 'vk_search');
    const r = await tool.handler({ query: 'context OR tokens OR mountains', top_k: 1 });
    expect(r.isError).toBeFalsy();
    // text-list output → at most one "### " heading line per hit
    const headings = (r.content[0]!.text.match(/^### /gm) ?? []).length;
    expect(headings).toBe(1);
  });
});

describe('vk_list_notes', () => {
  it('returns every markdown file under the current vault by default', async () => {
    const tool = findTool(fix.ctx, 'vk_list_notes');
    const r = await tool.handler({});
    expect(r.content[0]!.text).toMatch(/Token Efficiency/);
    expect(r.content[0]!.text).toMatch(/Context Engineering/);
    expect(r.content[0]!.text).toMatch(/Mountains/);
  });

  it('respects prefix filter', async () => {
    const tool = findTool(fix.ctx, 'vk_list_notes');
    const r = await tool.handler({ prefix: 'wiki/concepts/' });
    expect(r.content[0]!.text).toMatch(/Token Efficiency/);
    expect(r.content[0]!.text).not.toMatch(/Mountains/);
  });

  it('respects limit', async () => {
    const tool = findTool(fix.ctx, 'vk_list_notes');
    const r = await tool.handler({ limit: 1 });
    const bullets = (r.content[0]!.text.match(/^- /gm) ?? []).length;
    expect(bullets).toBe(1);
  });

  it('returns helpful message when no notes match prefix', async () => {
    const tool = findTool(fix.ctx, 'vk_list_notes');
    const r = await tool.handler({ prefix: 'does/not/exist/' });
    expect(r.content[0]!.text).toMatch(/No notes/);
  });
});

describe('vk_get_note', () => {
  it('reads a note and decomposes frontmatter + outline + body', async () => {
    const tool = findTool(fix.ctx, 'vk_get_note');
    const r = await tool.handler({ path: 'wiki/concepts/Token Efficiency.md' });
    expect(r.isError).toBeFalsy();
    const text = r.content[0]!.text;
    expect(text).toMatch(/Frontmatter/);
    expect(text).toMatch(/title.*Token Efficiency/);
    expect(text).toMatch(/Outline/);
    expect(text).toMatch(/Why/);
    expect(text).toMatch(/Body/);
  });

  it('rejects path-traversal attempts', async () => {
    const tool = findTool(fix.ctx, 'vk_get_note');
    const r1 = await tool.handler({ path: '../escape.md' });
    expect(r1.isError).toBe(true);
    const r2 = await tool.handler({ path: '/etc/passwd' });
    expect(r2.isError).toBe(true);
    const r3 = await tool.handler({ path: 'wiki/../../escape.md' });
    expect(r3.isError).toBe(true);
  });

  it('returns isError when note does not exist', async () => {
    const tool = findTool(fix.ctx, 'vk_get_note');
    const r = await tool.handler({ path: 'wiki/nope.md' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/not found/);
  });
});

describe('vk_get_tags', () => {
  it('lists distinct tags from the indexed vault', async () => {
    const tool = findTool(fix.ctx, 'vk_get_tags');
    const r = await tool.handler({});
    const text = r.content[0]!.text;
    expect(text).toMatch(/ai/);
    expect(text).toMatch(/llm/);
    expect(text).toMatch(/prompts/);
    expect(text).toMatch(/hobby/);
  });
});

describe('vk_search_by_tag', () => {
  it('returns notes carrying the given tag', async () => {
    const tool = findTool(fix.ctx, 'vk_search_by_tag');
    const r = await tool.handler({ tag: 'ai' });
    expect(r.content[0]!.text).toMatch(/Token Efficiency/);
    expect(r.content[0]!.text).not.toMatch(/Mountains/);
  });

  it('returns helpful message when no notes are tagged', async () => {
    const tool = findTool(fix.ctx, 'vk_search_by_tag');
    const r = await tool.handler({ tag: 'nonexistent-tag' });
    expect(r.content[0]!.text).toMatch(/No notes tagged/);
  });
});

describe('vk_recent_notes', () => {
  it('returns notes ordered by mtime descending; old note last', async () => {
    const tool = findTool(fix.ctx, 'vk_recent_notes');
    const r = await tool.handler({});
    const text = r.content[0]!.text;
    // Mountains was utime'd to 2020 → should appear last in the listing.
    const tokenIdx = text.indexOf('Token Efficiency');
    const mountainsIdx = text.indexOf('Mountains');
    expect(tokenIdx).toBeGreaterThan(-1);
    expect(mountainsIdx).toBeGreaterThan(-1);
    expect(tokenIdx).toBeLessThan(mountainsIdx);
  });

  it('respects limit', async () => {
    const tool = findTool(fix.ctx, 'vk_recent_notes');
    const r = await tool.handler({ limit: 1 });
    const bullets = (r.content[0]!.text.match(/^- /gm) ?? []).length;
    expect(bullets).toBe(1);
  });
});
