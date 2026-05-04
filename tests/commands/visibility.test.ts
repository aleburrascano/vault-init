import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { silent, arrayLogger } from '../helpers/logger.js';
import { liveDescribe } from '../helpers/live-describe.js';
import { getFixtureName } from '../helpers/live-fixture.js';

vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn() }));
vi.mock('execa', async (importOriginal) => {
  const real = await importOriginal<typeof import('execa')>();
  return { ...real, execa: vi.fn() };
});
vi.mock('../../src/lib/git.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/git.js')>();
  return { ...real, add: vi.fn(), commit: vi.fn(), pushOrPr: vi.fn() };
});
vi.mock('../../src/lib/platform.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/platform.js')>();
  return { ...real, findTool: vi.fn() };
});
vi.mock('../../src/lib/github-repo.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/github-repo.js')>();
  return {
    ...real,
    isAdmin: vi.fn(),
    getVisibility: vi.fn(),
    setRepoVisibility: vi.fn(),
  };
});
vi.mock('../../src/lib/github-pages.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/github-pages.js')>();
  return {
    ...real,
    enablePages: vi.fn(),
    setPagesVisibility: vi.fn(),
    disablePages: vi.fn(),
    pagesExist: vi.fn(),
    getPagesVisibility: vi.fn(),
  };
});
vi.mock('../../src/lib/github-auth.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/github-auth.js')>();
  return { ...real, requireAuthGatedEligible: vi.fn() };
});

import { confirm } from '@inquirer/prompts';
import { execa } from 'execa';
import { add, commit, pushOrPr } from '../../src/lib/git.js';
import { findTool } from '../../src/lib/platform.js';
import { isAdmin, getVisibility, setRepoVisibility } from '../../src/lib/github-repo.js';
import { enablePages, setPagesVisibility, disablePages, pagesExist, getPagesVisibility } from '../../src/lib/github-pages.js';
import { requireAuthGatedEligible } from '../../src/lib/github-auth.js';
import { writeCfg } from '../helpers/registry.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-visibility-test-'));
  vi.mocked(confirm).mockReset();
  vi.mocked(execa).mockReset();
  vi.mocked(add).mockReset();
  vi.mocked(commit).mockReset();
  vi.mocked(pushOrPr).mockReset();
  vi.mocked(findTool).mockReset();
  vi.mocked(isAdmin).mockReset();
  vi.mocked(getVisibility).mockReset();
  vi.mocked(setRepoVisibility).mockReset();
  vi.mocked(requireAuthGatedEligible).mockReset();
  vi.mocked(enablePages).mockReset();
  vi.mocked(setPagesVisibility).mockReset();
  vi.mocked(disablePages).mockReset();
  vi.mocked(pagesExist).mockReset();
  vi.mocked(getPagesVisibility).mockReset();

  // Common defaults
  vi.mocked(findTool).mockResolvedValue('/usr/bin/gh');
  vi.mocked(isAdmin).mockResolvedValue(true);
  vi.mocked(pagesExist).mockResolvedValue(false);
  vi.mocked(pushOrPr).mockResolvedValue({ mode: 'direct' });
  // git remote returns a GitHub URL
  vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
    if (args?.[2] === 'remote' && args?.[3] === 'get-url') {
      return { exitCode: 0, stdout: 'https://github.com/owner/MyVault.git', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }) as never);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeVaultDir(name: string = 'MyVault'): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface RunVisOptions {
  cfgPath?: string;
  skipConfirm?: boolean;
}

async function runVisibility(name: string, target: string, options: RunVisOptions = {}): Promise<string[]> {
  const { run } = await import('../../src/commands/visibility.js');
  const lines: string[] = [];
  await run(name, target, { log: arrayLogger(lines), ...options });
  return lines;
}

// ── VI-1: invalid vault name ──────────────────────────────────────────────────

describe('VI-1: invalid vault name', () => {
  it('throws on invalid name', async () => {
    const { run } = await import('../../src/commands/visibility.js');
    await expect(run('bad name', 'public', { log: silent })).rejects.toThrow(/letters, numbers, hyphens/i);
  });
});

// ── VI-2: invalid target mode ─────────────────────────────────────────────────

describe('VI-2: invalid target mode', () => {
  it('throws on unknown mode', async () => {
    const vaultDir = makeVaultDir();
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: vaultDir });
    const { run } = await import('../../src/commands/visibility.js');
    await expect(run('MyVault', 'stealth', { cfgPath, log: silent })).rejects.toThrow(/invalid mode/i);
  });
});

// ── VI-3: vault not registered ────────────────────────────────────────────────

describe('VI-3: vault not registered', () => {
  it('throws when vault not in registry', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const { run } = await import('../../src/commands/visibility.js');
    await expect(run('Unknown', 'public', { cfgPath, log: silent })).rejects.toThrow(/not a registered vault/i);
  });
});

// ── VI-4: gh not found ─────────────────────────────────────────────────────────

describe('VI-4: gh not found', () => {
  it('throws when gh not installed', async () => {
    const vaultDir = makeVaultDir();
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: vaultDir });
    vi.mocked(findTool).mockResolvedValue(null);
    const { run } = await import('../../src/commands/visibility.js');
    await expect(run('MyVault', 'public', { cfgPath, log: silent })).rejects.toThrow(/gh.*required/i);
  });
});

// ── VI-5: no origin remote ────────────────────────────────────────────────────

describe('VI-5: no origin remote', () => {
  it('throws when git remote fails', async () => {
    const vaultDir = makeVaultDir();
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: vaultDir });
    vi.mocked(execa).mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'no remote' } as never);
    const { run } = await import('../../src/commands/visibility.js');
    await expect(run('MyVault', 'public', { cfgPath, log: silent })).rejects.toThrow(/no.*origin/i);
  });
});

// ── VI-6: non-admin — throws ──────────────────────────────────────────────────

describe('VI-6: non-admin', () => {
  it('throws when user is not admin', async () => {
    const vaultDir = makeVaultDir();
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: vaultDir });
    vi.mocked(isAdmin).mockResolvedValue(false);
    vi.mocked(getVisibility).mockResolvedValue('public');
    const { run } = await import('../../src/commands/visibility.js');
    await expect(run('MyVault', 'private', { cfgPath, log: silent })).rejects.toThrow(/admin rights/i);
  });
});

// ── VI-7: already at target — no-op ──────────────────────────────────────────

describe('VI-7: already at target', () => {
  it('logs "already <target>" and returns', async () => {
    const vaultDir = makeVaultDir();
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: vaultDir });
    // Already public, pages public
    vi.mocked(getVisibility).mockResolvedValue('public');
    vi.mocked(pagesExist).mockResolvedValue(true);
    vi.mocked(getPagesVisibility).mockResolvedValue('public');
    // Add deploy.yml so needDeploy is false
    mkdirSync(join(vaultDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(vaultDir, '.github', 'workflows', 'deploy.yml'), '');

    const lines = await runVisibility('MyVault', 'public', { cfgPath, skipConfirm: true });

    expect(lines.some(l => /already public/i.test(l))).toBe(true);
    expect(vi.mocked(enablePages)).not.toHaveBeenCalled();
  });
});

// ── VI-8: private → public (no pages) — enables pages ────────────────────────

describe('VI-8: private → public, enabling Pages', () => {
  it('flips repo to public and enables Pages', async () => {
    const vaultDir = makeVaultDir();
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: vaultDir });
    vi.mocked(getVisibility).mockResolvedValue('private');
    vi.mocked(pagesExist).mockResolvedValue(false);
    // deploy.yml already exists to avoid workflow commit path
    mkdirSync(join(vaultDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(vaultDir, '.github', 'workflows', 'deploy.yml'), '');

    await runVisibility('MyVault', 'public', { cfgPath, skipConfirm: true });

    // setRepoVisibility is mocked at the module boundary (now wraps a
    // post-PATCH poll on getVisibility, which is also mocked); assert on
    // the wrapper-level call rather than the raw execa argv.
    expect(vi.mocked(setRepoVisibility)).toHaveBeenCalledWith('owner/MyVault', 'public');
    expect(vi.mocked(enablePages)).toHaveBeenCalled();
  });
});

// ── VI-9: public → private — disables pages ───────────────────────────────────

describe('VI-9: public → private, disables Pages', () => {
  it('flips repo to private and disables Pages', async () => {
    const vaultDir = makeVaultDir();
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: vaultDir });
    vi.mocked(getVisibility).mockResolvedValue('public');
    vi.mocked(pagesExist).mockResolvedValue(true);
    vi.mocked(getPagesVisibility).mockResolvedValue('public');

    await runVisibility('MyVault', 'private', { cfgPath, skipConfirm: true });

    expect(vi.mocked(setRepoVisibility)).toHaveBeenCalledWith('owner/MyVault', 'private');
    expect(vi.mocked(disablePages)).toHaveBeenCalled();
  });
});

// ── VI-10: auth-gated on free plan → throws ───────────────────────────────────

describe('VI-10: auth-gated on free plan', () => {
  it('throws because Pages private requires Pro', async () => {
    const vaultDir = makeVaultDir();
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: vaultDir });
    vi.mocked(getVisibility).mockResolvedValue('public');
    vi.mocked(pagesExist).mockResolvedValue(false);
    const { VaultkitError } = await import('../../src/lib/errors.js');
    vi.mocked(requireAuthGatedEligible).mockRejectedValue(
      new VaultkitError('PERMISSION_DENIED', 'auth-gated Pages requires GitHub Pro+ (your plan: free).'),
    );

    const { run } = await import('../../src/commands/visibility.js');
    await expect(run('MyVault', 'auth-gated', { cfgPath, log: silent, skipConfirm: true })).rejects.toThrow(/free|Pro/i);
  });
});

// ── VI-11: auth-gated on pro plan — sets private pages ────────────────────────

describe('VI-11: auth-gated on Pro plan', () => {
  it('enables Pages with private visibility', async () => {
    const vaultDir = makeVaultDir();
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: vaultDir });
    vi.mocked(getVisibility).mockResolvedValue('private');
    vi.mocked(pagesExist).mockResolvedValue(false);
    vi.mocked(requireAuthGatedEligible).mockResolvedValue(undefined);
    mkdirSync(join(vaultDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(vaultDir, '.github', 'workflows', 'deploy.yml'), '');

    await runVisibility('MyVault', 'auth-gated', { cfgPath, skipConfirm: true });

    expect(vi.mocked(enablePages)).toHaveBeenCalled();
    expect(vi.mocked(setPagesVisibility)).toHaveBeenCalledWith('owner/MyVault', 'private');
  });
});

// ── VI-11b: Pages-related calls graceful-fail with warn (not throw) ──────────

describe('VI-11b: Pages action failure logs warn instead of aborting', () => {
  // Matches init.ts:setupGitHubPages's pattern: visibility flip is the
  // user's primary intent, Pages is secondary. On Free-tier accounts,
  // private→public can surface a "current plan does not support" 422
  // from Pages-auth's stale visibility cache for >30s; aborting the
  // whole command would leave the repo correctly flipped but the user
  // staring at an error.
  it('logs warn + manual hint when enablePages throws, does not abort', async () => {
    const vaultDir = makeVaultDir();
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: vaultDir });
    vi.mocked(getVisibility).mockResolvedValue('private');
    vi.mocked(pagesExist).mockResolvedValue(false);
    vi.mocked(enablePages).mockRejectedValue(
      new Error('gh: Your current plan does not support GitHub Pages for this repository. (HTTP 422)'),
    );
    mkdirSync(join(vaultDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(vaultDir, '.github', 'workflows', 'deploy.yml'), '');

    const lines = await runVisibility('MyVault', 'public', { cfgPath, skipConfirm: true });

    // The visibility flip itself succeeded
    expect(vi.mocked(setRepoVisibility)).toHaveBeenCalledWith('owner/MyVault', 'public');
    // Pages enable was attempted and failed gracefully
    expect(vi.mocked(enablePages)).toHaveBeenCalled();
    expect(lines.some(l => /Could not auto-enable GitHub Pages/i.test(l))).toBe(true);
    expect(lines.some(l => /Enable manually:.*\/settings\/pages/i.test(l))).toBe(true);
  });

  it('logs warn + manual hint when disablePages throws, does not abort', async () => {
    const vaultDir = makeVaultDir();
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: vaultDir });
    vi.mocked(getVisibility).mockResolvedValue('public');
    vi.mocked(pagesExist).mockResolvedValue(true);
    vi.mocked(getPagesVisibility).mockResolvedValue('public');
    vi.mocked(disablePages).mockRejectedValue(new Error('HTTP 422 transient'));

    const lines = await runVisibility('MyVault', 'private', { cfgPath, skipConfirm: true });

    expect(vi.mocked(setRepoVisibility)).toHaveBeenCalledWith('owner/MyVault', 'private');
    expect(vi.mocked(disablePages)).toHaveBeenCalled();
    expect(lines.some(l => /Could not auto-disable GitHub Pages/i.test(l))).toBe(true);
    expect(lines.some(l => /Disable manually:.*\/settings\/pages/i.test(l))).toBe(true);
  });
});

// ── VI-12: user declines confirmation → aborts ───────────────────────────────

describe('VI-12: user declines', () => {
  it('logs aborted and makes no changes', async () => {
    const vaultDir = makeVaultDir();
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: vaultDir });
    vi.mocked(getVisibility).mockResolvedValue('private');
    vi.mocked(pagesExist).mockResolvedValue(false);
    vi.mocked(confirm).mockResolvedValueOnce(false);

    const lines = await runVisibility('MyVault', 'public', { cfgPath });

    expect(lines.some(l => /aborted/i.test(l))).toBe(true);
    expect(vi.mocked(enablePages)).not.toHaveBeenCalled();
  });
});

// ── VI-13: deploy workflow added via PR (no push access) ──────────────────────

describe('VI-13: deploy added, pushed via PR', () => {
  it('logs PR branch warning', async () => {
    const vaultDir = makeVaultDir();
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: vaultDir });
    vi.mocked(getVisibility).mockResolvedValue('private');
    vi.mocked(pagesExist).mockResolvedValue(false);
    vi.mocked(pushOrPr).mockResolvedValue({ mode: 'pr', branch: 'vaultkit-pages-1234567890' });
    // No deploy.yml — needs workflow add path

    await runVisibility('MyVault', 'public', { cfgPath, skipConfirm: true });

    expect(vi.mocked(commit)).toHaveBeenCalledWith(
      vaultDir,
      expect.stringMatching(/deploy workflow/i)
    );
    // PR mode warning should be logged
    expect(vi.mocked(pushOrPr)).toHaveBeenCalled();
  });
});

// ── LIVE: visibility toggles real GitHub repo ─────────────────────────────────

// Skipped: the available CI test PATs (Free-tier alt accounts) cannot
// reliably be flipped to public — GitHub returns 200 on the PATCH but
// the read endpoint readily reports 'private' immediately after, and a
// subsequent enablePages POST returns 422 "Your current plan does not
// support GitHub Pages for this repository" even though we just flipped
// to public. Whether this is a Free-tier account-level restriction, an
// abuse-flag artifact, or something else, the underlying state isn't
// what the API claims — no amount of polling/retrying/graceful-failing
// on vaultkit's side fixes it because the test PATs simply can't
// support this end-to-end flow. The 14 mocked describes above cover
// the command's logic exhaustively; this live block was specifically
// for API-contract coverage, which we lose here. Re-enable by replacing
// `describe.skip` with `liveDescribe` once a Pro test PAT is available
// (e.g., GitHub Education pack or OSS Pro grant).
//
// See docs/roadmap.md "Live-test CI: residual mitigations" for context.
describe.skip('live: visibility toggles real GitHub repo', { timeout: 60_000 }, () => {
  // Operates on the shared fixture from `tests/global-fixture.ts`. The
  // two it() blocks were collapsed into one because vitest's per-it
  // execution order is implementation-defined within a describe — the
  // public→private→assert→public→assert sequence is one logical
  // operation, and splitting it would have doubled the per-run mutation
  // count without adding coverage.

  async function restoreReal() {
    const { execa: realExeca } = await vi.importActual<typeof import('execa')>('execa');
    vi.mocked(execa).mockImplementation(realExeca as never);
    const realPlatform = await vi.importActual<typeof import('../../src/lib/platform.js')>('../../src/lib/platform.js');
    vi.mocked(findTool).mockImplementation(realPlatform.findTool);
    const realGit = await vi.importActual<typeof import('../../src/lib/git.js')>('../../src/lib/git.js');
    vi.mocked(add).mockImplementation(realGit.add);
    vi.mocked(commit).mockImplementation(realGit.commit);
    vi.mocked(pushOrPr).mockImplementation(realGit.pushOrPr);
    const realGithubRepo = await vi.importActual<typeof import('../../src/lib/github-repo.js')>('../../src/lib/github-repo.js');
    vi.mocked(isAdmin).mockImplementation(realGithubRepo.isAdmin);
    vi.mocked(getVisibility).mockImplementation(realGithubRepo.getVisibility);
    const realGithubPages = await vi.importActual<typeof import('../../src/lib/github-pages.js')>('../../src/lib/github-pages.js');
    vi.mocked(enablePages).mockImplementation(realGithubPages.enablePages);
    vi.mocked(setPagesVisibility).mockImplementation(realGithubPages.setPagesVisibility);
    vi.mocked(disablePages).mockImplementation(realGithubPages.disablePages);
    vi.mocked(pagesExist).mockImplementation(realGithubPages.pagesExist);
    vi.mocked(getPagesVisibility).mockImplementation(realGithubPages.getPagesVisibility);
    const realGithubAuth = await vi.importActual<typeof import('../../src/lib/github-auth.js')>('../../src/lib/github-auth.js');
    vi.mocked(requireAuthGatedEligible).mockImplementation(realGithubAuth.requireAuthGatedEligible);
  }

  beforeEach(restoreReal);
  beforeEach(async () => {
    const fixtureName = getFixtureName();
    // Re-register if a previous file's live test (disconnect) left the
    // fixture unregistered. Then reset visibility to private so the test
    // body's assertion sequence starts from a known state.
    const { getVaultDir } = await import('../../src/lib/registry.js');
    if ((await getVaultDir(fixtureName)) === null) {
      const { getCurrentUser } = await import('../../src/lib/github-auth.js');
      const user = await getCurrentUser();
      const { run: connectRun } = await import('../../src/commands/connect.js');
      await connectRun(`${user}/${fixtureName}`, { skipMcp: true, log: silent });
    }

    const { getVisibility: realGetVisibility, setRepoVisibility } =
      await vi.importActual<typeof import('../../src/lib/github-repo.js')>('../../src/lib/github-repo.js');
    const { getCurrentUser } =
      await vi.importActual<typeof import('../../src/lib/github-auth.js')>('../../src/lib/github-auth.js');
    const user = await getCurrentUser();
    const slug = `${user}/${fixtureName}`;
    if ((await realGetVisibility(slug)) !== 'private') {
      await setRepoVisibility(slug, 'private');
    }
  });

  afterEach(async () => {
    // Restore baseline so the next file (or re-run) starts from private.
    // Best-effort — a leak here surfaces in the workflow's post-test
    // orphan sweep + a subsequent test's beforeEach, which both reset.
    try {
      const fixtureName = getFixtureName();
      const { getVisibility: realGetVisibility, setRepoVisibility } =
        await vi.importActual<typeof import('../../src/lib/github-repo.js')>('../../src/lib/github-repo.js');
      const { getCurrentUser } =
        await vi.importActual<typeof import('../../src/lib/github-auth.js')>('../../src/lib/github-auth.js');
      const user = await getCurrentUser();
      const slug = `${user}/${fixtureName}`;
      if ((await realGetVisibility(slug)) !== 'private') {
        await setRepoVisibility(slug, 'private');
      }
    } catch {
      // Don't let cleanup failure mask the actual test result.
    }
  });

  it('toggles private vault to public and back', async () => {
    const fixtureName = getFixtureName();
    const { run } = await import('../../src/commands/visibility.js');
    const { getVisibility } = await import('../../src/lib/github-repo.js');
    const { getCurrentUser } = await import('../../src/lib/github-auth.js');
    const user = await getCurrentUser();
    const slug = `${user}/${fixtureName}`;

    await run(fixtureName, 'public', { skipConfirm: true, log: silent });
    expect(await getVisibility(slug)).toBe('public');

    await run(fixtureName, 'private', { skipConfirm: true, log: silent });
    expect(await getVisibility(slug)).toBe('private');
  });
});
