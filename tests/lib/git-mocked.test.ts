import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execa } from 'execa';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('../../src/lib/platform.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/platform.js')>();
  return { ...real, findTool: vi.fn() };
});

import { pushNewRepo, pushOrPr } from '../../src/lib/git.js';
import { findTool } from '../../src/lib/platform.js';
import { isVaultkitError } from '../../src/lib/errors.js';

const ACCOUNT_FLAGGED_STDERR =
  "remote: Repository 'fluids2/vk-live-visibility-1777742512681' is disabled.\n" +
  'remote: Please ask the owner to check their account.\n' +
  "fatal: unable to access 'https://github.com/fluids2/vk-live-visibility-1777742512681.git/': The requested URL returned error: 403";

beforeEach(() => {
  vi.mocked(execa).mockReset();
  vi.mocked(findTool).mockReset();
  vi.mocked(findTool).mockResolvedValue('/usr/bin/gh');
});

describe('pushNewRepo: account-flagged recognition', () => {
  it('throws VaultkitError(AUTH_REQUIRED) on first detection — does not retry', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 128, stdout: '', stderr: ACCOUNT_FLAGGED_STDERR,
    } as never);
    await expect(pushNewRepo('/tmp/vault', 'main')).rejects.toSatisfy((err) => {
      return isVaultkitError(err) && err.code === 'AUTH_REQUIRED' && /abuse-flag/i.test(err.message);
    });
    // Crucial: only one execa call. The retry budget is preserved for
    // genuinely transient failures (eventual-consistency races).
    expect(vi.mocked(execa).mock.calls).toHaveLength(1);
  });

  it('still retries on a transient "Repository not found" race', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: 'remote: Repository not found.' } as never)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never);
    await expect(pushNewRepo('/tmp/vault', 'main')).resolves.toBeUndefined();
    expect(vi.mocked(execa).mock.calls).toHaveLength(2);
  });
});

describe('pushOrPr: account-flagged recognition', () => {
  it('bails out before creating a PR branch when the direct push reveals account-flag', async () => {
    // First call is `git push` (direct). Returns the disabled-repo stderr.
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 128, stdout: '', stderr: ACCOUNT_FLAGGED_STDERR,
    } as never);
    await expect(
      pushOrPr('/tmp/vault', { branchPrefix: 'vaultkit-pages', prTitle: 'x', prBody: 'y' }),
    ).rejects.toSatisfy((err) => {
      return isVaultkitError(err) && err.code === 'AUTH_REQUIRED';
    });
    // Only the direct-push attempt happened — we did NOT proceed to
    // create a branch + push it + create a PR.
    expect(vi.mocked(execa).mock.calls).toHaveLength(1);
  });

  it('throws AUTH_REQUIRED when the branch push fails with disabled-repo stderr', async () => {
    // 1. direct push fails (any reason) → fall through to PR branch flow.
    // 2. git branch       → ok
    // 3. git reset --hard → ok
    // 4. git checkout     → ok
    // 5. git push branch  → fails with disabled-repo
    vi.mocked(execa)
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'rejected — non-fast-forward' } as never)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)
      .mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: ACCOUNT_FLAGGED_STDERR } as never);
    await expect(
      pushOrPr('/tmp/vault', { branchPrefix: 'vaultkit-pages', prTitle: 'x', prBody: 'y' }),
    ).rejects.toSatisfy((err) => isVaultkitError(err) && err.code === 'AUTH_REQUIRED');
  });
});
