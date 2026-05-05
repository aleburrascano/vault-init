import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SearchIndex,
  openSearchIndex,
  defaultSearchDbPath,
  _sanitizeQuery,
} from '../../src/lib/search-index.js';

let index: SearchIndex;

beforeEach(() => {
  index = openSearchIndex(':memory:');
});

afterEach(() => {
  index.close();
});

describe('_sanitizeQuery', () => {
  it('returns empty string on empty input', () => {
    expect(_sanitizeQuery('')).toBe('');
    expect(_sanitizeQuery('   ')).toBe('');
  });

  it('passes through plain words as quoted OR-joined tokens', () => {
    // OR-joining (not AND) is the deliberate choice — see ADR-0010
    // and the comment in `_sanitizeQuery`. Multi-token queries find
    // any partial-match note; BM25 ranks full matches higher.
    expect(_sanitizeQuery('token efficiency')).toBe('"token" OR "efficiency"');
  });

  it('returns single-token queries as a bare quoted term (no OR)', () => {
    expect(_sanitizeQuery('token')).toBe('"token"');
  });

  it('collapses runs of whitespace and drops empty tokens', () => {
    expect(_sanitizeQuery('  token   efficiency  ')).toBe('"token" OR "efficiency"');
  });

  it('strips FTS5-reserved characters: ( ) : " + - * ^', () => {
    expect(_sanitizeQuery('auth (required): yes')).toBe('"auth" OR "required" OR "yes"');
    expect(_sanitizeQuery('a+b-c*d')).toBe('"a" OR "b" OR "c" OR "d"');
  });

  it('drops bare AND/OR/NOT operators (case-insensitive)', () => {
    expect(_sanitizeQuery('token AND efficiency')).toBe('"token" OR "efficiency"');
    expect(_sanitizeQuery('token or efficiency')).toBe('"token" OR "efficiency"');
    expect(_sanitizeQuery('NOT token')).toBe('"token"');
  });

  it('keeps multi-byte unicode tokens intact', () => {
    expect(_sanitizeQuery('résumé café')).toBe('"résumé" OR "café"');
  });

  it('returns empty when only operators/punctuation are present', () => {
    expect(_sanitizeQuery('AND OR NOT')).toBe('');
    expect(_sanitizeQuery('()*+')).toBe('');
  });
});

describe('SearchIndex.upsert + query', () => {
  it('finds a note by a body keyword', () => {
    index.upsert({
      vault: 'v1',
      path: 'wiki/foo.md',
      title: 'Foo Notes',
      tags: '',
      body: 'This note describes the eventual consistency pattern.',
    });
    const hits = index.query('eventual');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe('wiki/foo.md');
    expect(hits[0]?.title).toBe('Foo Notes');
  });

  it('returns hits in BM25-ranked order with title weighted above body', () => {
    // Two notes: one mentions "token" only in the title, the other
    // mentions "token" only deep in the body. Title should win.
    index.upsert({
      vault: 'v1',
      path: 'wiki/title-hit.md',
      title: 'Token Efficiency',
      tags: '',
      body: 'Lorem ipsum dolor sit amet.',
    });
    index.upsert({
      vault: 'v1',
      path: 'wiki/body-hit.md',
      title: 'Performance Notes',
      tags: '',
      // long body so the single 'token' mention has a low TF weight
      body: 'a '.repeat(200) + 'token ' + 'b '.repeat(200),
    });
    const hits = index.query('token');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]?.path).toBe('wiki/title-hit.md');
  });

  it('weights tags above body (3x vs 1x per ADR-0010)', () => {
    index.upsert({
      vault: 'v1',
      path: 'wiki/tag-hit.md',
      title: 'Plain Title',
      tags: 'auth security',
      body: 'short body without target term',
    });
    index.upsert({
      vault: 'v1',
      path: 'wiki/body-hit.md',
      title: 'Plain Title',
      tags: 'unrelated',
      body: 'a '.repeat(200) + 'auth ' + 'b '.repeat(200),
    });
    const hits = index.query('auth');
    expect(hits[0]?.path).toBe('wiki/tag-hit.md');
  });

  it('returns the friend-failure-mode case: "token optimization" → "Token Efficiency" via title BM25', () => {
    // The reproducer for the original issue. A natural-language query
    // that doesn't lexically match the note title — but shares one
    // word ("token") — should still rank the title-bearing note high.
    index.upsert({
      vault: 'v1',
      path: 'wiki/topics/Token Efficiency.md',
      title: 'Token Efficiency',
      tags: 'tokens cost',
      body: 'Practices for reducing token consumption.',
    });
    index.upsert({
      vault: 'v1',
      path: 'wiki/topics/Other.md',
      title: 'Some Unrelated Note',
      tags: '',
      body: 'No relevant content.',
    });
    const hits = index.query('token optimization');
    // FTS5's default behavior with multi-token MATCH is implicit-AND.
    // Only the Token Efficiency note shares "token" — should be first.
    // (The "Other" note has zero matches and should not appear.)
    expect(hits[0]?.path).toBe('wiki/topics/Token Efficiency.md');
  });

  it('respects topK', () => {
    for (let i = 0; i < 10; i++) {
      index.upsert({
        vault: 'v1',
        path: `wiki/note-${i}.md`,
        title: `Note ${i}`,
        tags: 'common',
        body: 'shared keyword content',
      });
    }
    const hits = index.query('common', { topK: 3 });
    expect(hits).toHaveLength(3);
  });

  it('caps topK at 50 to keep payloads sane', () => {
    for (let i = 0; i < 60; i++) {
      index.upsert({
        vault: 'v1',
        path: `wiki/note-${i}.md`,
        title: `Note ${i}`,
        tags: '',
        body: 'shared',
      });
    }
    const hits = index.query('shared', { topK: 999 });
    expect(hits.length).toBeLessThanOrEqual(50);
  });

  it('scopes by vault when opts.vault is set', () => {
    index.upsert({ vault: 'v1', path: 'a.md', title: 'A', tags: '', body: 'shared content' });
    index.upsert({ vault: 'v2', path: 'b.md', title: 'B', tags: '', body: 'shared content' });
    const hits = index.query('shared', { vault: 'v1' });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.vault).toBe('v1');
  });

  it('searches across vaults when opts.vault is omitted', () => {
    index.upsert({ vault: 'v1', path: 'a.md', title: 'A', tags: '', body: 'shared content' });
    index.upsert({ vault: 'v2', path: 'b.md', title: 'B', tags: '', body: 'shared content' });
    const hits = index.query('shared');
    expect(hits).toHaveLength(2);
    expect(new Set(hits.map(h => h.vault))).toEqual(new Set(['v1', 'v2']));
  });

  it('upserting the same (vault, path) replaces the previous row', () => {
    index.upsert({ vault: 'v1', path: 'a.md', title: 'Old Title', tags: '', body: 'oldbody' });
    index.upsert({ vault: 'v1', path: 'a.md', title: 'New Title', tags: '', body: 'newbody' });
    expect(index.count()).toBe(1);
    expect(index.query('Old')).toHaveLength(0);
    expect(index.query('New')[0]?.title).toBe('New Title');
  });

  it('returns a non-empty snippet wrapping matches in brackets', () => {
    index.upsert({
      vault: 'v1',
      path: 'a.md',
      title: 'Foo',
      tags: '',
      body: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Notable eventual consistency reference here.',
    });
    const hits = index.query('eventual');
    expect(hits[0]?.snippet).toMatch(/\[eventual\]/i);
  });

  it('returns higher score for stronger matches', () => {
    index.upsert({
      vault: 'v1', path: 'strong.md', title: 'auth auth auth', tags: 'auth', body: 'auth auth',
    });
    index.upsert({
      vault: 'v1', path: 'weak.md', title: 'unrelated', tags: '', body: 'one auth mention',
    });
    const hits = index.query('auth');
    expect(hits[0]?.path).toBe('strong.md');
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
  });
});

describe('SearchIndex.delete', () => {
  beforeEach(() => {
    index.upsert({ vault: 'v1', path: 'a.md', title: 'A', tags: '', body: 'foo' });
    index.upsert({ vault: 'v1', path: 'b.md', title: 'B', tags: '', body: 'foo' });
    index.upsert({ vault: 'v2', path: 'c.md', title: 'C', tags: '', body: 'foo' });
  });

  it('removes a single note when path is given', () => {
    index.delete('v1', 'a.md');
    expect(index.count()).toBe(2);
    expect(index.query('foo').map(h => h.path).sort()).toEqual(['b.md', 'c.md']);
  });

  it('removes every note in a vault when path is omitted', () => {
    index.delete('v1');
    expect(index.count()).toBe(1);
    expect(index.query('foo')[0]?.vault).toBe('v2');
  });

  it('is a no-op when the (vault, path) pair does not exist', () => {
    index.delete('v1', 'nonexistent.md');
    expect(index.count()).toBe(3);
  });

  it('is a no-op when the vault does not exist', () => {
    index.delete('does-not-exist');
    expect(index.count()).toBe(3);
  });
});

describe('SearchIndex.listVaults + count', () => {
  it('returns distinct vault names sorted', () => {
    index.upsert({ vault: 'zebra', path: 'a.md', title: 'A', tags: '', body: '' });
    index.upsert({ vault: 'alpha', path: 'b.md', title: 'B', tags: '', body: '' });
    index.upsert({ vault: 'alpha', path: 'c.md', title: 'C', tags: '', body: '' });
    expect(index.listVaults()).toEqual(['alpha', 'zebra']);
  });

  it('count() returns total rows or per-vault rows', () => {
    index.upsert({ vault: 'v1', path: 'a.md', title: 'A', tags: '', body: '' });
    index.upsert({ vault: 'v1', path: 'b.md', title: 'B', tags: '', body: '' });
    index.upsert({ vault: 'v2', path: 'c.md', title: 'C', tags: '', body: '' });
    expect(index.count()).toBe(3);
    expect(index.count('v1')).toBe(2);
    expect(index.count('v2')).toBe(1);
    expect(index.count('does-not-exist')).toBe(0);
  });

  it('returns empty list when index is empty', () => {
    expect(index.listVaults()).toEqual([]);
    expect(index.count()).toBe(0);
  });
});

describe('SearchIndex query edge cases', () => {
  beforeEach(() => {
    index.upsert({ vault: 'v1', path: 'a.md', title: 'Foo', tags: '', body: 'bar baz' });
  });

  it('returns empty array on empty query string', () => {
    expect(index.query('')).toEqual([]);
    expect(index.query('   ')).toEqual([]);
  });

  it('returns empty array on operator-only query', () => {
    expect(index.query('AND OR NOT')).toEqual([]);
  });

  it('returns empty array on no match', () => {
    expect(index.query('nothingmatchesthis')).toEqual([]);
  });

  it('handles parentheses + colons + quotes in query without throwing', () => {
    // The friend's failure mode included queries like "claude code:
    // (token optimization)". After sanitization these tokenize cleanly.
    expect(() => index.query('claude code: (token optimization)')).not.toThrow();
  });

  it('supports unicode bodies and queries (diacritic-folded)', () => {
    index.upsert({ vault: 'v1', path: 'u.md', title: 'résumé', tags: '', body: 'café au lait' });
    // remove_diacritics 1: searching "resume" matches "résumé"
    const hits = index.query('resume');
    expect(hits.some(h => h.path === 'u.md')).toBe(true);
  });
});

describe('openSearchIndex + defaultSearchDbPath', () => {
  it('defaultSearchDbPath() returns ~/.vaultkit-search.db', () => {
    const path = defaultSearchDbPath();
    // Don't pin the exact homedir, but assert the leaf is right.
    expect(path).toMatch(/[/\\]\.vaultkit-search\.db$/);
  });

  it('openSearchIndex(":memory:") returns a usable handle', () => {
    const idx = openSearchIndex(':memory:');
    try {
      idx.upsert({ vault: 'v', path: 'a.md', title: 'A', tags: '', body: 'hello' });
      expect(idx.query('hello')).toHaveLength(1);
    } finally {
      idx.close();
    }
  });
});
