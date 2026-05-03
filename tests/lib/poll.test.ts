import { describe, it, expect, vi } from 'vitest';
import { pollUntil } from '../../src/lib/poll.js';
import { isVaultkitError } from '../../src/lib/errors.js';

describe('pollUntil', () => {
  it('returns immediately when the predicate is satisfied on the first read', async () => {
    const read = vi.fn().mockResolvedValue('public');
    const result = await pollUntil(read, (v) => v === 'public', { intervalMs: 10 });
    expect(result).toBe('public');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('polls until the predicate flips to true', async () => {
    let attempt = 0;
    const read = vi.fn().mockImplementation(async () => {
      attempt += 1;
      return attempt < 3 ? 'private' : 'public';
    });
    const result = await pollUntil(read, (v) => v === 'public', { intervalMs: 1 });
    expect(result).toBe('public');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('throws VaultkitError("NETWORK_TIMEOUT") when the predicate never becomes true', async () => {
    const read = vi.fn().mockResolvedValue('private');
    let caught: unknown;
    try {
      await pollUntil(read, (v) => v === 'public', {
        timeoutMs: 50,
        intervalMs: 10,
        description: 'fixture visibility=public',
      });
    } catch (err) {
      caught = err;
    }
    expect(isVaultkitError(caught)).toBe(true);
    if (isVaultkitError(caught)) {
      expect(caught.code).toBe('NETWORK_TIMEOUT');
      expect(caught.message).toContain('fixture visibility=public');
      expect(caught.message).toContain('private'); // last-observed value in the message
    }
  });

  it('propagates errors from the read function without retrying', async () => {
    const read = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(pollUntil(read, () => true, { intervalMs: 10 })).rejects.toThrow('boom');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('always invokes read at least once even with a tiny timeout', async () => {
    const read = vi.fn().mockResolvedValue('public');
    const result = await pollUntil(read, (v) => v === 'public', { timeoutMs: 0, intervalMs: 1 });
    expect(result).toBe('public');
    expect(read).toHaveBeenCalledTimes(1);
  });
});
