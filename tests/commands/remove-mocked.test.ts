import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { silent, arrayLogger } from '../helpers/logger.js';

vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn(), input: vi.fn() }));
vi.mock('execa', async (importOriginal) => {
  const real = await importOriginal<typeof import('execa')>();
  return { ...real, execa: vi.fn() };
});
vi.mock('../../src/lib/platform.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/platform.js')>();
  return { ...real, findTool: vi.fn() };
});
vi.mock('../../src/lib/github/github-repo.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/github/github-repo.js')>();
  return { ...real, isAdmin: vi.fn(), deleteRepoCapturing: vi.fn() };
});
vi.mock('../../src/lib/github/github-auth.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/github/github-auth.js')>();
  return { ...real, ensureDeleteRepoScope: vi.fn() };
});

import { input } from '@inquirer/prompts';
import { execa } from 'execa';
import { findTool } from '../../src/lib/platform.js';
import { isAdmin, deleteRepoCapturing } from '../../src/lib/github/github-repo.js';
import { ensureDeleteRepoScope } from '../../src/lib/github/github-auth.js';
import { writeCfg } from '../helpers/registry.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-remove-mock-'));
  vi.mocked(input).mockReset();
  vi.mocked(execa).mockReset();
  vi.mocked(findTool).mockReset();
  vi.mocked(isAdmin).mockReset();
  vi.mocked(deleteRepoCapturing).mockReset();
  vi.mocked(ensureDeleteRepoScope).mockReset();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeVaultDir(dir: string, withGit = false): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), '');
  mkdirSync(join(dir, 'raw'), { recursive: true });
  mkdirSync(join(dir, 'wiki'), { recursive: true });
  if (withGit) mkdirSync(join(dir, '.git'), { recursive: true });
}

// ── R-1: default mode (local + MCP only) ──────────────────────────────────────

describe('R-1: default remove (no --delete-repo)', () => {
  it('removes local dir + MCP without touching GitHub', async () => {
    const vaultDir = join(tmp, 'KeepRemote');
    makeVaultDir(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { KeepRemote: vaultDir });

    vi.mocked(findTool).mockResolvedValue(null);

    const { run } = await import('../../src/commands/remove.js');
    const lines: string[] = [];
    await run('KeepRemote', { cfgPath, skipConfirm: true, skipMcp: true, log: arrayLogger(lines) });

    expect(existsSync(vaultDir)).toBe(false);
    expect(lines.some(l => /Done\. KeepRemote removed/i.test(String(l)))).toBe(true);
    // Critical: ensureDeleteRepoScope MUST NOT be called when --delete-repo
    // is absent — security invariant per .claude/rules/security-invariants.md.
    expect(vi.mocked(ensureDeleteRepoScope)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteRepoCapturing)).not.toHaveBeenCalled();
  });

  it('uses the milder TYPE_NAME_TO_CONFIRM prompt (not the deletion variant)', async () => {
    const vaultDir = join(tmp, 'PromptVault');
    makeVaultDir(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { PromptVault: vaultDir });

    vi.mocked(input).mockResolvedValueOnce('PromptVault');
    vi.mocked(findTool).mockResolvedValue(null);

    const { run } = await import('../../src/commands/remove.js');
    await run('PromptVault', { cfgPath, skipMcp: true, log: silent });

    const promptCall = vi.mocked(input).mock.calls[0]?.[0] as { message?: string } | undefined;
    // Local-only path uses the milder prompt — must NOT include "deletion".
    expect(promptCall?.message).toBe('Type the vault name to confirm:');
  });

  it('aborts cleanly when confirmation name is wrong', async () => {
    const vaultDir = join(tmp, 'AbortVault');
    makeVaultDir(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { AbortVault: vaultDir });

    vi.mocked(input).mockResolvedValueOnce('NotTheRightName');

    const { run } = await import('../../src/commands/remove.js');
    const lines: string[] = [];
    await run('AbortVault', { cfgPath, skipMcp: true, log: arrayLogger(lines) });

    expect(lines.some(l => /aborted/i.test(String(l)))).toBe(true);
    expect(existsSync(vaultDir)).toBe(true);
  });
});

// ── R-2: --delete-repo mode (full destruction) ────────────────────────────────

describe('R-2: remove --delete-repo', () => {
  it('requests delete_repo scope, deletes GitHub repo, then local + MCP', async () => {
    const vaultDir = join(tmp, 'FullDestroy');
    makeVaultDir(vaultDir, true);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { FullDestroy: vaultDir });

    vi.mocked(findTool).mockResolvedValue(null);
    vi.mocked(isAdmin).mockResolvedValue(true);
    vi.mocked(ensureDeleteRepoScope).mockResolvedValue();
    vi.mocked(deleteRepoCapturing).mockResolvedValue({ ok: true, stderr: '' });
    // git getRepoSlug shells out via `git -C <dir> remote get-url origin`
    // and parses out owner/repo from the URL. Return a realistic GitHub
    // URL so the regex match succeeds.
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: 'https://github.com/owner/FullDestroy.git', stderr: '' } as never);

    const { run } = await import('../../src/commands/remove.js');
    const lines: string[] = [];
    await run('FullDestroy', {
      cfgPath, deleteRepo: true, skipConfirm: true, skipMcp: true, log: arrayLogger(lines),
    });

    expect(vi.mocked(ensureDeleteRepoScope)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deleteRepoCapturing)).toHaveBeenCalledWith('owner/FullDestroy');
    expect(existsSync(vaultDir)).toBe(false);
    expect(lines.some(l => /Summary:/i.test(String(l)))).toBe(true);
    expect(lines.some(l => /GitHub:\s+deleted/i.test(String(l)))).toBe(true);
  });

  it('skips GitHub deletion when caller is not admin (still removes local + MCP)', async () => {
    const vaultDir = join(tmp, 'NotAdmin');
    makeVaultDir(vaultDir, true);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { NotAdmin: vaultDir });

    vi.mocked(findTool).mockResolvedValue(null);
    vi.mocked(isAdmin).mockResolvedValue(false);
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: 'https://github.com/someone-else/NotAdmin.git', stderr: '' } as never);

    // Use confirmName (not skipConfirm) so the confirmation block actually
    // runs — that's where the "you don't own this repo" note is logged.
    const { run } = await import('../../src/commands/remove.js');
    const lines: string[] = [];
    await run('NotAdmin', {
      cfgPath, deleteRepo: true, confirmName: 'NotAdmin', skipMcp: true, log: arrayLogger(lines),
    });

    // Not admin → ensureDeleteRepoScope and deleteRepoCapturing must NOT fire.
    expect(vi.mocked(ensureDeleteRepoScope)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteRepoCapturing)).not.toHaveBeenCalled();
    // Local cleanup still runs.
    expect(existsSync(vaultDir)).toBe(false);
    expect(lines.some(l => /you don't own this repo/i.test(String(l)))).toBe(true);
  });

  it('uses the stronger TYPE_NAME_TO_CONFIRM_DELETION prompt', async () => {
    const vaultDir = join(tmp, 'StrongPrompt');
    makeVaultDir(vaultDir, true);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { StrongPrompt: vaultDir });

    vi.mocked(input).mockResolvedValueOnce('StrongPrompt');
    vi.mocked(findTool).mockResolvedValue(null);
    vi.mocked(isAdmin).mockResolvedValue(false);
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: 'https://github.com/me/StrongPrompt.git', stderr: '' } as never);

    const { run } = await import('../../src/commands/remove.js');
    await run('StrongPrompt', {
      cfgPath, deleteRepo: true, skipMcp: true, log: silent,
    });

    const promptCall = vi.mocked(input).mock.calls[0]?.[0] as { message?: string } | undefined;
    // The deletion-variant prompt explicitly mentions deletion.
    expect(promptCall?.message).toBe('Type the vault name to confirm deletion:');
  });
});

// ── R-3: not-registered errors point at `vaultkit list` (the new name) ────────

describe('R-3: not-registered hint', () => {
  it('error message references `vaultkit list` (post-rename), not the old `status`', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, {});

    const { run } = await import('../../src/commands/remove.js');
    await expect(run('Ghost', { cfgPath, skipConfirm: true, log: silent })).rejects.toThrow(/vaultkit list/i);
  });
});
