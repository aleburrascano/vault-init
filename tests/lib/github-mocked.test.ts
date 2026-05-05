import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('../../src/lib/platform.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/platform.js')>();
  return { ...real, findTool: vi.fn() };
});

import {
  createRepo,
  deleteRepo,
  repoExists,
  isAdmin,
  getVisibility,
  setRepoVisibility,
  repoUrl,
  repoCloneUrl,
} from '../../src/lib/github/github-repo.js';
import {
  enablePages,
  setPagesVisibility,
  disablePages,
  pagesExist,
  getPagesVisibility,
  pagesUrl,
} from '../../src/lib/github/github-pages.js';
import {
  getCurrentUser,
  getUserPlan,
  isAuthenticated,
  ensureDeleteRepoScope,
} from '../../src/lib/github/github-auth.js';
import { findTool } from '../../src/lib/platform.js';

const GH_PATH = '/usr/bin/gh';

beforeEach(() => {
  vi.mocked(execa).mockReset();
  vi.mocked(findTool).mockReset();
  vi.mocked(findTool).mockResolvedValue(GH_PATH);
  vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);
});

function lastArgs(): string[] {
  const calls = vi.mocked(execa).mock.calls;
  return calls[calls.length - 1]?.[1] as string[];
}

function firstArgs(): string[] {
  const calls = vi.mocked(execa).mock.calls;
  return calls[0]?.[1] as string[];
}

/**
 * Default mock returns `{exitCode: 0, stdout: ''}`. That's fine for
 * one-shot wrappers (createRepo, deleteRepo) but breaks wrappers that
 * now poll for confirmation (setRepoVisibility, enablePages) — the
 * poll's read call gets `stdout: ''` and JSON.parse('') throws. Stages
 * a sequence: first call (the mutation) + a typed read response (the
 * poll's first observation, immediately satisfying the predicate).
 */
function stageMutationThenReadOk(readJson: object): void {
  vi.mocked(execa)
    .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)
    .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify(readJson), stderr: '' } as never);
}

describe('createRepo', () => {
  // Migrated to `gh api --include POST /user/repos` so the retry layer
  // can read X-RateLimit-* / Retry-After headers. Argv shape changed;
  // the security invariant (validated vault name → POST body) is preserved.
  it('passes private=true by default via gh api', async () => {
    await createRepo('myrepo');
    expect(lastArgs()).toEqual([
      'api', '--include', '--method', 'POST', '/user/repos',
      '-f', 'name=myrepo',
      '-F', 'private=true',
    ]);
  });

  it('passes private=false when visibility=public', async () => {
    await createRepo('myrepo', { visibility: 'public' });
    expect(lastArgs()).toEqual([
      'api', '--include', '--method', 'POST', '/user/repos',
      '-f', 'name=myrepo',
      '-F', 'private=false',
    ]);
  });

  it('throws if gh exits non-zero with a fatal stderr', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'name taken' } as never);
    await expect(createRepo('myrepo')).rejects.toThrow(/name taken/);
  });
});

describe('deleteRepo', () => {
  // Migrated to `gh api --include DELETE /repos/<slug>` for header-aware
  // retry. Argv shape changed; the isAdmin + typed-name confirmation
  // precondition (security invariant) is the caller's responsibility and
  // unchanged.
  it('issues DELETE /repos/<slug> via gh api', async () => {
    await deleteRepo('owner/repo');
    expect(lastArgs()).toEqual([
      'api', '--include', '--method', 'DELETE', '/repos/owner/repo',
    ]);
  });

  it('throws on non-zero exit', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not found' } as never);
    await expect(deleteRepo('owner/repo')).rejects.toThrow(/not found/);
  });
});

describe('repoExists', () => {
  it('returns true when gh repo view exits 0', async () => {
    expect(await repoExists('owner/repo')).toBe(true);
    expect(lastArgs()).toEqual(['repo', 'view', 'owner/repo']);
  });

  it('returns false on non-zero exit', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' } as never);
    expect(await repoExists('owner/missing')).toBe(false);
  });
});

describe('isAdmin', () => {
  it('returns true when gh api responds with permissions.admin=true', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ permissions: { admin: true }, visibility: 'private' }),
      stderr: '',
    } as never);
    expect(await isAdmin('owner/repo')).toBe(true);
    expect(lastArgs()).toEqual(['api', 'repos/owner/repo']);
  });

  it('returns false when permissions.admin missing or false', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ permissions: { admin: false }, visibility: 'private' }),
      stderr: '',
    } as never);
    expect(await isAdmin('owner/repo')).toBe(false);
  });

  it('returns false when api call errors (catch-all)', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'Not Found' } as never);
    expect(await isAdmin('owner/repo')).toBe(false);
  });
});

describe('getVisibility', () => {
  it('returns the visibility field', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ visibility: 'public', permissions: { admin: false } }),
      stderr: '',
    } as never);
    expect(await getVisibility('owner/repo')).toBe('public');
  });

  it('throws on non-zero exit', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'forbidden' } as never);
    await expect(getVisibility('owner/repo')).rejects.toThrow(/forbidden/);
  });
});

describe('setRepoVisibility', () => {
  // Migrated to `gh api --include PATCH /repos/<slug> -f visibility=<v>`.
  // Now polls getVisibility post-PATCH to confirm the change has propagated
  // to the read endpoint before returning — see github.ts comment for why.
  // The "previous visibility change is still in progress" 422 race on the
  // PATCH itself is still classified as transient inside _classifyGhFailure.
  it('issues PATCH /repos/<slug> via gh api with visibility field, then polls until visible', async () => {
    stageMutationThenReadOk({ visibility: 'public', permissions: { admin: false } });
    await setRepoVisibility('owner/repo', 'public');
    // First call: the PATCH (the assertion we care about)
    expect(firstArgs()).toEqual([
      'api', '--include', '--method', 'PATCH', '/repos/owner/repo',
      '-f', 'visibility=public',
    ]);
    // Second call: the poll's read (sanity check — it ran)
    expect(lastArgs()).toEqual(['api', 'repos/owner/repo']);
  });

  it('passes private when target is private', async () => {
    stageMutationThenReadOk({ visibility: 'private', permissions: { admin: false } });
    await setRepoVisibility('owner/repo', 'private');
    expect(firstArgs()).toContain('visibility=private');
  });

  it('throws on a fatal non-zero gh exit before polling', async () => {
    // "rate limit" plain text without any of the recognized phrases
    // (secondary/abuse/HTTP 429) falls through to fatal — same behavior
    // as before for unclassified failures. Poll never runs.
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'rate limit' } as never);
    await expect(setRepoVisibility('owner/repo', 'public')).rejects.toThrow(/rate limit/);
    expect(vi.mocked(execa).mock.calls).toHaveLength(1); // PATCH only, no poll
  });
});

describe('enablePages', () => {
  // Now polls pagesExist post-POST to confirm the Pages site is provisioned
  // before returning, mirroring setRepoVisibility's poll-after-mutate pattern.
  it('issues POST /pages with build_type=workflow then polls until pagesExist', async () => {
    // Default mock returns exitCode: 0, which makes pagesExist return true.
    // So the poll succeeds on its first read.
    await enablePages('owner/repo');
    // First call: the POST (the assertion we care about)
    expect(firstArgs()).toEqual([
      'api', 'repos/owner/repo/pages', '--method', 'POST',
      '--field', 'build_type=workflow',
      '--field', 'source[branch]=main',
      '--field', 'source[path]=/',
    ]);
    // Second call: pagesExist's GET (sanity check — it ran)
    expect(lastArgs()).toEqual(['api', 'repos/owner/repo/pages']);
  });

  it('honors buildType=legacy', async () => {
    await enablePages('owner/repo', { buildType: 'legacy' });
    const args = firstArgs();
    const idx = args.indexOf('build_type=legacy');
    expect(idx).toBeGreaterThan(-1);
  });
});

describe('setPagesVisibility', () => {
  // Now polls getPagesVisibility post-PUT to confirm the change has
  // propagated to the read endpoint, mirroring setRepoVisibility and
  // enablePages's poll-after-mutate pattern.
  it('passes public=true for public visibility, then polls until confirmed', async () => {
    stageMutationThenReadOk({ public: true });
    await setPagesVisibility('owner/repo', 'public');
    expect(firstArgs()).toEqual([
      'api', 'repos/owner/repo/pages', '--method', 'PUT',
      '--field', 'public=true',
    ]);
    expect(lastArgs()).toEqual(['api', 'repos/owner/repo/pages']); // poll's GET
  });

  it('passes public=false for private visibility', async () => {
    stageMutationThenReadOk({ public: false });
    await setPagesVisibility('owner/repo', 'private');
    expect(firstArgs()).toContain('public=false');
  });
});

describe('disablePages', () => {
  it('issues a DELETE on the pages endpoint', async () => {
    await disablePages('owner/repo');
    expect(lastArgs()).toEqual([
      'api', 'repos/owner/repo/pages', '--method', 'DELETE',
    ]);
  });

  it('does not throw on non-zero exit (uses gh, not ghJson)', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' } as never);
    await expect(disablePages('owner/repo')).resolves.toBeUndefined();
  });
});

describe('pagesExist', () => {
  it('returns true on exit 0', async () => {
    expect(await pagesExist('owner/repo')).toBe(true);
  });

  it('returns false on non-zero', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' } as never);
    expect(await pagesExist('owner/repo')).toBe(false);
  });
});

describe('getPagesVisibility', () => {
  it('returns null when pages do not exist', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' } as never);
    expect(await getPagesVisibility('owner/repo')).toBeNull();
  });

  it('returns "public" when public=true', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 0, stdout: JSON.stringify({ public: true }), stderr: '',
    } as never);
    expect(await getPagesVisibility('owner/repo')).toBe('public');
  });

  it('returns "private" when public=false', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 0, stdout: JSON.stringify({ public: false }), stderr: '',
    } as never);
    expect(await getPagesVisibility('owner/repo')).toBe('private');
  });
});

describe('getCurrentUser', () => {
  it('parses login from gh api user', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 0, stdout: JSON.stringify({ login: 'octocat' }), stderr: '',
    } as never);
    expect(await getCurrentUser()).toBe('octocat');
    expect(lastArgs()).toEqual(['api', 'user']);
  });

  it('throws if login is missing', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 0, stdout: JSON.stringify({}), stderr: '',
    } as never);
    await expect(getCurrentUser()).rejects.toThrow(/login field missing/);
  });
});

describe('getUserPlan', () => {
  it('returns plan.name when present', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 0, stdout: JSON.stringify({ login: 'a', plan: { name: 'pro' } }), stderr: '',
    } as never);
    expect(await getUserPlan()).toBe('pro');
  });

  it('returns "free" when plan is missing', async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      exitCode: 0, stdout: JSON.stringify({ login: 'a' }), stderr: '',
    } as never);
    expect(await getUserPlan()).toBe('free');
  });
});

describe('isAuthenticated', () => {
  it('returns true when gh auth status exits 0', async () => {
    expect(await isAuthenticated()).toBe(true);
    expect(lastArgs()).toEqual(['auth', 'status']);
  });

  it('returns false when gh auth status exits non-zero', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' } as never);
    expect(await isAuthenticated()).toBe(false);
  });
});

describe('ensureDeleteRepoScope', () => {
  // ensureDeleteRepoScope early-returns when GH_TOKEN is set (PAT auth, eg CI).
  // Clear it so these tests exercise the interactive-refresh path they assert on.
  let savedGhToken: string | undefined;
  beforeEach(() => {
    savedGhToken = process.env.GH_TOKEN;
    delete process.env.GH_TOKEN;
  });
  afterEach(() => {
    if (savedGhToken !== undefined) process.env.GH_TOKEN = savedGhToken;
  });

  it('runs gh auth refresh with delete_repo scope (interactive, no timeout)', async () => {
    await ensureDeleteRepoScope();
    const lastCall = vi.mocked(execa).mock.calls[vi.mocked(execa).mock.calls.length - 1];
    expect(lastCall?.[0]).toBe(GH_PATH);
    expect(lastCall?.[1]).toEqual([
      'auth', 'refresh', '-h', 'github.com', '-s', 'delete_repo',
    ]);
  });

  it('throws if gh CLI cannot be found', async () => {
    vi.mocked(findTool).mockResolvedValueOnce(null);
    await expect(ensureDeleteRepoScope()).rejects.toThrow(/gh CLI not found/);
  });

  it('throws AUTH_REQUIRED when gh auth refresh exits non-zero', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'cancelled' } as never);
    await expect(ensureDeleteRepoScope()).rejects.toThrow(/delete_repo|gh auth refresh/);
  });
});

describe('gh CLI not found', () => {
  it('createRepo throws a clear error when gh is missing', async () => {
    vi.mocked(findTool).mockResolvedValueOnce(null);
    await expect(createRepo('r')).rejects.toThrow(/gh CLI not found/);
  });
});

describe('repoUrl', () => {
  it('returns the base URL when no path is given', () => {
    expect(repoUrl('owner/repo')).toBe('https://github.com/owner/repo');
  });

  it('appends a sub-page path', () => {
    expect(repoUrl('owner/repo', 'settings/pages')).toBe('https://github.com/owner/repo/settings/pages');
  });
});

describe('repoCloneUrl', () => {
  it('returns the .git clone URL', () => {
    expect(repoCloneUrl('owner', 'repo')).toBe('https://github.com/owner/repo.git');
  });
});

describe('pagesUrl', () => {
  it('returns the github.io site URL with trailing slash', () => {
    expect(pagesUrl('owner', 'repo')).toBe('https://owner.github.io/repo/');
  });
});
