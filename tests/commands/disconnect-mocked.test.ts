import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn(), input: vi.fn() }));
vi.mock('execa', async (importOriginal) => {
  const real = await importOriginal<typeof import('execa')>();
  return { ...real, execa: vi.fn() };
});
vi.mock('../../src/lib/platform.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/platform.js')>();
  return { ...real, findTool: vi.fn() };
});

import { input } from '@inquirer/prompts';
import { execa } from 'execa';
import { findTool } from '../../src/lib/platform.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-disconnect-mock-'));
  vi.mocked(input).mockReset();
  vi.mocked(execa).mockReset();
  vi.mocked(findTool).mockReset();
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

function makeVaultDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), '');
  mkdirSync(join(dir, 'raw'), { recursive: true });
  mkdirSync(join(dir, 'wiki'), { recursive: true });
}

// ── DIS-1: vault dir missing — logged as skipped, not an error ────────────────

describe('DIS-1: vault dir missing', () => {
  it('logs skipping local deletion and reports done', async () => {
    const vaultDir = join(tmp, 'GhostVault');
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { GhostVault: vaultDir });
    // dir doesn't exist

    vi.mocked(findTool).mockResolvedValue(null);

    const { run } = await import('../../src/commands/disconnect.js');
    const lines: unknown[] = [];
    await run('GhostVault', { cfgPath, skipConfirm: true, skipMcp: true, log: (m: unknown) => lines.push(m) });

    expect(lines.some(l => /not found.*skip|skip/i.test(String(l)))).toBe(true);
    expect(lines.some(l => /done/i.test(String(l)))).toBe(true);
  });
});

// ── DIS-2: wrong name typed in confirmation → aborts ─────────────────────────

describe('DIS-2: wrong name typed', () => {
  it('logs aborted and does not delete directory', async () => {
    const vaultDir = join(tmp, 'MyVault');
    makeVaultDir(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: vaultDir });

    vi.mocked(input).mockResolvedValueOnce('WrongName');

    const { run } = await import('../../src/commands/disconnect.js');
    const lines: unknown[] = [];
    await run('MyVault', { cfgPath, skipMcp: true, log: (m: unknown) => lines.push(m) });

    expect(lines.some(l => /aborted/i.test(String(l)))).toBe(true);
    expect(existsSync(vaultDir)).toBe(true);
  });
});

// ── DIS-3: correct name typed → proceeds ─────────────────────────────────────

describe('DIS-3: correct name typed', () => {
  it('deletes directory when name confirmed', async () => {
    const vaultDir = join(tmp, 'ConfirmedVault');
    makeVaultDir(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { ConfirmedVault: vaultDir });

    vi.mocked(input).mockResolvedValueOnce('ConfirmedVault');

    const { run } = await import('../../src/commands/disconnect.js');
    await run('ConfirmedVault', { cfgPath, skipMcp: true, log: () => {} });

    expect(existsSync(vaultDir)).toBe(false);
  });
});

// ── DIS-4: MCP removal called when claude found ───────────────────────────────

describe('DIS-4: MCP removal with claude found', () => {
  it('calls claude mcp remove', async () => {
    const vaultDir = join(tmp, 'McpVault');
    makeVaultDir(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { McpVault: vaultDir });

    vi.mocked(findTool).mockResolvedValue('/usr/bin/claude');
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);

    const { run } = await import('../../src/commands/disconnect.js');
    await run('McpVault', { cfgPath, skipConfirm: true, log: () => {} });

    const removeCalls = vi.mocked(execa).mock.calls.filter(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args.includes('remove') && args.includes('McpVault');
    });
    expect(removeCalls.length).toBeGreaterThan(0);
  });
});

// ── DIS-5: MCP removal skipped when claude not found ─────────────────────────

describe('DIS-5: MCP removal skipped', () => {
  it('logs warning and manual instruction when claude not found', async () => {
    const vaultDir = join(tmp, 'NoClaudeVault');
    makeVaultDir(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { NoClaudeVault: vaultDir });

    vi.mocked(findTool).mockResolvedValue(null);

    const { run } = await import('../../src/commands/disconnect.js');
    const lines: unknown[] = [];
    await run('NoClaudeVault', { cfgPath, skipConfirm: true, log: (m: unknown) => lines.push(m) });

    expect(lines.some(l => /Claude Code not found|MCP cleanup skipped/i.test(String(l)))).toBe(true);
    expect(lines.some(l => /claude mcp remove/i.test(String(l)))).toBe(true);
  });
});
