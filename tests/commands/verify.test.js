import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

// Mock interactive prompt so tests never block waiting for user input
vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn() }));

// Mock execa for network-free git fetch/diff/pull
vi.mock('execa', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, execa: vi.fn() };
});

// Mock findTool to control whether claude is "installed"
vi.mock('../../src/lib/platform.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, findTool: vi.fn() };
});

import { confirm } from '@inquirer/prompts';
import { execa } from 'execa';
import { findTool } from '../../src/lib/platform.js';

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-verify-test-'));
  vi.mocked(confirm).mockReset();
  vi.mocked(execa).mockReset();
  vi.mocked(findTool).mockReset();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeCfg(cfgPath, vaults) {
  const mcpServers = {};
  for (const [name, { dir, hash }] of Object.entries(vaults)) {
    const args = [`${dir}/.mcp-start.js`];
    if (hash) args.push(`--expected-sha256=${hash}`);
    mcpServers[name] = { command: 'node', args };
  }
  writeFileSync(cfgPath, JSON.stringify({ mcpServers }), 'utf8');
}

function computeHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

function writeLauncher(dir, content = '// launcher') {
  writeFileSync(join(dir, '.mcp-start.js'), content, 'utf8');
  return computeHash(content);
}

function mockNoGit() {
  // No .git directory, so upstream drift check is skipped
  vi.mocked(execa).mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
}

async function runVerify(name, cfgPath) {
  const { run } = await import('../../src/commands/verify.js');
  const lines = [];
  await run(name, { cfgPath, log: (m) => lines.push(m) });
  return lines;
}

// ── V-1: invalid vault name ───────────────────────────────────────────────────

describe('V-1: invalid vault name', () => {
  it('throws on invalid name format', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');

    const { run } = await import('../../src/commands/verify.js');
    await expect(run('bad name!', { cfgPath, log: () => {} })).rejects.toThrow();
  });
});

// ── V-2: vault not registered ─────────────────────────────────────────────────

describe('V-2: vault not registered', () => {
  it('throws with "not a registered vault" message', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');

    const { run } = await import('../../src/commands/verify.js');
    await expect(run('NoSuchVault', { cfgPath, log: () => {} })).rejects.toThrow(/not a registered vault/i);
  });
});

// ── V-3: launcher file missing ────────────────────────────────────────────────

describe('V-3: launcher missing', () => {
  it('throws with update hint', async () => {
    const vaultDir = join(tmp, 'NoLauncher');
    mkdirSync(vaultDir, { recursive: true });
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { NoLauncher: { dir: vaultDir, hash: null } });

    const { run } = await import('../../src/commands/verify.js');
    await expect(run('NoLauncher', { cfgPath, log: () => {} })).rejects.toThrow(/vaultkit update/i);
  });
});

// ── V-4: hash matches — verified with no action needed ───────────────────────

describe('V-4: hash matches', () => {
  it('reports verified without prompting', async () => {
    const vaultDir = join(tmp, 'GoodVault');
    mkdirSync(vaultDir, { recursive: true });
    const hash = writeLauncher(vaultDir);

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { GoodVault: { dir: vaultDir, hash } });

    mockNoGit();

    const lines = await runVerify('GoodVault', cfgPath);

    expect(lines.some(l => /verified/i.test(l))).toBe(true);
    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
  });
});

// ── V-5: hash mismatch — user declines re-pin ─────────────────────────────────

describe('V-5: hash mismatch, user aborts', () => {
  it('logs aborted and does not call claude mcp', async () => {
    const vaultDir = join(tmp, 'MismatchVault');
    mkdirSync(vaultDir, { recursive: true });
    writeLauncher(vaultDir, '// real content');

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MismatchVault: { dir: vaultDir, hash: 'a'.repeat(64) } });

    mockNoGit();
    vi.mocked(confirm).mockResolvedValueOnce(false);

    const lines = await runVerify('MismatchVault', cfgPath);

    expect(lines.some(l => /aborted/i.test(l))).toBe(true);
    // confirm was called once (re-pin prompt)
    expect(vi.mocked(confirm)).toHaveBeenCalledOnce();
  });
});

// ── V-6: hash mismatch — user confirms re-pin, claude found ──────────────────

describe('V-6: hash mismatch, user confirms re-pin', () => {
  it('calls claude mcp remove then add with new hash', async () => {
    const vaultDir = join(tmp, 'RepinVault');
    mkdirSync(vaultDir, { recursive: true });
    const realHash = writeLauncher(vaultDir, '// launcher v2');

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { RepinVault: { dir: vaultDir, hash: 'deadbeef'.repeat(8) } });

    mockNoGit();
    vi.mocked(confirm).mockResolvedValueOnce(true);
    vi.mocked(findTool).mockResolvedValue('/usr/bin/claude');
    // After confirm, execa is called for mcp remove + add
    vi.mocked(execa).mockImplementation(async (cmd, args) => {
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const lines = await runVerify('RepinVault', cfgPath);

    expect(lines.some(l => /re-pinning/i.test(l))).toBe(true);
    expect(lines.some(l => /done/i.test(l))).toBe(true);
    // claude mcp remove called
    const removeCalls = vi.mocked(execa).mock.calls.filter(c => c[1]?.includes('remove'));
    expect(removeCalls.length).toBeGreaterThan(0);
    // claude mcp add called with expected-sha256
    const addCalls = vi.mocked(execa).mock.calls.filter(c => c[1]?.some(a => a?.includes('expected-sha256')));
    expect(addCalls.length).toBeGreaterThan(0);
    expect(addCalls[0][1]).toContain(`--expected-sha256=${realHash}`);
  });
});

// ── V-7: hash mismatch — user confirms but claude not found ──────────────────

describe('V-7: hash mismatch, claude not found', () => {
  it('logs manual instruction and throws', async () => {
    const vaultDir = join(tmp, 'NoClaude');
    mkdirSync(vaultDir, { recursive: true });
    writeLauncher(vaultDir, '// content');

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { NoClaude: { dir: vaultDir, hash: 'wrong'.padEnd(64, '0') } });

    mockNoGit();
    vi.mocked(confirm).mockResolvedValueOnce(true);
    vi.mocked(findTool).mockResolvedValue(null);

    const { run } = await import('../../src/commands/verify.js');
    const lines = [];
    await expect(run('NoClaude', { cfgPath, log: (m) => lines.push(m) })).rejects.toThrow(/Claude Code not found/i);
    expect(lines.some(l => /claude mcp/i.test(l))).toBe(true);
  });
});

// ── V-8: no pinned hash (legacy) — mismatch against empty string ──────────────

describe('V-8: no pinned hash', () => {
  it('shows (none registered) for pinned and prompts to re-pin', async () => {
    const vaultDir = join(tmp, 'LegacyVerify');
    mkdirSync(vaultDir, { recursive: true });
    writeLauncher(vaultDir);

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { LegacyVerify: { dir: vaultDir, hash: null } });

    mockNoGit();
    vi.mocked(confirm).mockResolvedValueOnce(false);

    const lines = await runVerify('LegacyVerify', cfgPath);

    expect(lines.some(l => /none registered/i.test(l))).toBe(true);
    expect(lines.some(l => /aborted/i.test(l))).toBe(true);
  });
});

// ── LIVE: verify checks real launcher hash ────────────────────────────────────

const LIVE = !!process.env.VAULTKIT_LIVE_TEST;
const LIVE_VAULT = `vk-live-verify-${Date.now()}`;

describe.skipIf(!LIVE)('live: verify checks real launcher hash', { timeout: 60_000 }, () => {
  async function restoreReal() {
    const { execa: realExeca } = await vi.importActual('execa');
    vi.mocked(execa).mockImplementation(realExeca);
    const realPlatform = await vi.importActual('../../src/lib/platform.js');
    vi.mocked(findTool).mockImplementation(realPlatform.findTool);
  }

  beforeEach(restoreReal);

  beforeAll(async () => {
    await restoreReal();
    const { run } = await import('../../src/commands/init.js');
    await run(LIVE_VAULT, { publishMode: 'private', skipInstallCheck: true, log: () => {} });
  }, 60_000);

  afterAll(async () => {
    await restoreReal();
    const { run } = await import('../../src/commands/destroy.js');
    await run(LIVE_VAULT, { skipConfirm: true, skipMcp: true, confirmName: LIVE_VAULT, log: () => {} }).catch(() => {});
  }, 60_000);

  it('verifies launcher hash matches pinned hash', async () => {
    const { run } = await import('../../src/commands/verify.js');
    const lines = [];
    await run(LIVE_VAULT, { yes: false, log: (m) => lines.push(m) });
    expect(lines.some(l => /verified/i.test(l))).toBe(true);
  });
});
