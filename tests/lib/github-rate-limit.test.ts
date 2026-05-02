import { describe, it, expect } from 'vitest';
import {
  _parseGhIncludeOutput,
  _classifyGhFailure,
} from '../../src/lib/gh-retry.js';

describe('_parseGhIncludeOutput', () => {
  it('parses a 200 response with rate-limit headers and a JSON body', () => {
    const raw =
      'HTTP/2.0 200 OK\r\n' +
      'Content-Type: application/json\r\n' +
      'X-RateLimit-Limit: 5000\r\n' +
      'X-RateLimit-Remaining: 4999\r\n' +
      'X-RateLimit-Reset: 1700000000\r\n' +
      '\r\n' +
      '{"login":"octocat"}';
    const { status, headers, body } = _parseGhIncludeOutput(raw);
    expect(status).toBe(200);
    expect(headers['x-ratelimit-remaining']).toBe('4999');
    expect(headers['x-ratelimit-reset']).toBe('1700000000');
    expect(headers['content-type']).toBe('application/json');
    expect(body).toBe('{"login":"octocat"}');
  });

  it('lowercases header names so callers match case-insensitively', () => {
    const raw = 'HTTP/2.0 200 OK\r\nRetry-After: 60\r\n\r\n';
    const { headers } = _parseGhIncludeOutput(raw);
    expect(headers['retry-after']).toBe('60');
    expect(headers['Retry-After']).toBeUndefined();
  });

  it('handles unix-style \\n line endings', () => {
    const raw = 'HTTP/1.1 403 Forbidden\nRetry-After: 30\n\n{"message":"abuse"}';
    const { status, headers, body } = _parseGhIncludeOutput(raw);
    expect(status).toBe(403);
    expect(headers['retry-after']).toBe('30');
    expect(body).toBe('{"message":"abuse"}');
  });

  it('returns the raw blob as body when there is no header block', () => {
    const raw = '{"already":"plain json"}';
    const { status, headers, body } = _parseGhIncludeOutput(raw);
    expect(status).toBeUndefined();
    expect(headers).toEqual({});
    expect(body).toBe(raw);
  });

  it('returns the raw blob as body when the first line is not a status line', () => {
    const raw = 'X-Something: 1\r\n\r\nbody';
    const { status, headers, body } = _parseGhIncludeOutput(raw);
    expect(status).toBeUndefined();
    expect(headers).toEqual({});
    expect(body).toBe(raw);
  });

  it('returns empty headers/body for empty input', () => {
    const { status, headers, body } = _parseGhIncludeOutput('');
    expect(status).toBeUndefined();
    expect(headers).toEqual({});
    expect(body).toBe('');
  });

  it('returns raw blob when the status line is malformed (no HTTP/ prefix)', () => {
    const raw = 'HTTPx 200 OK\r\n\r\nbody';
    const { status, headers, body } = _parseGhIncludeOutput(raw);
    expect(status).toBeUndefined();
    expect(headers).toEqual({});
    expect(body).toBe(raw);
  });

  it('returns raw blob when the status line has a non-numeric status code', () => {
    const raw = 'HTTP/1.1 abc OK\r\n\r\nbody';
    const { status, headers, body } = _parseGhIncludeOutput(raw);
    expect(status).toBeUndefined();
    expect(headers).toEqual({});
    expect(body).toBe(raw);
  });

  it('preserves embedded colons in header values', () => {
    const raw = 'HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n\r\n{}';
    const { headers } = _parseGhIncludeOutput(raw);
    expect(headers['content-type']).toBe('application/json; charset=utf-8');
  });

  it('skips header lines without a colon instead of throwing', () => {
    const raw = 'HTTP/1.1 200 OK\r\nNoColonHere\r\nGood-Header: yes\r\n\r\n{}';
    const { status, headers, body } = _parseGhIncludeOutput(raw);
    expect(status).toBe(200);
    expect(headers['good-header']).toBe('yes');
    expect(body).toBe('{}');
  });

  it('handles mixed \\r\\n and \\n line endings within the same response', () => {
    const raw = 'HTTP/1.1 200 OK\r\nA: 1\nB: 2\r\n\r\nbody';
    const { status, headers, body } = _parseGhIncludeOutput(raw);
    expect(status).toBe(200);
    expect(headers['a']).toBe('1');
    expect(headers['b']).toBe('2');
    expect(body).toBe('body');
  });
});

describe('_classifyGhFailure', () => {
  it('flags a freshly-disabled repo as auth_flagged (no retry)', () => {
    // Real stderr from the v2.7.0 Ubuntu CI failure on 2026-05-02.
    const stderr =
      "remote: Repository 'fluids2/vk-live-visibility-1777742512681' is disabled.\n" +
      'remote: Please ask the owner to check their account.\n' +
      "fatal: unable to access 'https://github.com/fluids2/vk-live-visibility-1777742512681.git/': The requested URL returned error: 403";
    const cls = _classifyGhFailure(403, '', stderr, {});
    expect(cls.kind).toBe('auth_flagged');
  });

  it('also recognizes the disabled-repo phrase in the body, not just stderr', () => {
    const body = JSON.stringify({ message: "Repository 'owner/repo' is disabled." });
    const cls = _classifyGhFailure(403, body, '', {});
    expect(cls.kind).toBe('auth_flagged');
  });

  it('flags secondary-rate-limit body as rate_limited and uses Retry-After when present', () => {
    const body = JSON.stringify({
      message: 'You have exceeded a secondary rate limit. Please wait a few minutes.',
      documentation_url: 'https://docs.github.com/...',
    });
    const cls = _classifyGhFailure(403, body, '', { 'retry-after': '45' });
    expect(cls.kind).toBe('rate_limited');
    expect(cls.backoffMs).toBe(45_000);
  });

  it('falls back to 60s when Retry-After is missing on secondary rate limit', () => {
    const body = JSON.stringify({ message: 'You have exceeded a secondary rate limit.' });
    const cls = _classifyGhFailure(403, body, '', {});
    expect(cls.kind).toBe('rate_limited');
    expect(cls.backoffMs).toBe(60_000);
  });

  it('recognizes abuse detection phrasing', () => {
    const body = JSON.stringify({ message: 'You have triggered an abuse detection mechanism.' });
    const cls = _classifyGhFailure(403, body, '', {});
    expect(cls.kind).toBe('rate_limited');
  });

  it('classifies HTTP 429 as rate_limited regardless of body', () => {
    const cls = _classifyGhFailure(429, '', '', { 'retry-after': '10' });
    expect(cls.kind).toBe('rate_limited');
    expect(cls.backoffMs).toBe(10_000);
  });

  it('classifies HTTP 500-599 as transient', () => {
    expect(_classifyGhFailure(500, '', '', {}).kind).toBe('transient');
    expect(_classifyGhFailure(503, '', '', {}).kind).toBe('transient');
    expect(_classifyGhFailure(599, '', '', {}).kind).toBe('transient');
  });

  it('classifies legacy "HTTP 5xx" stderr (no parsed status) as transient', () => {
    const cls = _classifyGhFailure(undefined, '', 'gh: HTTP 502 — bad gateway', {});
    expect(cls.kind).toBe('transient');
  });

  it('classifies the visibility-change-in-progress 422 as transient', () => {
    const body = JSON.stringify({ message: 'previous visibility change is still in progress.' });
    const cls = _classifyGhFailure(422, body, '', {});
    expect(cls.kind).toBe('transient');
  });

  it('classifies network resets/timeouts as transient', () => {
    expect(_classifyGhFailure(undefined, '', 'connect ECONNRESET 140.82.114.6:443', {}).kind).toBe('transient');
    expect(_classifyGhFailure(undefined, '', 'request to ... failed, reason: ETIMEDOUT', {}).kind).toBe('transient');
    expect(_classifyGhFailure(undefined, '', 'connect ECONNREFUSED 127.0.0.1:443', {}).kind).toBe('transient');
    expect(_classifyGhFailure(undefined, '', 'EHOSTUNREACH', {}).kind).toBe('transient');
  });

  it('falls through to fatal for everything else', () => {
    const cls = _classifyGhFailure(404, JSON.stringify({ message: 'Not Found' }), 'gh: Not Found (HTTP 404)', {});
    expect(cls.kind).toBe('fatal');
    expect(cls.reason).toContain('Not Found');
  });

  it('prioritizes auth_flagged over secondary-rate-limit when both phrases appear', () => {
    // If the same response somehow names both, the disabled-repo signal
    // is the more diagnostic one — retrying won't help even if there's
    // also a rate-limit angle.
    const body = JSON.stringify({
      message:
        "You have exceeded a secondary rate limit. Repository 'owner/repo' is disabled.",
    });
    const cls = _classifyGhFailure(403, body, '', { 'retry-after': '60' });
    expect(cls.kind).toBe('auth_flagged');
  });

  it('caps secondary-rate-limit backoffMs at 60s when Retry-After is absurdly large', () => {
    // GitHub returning Retry-After: 999999 must not stall the process for
    // ~11 days. Cap matches PROACTIVE_SLEEP_CAP_MS so consumer sleep is
    // bounded without the consumer needing its own cap.
    const body = JSON.stringify({ message: 'You have exceeded a secondary rate limit.' });
    const cls = _classifyGhFailure(403, body, '', { 'retry-after': '999999' });
    expect(cls.kind).toBe('rate_limited');
    expect(cls.backoffMs).toBe(60_000);
  });

  it('caps HTTP 429 backoffMs at 60s when Retry-After is absurdly large', () => {
    const cls = _classifyGhFailure(429, '', '', { 'retry-after': '999999' });
    expect(cls.kind).toBe('rate_limited');
    expect(cls.backoffMs).toBe(60_000);
  });

  it('falls back to 60s default when Retry-After is zero, negative, or non-numeric', () => {
    const body = JSON.stringify({ message: 'You have exceeded a secondary rate limit.' });
    expect(_classifyGhFailure(403, body, '', { 'retry-after': '0' }).backoffMs).toBe(60_000);
    expect(_classifyGhFailure(403, body, '', { 'retry-after': '-5' }).backoffMs).toBe(60_000);
    expect(_classifyGhFailure(403, body, '', { 'retry-after': 'garbage' }).backoffMs).toBe(60_000);
    expect(_classifyGhFailure(403, body, '', {}).backoffMs).toBe(60_000);
  });

  it('classifies status 499 as fatal (just below the 5xx range)', () => {
    const cls = _classifyGhFailure(499, '', 'something', {});
    expect(cls.kind).toBe('fatal');
  });

  it('classifies status 600 as fatal (just above the 5xx range)', () => {
    const cls = _classifyGhFailure(600, '', 'something', {});
    expect(cls.kind).toBe('fatal');
  });

  it('detects auth-flagged text in body even when status is undefined', () => {
    // Older `gh` versions may not surface a parsed status; the regex
    // matches against the body+stderr blob regardless.
    const body = JSON.stringify({ message: "Repository 'owner/repo' is disabled." });
    const cls = _classifyGhFailure(undefined, body, '', {});
    expect(cls.kind).toBe('auth_flagged');
  });
});
