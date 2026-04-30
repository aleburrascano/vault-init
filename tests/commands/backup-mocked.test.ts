import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../src/lib/git.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/git.js')>();
  return { ...real, archiveZip: vi.fn() };
});

// Also mock execa for the git status call inside backup.run.
vi.mock('execa', async (importOriginal) => {
  const real = await importOriginal<typeof import('execa')>();
  return { ...real, execa: vi.fn() };
});

import { archiveZip } from '../../src/lib/git.js';
import { execa } from 'execa';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-backup-mock-'));
  vi.mocked(archiveZip).mockReset();
  vi.mocked(execa).mockReset();
  // Default: git status returns clean (no uncommitted changes)
  vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeCfg(cfgPath: string, vaults: Record<string, string>): void {
  const mcpServers: Record<string, { command: string; args: string[] }> = {};
  for (const [name, dir] of Object.entries(vaults)) {
    mcpServers[name] = { command: 'node', args: [`${dir}/.mcp-start.js`] };
  }
  writeFileSync(cfgPath, JSON.stringify({ mcpServers }), 'utf8');
}

function makeGitDir(dir: string): void {
  mkdirSync(join(dir, '.git'), { recursive: true });
}

// ── B-3: vault dir missing ────────────────────────────────────────────────────

describe('B-3: vault directory missing', () => {
  it('throws with not-a-git-repo error when vault dir absent', async () => {
    const vaultDir = join(tmp, 'GhostVault');
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { GhostVault: vaultDir });
    // dir doesn't exist

    const { run } = await import('../../src/commands/backup.js');
    await expect(run('GhostVault', { cfgPath, backupsDir: tmp })).rejects.toThrow(/not a git repository/i);
  });
});

// ── B-4: dir exists but not a git repo ───────────────────────────────────────

describe('B-4: not a git repo', () => {
  it('throws with not-a-git-repo error', async () => {
    const vaultDir = join(tmp, 'NoGit');
    mkdirSync(vaultDir, { recursive: true });
    // no .git dir
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { NoGit: vaultDir });

    const { run } = await import('../../src/commands/backup.js');
    await expect(run('NoGit', { cfgPath, backupsDir: tmp })).rejects.toThrow(/not a git repository/i);
  });
});

// ── B-5: uncommitted changes — warns but still creates backup ─────────────────

describe('B-5: uncommitted changes', () => {
  it('logs warning and still creates backup', async () => {
    const vaultDir = join(tmp, 'DirtyVault');
    makeGitDir(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { DirtyVault: vaultDir });
    const backupsDir = join(tmp, '.backups');

    // Simulate dirty working tree: git status --porcelain returns non-empty output
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 0, stdout: ' M uncommitted.md\n', stderr: '' } as never);

    vi.mocked(archiveZip).mockImplementation(async (_dir: string, zipPath: string) => {
      mkdirSync(backupsDir, { recursive: true });
      writeFileSync(zipPath, 'fake-zip-content');
    });

    const { run } = await import('../../src/commands/backup.js');
    const lines: string[] = [];
    await run('DirtyVault', { cfgPath, backupsDir, log: (m: unknown) => lines.push(String(m)) });

    expect(lines.some(l => /uncommitted changes/i.test(l))).toBe(true);
    expect(vi.mocked(archiveZip)).toHaveBeenCalledOnce();
  });
});

// ── B-6: archiveZip throws — backup fails cleanly ────────────────────────────

describe('B-6: archiveZip failure', () => {
  it('throws when archiveZip rejects', async () => {
    const vaultDir = join(tmp, 'ArchiveFail');
    makeGitDir(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { ArchiveFail: vaultDir });

    vi.mocked(archiveZip).mockRejectedValueOnce(new Error('git archive failed: no commits'));

    const { run } = await import('../../src/commands/backup.js');
    await expect(run('ArchiveFail', { cfgPath, backupsDir: tmp })).rejects.toThrow(/no commits/i);
  });
});

// ── B-7: zip not created after archiveZip resolves ───────────────────────────

describe('B-7: zip not created after archiveZip', () => {
  it('throws "file was not created" error', async () => {
    const vaultDir = join(tmp, 'EmptyArchive');
    makeGitDir(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { EmptyArchive: vaultDir });

    // archiveZip resolves but does NOT write the zip
    vi.mocked(archiveZip).mockResolvedValueOnce(undefined);

    const { run } = await import('../../src/commands/backup.js');
    await expect(run('EmptyArchive', { cfgPath, backupsDir: tmp })).rejects.toThrow(/not created/i);
  });
});

// ── B-8: backupsDir is auto-created ──────────────────────────────────────────

describe('B-8: backupsDir created automatically', () => {
  it('creates the backups directory if missing', async () => {
    const vaultDir = join(tmp, 'AutoDirVault');
    makeGitDir(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { AutoDirVault: vaultDir });
    const backupsDir = join(tmp, 'new', 'nested', '.backups');
    // backupsDir does NOT exist yet

    vi.mocked(archiveZip).mockImplementation(async (_dir: string, zipPath: string) => {
      writeFileSync(zipPath, 'fake-zip');
    });

    const { run } = await import('../../src/commands/backup.js');
    await run('AutoDirVault', { cfgPath, backupsDir });

    expect(existsSync(backupsDir)).toBe(true);
  });
});

// ── B-9: zip filename includes vault name and timestamp ───────────────────────

describe('B-9: zip filename format', () => {
  it('returns path matching <name>-<timestamp>.zip', async () => {
    const vaultDir = join(tmp, 'NameCheck');
    makeGitDir(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { NameCheck: vaultDir });
    const backupsDir = join(tmp, '.backups');

    vi.mocked(archiveZip).mockImplementation(async (_dir: string, zipPath: string) => {
      mkdirSync(backupsDir, { recursive: true });
      writeFileSync(zipPath, 'fake-zip');
    });

    const { run } = await import('../../src/commands/backup.js');
    const zipPath = await run('NameCheck', { cfgPath, backupsDir });

    expect(zipPath).toMatch(/NameCheck-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/);
  });
});
