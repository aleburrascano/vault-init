import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { arrayLogger } from '../helpers/logger.js';

vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn() }));
vi.mock('execa', async (importOriginal) => {
  const real = await importOriginal<typeof import('execa')>();
  return { ...real, execa: vi.fn() };
});

import { confirm } from '@inquirer/prompts';
import { execa } from 'execa';
import { installGhForPlatform } from '../../src/lib/platform.js';
import { isVaultkitError } from '../../src/lib/errors.js';

let origPlatform: NodeJS.Platform;

beforeEach(() => {
  origPlatform = process.platform;
  vi.mocked(confirm).mockReset();
  vi.mocked(execa).mockReset();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: origPlatform, writable: true });
});

describe('installGhForPlatform', () => {
  it('on Windows with skipInstallCheck=true, invokes winget with the full canonical argv', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);

    await installGhForPlatform({ log: arrayLogger([]), skipInstallCheck: true });

    // confirm() must NOT be invoked when skipInstallCheck is set.
    expect(vi.mocked(confirm)).not.toHaveBeenCalled();

    // winget argv shape (per platform.ts:166): the full set of flags
    // matters — `-e` (exact match), `--accept-package-agreements`,
    // `--accept-source-agreements`. A regression that drops `-e` could
    // match the wrong package (`GitHub.cli` matches partial names).
    const wingetCall = vi.mocked(execa).mock.calls.find(c => c[0] === 'winget');
    expect(wingetCall).toBeDefined();
    expect(wingetCall?.[1]).toEqual([
      'install', '--id', 'GitHub.cli', '-e',
      '--accept-package-agreements', '--accept-source-agreements',
    ]);
  });

  it('on Windows with confirm() returning false, does NOT invoke winget', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
    vi.mocked(confirm).mockResolvedValue(false);

    await installGhForPlatform({ log: arrayLogger([]), skipInstallCheck: false });

    expect(vi.mocked(confirm)).toHaveBeenCalledTimes(1);
    const wingetCall = vi.mocked(execa).mock.calls.find(c => c[0] === 'winget');
    expect(wingetCall).toBeUndefined();
  });

  it('on darwin with brew available, invokes `brew install gh`', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
    vi.mocked(execa).mockImplementation((async (cmd: string, args?: readonly string[]) => {
      // `which brew` succeeds → falls into the brew branch.
      if (cmd === 'which' && args?.[0] === 'brew') {
        return { exitCode: 0, stdout: '/opt/homebrew/bin/brew', stderr: '' };
      }
      // brew install completes successfully.
      if (cmd === 'brew') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: 'not found' };
    }) as never);

    await installGhForPlatform({ log: arrayLogger([]) });

    const brewCall = vi.mocked(execa).mock.calls.find(c => c[0] === 'brew');
    expect(brewCall).toBeDefined();
    expect(brewCall?.[1]).toEqual(['install', 'gh']);
  });

  it('throws VaultkitError("TOOL_MISSING") when no platform package manager is available', async () => {
    // Simulate freebsd (or any platform without winget/brew/apt/dnf).
    Object.defineProperty(process, 'platform', { value: 'freebsd', writable: true });
    // All `which <pkg-mgr>` probes return exit 1 (not found).
    vi.mocked(execa).mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'not found' } as never);

    let caught: unknown = null;
    try {
      await installGhForPlatform({ log: arrayLogger([]) });
    } catch (err) {
      caught = err;
    }
    expect(isVaultkitError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('TOOL_MISSING');
    // The error message points at the manual install URL.
    expect((caught as Error).message).toMatch(/cli\.github\.com/);
  });

  it('on darwin without brew, falls through to apt/dnf checks then throws TOOL_MISSING', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
    // `which brew`, `which apt-get`, `which dnf` all exit 1 → throws.
    vi.mocked(execa).mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'not found' } as never);

    let caught: unknown = null;
    try {
      await installGhForPlatform({ log: arrayLogger([]) });
    } catch (err) {
      caught = err;
    }
    expect(isVaultkitError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('TOOL_MISSING');
  });
});
