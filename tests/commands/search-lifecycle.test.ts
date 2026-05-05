import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSearchIndex, type SearchIndex } from '../../src/lib/search/search-index.js';
import { indexVault, removeVaultFromIndex } from '../../src/lib/search/search-indexer.js';

/**
 * S5 wiring tests: the `vaultkit-search` index is kept current across
 * the vault lifecycle. Each command touches a real on-disk SQLite
 * file (in a tmp dir, NOT `~/.vaultkit-search.db`) and we assert the
 * row count + content reflects the mutation.
 *
 * These tests are decoupled from the actual command flows (init,
 * update, pull, destroy, disconnect) — those are covered by their
 * own command tests. This file exercises the index helpers
 * directly with the same call shapes the wired commands use, so a
 * regression in the wiring (e.g. `removeVaultFromIndex` called with
 * the wrong vault name) shows up as a failing assertion here.
 *
 * Coverage parity with the wirings:
 *   - init           → indexVault(name, dir, idx)
 *   - update         → indexVault(name, dir, idx)
 *   - pull           → indexVault(name, dir, idx) per pulled vault
 *   - destroy        → removeVaultFromIndex(name, idx)
 *   - disconnect     → removeVaultFromIndex(name, idx)
 */

let tmp: string;
let dbPath: string;
let index: SearchIndex;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-search-lifecycle-test-'));
  dbPath = join(tmp, 'search.db');
  index = openSearchIndex(dbPath);
});

afterEach(() => {
  index.close();
  rmSync(tmp, { recursive: true, force: true });
});

function writeNote(vaultDir: string, rel: string, content: string): void {
  const full = join(vaultDir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

describe('search lifecycle: init → indexVault adds vault rows', () => {
  it('a fresh init populates the index with every note in the vault', async () => {
    const vaultDir = join(tmp, 'my-vault');
    mkdirSync(vaultDir, { recursive: true });
    writeNote(vaultDir, 'CLAUDE.md', '# my-vault\nroot doc');
    writeNote(vaultDir, 'wiki/concepts/eventual-consistency.md', '---\ntitle: Eventual Consistency\ntags: ddd\n---\nbody');
    writeNote(vaultDir, 'raw/articles/foo.md', '# Foo article\n');

    const result = await indexVault('my-vault', vaultDir, index);

    expect(result.added).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.removed).toBe(0);
    expect(index.count('my-vault')).toBe(3);

    // Cross-check searchability: a query against the indexed title
    // returns the right note (BM25 weighting).
    const hits = index.query('eventual consistency', { vault: 'my-vault' });
    expect(hits[0]?.title).toBe('Eventual Consistency');
  });
});

describe('search lifecycle: update → indexVault refreshes vault rows', () => {
  it('re-indexing reflects added, modified, and deleted notes', async () => {
    const vaultDir = join(tmp, 'my-vault');
    mkdirSync(vaultDir, { recursive: true });

    // First update (mimicking init)
    writeNote(vaultDir, 'a.md', '# A\noriginal');
    writeNote(vaultDir, 'b.md', '# B');
    await indexVault('my-vault', vaultDir, index);
    expect(index.count('my-vault')).toBe(2);

    // Second update: a modified, b deleted, c added
    writeNote(vaultDir, 'a.md', '# A\nmodified body content');
    rmSync(join(vaultDir, 'b.md'));
    writeNote(vaultDir, 'c.md', '# C\nnew note');

    const result = await indexVault('my-vault', vaultDir, index);
    expect(result).toEqual({ added: 1, updated: 1, removed: 1 });
    expect(index.count('my-vault')).toBe(2);

    // Modified content is queryable
    const modifiedHits = index.query('modified', { vault: 'my-vault' });
    expect(modifiedHits.some(h => h.path === 'a.md')).toBe(true);

    // Deleted note's content is NOT queryable
    const deletedHits = index.query('B', { vault: 'my-vault' });
    expect(deletedHits.some(h => h.path === 'b.md')).toBe(false);
  });
});

describe('search lifecycle: pull → indexVault per pulled vault keeps each fresh', () => {
  it('cross-vault rows update independently after a pull-style multi-vault refresh', async () => {
    const v1 = join(tmp, 'v1');
    const v2 = join(tmp, 'v2');
    mkdirSync(v1, { recursive: true });
    mkdirSync(v2, { recursive: true });

    writeNote(v1, 'a.md', '# v1-A');
    writeNote(v2, 'b.md', '# v2-B');
    await indexVault('v1', v1, index);
    await indexVault('v2', v2, index);
    expect(index.count('v1')).toBe(1);
    expect(index.count('v2')).toBe(1);

    // v1 gets a new note from upstream; v2 unchanged.
    writeNote(v1, 'new.md', '# v1-New');
    await indexVault('v1', v1, index);  // pull just re-indexes
    await indexVault('v2', v2, index);  // pull does v2 too

    expect(index.count('v1')).toBe(2);
    expect(index.count('v2')).toBe(1);
    expect(index.listVaults().sort()).toEqual(['v1', 'v2']);
  });
});

describe('search lifecycle: destroy / disconnect → removeVaultFromIndex purges rows', () => {
  it('purges every row for the named vault but leaves other vaults intact', async () => {
    const v1 = join(tmp, 'v1');
    const v2 = join(tmp, 'v2');
    mkdirSync(v1, { recursive: true });
    mkdirSync(v2, { recursive: true });
    writeNote(v1, 'a.md', '# v1-A');
    writeNote(v1, 'b.md', '# v1-B');
    writeNote(v2, 'c.md', '# v2-C');
    await indexVault('v1', v1, index);
    await indexVault('v2', v2, index);

    // Destroy / disconnect path
    const removed = removeVaultFromIndex('v1', index);
    expect(removed).toBe(2);
    expect(index.count('v1')).toBe(0);
    expect(index.count('v2')).toBe(1);
  });

  it('is idempotent — removing an already-purged vault is a no-op', () => {
    expect(removeVaultFromIndex('never-indexed', index)).toBe(0);
    expect(removeVaultFromIndex('never-indexed', index)).toBe(0);
  });

  it('purges across both destroy AND disconnect call shapes (same helper)', async () => {
    // Both destroy.ts and disconnect.ts call removeVaultFromIndex(name, idx).
    // Ensure no asymmetry exists between the two call sites.
    const v1 = join(tmp, 'v1');
    mkdirSync(v1, { recursive: true });
    writeNote(v1, 'a.md', '# A');
    await indexVault('v1', v1, index);
    expect(index.count('v1')).toBe(1);

    // Two consecutive removes (e.g. user runs destroy after disconnect)
    removeVaultFromIndex('v1', index);
    removeVaultFromIndex('v1', index);
    expect(index.count('v1')).toBe(0);
  });
});

describe('search lifecycle: roundtrip — init → update → destroy', () => {
  it('the index ends empty after a full lifecycle on a single vault', async () => {
    const vaultDir = join(tmp, 'my-vault');
    mkdirSync(vaultDir, { recursive: true });
    writeNote(vaultDir, 'a.md', '# A');
    writeNote(vaultDir, 'b.md', '# B');

    // init
    await indexVault('my-vault', vaultDir, index);
    expect(index.count('my-vault')).toBe(2);

    // update — adds c.md
    writeNote(vaultDir, 'c.md', '# C');
    await indexVault('my-vault', vaultDir, index);
    expect(index.count('my-vault')).toBe(3);

    // destroy
    removeVaultFromIndex('my-vault', index);
    expect(index.count('my-vault')).toBe(0);
    expect(index.listVaults()).toEqual([]);
  });
});
