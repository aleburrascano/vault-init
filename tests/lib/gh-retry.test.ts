import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock execa and findTool BEFORE importing gh-retry. ghJson's retry loop
// calls gh() which calls findTool + execa on every attempt — controlled
// here so tests can stage success / transient / rate-limited / fatal /
// auth-flagged exit codes per attempt.
vi.mock('execa', async (importOriginal) => {
  const real = await importOriginal<typeof import('execa')>();
  return { ...real, execa: vi.fn() };
});
vi.mock('../../src/lib/platform.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/platform.js')>();
  return { ...real, findTool: vi.fn() };
});

import { execa } from 'execa';
import { findTool } from '../../src/lib/platform.js';
import { gh, ghJson } from '../../src/lib/gh-retry.js';
import { VaultkitError, isVaultkitError } from '../../src/lib/errors.js';

beforeEach(() => {
  vi.mocked(execa).mockReset();
  vi.mocked(findTool).mockReset();
  vi.mocked(findTool).mockResolvedValue('/usr/bin/gh');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('gh (raw, never throws)', () => {
  it('returns parsed headers + body when --include is passed', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'HTTP/2 200 OK\r\nX-RateLimit-Remaining: 4999\r\n\r\n{"login":"octocat"}',
      stderr: '',
    } as never);

    const result = await gh('api', '--include', 'user');
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe(200);
    expect(result.headers['x-ratelimit-remaining']).toBe('4999');
    expect(result.body).toBe('{"login":"octocat"}');
  });

  it('returns empty headers + raw stdout as body when --include is NOT passed', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '{"login":"octocat"}',
      stderr: '',
    } as never);

    const result = await gh('api', 'user');
    expect(result.status).toBeUndefined();
    expect(result.headers).toEqual({});
    expect(result.body).toBe('{"login":"octocat"}');
  });

  it('throws when gh CLI is not found', async () => {
    vi.mocked(findTool).mockResolvedValueOnce(null);
    await expect(gh('api', 'user')).rejects.toThrow(/gh CLI not found/i);
  });
});

describe('ghJson happy path and immediate-throw paths', () => {
  it('returns the body on a successful response (no retry)', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '{"login":"octocat"}',
      stderr: '',
    } as never);

    const body = await ghJson('api', 'user');
    expect(body).toBe('{"login":"octocat"}');
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1);
  });

  it('throws plain Error immediately on a fatal failure (no retry)', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'gh: Not Found (HTTP 404)',
    } as never);

    await expect(ghJson('api', 'repos/owner/missing')).rejects.toThrow(/Not Found/);
    // Plain Error, NOT VaultkitError
    try {
      await ghJson('api', 'repos/owner/missing');
    } catch (err) {
      expect(isVaultkitError(err)).toBe(false);
    }
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(2); // first throw + the second call inside try/catch
  });

  it('throws VaultkitError(AUTH_REQUIRED) immediately on auth-flagged response (no retry)', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: "remote: Repository 'owner/repo' is disabled.\nremote: Please ask the owner to check their account.",
    } as never);

    let caught: unknown;
    try { await ghJson('repo', 'view', 'owner/repo'); } catch (e) { caught = e; }
    expect(isVaultkitError(caught)).toBe(true);
    expect((caught as VaultkitError).code).toBe('AUTH_REQUIRED');
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1); // no retry
  });
});

describe('ghJson retry budget exhaustion', () => {
  it('throws VaultkitError(RATE_LIMITED) after rate-limit budget exhausted (4 attempts)', async () => {
    vi.useFakeTimers();
    // Stage 4 rate-limited responses (initial + 3 retries = 4 attempts).
    const rateLimitBody = JSON.stringify({ message: 'You have exceeded a secondary rate limit.' });
    for (let i = 0; i < 4; i++) {
      vi.mocked(execa).mockResolvedValueOnce({
        exitCode: 1, stdout: rateLimitBody, stderr: '',
      } as never);
    }

    const promise = ghJson('api', 'user');
    // Capture rejection without un-handling it; advance timers concurrently.
    let caught: unknown;
    const settled = promise.catch(e => { caught = e; });
    // Each rate-limit retry sleeps for the capped 60_000ms.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }
    await settled;

    expect(isVaultkitError(caught)).toBe(true);
    expect((caught as VaultkitError).code).toBe('RATE_LIMITED');
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(4);
  });

  it('throws plain Error after transient budget exhausted (6 attempts: initial + 5 retries)', async () => {
    vi.useFakeTimers();
    // Stage 6 transient responses (5xx). The schedule was extended to
    // [1s, 2s, 4s, 8s, 16s] in 2.7.4 to cover GitHub's Pages-auth
    // visibility-propagation cache (>7s on Free-tier). Total wait ~31s.
    for (let i = 0; i < 6; i++) {
      vi.mocked(execa).mockResolvedValueOnce({
        exitCode: 1, stdout: '', stderr: 'gh: HTTP 503 Service Unavailable',
      } as never);
    }

    const promise = ghJson('api', 'user');
    let caught: unknown;
    const settled = promise.catch(e => { caught = e; });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(16000);
    await settled;

    expect(caught).toBeInstanceOf(Error);
    // Plain Error, not VaultkitError
    expect(isVaultkitError(caught)).toBe(false);
    expect(String((caught as Error).message)).toMatch(/exhausted retry budget|HTTP 503/);
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(6);
  });
});

describe('ghJson succeeds after retries', () => {
  it('returns body when transient failure is followed by success', async () => {
    vi.useFakeTimers();
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 1, stdout: '', stderr: 'gh: HTTP 502 Bad Gateway',
    } as never);
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 0, stdout: '{"recovered":true}', stderr: '',
    } as never);

    const promise = ghJson('api', 'user');
    let result: string | undefined;
    const settled = promise.then(r => { result = r; });
    await vi.advanceTimersByTimeAsync(1000); // first transient sleep
    await settled;

    expect(result).toBe('{"recovered":true}');
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(2);
  });

  it('returns body when rate-limit failure is followed by success', async () => {
    vi.useFakeTimers();
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 1,
      stdout: JSON.stringify({ message: 'You have exceeded a secondary rate limit.' }),
      stderr: '',
    } as never);
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 0, stdout: '{"ok":true}', stderr: '',
    } as never);

    const promise = ghJson('api', 'user');
    let result: string | undefined;
    const settled = promise.then(r => { result = r; });
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;

    expect(result).toBe('{"ok":true}');
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(2);
  });

  it('does not reset the transient counter when a rate-limit error appears mid-sequence', async () => {
    vi.useFakeTimers();
    // Transient schedule is [1, 2, 4, 8, 16]s = 5 retry slots. Stage 5
    // transients (consuming all 5 slots, counter=5) + 1 rate-limit + 1
    // transient. The rate-limit uses its own counter. After the
    // rate-limit retry, the next transient should EXHAUST the transient
    // budget (counter is still 5, no more slots). Total: 7 execa calls.
    for (let i = 0; i < 5; i++) {
      vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'HTTP 503' } as never);
    }
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 1,
      stdout: JSON.stringify({ message: 'You have exceeded a secondary rate limit.' }),
      stderr: '',
    } as never);
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'HTTP 503' } as never);

    const promise = ghJson('api', 'user');
    let caught: unknown;
    const settled = promise.catch(e => { caught = e; });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(16000);
    await vi.advanceTimersByTimeAsync(60_000); // rate-limit retry
    await settled;

    // 7 calls made; 6th transient exhausted budget → plain Error
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(7);
    expect(isVaultkitError(caught)).toBe(false);
    expect(String((caught as Error).message)).toMatch(/exhausted retry budget/);
  });
});
