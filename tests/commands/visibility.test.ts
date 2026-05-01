import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { silent, arrayLogger } from '../helpers/logger.js';

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
vi.mock('../../src/lib/github.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/github.js')>();
  return {
    ...real,
    isAdmin: vi.fn(),
    getVisibility: vi.fn(),
    requireAuthGatedEligible: vi.fn(),
    enablePages: vi.fn(),
    setPagesVisibility: vi.fn(),
    disablePages: vi.fn(),
    pagesExist: vi.fn(),
    getPagesVisibility: vi.fn(),
  };
});

import { confirm } from '@inquirer/prompts';
import { execa } from 'execa';
import { add, commit, pushOrPr } from '../../src/lib/git.js';
import { findTool } from '../../src/lib/platform.js';
import {
  isAdmin, getVisibility, requireAuthGatedEligible,
  enablePages, setPagesVisibility, disablePages, pagesExist, getPagesVisibility,
} from '../../src/lib/github.js';
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

    const repoEditCalls = vi.mocked(execa).mock.calls.filter(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args.includes('edit') && args.includes('public');
    });
    expect(repoEditCalls.length).toBeGreaterThan(0);
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

    const repoEditCalls = vi.mocked(execa).mock.calls.filter(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args.includes('edit') && args.includes('private');
    });
    expect(repoEditCalls.length).toBeGreaterThan(0);
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

const LIVE_VAULT = `vk-live-visibility-${Date.now()}`;

describe('live: visibility toggles real GitHub repo', { timeout: 60_000 }, () => {
  async function restoreReal() {
    const { execa: realExeca } = await vi.importActual<typeof import('execa')>('execa');
    vi.mocked(execa).mockImplementation(realExeca as never);
    const realPlatform = await vi.importActual<typeof import('../../src/lib/platform.js')>('../../src/lib/platform.js');
    vi.mocked(findTool).mockImplementation(realPlatform.findTool);
    const realGit = await vi.importActual<typeof import('../../src/lib/git.js')>('../../src/lib/git.js');
    vi.mocked(add).mockImplementation(realGit.add);
    vi.mocked(commit).mockImplementation(realGit.commit);
    vi.mocked(pushOrPr).mockImplementation(realGit.pushOrPr);
    const realGithub = await vi.importActual<typeof import('../../src/lib/github.js')>('../../src/lib/github.js');
    vi.mocked(isAdmin).mockImplementation(realGithub.isAdmin);
    vi.mocked(getVisibility).mockImplementation(realGithub.getVisibility);
    vi.mocked(requireAuthGatedEligible).mockImplementation(realGithub.requireAuthGatedEligible);
    vi.mocked(enablePages).mockImplementation(realGithub.enablePages);
    vi.mocked(setPagesVisibility).mockImplementation(realGithub.setPagesVisibility);
    vi.mocked(disablePages).mockImplementation(realGithub.disablePages);
    vi.mocked(pagesExist).mockImplementation(realGithub.pagesExist);
    vi.mocked(getPagesVisibility).mockImplementation(realGithub.getPagesVisibility);
  }

  beforeEach(restoreReal);

  beforeAll(async () => {
    await restoreReal();
    const { run } = await import('../../src/commands/init.js');
    await run(LIVE_VAULT, { publishMode: 'private', skipInstallCheck: true, log: silent });
  }, 60_000);

  afterAll(async () => {
    await restoreReal();
    const { run } = await import('../../src/commands/destroy.js');
    await run(LIVE_VAULT, { skipConfirm: true, skipMcp: true, confirmName: LIVE_VAULT, log: silent }).catch(() => {});
  }, 60_000);

  it('switches vault to public', async () => {
    const { run } = await import('../../src/commands/visibility.js');
    await run(LIVE_VAULT, 'public', { skipConfirm: true, log: silent });

    const { getVisibility, getCurrentUser } = await import('../../src/lib/github.js');
    const user = await getCurrentUser();
    expect(await getVisibility(`${user}/${LIVE_VAULT}`)).toBe('public');
  });

  it('switches vault back to private', async () => {
    const { run } = await import('../../src/commands/visibility.js');
    await run(LIVE_VAULT, 'private', { skipConfirm: true, log: silent });

    const { getVisibility, getCurrentUser } = await import('../../src/lib/github.js');
    const user = await getCurrentUser();
    expect(await getVisibility(`${user}/${LIVE_VAULT}`)).toBe('private');
  });
});
