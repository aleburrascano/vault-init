import { describe, it, expect, beforeEach, vi } from 'vitest';
import { arrayLogger } from '../helpers/logger.js';

vi.mock('@inquirer/prompts', () => ({ input: vi.fn() }));
vi.mock('execa', async (importOriginal) => {
  const real = await importOriginal<typeof import('execa')>();
  return { ...real, execa: vi.fn() };
});
vi.mock('../../src/lib/platform.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/platform.js')>();
  return { ...real, findTool: vi.fn(), installGhForPlatform: vi.fn() };
});

import { input } from '@inquirer/prompts';
import { execa } from 'execa';
import { findTool, installGhForPlatform } from '../../src/lib/platform.js';
import {
  checkNode,
  ensureGh,
  ensureGhAuth,
  ensureGitConfig,
} from '../../src/lib/prereqs.js';
import { isVaultkitError } from '../../src/lib/errors.js';

beforeEach(() => {
  vi.mocked(input).mockReset();
  vi.mocked(execa).mockReset();
  vi.mocked(findTool).mockReset();
  vi.mocked(installGhForPlatform).mockReset();
});

describe('ensureGhAuth', () => {
  // Item 2: hot path on every `vaultkit init` run — only the live init
  // block (Ubuntu CI) exercises it today; on Windows it has zero coverage.
  it('returns immediately when authed and scopes is undefined (init preflight shape)', async () => {
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') {
        return { exitCode: 0, stdout: '', stderr: "Token scopes: 'gist'" };
      }
      throw new Error(`unexpected execa call: ${args?.join(' ')}`);
    }) as never);

    await ensureGhAuth({ ghPath: '/usr/bin/gh', log: arrayLogger([]) });

    // Only the auth status probe should run; no login, no refresh.
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(execa).mock.calls[0]?.[1]).toEqual(['auth', 'status']);
  });

  it('returns immediately when authed and scopes is an empty array', async () => {
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') {
        return { exitCode: 0, stdout: '', stderr: "Token scopes: 'gist'" };
      }
      throw new Error(`unexpected execa call: ${args?.join(' ')}`);
    }) as never);

    await ensureGhAuth({ ghPath: '/usr/bin/gh', log: arrayLogger([]), scopes: [] });

    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1);
  });

  // Item 3a: not-authed + no scopes → bare `gh auth login` argv (no -s flag).
  it('invokes `gh auth login` with no -s when not authed and no scopes requested', async () => {
    const captured: readonly string[][] = [];
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args) (captured as string[][]).push([...args]);
      if (args?.[0] === 'auth' && args?.[1] === 'status') {
        return { exitCode: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' };
      }
      if (args?.[0] === 'auth' && args?.[1] === 'login') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    await ensureGhAuth({ ghPath: '/usr/bin/gh', log: arrayLogger([]) });

    const loginCall = captured.find(c => c[0] === 'auth' && c[1] === 'login');
    expect(loginCall).toEqual(['auth', 'login']);
  });

  // Item 3b: not-authed + scopes → canonical argv `auth login -s repo,workflow`.
  // setup.test.ts only asserts a /repo|workflow/ regex against the joined refresh args;
  // this pins the full shape for the login path.
  it('invokes `gh auth login -s <scopes>` with the canonical argv shape when not authed', async () => {
    const captured: readonly string[][] = [];
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args) (captured as string[][]).push([...args]);
      if (args?.[0] === 'auth' && args?.[1] === 'status') {
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    await ensureGhAuth({
      ghPath: '/usr/bin/gh',
      log: arrayLogger([]),
      scopes: ['repo', 'workflow'],
    });

    const loginCall = captured.find(c => c[0] === 'auth' && c[1] === 'login');
    expect(loginCall).toEqual(['auth', 'login', '-s', 'repo,workflow']);
  });

  // Item 4: authed + every requested scope already present in stderr → no refresh call.
  // Today only the partial-missing path is tested (setup.test.ts:58-88).
  it('does not invoke refresh when all requested scopes are already present', async () => {
    const captured: readonly string[][] = [];
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args) (captured as string[][]).push([...args]);
      if (args?.[0] === 'auth' && args?.[1] === 'status') {
        return {
          exitCode: 0,
          stdout: '',
          stderr: "Token scopes: 'repo', 'workflow', 'gist'",
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    await ensureGhAuth({
      ghPath: '/usr/bin/gh',
      log: arrayLogger([]),
      scopes: ['repo', 'workflow'],
    });

    const refreshCall = captured.find(c => c[0] === 'auth' && c[1] === 'refresh');
    expect(refreshCall).toBeUndefined();
  });

  // Item 3 extension: pin the canonical refresh argv shape.
  // setup.test.ts:85-87 asserts `'refresh'` is in args and `repo|workflow` is joined,
  // but does not pin `-h github.com`. This test fails if a future PR drops it.
  it('refreshes with the canonical `auth refresh -h github.com -s <missing>` argv shape', async () => {
    const captured: readonly string[][] = [];
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args) (captured as string[][]).push([...args]);
      if (args?.[0] === 'auth' && args?.[1] === 'status') {
        return { exitCode: 0, stdout: '', stderr: "Token scopes: 'gist'" };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    await ensureGhAuth({
      ghPath: '/usr/bin/gh',
      log: arrayLogger([]),
      scopes: ['repo', 'workflow'],
    });

    const refreshCall = captured.find(c => c[0] === 'auth' && c[1] === 'refresh');
    expect(refreshCall).toEqual(['auth', 'refresh', '-h', 'github.com', '-s', 'repo,workflow']);
  });

  // Item 9 (probable latent bug): the scope-presence check uses
  // `new RegExp(\`'${s}'\`)` with no escaping. A scope name containing a
  // regex meta-char (e.g. `.`) becomes a pattern, not a literal. Today's
  // hard-coded scopes (`repo`, `workflow`, `gist`) contain no meta-chars
  // so the bug is latent; this test guards against future scopes (e.g.
  // `read:org` or anything with `.`, `*`, `|`, `(`).
  it('treats scope name with regex meta-chars literally (not as a regex pattern)', async () => {
    const captured: readonly string[][] = [];
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args) (captured as string[][]).push([...args]);
      if (args?.[0] === 'auth' && args?.[1] === 'status') {
        // Haystack contains 'aXb' but NOT the literal scope 'a.b'.
        // The naive regex `/'a.b'/` would match 'aXb' (false positive)
        // and conclude the scope is satisfied → no refresh invoked.
        return { exitCode: 0, stdout: '', stderr: "Token scopes: 'aXb', 'gist'" };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    await ensureGhAuth({
      ghPath: '/usr/bin/gh',
      log: arrayLogger([]),
      scopes: ['a.b'],
    });

    // The scope 'a.b' is genuinely missing — refresh MUST be invoked to
    // request it. If the regex matches 'aXb' and short-circuits, this fails.
    const refreshCall = captured.find(c => c[0] === 'auth' && c[1] === 'refresh');
    expect(refreshCall).toBeDefined();
    expect(refreshCall).toContain('a.b');
  });

  // ensureGhAuth concatenates stderr + stdout for the scope haystack
  // (prereqs.ts:95). Two real-world variants where the scopes line lands
  // on stdout instead of stderr — older gh, --show-token mode, or
  // localized output.
  it('matches scopes from stdout when "Token scopes:" lands there instead of stderr', async () => {
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') {
        // Stream-flipped: scope list in stdout, stderr empty.
        return { exitCode: 0, stdout: "Token scopes: 'gist', 'repo'", stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    await ensureGhAuth({ ghPath: '/usr/bin/gh', log: arrayLogger([]), scopes: ['gist'] });

    // 'gist' is present in stdout-only haystack → NO refresh invoked.
    const refreshCall = vi.mocked(execa).mock.calls.find(c => {
      const a = c[1] as unknown;
      return Array.isArray(a) && a[0] === 'auth' && a[1] === 'refresh';
    });
    expect(refreshCall).toBeUndefined();
  });

  it('matches scopes when the auth status output is split across stderr and stdout', async () => {
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') {
        // Some gh versions/modes emit the leader on stderr but break the
        // scope list mid-line into stdout. Concat must find both.
        return { exitCode: 0, stdout: "'workflow'", stderr: "Token scopes: 'repo', " };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    await ensureGhAuth({ ghPath: '/usr/bin/gh', log: arrayLogger([]), scopes: ['repo', 'workflow'] });

    // Both scopes appear in stderr+stdout concat → NO refresh invoked.
    const refreshCall = vi.mocked(execa).mock.calls.find(c => {
      const a = c[1] as unknown;
      return Array.isArray(a) && a[0] === 'auth' && a[1] === 'refresh';
    });
    expect(refreshCall).toBeUndefined();
  });

  // Item 10: when `gh auth status` succeeds but its stderr lacks the
  // `Token scopes:` block (older gh versions, localized builds, format
  // drift), every requested scope is currently treated as missing →
  // a refresh is invoked. This pins the current behavior so a regression
  // (e.g. silent skip when no scope line is found) is caught.
  it('invokes refresh for all requested scopes when stderr has no `Token scopes:` line', async () => {
    const captured: readonly string[][] = [];
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args) (captured as string[][]).push([...args]);
      if (args?.[0] === 'auth' && args?.[1] === 'status') {
        // Authenticated, but no `Token scopes:` line at all.
        return {
          exitCode: 0,
          stdout: '',
          stderr: 'Logged in to github.com as octocat (oauth_token)',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    await ensureGhAuth({
      ghPath: '/usr/bin/gh',
      log: arrayLogger([]),
      scopes: ['repo', 'workflow'],
    });

    const refreshCall = captured.find(c => c[0] === 'auth' && c[1] === 'refresh');
    expect(refreshCall).toBeDefined();
    // All requested scopes should be in the -s argument since none were
    // detected as already present.
    expect(refreshCall).toEqual(['auth', 'refresh', '-h', 'github.com', '-s', 'repo,workflow']);
  });
});

describe('ensureGitConfig', () => {
  // Item 5a: both opts provided + git config empty → no inquirer call,
  // two git config writes with the supplied values.
  it('skips inquirer prompts when both nameOpt and emailOpt are provided', async () => {
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      // user.name and user.email both empty → would normally prompt.
      if (args?.[0] === 'config') return { exitCode: 0, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    await ensureGitConfig({ nameOpt: 'Alice', emailOpt: 'alice@example.com' });

    expect(vi.mocked(input)).not.toHaveBeenCalled();
    const writes = vi.mocked(execa).mock.calls
      .map(c => c[1] as readonly string[] | undefined)
      .filter((a): a is readonly string[] => Array.isArray(a) && a[0] === 'config' && a[1] === '--global');
    expect(writes).toEqual([
      ['config', '--global', 'user.name', 'Alice'],
      ['config', '--global', 'user.email', 'alice@example.com'],
    ]);
  });

  // Item 5b: only nameOpt provided + email config empty → input prompted once
  // for email, never for name.
  it('prompts only for the missing field when one opt is provided', async () => {
    vi.mocked(input).mockResolvedValue('alice@example.com');
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'config' && args?.[1] === 'user.name') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args?.[0] === 'config' && args?.[1] === 'user.email') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    await ensureGitConfig({ nameOpt: 'Alice' });

    expect(vi.mocked(input)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(input).mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringMatching(/email/i),
    });
  });

  // Item 5d: empty-string opt passes through verbatim (nullish-coalesce
  // short-circuits only on null/undefined, NOT on ''). Pin this current
  // behavior — `git config --global user.name ""` is what gets written.
  // A future "treat empty string as missing" change is a UX improvement
  // but a behavior change that this test will surface in the diff.
  it('writes an empty user.name when nameOpt is the empty string (latent UX issue)', async () => {
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'config' && args?.[1] === 'user.name') {
        return { exitCode: 0, stdout: '', stderr: '' }; // not set yet
      }
      if (args?.[0] === 'config' && args?.[1] === 'user.email') {
        return { exitCode: 0, stdout: 'already@set.com', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    await ensureGitConfig({ nameOpt: '' });

    // input() was NOT called — the empty string short-circuited the prompt.
    expect(vi.mocked(input)).not.toHaveBeenCalled();
    const writes = vi.mocked(execa).mock.calls
      .map(c => c[1] as readonly string[] | undefined)
      .filter((a): a is readonly string[] => Array.isArray(a) && a[0] === 'config' && a[1] === '--global');
    expect(writes).toEqual([['config', '--global', 'user.name', '']]);
  });

  // CRLF stdout from `git config` is the Windows default (git emits
  // platform-native line endings). The .trim() at prereqs.ts:117/121
  // handles trailing \r\n — pin this with explicit CRLF fixtures so a
  // regression to a substring check (or a switch from .trim() to
  // .trimEnd-with-\n-only) surfaces here instead of in production.
  it('treats CRLF-terminated stdout as a populated value (Windows git default)', async () => {
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'config' && args?.[1] === 'user.name') {
        return { exitCode: 0, stdout: 'Existing User\r\n', stderr: '' };
      }
      if (args?.[0] === 'config' && args?.[1] === 'user.email') {
        return { exitCode: 0, stdout: 'existing@example.com\r\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    await ensureGitConfig();

    expect(vi.mocked(input)).not.toHaveBeenCalled();
    const writes = vi.mocked(execa).mock.calls
      .map(c => c[1] as readonly string[] | undefined)
      .filter((a): a is readonly string[] => Array.isArray(a) && a[0] === 'config' && a[1] === '--global');
    expect(writes).toEqual([]);
  });

  // Item 5c: both fields already set in git config → no inquirer, no writes.
  it('is a no-op when git config already has both name and email', async () => {
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'config' && args?.[1] === 'user.name') {
        return { exitCode: 0, stdout: 'Existing User', stderr: '' };
      }
      if (args?.[0] === 'config' && args?.[1] === 'user.email') {
        return { exitCode: 0, stdout: 'existing@example.com', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    await ensureGitConfig();

    expect(vi.mocked(input)).not.toHaveBeenCalled();
    const writes = vi.mocked(execa).mock.calls
      .map(c => c[1] as readonly string[] | undefined)
      .filter((a): a is readonly string[] => Array.isArray(a) && a[0] === 'config' && a[1] === '--global');
    expect(writes).toEqual([]);
  });
});

describe('ensureGh', () => {
  // Item 6a: gh already on PATH → fast-path return, NO install attempt.
  // A regression that always invokes installGhForPlatform (e.g. running
  // winget on every init) would only show as a slowdown — pin it.
  it('returns the gh path immediately when findTool succeeds on the first call', async () => {
    vi.mocked(findTool).mockResolvedValueOnce('/usr/bin/gh');

    const result = await ensureGh({ log: arrayLogger([]), skipInstallCheck: false });
    expect(result).toBe('/usr/bin/gh');
    expect(vi.mocked(installGhForPlatform)).not.toHaveBeenCalled();
    expect(vi.mocked(findTool)).toHaveBeenCalledTimes(1);
  });

  // Item 6: install-then-still-missing → throws VaultkitError('TOOL_MISSING').
  // Realistic on Windows when the new winget-installed gh isn't yet on PATH.
  it("throws TOOL_MISSING when install succeeds but findTool still can't locate gh", async () => {
    vi.mocked(findTool).mockResolvedValue(null);
    vi.mocked(installGhForPlatform).mockResolvedValue(undefined);

    await expect(
      ensureGh({ log: arrayLogger([]), skipInstallCheck: true }),
    ).rejects.toMatchObject({
      name: 'VaultkitError',
      code: 'TOOL_MISSING',
    });

    // Sanity: install was attempted exactly once, findTool was called twice
    // (before and after install).
    expect(vi.mocked(installGhForPlatform)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(findTool)).toHaveBeenCalledTimes(2);
  });

  // Item 7: installGhForPlatform throws → underlying error escapes uncaught.
  it('propagates the underlying error when installGhForPlatform throws', async () => {
    vi.mocked(findTool).mockResolvedValue(null);
    vi.mocked(installGhForPlatform).mockRejectedValue(new Error('winget exited 1'));

    await expect(
      ensureGh({ log: arrayLogger([]), skipInstallCheck: true }),
    ).rejects.toThrow(/winget exited 1/);

    // It should NOT have been wrapped in a VaultkitError — the install failure
    // surfaces verbatim so the caller (setup.ts) can log it as `x fail`.
    try {
      await ensureGh({ log: arrayLogger([]), skipInstallCheck: true });
    } catch (err) {
      expect(isVaultkitError(err)).toBe(false);
    }
  });
});

describe('checkNode', () => {
  // Item 8: pin the boundary. Today the assertion is "whatever Node CI runs"
  // — we never actually exercise the major < 22 branch in a controlled way.
  const stubNodeVersion = (v: string) => {
    const original = Object.getOwnPropertyDescriptor(process.versions, 'node');
    Object.defineProperty(process.versions, 'node', {
      configurable: true,
      get: () => v,
    });
    return () => {
      if (original) Object.defineProperty(process.versions, 'node', original);
    };
  };

  it('returns ok=false with an actionable message when major < 22', () => {
    const restore = stubNodeVersion('21.7.3');
    try {
      const result = checkNode();
      expect(result.ok).toBe(false);
      expect(result.version).toBe('21.7.3');
      expect(result.message).toMatch(/Node\.js 22\+/);
    } finally {
      restore();
    }
  });

  it('returns ok=true at the lower boundary (22.0.0)', () => {
    const restore = stubNodeVersion('22.0.0');
    try {
      const result = checkNode();
      expect(result.ok).toBe(true);
      expect(result.version).toBe('22.0.0');
    } finally {
      restore();
    }
  });

  it('returns ok=true above the boundary (23.x)', () => {
    const restore = stubNodeVersion('23.4.5');
    try {
      const result = checkNode();
      expect(result.ok).toBe(true);
    } finally {
      restore();
    }
  });

  it('pins the success message format ("node: v<version>")', () => {
    // checkNode at prereqs.ts:34 returns `node: v${version}`. A copy
    // change (e.g. dropping the leading `v` or adding a suffix) would
    // pass every existing test that only asserts ok === true. The
    // failure-path message is already pinned by regex; pin success too.
    const restore = stubNodeVersion('22.5.0');
    try {
      const result = checkNode();
      expect(result.message).toBe('node: v22.5.0');
    } finally {
      restore();
    }
  });
});
