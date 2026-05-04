import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execa } from 'execa';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('../../src/lib/platform.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/platform.js')>();
  return { ...real, findTool: vi.fn() };
});

import { pushNewRepo, pushOrPr, clone, _classifyCloneFailure } from '../../src/lib/git.js';
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

describe('_classifyCloneFailure: stderr → VaultkitError translation', () => {
  it('returns null for unrecognized stderr (caller re-throws verbatim)', () => {
    expect(_classifyCloneFailure('something completely unrelated', 'a/b')).toBeNull();
    expect(_classifyCloneFailure('', 'a/b')).toBeNull();
  });

  it('classifies "Repository not found" stderr as UNRECOGNIZED_INPUT', () => {
    const err = _classifyCloneFailure('remote: Repository not found.\nfatal: ...', 'owner/missing');
    expect(err).not.toBeNull();
    expect(err?.code).toBe('UNRECOGNIZED_INPUT');
    expect(err?.message).toMatch(/owner\/missing/);
    expect(err?.message).toMatch(/private repo/);
    expect(err?.message).toMatch(/vaultkit setup/);
  });

  it('classifies gh-style "Could not resolve to a Repository" as UNRECOGNIZED_INPUT', () => {
    const err = _classifyCloneFailure(
      "GraphQL error: Could not resolve to a Repository with the name 'foo/bar'.",
      'foo/bar',
    );
    expect(err?.code).toBe('UNRECOGNIZED_INPUT');
  });

  it('classifies SSH "Permission denied (publickey)" as AUTH_REQUIRED', () => {
    const err = _classifyCloneFailure(
      'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
      'owner/private',
    );
    expect(err?.code).toBe('AUTH_REQUIRED');
    expect(err?.message).toMatch(/SSH key/);
    expect(err?.message).toMatch(/HTTPS/);
    expect(err?.message).toMatch(/owner\/private/);
  });

  it('classifies "Could not resolve host" as NETWORK_TIMEOUT', () => {
    const err = _classifyCloneFailure(
      "fatal: unable to access 'https://github.com/x/y/': Could not resolve host: github.com",
      'x/y',
    );
    expect(err?.code).toBe('NETWORK_TIMEOUT');
    expect(err?.message).toMatch(/internet connection/i);
  });

  it('classifies "Failed to connect" as NETWORK_TIMEOUT', () => {
    const err = _classifyCloneFailure(
      'fatal: unable to access ...: Failed to connect to github.com port 443',
      'x/y',
    );
    expect(err?.code).toBe('NETWORK_TIMEOUT');
  });

  it('classifies HTTP 401 as AUTH_REQUIRED', () => {
    const err = _classifyCloneFailure(
      "fatal: unable to access 'https://github.com/x/y/': The requested URL returned error: HTTP 401",
      'x/y',
    );
    expect(err?.code).toBe('AUTH_REQUIRED');
    expect(err?.message).toMatch(/Authentication required/i);
    expect(err?.message).toMatch(/vaultkit setup/);
  });

  it('classifies account-flagged stderr as AUTH_REQUIRED (delegates to existing helper)', () => {
    const err = _classifyCloneFailure(ACCOUNT_FLAGGED_STDERR, 'owner/abused');
    expect(err?.code).toBe('AUTH_REQUIRED');
    expect(err?.message).toMatch(/abuse-flagged/);
  });
});

describe('clone: throws classified VaultkitError on failure', () => {
  it('throws UNRECOGNIZED_INPUT when gh clone fails with not-found', async () => {
    vi.mocked(findTool).mockResolvedValue('/usr/bin/gh');
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 1, stdout: '',
      stderr: "GraphQL: Could not resolve to a Repository with the name 'owner/missing'.",
    } as never);
    let caught: unknown;
    try {
      await clone('owner/missing', '/tmp/dest');
    } catch (err) {
      caught = err;
    }
    expect(isVaultkitError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('UNRECOGNIZED_INPUT');
  });

  it('throws AUTH_REQUIRED when plain git clone fails with publickey error', async () => {
    vi.mocked(findTool).mockResolvedValue(null);
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 128, stdout: '',
      stderr: 'git@github.com: Permission denied (publickey).',
    } as never);
    let caught: unknown;
    try {
      await clone('owner/private', '/tmp/dest', { useGh: false });
    } catch (err) {
      caught = err;
    }
    expect(isVaultkitError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('AUTH_REQUIRED');
  });

  it('throws plain Error (not VaultkitError) for unrecognized stderr — preserves diagnostic', async () => {
    vi.mocked(findTool).mockResolvedValue(null);
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 128, stdout: '',
      stderr: 'fatal: some weird obscure git error nobody has seen before',
    } as never);
    let caught: unknown;
    try {
      await clone('owner/repo', '/tmp/dest', { useGh: false });
    } catch (err) {
      caught = err;
    }
    expect(isVaultkitError(caught)).toBe(false);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/some weird obscure git error/);
    expect((caught as Error).message).toMatch(/owner\/repo/);
  });

  it('returns silently on success', async () => {
    vi.mocked(findTool).mockResolvedValue('/usr/bin/gh');
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 0, stdout: '', stderr: '',
    } as never);
    await expect(clone('owner/repo', '/tmp/dest')).resolves.toBeUndefined();
  });
});
