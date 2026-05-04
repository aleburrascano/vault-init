import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { arrayLogger } from '../helpers/logger.js';

vi.mock('@inquirer/prompts', () => ({ input: vi.fn(), confirm: vi.fn() }));
vi.mock('execa', async (importOriginal) => {
  const real = await importOriginal<typeof import('execa')>();
  return { ...real, execa: vi.fn() };
});
vi.mock('../../src/lib/platform.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/platform.js')>();
  return { ...real, findTool: vi.fn() };
});
vi.mock('../../src/lib/github-repo.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/github-repo.js')>();
  return { ...real, isAdmin: vi.fn() };
});
vi.mock('../../src/lib/github-auth.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/github-auth.js')>();
  return { ...real, ensureDeleteRepoScope: vi.fn() };
});

import { input } from '@inquirer/prompts';
import { execa } from 'execa';
import { findTool } from '../../src/lib/platform.js';
import { isAdmin } from '../../src/lib/github-repo.js';
import { ensureDeleteRepoScope } from '../../src/lib/github-auth.js';
import { writeCfg } from '../helpers/registry.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-destroy-mock-'));
  vi.mocked(input).mockReset();
  vi.mocked(execa).mockReset();
  vi.mocked(findTool).mockReset();
  vi.mocked(isAdmin).mockReset();
  vi.mocked(ensureDeleteRepoScope).mockReset();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeVaultDir(dir: string, withGit: boolean = false): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), '');
  mkdirSync(join(dir, 'raw'), { recursive: true });
  mkdirSync(join(dir, 'wiki'), { recursive: true });
  if (withGit) mkdirSync(join(dir, '.git'), { recursive: true });
}

function mockGitRemote(url: string): void {
  vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
    if (args?.[2] === 'remote' && args?.[3] === 'get-url') {
      return { exitCode: 0, stdout: url, stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }) as never);
}

// ── DE-1: non-admin collaborator — GitHub deletion skipped ───────────────────

describe('DE-1: non-admin user', () => {
  it('skips GitHub deletion and notes repo ownership', async () => {
    const vaultDir = join(tmp, 'CollabVault');
    makeVaultDir(vaultDir, true);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { CollabVault: vaultDir });

    mockGitRemote('https://github.com/owner/CollabVault.git');
    vi.mocked(isAdmin).mockResolvedValueOnce(false);
    vi.mocked(ensureDeleteRepoScope).mockResolvedValue(undefined);
    vi.mocked(findTool).mockResolvedValue(null);
    vi.mocked(input).mockResolvedValueOnce('CollabVault');

    const { run } = await import('../../src/commands/destroy.js');
    const lines: string[] = [];
    await run('CollabVault', { cfgPath, skipMcp: true, log: arrayLogger(lines) });

    expect(lines.some(l => /don't own|skipping/i.test(l))).toBe(true);
    expect(existsSync(vaultDir)).toBe(false);
  });
});

// ── DE-2: admin user, wrong name typed → aborts ──────────────────────────────

describe('DE-2: admin user, wrong name typed', () => {
  it('aborts and does not delete directory', async () => {
    const vaultDir = join(tmp, 'AdminVault');
    makeVaultDir(vaultDir, true);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { AdminVault: vaultDir });

    mockGitRemote('https://github.com/me/AdminVault.git');
    vi.mocked(isAdmin).mockResolvedValueOnce(true);
    vi.mocked(ensureDeleteRepoScope).mockResolvedValue(undefined);
    vi.mocked(input).mockResolvedValueOnce('wrongname');

    const { run } = await import('../../src/commands/destroy.js');
    const lines: string[] = [];
    await run('AdminVault', { cfgPath, log: arrayLogger(lines) });

    expect(lines.some(l => /aborted/i.test(l))).toBe(true);
    expect(existsSync(vaultDir)).toBe(true);
  });
});

// ── DE-3: admin user confirms — gh repo delete called ────────────────────────

describe('DE-3: admin user confirms deletion', () => {
  it('calls gh repo delete with --yes', async () => {
    const vaultDir = join(tmp, 'DeleteVault');
    makeVaultDir(vaultDir, true);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { DeleteVault: vaultDir });

    vi.mocked(isAdmin).mockResolvedValueOnce(true);
    vi.mocked(ensureDeleteRepoScope).mockResolvedValue(undefined);
    vi.mocked(input).mockResolvedValueOnce('DeleteVault');
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'gh') return '/usr/bin/gh';
      if (name === 'claude') return null;
      return null;
    });
    // mock all execa calls including git remote and gh repo delete
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args?.[2] === 'remote' && args?.[3] === 'get-url') {
        return { exitCode: 0, stdout: 'https://github.com/me/DeleteVault.git', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const { run } = await import('../../src/commands/destroy.js');
    const lines: string[] = [];
    await run('DeleteVault', { cfgPath, skipMcp: true, log: arrayLogger(lines) });

    // deleteRepo migrated to `gh api --method DELETE /repos/<slug>`
    // for header-aware retry. Filter by the HTTP method instead of the
    // old `delete --yes` shorthand.
    const deleteCalls = vi.mocked(execa).mock.calls.filter(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args.includes('api') && args.includes('DELETE');
    });
    expect(deleteCalls.length).toBeGreaterThan(0);
    expect(existsSync(vaultDir)).toBe(false);
  });
});

// ── DE-4: GitHub deletion fails — continues with local + MCP cleanup ──────────

describe('DE-4: GitHub deletion fails', () => {
  it('logs warning but still deletes local directory', async () => {
    const vaultDir = join(tmp, 'PartialVault');
    makeVaultDir(vaultDir, true);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { PartialVault: vaultDir });

    vi.mocked(isAdmin).mockResolvedValueOnce(true);
    vi.mocked(ensureDeleteRepoScope).mockResolvedValue(undefined);
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'gh') return '/usr/bin/gh';
      return null;
    });
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args?.[2] === 'remote' && args?.[3] === 'get-url') {
        return { exitCode: 0, stdout: 'https://github.com/me/PartialVault.git', stderr: '' };
      }
      // deleteRepo migrated to `gh api --method DELETE /repos/<slug>`.
      if (args?.includes('api') && args?.includes('DELETE')) {
        return { exitCode: 1, stdout: '', stderr: 'permission denied' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const { run } = await import('../../src/commands/destroy.js');
    const lines: string[] = [];
    await run('PartialVault', { cfgPath, skipConfirm: true, skipMcp: true, log: arrayLogger(lines) });

    expect(lines.some(l => /GitHub repo deletion failed|continuing/i.test(l))).toBe(true);
    expect(existsSync(vaultDir)).toBe(false);
  });
});

// ── DE-5: MCP removal skipped when claude not found ──────────────────────────

describe('DE-5: MCP removal skipped', () => {
  it('logs warning when claude not found', async () => {
    const vaultDir = join(tmp, 'NoMcpVault');
    makeVaultDir(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { NoMcpVault: vaultDir });

    vi.mocked(isAdmin).mockRejectedValueOnce(new Error('no git'));
    vi.mocked(findTool).mockResolvedValue(null);
    vi.mocked(execa).mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' } as never);

    const { run } = await import('../../src/commands/destroy.js');
    const lines: string[] = [];
    await run('NoMcpVault', { cfgPath, skipConfirm: true, log: arrayLogger(lines) });

    expect(lines.some(l => /Claude Code not found|MCP cleanup skipped/i.test(l))).toBe(true);
  });
});

// ── DE-7: scope refresh fails — abort before any deletion ────────────────────

describe('DE-7: ensureDeleteRepoScope failure aborts the run', () => {
  it('throws and leaves the local directory intact', async () => {
    const vaultDir = join(tmp, 'ScopeFailVault');
    makeVaultDir(vaultDir, true);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { ScopeFailVault: vaultDir });

    mockGitRemote('https://github.com/me/ScopeFailVault.git');
    vi.mocked(isAdmin).mockResolvedValueOnce(true);
    vi.mocked(ensureDeleteRepoScope).mockRejectedValueOnce(new Error('AUTH_REQUIRED: declined'));

    const { run } = await import('../../src/commands/destroy.js');
    await expect(
      run('ScopeFailVault', { cfgPath, log: arrayLogger([]) }),
    ).rejects.toThrow(/AUTH_REQUIRED|declined/);
    expect(existsSync(vaultDir)).toBe(true);
  });
});

// ── DE-8: gh repo delete failure surfaces stderr ─────────────────────────────

describe('DE-8: gh repo delete failure surfaces stderr', () => {
  it('logs the gh stderr alongside the failure warning', async () => {
    const vaultDir = join(tmp, 'StderrVault');
    makeVaultDir(vaultDir, true);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { StderrVault: vaultDir });

    vi.mocked(isAdmin).mockResolvedValueOnce(true);
    vi.mocked(ensureDeleteRepoScope).mockResolvedValue(undefined);
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'gh') return '/usr/bin/gh';
      return null;
    });
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args?.[2] === 'remote' && args?.[3] === 'get-url') {
        return { exitCode: 0, stdout: 'https://github.com/me/StderrVault.git', stderr: '' };
      }
      // deleteRepo migrated to `gh api --method DELETE /repos/<slug>`.
      if (args?.includes('api') && args?.includes('DELETE')) {
        return { exitCode: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible by integration' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const { run } = await import('../../src/commands/destroy.js');
    const lines: string[] = [];
    await run('StderrVault', { cfgPath, skipConfirm: true, skipMcp: true, log: arrayLogger(lines) });

    expect(lines.some(l => /HTTP 403/.test(l))).toBe(true);
    expect(existsSync(vaultDir)).toBe(false);
  });
});

// ── DE-6: summary shows github/mcp/local status ───────────────────────────────

describe('DE-6: summary output', () => {
  it('shows summary with GitHub, MCP, and Local statuses', async () => {
    const vaultDir = join(tmp, 'SummaryVault');
    makeVaultDir(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { SummaryVault: vaultDir });

    vi.mocked(isAdmin).mockRejectedValueOnce(new Error('no git'));
    vi.mocked(findTool).mockResolvedValue(null);
    vi.mocked(execa).mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' } as never);

    const { run } = await import('../../src/commands/destroy.js');
    const lines: string[] = [];
    await run('SummaryVault', { cfgPath, skipConfirm: true, log: arrayLogger(lines) });

    expect(lines.some(l => /Summary/i.test(l))).toBe(true);
    expect(lines.some(l => /GitHub/i.test(l))).toBe(true);
    expect(lines.some(l => /MCP/i.test(l))).toBe(true);
    expect(lines.some(l => /Local/i.test(l))).toBe(true);
  });
});
