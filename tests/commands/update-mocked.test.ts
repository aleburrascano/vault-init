import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const TMPL_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../lib/mcp-start.js.tmpl');

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

import { confirm } from '@inquirer/prompts';
import { execa } from 'execa';
import { add, commit, pushOrPr } from '../../src/lib/git.js';
import { findTool } from '../../src/lib/platform.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-update-mock-'));
  vi.mocked(confirm).mockReset();
  vi.mocked(execa).mockReset();
  vi.mocked(add).mockReset();
  vi.mocked(commit).mockReset();
  vi.mocked(pushOrPr).mockReset();
  vi.mocked(findTool).mockReset();
  // Default: no staged changes, claude not found
  vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);
  vi.mocked(findTool).mockResolvedValue(null);
  vi.mocked(pushOrPr).mockResolvedValue({ mode: 'direct' });
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

// ── U-1: not a git repo → throws ─────────────────────────────────────────────

describe('U-1: not a git repo', () => {
  it('throws when vault dir has no .git', async () => {
    const vaultDir = join(tmp, 'NoGit');
    mkdirSync(vaultDir, { recursive: true });
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { NoGit: vaultDir });

    const { run } = await import('../../src/commands/update.js');
    await expect(run('NoGit', { cfgPath, skipConfirm: true, log: () => {} })).rejects.toThrow(/not a git repository/i);
  });
});

// ── U-2: already up to date (launcher matches + all layout files present) ─────

describe('U-2: already up to date, re-pins', () => {
  it('logs "already up to date" and skips commit', async () => {
    const vaultDir = join(tmp, 'UpToDate');
    makeGitDir(vaultDir);
    // Copy current template so hashes match
    copyFileSync(TMPL_PATH, join(vaultDir, '.mcp-start.js'));
    // Create all layout files so nothing is missing
    writeFileSync(join(vaultDir, 'CLAUDE.md'), '');
    writeFileSync(join(vaultDir, 'README.md'), '');
    writeFileSync(join(vaultDir, 'index.md'), '');
    writeFileSync(join(vaultDir, 'log.md'), '');
    writeFileSync(join(vaultDir, '.gitignore'), '');
    writeFileSync(join(vaultDir, '.gitattributes'), '');
    mkdirSync(join(vaultDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(vaultDir, '.github', 'workflows', 'duplicate-check.yml'), '');
    mkdirSync(join(vaultDir, 'raw'), { recursive: true });
    writeFileSync(join(vaultDir, 'raw', '.gitkeep'), '');
    mkdirSync(join(vaultDir, 'wiki'), { recursive: true });
    writeFileSync(join(vaultDir, 'wiki', '.gitkeep'), '');

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { UpToDate: vaultDir });

    const { run } = await import('../../src/commands/update.js');
    const lines: string[] = [];
    await run('UpToDate', { cfgPath, skipConfirm: true, log: (m: unknown) => lines.push(String(m)) });

    expect(lines.some(l => /already up to date/i.test(l))).toBe(true);
    // No actual commit should be made
    expect(vi.mocked(commit)).not.toHaveBeenCalled();
  });
});

// ── U-3: user declines confirmation → aborts ─────────────────────────────────

describe('U-3: user declines', () => {
  it('logs aborted and makes no changes', async () => {
    const vaultDir = join(tmp, 'AbortVault');
    makeGitDir(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { AbortVault: vaultDir });

    vi.mocked(confirm).mockResolvedValueOnce(false);

    const { run } = await import('../../src/commands/update.js');
    const lines: string[] = [];
    await run('AbortVault', { cfgPath, log: (m: unknown) => lines.push(String(m)) });

    expect(lines.some(l => /aborted/i.test(l))).toBe(true);
    expect(vi.mocked(commit)).not.toHaveBeenCalled();
  });
});

// ── U-4: launcher updated, pushed directly ────────────────────────────────────

describe('U-4: launcher updated, direct push', () => {
  it('commits and pushes, logs done', async () => {
    const vaultDir = join(tmp, 'DirectPush');
    makeGitDir(vaultDir);
    // Write a stale launcher (wrong content → hash won't match template)
    writeFileSync(join(vaultDir, '.mcp-start.js'), '// stale');
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { DirectPush: vaultDir });

    vi.mocked(pushOrPr).mockResolvedValueOnce({ mode: 'direct' });
    // Simulate "git diff --cached" showing staged files
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 0, stdout: '.mcp-start.js', stderr: '' } as never);

    const { run } = await import('../../src/commands/update.js');
    const lines: string[] = [];
    await run('DirectPush', { cfgPath, skipConfirm: true, log: (m: unknown) => lines.push(String(m)) });

    expect(vi.mocked(commit)).toHaveBeenCalled();
    expect(vi.mocked(pushOrPr)).toHaveBeenCalled();
    expect(lines.some(l => /done/i.test(l))).toBe(true);
  });
});

// ── U-5: launcher updated, pushed via PR ─────────────────────────────────────

describe('U-5: launcher updated, PR mode', () => {
  it('logs PR branch name', async () => {
    const vaultDir = join(tmp, 'PrMode');
    makeGitDir(vaultDir);
    writeFileSync(join(vaultDir, '.mcp-start.js'), '// stale');
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { PrMode: vaultDir });

    vi.mocked(pushOrPr).mockResolvedValueOnce({ mode: 'pr', branch: 'vaultkit-update-1234567890' });
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 0, stdout: '.mcp-start.js', stderr: '' } as never);

    const { run } = await import('../../src/commands/update.js');
    const lines: string[] = [];
    await run('PrMode', { cfgPath, skipConfirm: true, log: (m: unknown) => lines.push(String(m)) });

    expect(lines.some(l => /PR|branch/i.test(l))).toBe(true);
    expect(lines.some(l => /vaultkit-update/i.test(l))).toBe(true);
  });
});

// ── U-6: MCP re-registration skipped when claude not found ───────────────────

describe('U-6: claude not found', () => {
  it('logs warning with manual commands', async () => {
    const vaultDir = join(tmp, 'NoClaude');
    makeGitDir(vaultDir);
    writeFileSync(join(vaultDir, '.mcp-start.js'), '// stale');
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { NoClaude: vaultDir });

    vi.mocked(findTool).mockResolvedValue(null);
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 0, stdout: '.mcp-start.js', stderr: '' } as never);
    vi.mocked(pushOrPr).mockResolvedValueOnce({ mode: 'direct' });

    const { run } = await import('../../src/commands/update.js');
    const lines: string[] = [];
    await run('NoClaude', { cfgPath, skipConfirm: true, log: (m: unknown) => lines.push(String(m)) });

    expect(lines.some(l => /Claude Code not found|MCP re-registration skipped/i.test(l))).toBe(true);
    expect(lines.some(l => /claude mcp/i.test(l))).toBe(true);
  });
});

// ── U-7: layout files missing — commit message reflects layout-only change ───

describe('U-7: layout-only restore', () => {
  it('uses layout-only commit message when launcher unchanged', async () => {
    const vaultDir = join(tmp, 'LayoutOnly');
    makeGitDir(vaultDir);
    // Launcher matches template — no launcher change
    copyFileSync(TMPL_PATH, join(vaultDir, '.mcp-start.js'));
    // Missing layout files — CLAUDE.md absent

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { LayoutOnly: vaultDir });

    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 0, stdout: 'CLAUDE.md', stderr: '' } as never);
    vi.mocked(pushOrPr).mockResolvedValueOnce({ mode: 'direct' });

    const { run } = await import('../../src/commands/update.js');
    await run('LayoutOnly', { cfgPath, skipConfirm: true, log: () => {} });

    expect(vi.mocked(commit)).toHaveBeenCalledWith(
      vaultDir,
      expect.stringMatching(/restore standard vaultkit layout/i)
    );
  });
});
