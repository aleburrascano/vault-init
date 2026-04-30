import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execa } from 'execa';

vi.mock('../../src/lib/git.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, getStatus: vi.fn() };
});

import { getStatus } from '../../src/lib/git.js';

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-status-test-'));
  vi.mocked(getStatus).mockReset();
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

function makeGitRepo(dir) {
  mkdirSync(join(dir, '.git'), { recursive: true });
}

async function runStatus(name, cfgPath) {
  const { run } = await import('../../src/commands/status.js');
  const lines = [];
  await run(name, { cfgPath, log: (m) => lines.push(m) });
  return lines;
}

// ── S-1: no vaults registered ────────────────────────────────────────────────

describe('S-1: no vaults registered', () => {
  it('logs no vaults message', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');

    const lines = await runStatus(undefined, cfgPath);
    expect(lines.some(l => /no vaults/i.test(l))).toBe(true);
  });
});

// ── S-2: vault directory missing ─────────────────────────────────────────────

describe('S-2: vault directory missing', () => {
  it('shows DIR MISSING for absent vault dir', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { GhostVault: { dir: join(tmp, 'nonexistent'), hash: null } });

    const lines = await runStatus(undefined, cfgPath);
    expect(lines.some(l => /DIR MISSING/i.test(l))).toBe(true);
  });
});

// ── S-3: vault dir exists but not a git repo ──────────────────────────────────

describe('S-3: not a git repo', () => {
  it('shows [not a git repo] for non-git directory', async () => {
    const vaultDir = join(tmp, 'NoGit');
    mkdirSync(vaultDir, { recursive: true });
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { NoGit: { dir: vaultDir, hash: null } });

    const lines = await runStatus(undefined, cfgPath);
    expect(lines.some(l => /not a git repo/i.test(l))).toBe(true);
  });
});

// ── S-4: clean vault with upstream ───────────────────────────────────────────

describe('S-4: clean vault with upstream', () => {
  it('shows branch name and clean status', async () => {
    const vaultDir = join(tmp, 'CleanVault');
    makeGitRepo(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { CleanVault: { dir: vaultDir, hash: 'abc123' } });

    vi.mocked(getStatus).mockResolvedValueOnce({
      branch: 'main',
      dirty: false,
      ahead: 0,
      behind: 0,
      remote: 'origin/main',
      lastCommit: '2026-04-29 Initial commit',
    });

    const lines = await runStatus(undefined, cfgPath);
    expect(lines.some(l => /CleanVault/i.test(l))).toBe(true);
    expect(lines.some(l => /main.*clean/i.test(l))).toBe(true);
    expect(lines.some(l => /2026-04-29 Initial commit/i.test(l))).toBe(true);
  });
});

// ── S-5: dirty vault ──────────────────────────────────────────────────────────

describe('S-5: dirty vault', () => {
  it('shows dirty status', async () => {
    const vaultDir = join(tmp, 'DirtyVault');
    makeGitRepo(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { DirtyVault: { dir: vaultDir, hash: null } });

    vi.mocked(getStatus).mockResolvedValueOnce({
      branch: 'main',
      dirty: true,
      ahead: 0,
      behind: 0,
      remote: 'origin/main',
      lastCommit: '',
    });

    const lines = await runStatus(undefined, cfgPath);
    expect(lines.some(l => /dirty/i.test(l))).toBe(true);
  });
});

// ── S-6: vault ahead of remote ───────────────────────────────────────────────

describe('S-6: vault ahead of remote', () => {
  it('shows ahead count', async () => {
    const vaultDir = join(tmp, 'AheadVault');
    makeGitRepo(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { AheadVault: { dir: vaultDir, hash: null } });

    vi.mocked(getStatus).mockResolvedValueOnce({
      branch: 'main',
      dirty: false,
      ahead: 3,
      behind: 0,
      remote: 'origin/main',
      lastCommit: '',
    });

    const lines = await runStatus(undefined, cfgPath);
    expect(lines.some(l => /ahead 3/i.test(l))).toBe(true);
  });
});

// ── S-7: vault behind remote ──────────────────────────────────────────────────

describe('S-7: vault behind remote', () => {
  it('shows behind count', async () => {
    const vaultDir = join(tmp, 'BehindVault');
    makeGitRepo(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { BehindVault: { dir: vaultDir, hash: null } });

    vi.mocked(getStatus).mockResolvedValueOnce({
      branch: 'main',
      dirty: false,
      ahead: 0,
      behind: 5,
      remote: 'origin/main',
      lastCommit: '',
    });

    const lines = await runStatus(undefined, cfgPath);
    expect(lines.some(l => /behind 5/i.test(l))).toBe(true);
  });
});

// ── S-8: vault with no upstream ───────────────────────────────────────────────

describe('S-8: no upstream configured', () => {
  it('shows [no upstream]', async () => {
    const vaultDir = join(tmp, 'LocalOnly');
    makeGitRepo(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { LocalOnly: { dir: vaultDir, hash: null } });

    vi.mocked(getStatus).mockResolvedValueOnce({
      branch: 'main',
      dirty: false,
      ahead: 0,
      behind: 0,
      remote: null,
      lastCommit: '',
    });

    const lines = await runStatus(undefined, cfgPath);
    expect(lines.some(l => /no upstream/i.test(l))).toBe(true);
  });
});

// ── S-9: no pinned hash — legacy registration ─────────────────────────────────

describe('S-9: no pinned hash', () => {
  it('suggests vaultkit update', async () => {
    const vaultDir = join(tmp, 'LegacyVault');
    makeGitRepo(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { LegacyVault: { dir: vaultDir, hash: null } });

    vi.mocked(getStatus).mockResolvedValueOnce({
      branch: 'main',
      dirty: false,
      ahead: 0,
      behind: 0,
      remote: 'origin/main',
      lastCommit: '',
    });

    const lines = await runStatus(undefined, cfgPath);
    expect(lines.some(l => /vaultkit update/i.test(l))).toBe(true);
  });
});

// ── S-10: single-vault detail mode — vault not registered ─────────────────────

describe('S-10: single-vault mode — not registered', () => {
  it('throws when vault not in registry', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');

    const { run } = await import('../../src/commands/status.js');
    await expect(run('UnknownVault', { cfgPath, log: () => {} })).rejects.toThrow(/not registered/i);
  });
});

// ── S-11: single-vault detail mode — directory is not a git repo ──────────────

describe('S-11: single-vault mode — not a git repo', () => {
  it('throws when dir exists but has no .git', async () => {
    const vaultDir = join(tmp, 'NotGit');
    mkdirSync(vaultDir, { recursive: true });
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { NotGit: { dir: vaultDir, hash: null } });

    const { run } = await import('../../src/commands/status.js');
    await expect(run('NotGit', { cfgPath, log: () => {} })).rejects.toThrow(/not a git repository/i);
  });
});

// ── S-12: single-vault detail mode — happy path (real git repo) ───────────────

describe('S-12: single-vault detail mode — real git repo', () => {
  it('shows vault name and path, and git status output', async () => {
    const bare = join(tmp, 'bare.git');
    const vaultDir = join(tmp, 'DetailVault');
    await execa('git', ['init', '--bare', '-b', 'main', bare]);
    await execa('git', ['clone', bare, vaultDir]);
    await execa('git', ['-C', vaultDir, 'config', 'user.email', 'test@test.com']);
    await execa('git', ['-C', vaultDir, 'config', 'user.name', 'Test']);
    writeFileSync(join(vaultDir, 'README.md'), 'hello');
    await execa('git', ['-C', vaultDir, 'add', '.']);
    await execa('git', ['-C', vaultDir, 'commit', '-m', 'init']);
    await execa('git', ['-C', vaultDir, 'push', '-u', 'origin', 'main']);

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { DetailVault: { dir: vaultDir, hash: null } });

    const { run } = await import('../../src/commands/status.js');
    const lines = [];
    await run('DetailVault', { cfgPath, log: (m) => lines.push(m) });

    expect(lines.some(l => /DetailVault/i.test(l))).toBe(true);
    expect(lines.some(l => /Path:/i.test(l))).toBe(true);
    // git status output should mention "nothing to commit" or "up to date"
    expect(lines.some(l => /nothing to commit|up to date|working tree clean/i.test(l))).toBe(true);
  }, 15000);
});

// ── LIVE: status reports real vault state ─────────────────────────────────────

const LIVE = !!process.env.VAULTKIT_LIVE_TEST;
const LIVE_VAULT = `vk-live-status-${Date.now()}`;

describe.skipIf(!LIVE)('live: status reports real vault state', { timeout: 60_000 }, () => {
  async function restoreReal() {
    const realGit = await vi.importActual('../../src/lib/git.js');
    vi.mocked(getStatus).mockImplementation(realGit.getStatus);
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

  it('lists vault in summary mode', async () => {
    const { run } = await import('../../src/commands/status.js');
    const lines = [];
    await run(undefined, { log: (m) => lines.push(m) });
    expect(lines.some(l => l.includes(LIVE_VAULT))).toBe(true);
  });

  it('shows detail in single-vault mode', async () => {
    const { run } = await import('../../src/commands/status.js');
    const lines = [];
    await run(LIVE_VAULT, { log: (m) => lines.push(m) });
    expect(lines.some(l => /main/i.test(l))).toBe(true);
    expect(lines.some(l => /clean|nothing to commit|up.to.date/i.test(l))).toBe(true);
  });
});
