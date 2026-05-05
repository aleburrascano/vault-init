import { describe, it, expect } from 'vitest';
import { _parseUserJson, _parsePlanJson } from '../../src/lib/github/github-auth.js';
import { _parseRepoJson } from '../../src/lib/github/github-repo.js';
import { _parsePagesJson } from '../../src/lib/github/github-pages.js';

// Tests only the pure JSON-parsing helpers — no gh CLI invoked.
// Integration tests (createRepo, deleteRepo, etc.) are deferred to manual testing.

describe('_parseUserJson', () => {
  it('extracts login', () => {
    expect(_parseUserJson('{"login":"octocat","name":"Octocat"}')).toBe('octocat');
  });

  it('throws on invalid JSON', () => {
    expect(() => _parseUserJson('not json')).toThrow();
  });

  it('throws when login missing', () => {
    expect(() => _parseUserJson('{"name":"Octocat"}')).toThrow(/login/);
  });
});

describe('_parsePlanJson', () => {
  it('extracts plan name', () => {
    expect(_parsePlanJson('{"plan":{"name":"pro"}}')).toBe('pro');
  });

  it('returns "free" when plan is absent', () => {
    expect(_parsePlanJson('{"login":"user"}')).toBe('free');
  });
});

describe('_parseRepoJson', () => {
  it('extracts visibility public', () => {
    expect(_parseRepoJson('{"visibility":"public","permissions":{"admin":true}}')).toEqual({
      visibility: 'public',
      isAdmin: true,
    });
  });

  it('extracts visibility private with non-admin', () => {
    expect(_parseRepoJson('{"visibility":"private","permissions":{"admin":false}}')).toEqual({
      visibility: 'private',
      isAdmin: false,
    });
  });

  it('defaults isAdmin to false when permissions absent', () => {
    expect(_parseRepoJson('{"visibility":"public"}')).toEqual({
      visibility: 'public',
      isAdmin: false,
    });
  });

  it('throws on invalid JSON', () => {
    expect(() => _parseRepoJson('bad')).toThrow();
  });
});

describe('_parsePagesJson', () => {
  it('returns null when pages not enabled', () => {
    expect(_parsePagesJson(null)).toBeNull();
    expect(_parsePagesJson('')).toBeNull();
  });

  it('extracts public pages visibility', () => {
    expect(_parsePagesJson('{"public":true}')).toBe('public');
  });

  it('extracts private pages visibility', () => {
    expect(_parsePagesJson('{"public":false}')).toBe('private');
  });

  it('falls back to public field', () => {
    expect(_parsePagesJson('{"visibility":"public"}')).toBe('public');
    expect(_parsePagesJson('{"visibility":"private"}')).toBe('private');
  });

  it('defaults to public when neither public nor visibility field present', () => {
    expect(_parsePagesJson('{"html_url":"https://example.github.io"}')).toBe('public');
  });
});

describe('_parseUserJson — edge cases', () => {
  it('throws when given an empty object', () => {
    expect(() => _parseUserJson('{}')).toThrow(/login/);
  });
});
