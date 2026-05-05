/**
 * In-memory test double for ISearchIndex. Backed by a Map — no SQLite
 * required. Intended for unit tests of individual MCP tool handlers where
 * the test wants to control exactly what the index returns without running
 * the real indexer.
 *
 * Limitations vs. the real SearchIndex:
 * - `query()` does a simple case-insensitive substring match (not BM25).
 * - `notesByTag()` does a plain string-contains match on the tags field.
 * - `listTags()` splits on whitespace; no deduplication across vaults.
 * These differences are intentional — unit tests assert on handler logic,
 * not FTS5 ranking accuracy.
 */

import type { ISearchIndex, IndexRecord, QueryOptions, SearchHit, NoteRef } from '../../src/lib/search-index.js';

export class FakeSearchIndex implements ISearchIndex {
  private records: IndexRecord[] = [];

  upsert(record: IndexRecord): void {
    this.delete(record.vault, record.path);
    this.records.push({ ...record });
  }

  delete(vault: string, path?: string): void {
    if (path === undefined) {
      this.records = this.records.filter(r => r.vault !== vault);
    } else {
      this.records = this.records.filter(r => !(r.vault === vault && r.path === path));
    }
  }

  query(rawQuery: string, opts: QueryOptions = {}): SearchHit[] {
    const q = rawQuery.toLowerCase();
    const scoped = opts.vault !== undefined && opts.vault !== '*';
    const topK = Math.min(opts.topK ?? 5, 50);
    return this.records
      .filter(r => !scoped || r.vault === opts.vault)
      .filter(r =>
        r.title.toLowerCase().includes(q) ||
        r.tags.toLowerCase().includes(q) ||
        r.body.toLowerCase().includes(q),
      )
      .slice(0, topK)
      .map(r => ({
        vault: r.vault,
        path: r.path,
        title: r.title,
        snippet: r.body.slice(0, 120),
        score: 1,
      }));
  }

  listTags(vault?: string): string[] {
    const scoped = vault !== undefined && vault !== '*';
    const tags = new Set<string>();
    for (const r of this.records) {
      if (scoped && r.vault !== vault) continue;
      for (const t of r.tags.split(/\s+/).filter(Boolean)) {
        tags.add(t);
      }
    }
    return [...tags].sort();
  }

  notesByTag(tag: string, opts: { vault?: string; topK?: number } = {}): NoteRef[] {
    const scoped = opts.vault !== undefined && opts.vault !== '*';
    const topK = Math.min(opts.topK ?? 50, 200);
    return this.records
      .filter(r => !scoped || r.vault === opts.vault)
      .filter(r => r.tags.toLowerCase().split(/\s+/).includes(tag.toLowerCase()))
      .slice(0, topK)
      .map(r => ({ vault: r.vault, path: r.path, title: r.title }));
  }

  listVaults(): string[] {
    return [...new Set(this.records.map(r => r.vault))].sort();
  }

  listPaths(vault: string): string[] {
    return this.records
      .filter(r => r.vault === vault)
      .map(r => r.path)
      .sort();
  }

  count(vault?: string): number {
    if (vault === undefined) return this.records.length;
    return this.records.filter(r => r.vault === vault).length;
  }

  close(): void {
    // No-op for in-memory test double.
  }
}
