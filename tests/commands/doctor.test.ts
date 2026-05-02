import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { arrayLogger } from '../helpers/logger.js';

vi.mock('../../src/lib/platform.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/platform.js')>();
  return { ...real, findTool: vi.fn() };
});

vi.mock('execa', async (importOriginal) => {
  const real = await importOriginal<typeof import('execa')>();
  return { ...real, execa: vi.fn() };
});

import { findTool } from '../../src/lib/platform.js';
import { execa } from 'execa';
import { writeCfg } from '../helpers/registry.js';
import { mockGitConfig } from '../helpers/git.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-doctor-test-'));
  vi.mocked(findTool).mockReset();
  vi.mocked(execa).mockReset();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function mockAllToolsFound(): void {
  vi.mocked(findTool).mockImplementation(async (name: string) => `/usr/bin/${name}`);
}

function mockGhAuth(authenticated: boolean = true): void {
  vi.mocked(execa).mockImplementation((async (cmd: string, args?: readonly string[]) => {
    if (args?.[0] === 'auth' && args?.[1] === 'status') {
      return { exitCode: authenticated ? 0 : 1, stdout: '', stderr: '' };
    }
    if (args?.includes('user.name')) return { exitCode: 0, stdout: 'Test User', stderr: '' };
    if (args?.includes('user.email')) return { exitCode: 0, stdout: 'test@example.com', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  }) as never);
}

function writeLauncher(dir: string, content: string = '// launcher'): void {
  writeFileSync(join(dir, '.mcp-start.js'), content, 'utf8');
}

async function runDoctor(cfgPath: string): Promise<{ issues: number; lines: string[] }> {
  const { run } = await import('../../src/commands/doctor.js');
  const lines: string[] = [];
  const issues = await run({ cfgPath, log: arrayLogger(lines) });
  return { issues, lines };
}

// ── D-1: git not found — required ────────────────────────────────────────────

describe('D-1: git not found', () => {
  it('reports fail for git and increments issues', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'git') return null;
      return `/usr/bin/${name}`;
    });
    mockGitConfig();

    const { issues, lines } = await runDoctor(cfgPath);

    expect(lines.some(l => /git.*not found/i.test(l))).toBe(true);
    expect(lines.some(l => /fail/i.test(l))).toBe(true);
    expect(issues).toBeGreaterThan(0);
  });
});

// ── D-2: node version too old ─────────────────────────────────────────────────

describe('D-2: node version check', () => {
  it('logs ok when node >= 22', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    mockAllToolsFound();
    mockGhAuth(true);

    const { lines } = await runDoctor(cfgPath);
    // Current node in this env is >= 22 (project requires it)
    const nodeMajor = parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    if (nodeMajor >= 22) {
      expect(lines.some(l => /ok.*node/i.test(l))).toBe(true);
    }
  });
});

// ── D-3: gh not found — warning only ─────────────────────────────────────────

describe('D-3: gh not found', () => {
  it('logs warn for gh but does not fail', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'gh') return null;
      return `/usr/bin/${name}`;
    });
    mockGitConfig();

    const { lines } = await runDoctor(cfgPath);

    expect(lines.some(l => /gh.*not found/i.test(l))).toBe(true);
    expect(lines.some(l => /warn/i.test(l))).toBe(true);
    // gh missing is a warning, not a hard failure
    // issues may still be 0 if only gh is missing
    const gitLine = lines.find(l => /git/i.test(l));
    expect(gitLine).toBeDefined();
  });
});

// ── D-4: gh found but not authenticated ───────────────────────────────────────

describe('D-4: gh found but unauthenticated', () => {
  it('warns about authentication', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    mockAllToolsFound();
    mockGhAuth(false);

    const { lines } = await runDoctor(cfgPath);

    expect(lines.some(l => /gh.*not authenticated|not authenticated/i.test(l))).toBe(true);
    expect(lines.some(l => /gh auth login/i.test(l))).toBe(true);
  });
});

// ── D-5: claude not found — warning only ──────────────────────────────────────

describe('D-5: claude not found', () => {
  it('logs warn and install hint for claude', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'claude') return null;
      return `/usr/bin/${name}`;
    });
    mockGhAuth(true);

    const { lines } = await runDoctor(cfgPath);

    expect(lines.some(l => /claude.*not found/i.test(l))).toBe(true);
    expect(lines.some(l => /npm install/i.test(l))).toBe(true);
  });
});

// ── D-6: git user.name / user.email not configured ────────────────────────────

describe('D-6: git config not set', () => {
  it('reports fail and shows remedy hint', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    mockAllToolsFound();
    vi.mocked(execa).mockImplementation((async (cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'auth') return { exitCode: 0, stdout: '', stderr: '' };
      // git config returns empty stdout — not configured
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const { issues, lines } = await runDoctor(cfgPath);

    expect(lines.some(l => /git config.*not set|user\.name.*user\.email/i.test(l))).toBe(true);
    expect(lines.some(l => /git config --global/i.test(l))).toBe(true);
    expect(issues).toBeGreaterThan(0);
  });
});

// ── D-7: no vaults registered ─────────────────────────────────────────────────

describe('D-7: no vaults registered', () => {
  it('logs "no vaults" and returns 0 issues', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    mockAllToolsFound();
    mockGhAuth(true);

    const { issues, lines } = await runDoctor(cfgPath);

    expect(lines.some(l => /no vaults/i.test(l))).toBe(true);
    // Prerequisites all ok, no vault issues
    expect(issues).toBe(0);
  });
});

// ── D-8: vault directory missing ─────────────────────────────────────────────

describe('D-8: vault directory missing', () => {
  it('reports fail and connect hint', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { GhostVault: { dir: join(tmp, 'nonexistent'), hash: null } });
    mockAllToolsFound();
    mockGhAuth(true);

    const { issues, lines } = await runDoctor(cfgPath);

    expect(lines.some(l => /GhostVault.*directory missing|missing/i.test(l))).toBe(true);
    expect(lines.some(l => /vaultkit connect/i.test(l))).toBe(true);
    expect(issues).toBeGreaterThan(0);
  });
});

// ── D-9: launcher .mcp-start.js missing ───────────────────────────────────────

describe('D-9: launcher missing', () => {
  it('warns and suggests update', async () => {
    const vaultDir = join(tmp, 'MyVault');
    mkdirSync(vaultDir, { recursive: true });
    // no .mcp-start.js written

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: { dir: vaultDir, hash: 'abc123' } });
    mockAllToolsFound();
    mockGhAuth(true);

    const { lines } = await runDoctor(cfgPath);

    expect(lines.some(l => /\.mcp-start\.js.*missing|missing/i.test(l))).toBe(true);
    expect(lines.some(l => /vaultkit update/i.test(l))).toBe(true);
  });
});

// ── D-10: hash mismatch ────────────────────────────────────────────────────────

describe('D-10: hash mismatch', () => {
  it('reports fail with pinned vs on-disk hashes and verify hint', async () => {
    const vaultDir = join(tmp, 'MyVault');
    mkdirSync(vaultDir, { recursive: true });
    writeLauncher(vaultDir, '// modified launcher content');

    const cfgPath = join(tmp, '.claude.json');
    // Pinned hash is wrong — won't match actual file content
    writeCfg(cfgPath, { MyVault: { dir: vaultDir, hash: 'a'.repeat(64) } });
    mockAllToolsFound();
    mockGhAuth(true);

    const { issues, lines } = await runDoctor(cfgPath);

    expect(lines.some(l => /hash mismatch/i.test(l))).toBe(true);
    expect(lines.some(l => /pinned/i.test(l))).toBe(true);
    expect(lines.some(l => /on.disk/i.test(l))).toBe(true);
    expect(lines.some(l => /vaultkit verify/i.test(l))).toBe(true);
    expect(issues).toBeGreaterThan(0);
  });
});

// ── D-11: no pinned hash (legacy registration) ────────────────────────────────

describe('D-11: no pinned hash (legacy)', () => {
  it('warns and suggests update', async () => {
    const vaultDir = join(tmp, 'LegacyVault');
    mkdirSync(vaultDir, { recursive: true });
    writeLauncher(vaultDir, '// launcher');

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { LegacyVault: { dir: vaultDir, hash: null } });
    mockAllToolsFound();
    mockGhAuth(true);

    const { lines } = await runDoctor(cfgPath);

    expect(lines.some(l => /no pinned hash|legacy/i.test(l))).toBe(true);
    expect(lines.some(l => /vaultkit update/i.test(l))).toBe(true);
  });
});

// ── D-12: vault layout incomplete (not vaultLike) ─────────────────────────────

describe('D-12: vault layout incomplete', () => {
  it('warns about incomplete layout and suggests update', async () => {
    const vaultDir = join(tmp, 'IncompleteVault');
    mkdirSync(vaultDir, { recursive: true });

    // Write a real launcher so hash check passes
    const { createHash } = await import('node:crypto');
    const content = '// valid launcher';
    const realHash = createHash('sha256').update(content).digest('hex');
    writeFileSync(join(vaultDir, '.mcp-start.js'), content, 'utf8');

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { IncompleteVault: { dir: vaultDir, hash: realHash } });
    mockAllToolsFound();
    mockGhAuth(true);

    const { lines } = await runDoctor(cfgPath);

    // dir exists, launcher exists, hash matches, but no .obsidian or CLAUDE.md+raw+wiki
    expect(lines.some(l => /vault layout incomplete|incomplete/i.test(l))).toBe(true);
    expect(lines.some(l => /vaultkit update/i.test(l))).toBe(true);
  });
});

// ── D-13: healthy vault — all checks pass ─────────────────────────────────────

describe('D-13: healthy vault', () => {
  it('reports ok and 0 issues', async () => {
    const vaultDir = join(tmp, 'HealthyVault');
    mkdirSync(join(vaultDir, '.obsidian'), { recursive: true });

    const { createHash } = await import('node:crypto');
    const content = '// launcher';
    const realHash = createHash('sha256').update(content).digest('hex');
    writeFileSync(join(vaultDir, '.mcp-start.js'), content, 'utf8');

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { HealthyVault: { dir: vaultDir, hash: realHash } });
    mockAllToolsFound();
    mockGhAuth(true);

    const { issues, lines } = await runDoctor(cfgPath);

    expect(lines.some(l => /HealthyVault.*ok|ok.*HealthyVault/i.test(l))).toBe(true);
    expect(issues).toBe(0);
    expect(lines.some(l => /everything looks good/i.test(l))).toBe(true);
  });
});

// ── D-14: non-vaultkit MCP servers reported ────────────────────────────────────

describe('D-14: non-vaultkit MCP servers listed', () => {
  it('mentions other MCP servers by name', async () => {
    const vaultDir = join(tmp, 'RealVault');
    mkdirSync(join(vaultDir, '.obsidian'), { recursive: true });

    const { createHash } = await import('node:crypto');
    const content = '// launcher';
    const realHash = createHash('sha256').update(content).digest('hex');
    writeFileSync(join(vaultDir, '.mcp-start.js'), content, 'utf8');

    const cfgPath = join(tmp, '.claude.json');
    // One real vault + one non-vault MCP server
    const mcpServers = {
      RealVault: { command: 'node', args: [`${vaultDir}/.mcp-start.js`, `--expected-sha256=${realHash}`] },
      myOtherServer: { command: 'python', args: ['server.py'] },
    };
    writeFileSync(cfgPath, JSON.stringify({ mcpServers }), 'utf8');
    mockAllToolsFound();
    mockGhAuth(true);

    const { lines } = await runDoctor(cfgPath);

    expect(lines.some(l => /other MCP servers|myOtherServer/i.test(l))).toBe(true);
  });
});

// ── D-15: multi-vault aggregation across mixed states ────────────────────────

describe('D-15: multi-vault aggregation', () => {
  it('reports each of N vaults independently and sums the issue count', async () => {
    const { createHash } = await import('node:crypto');

    // Vault A: healthy
    const dirA = join(tmp, 'VaultA');
    mkdirSync(join(dirA, '.obsidian'), { recursive: true });
    const contentA = '// A launcher';
    const hashA = createHash('sha256').update(contentA).digest('hex');
    writeFileSync(join(dirA, '.mcp-start.js'), contentA, 'utf8');

    // Vault B: launcher missing (warn — does NOT count as issue)
    const dirB = join(tmp, 'VaultB');
    mkdirSync(dirB, { recursive: true });

    // Vault C: hash mismatch (fail — counts as issue)
    const dirC = join(tmp, 'VaultC');
    mkdirSync(dirC, { recursive: true });
    writeFileSync(join(dirC, '.mcp-start.js'), '// C content', 'utf8');

    // Vault D: directory missing (fail — counts as issue)
    const dirD = join(tmp, 'NeverExistedD');

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, {
      VaultA: { dir: dirA, hash: hashA },
      VaultB: { dir: dirB, hash: 'b'.repeat(64) },
      VaultC: { dir: dirC, hash: 'c'.repeat(64) }, // wrong hash
      VaultD: { dir: dirD, hash: 'd'.repeat(64) },
    });
    mockAllToolsFound();
    mockGhAuth(true);

    const { issues, lines } = await runDoctor(cfgPath);

    // Each vault appears in output independently
    expect(lines.some(l => /VaultA/.test(l) && /\+ ok/.test(l))).toBe(true);
    expect(lines.some(l => /VaultB/.test(l) && /\.mcp-start\.js.*missing|missing/i.test(l))).toBe(true);
    expect(lines.some(l => /VaultC/.test(l) && /hash mismatch/i.test(l))).toBe(true);
    expect(lines.some(l => /VaultD/.test(l) && /directory missing|missing/i.test(l))).toBe(true);
    // Two failures (C and D); B is a warn (does not count)
    expect(issues).toBe(2);
  });
});

// ── D-16: everything missing — issue cascade ──────────────────────────────────

describe('D-16: everything missing', () => {
  it('produces a coherent report when git, gh, claude all absent + git config empty', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    vi.mocked(findTool).mockResolvedValue(null);
    // git config returns empty for both name and email
    vi.mocked(execa).mockImplementation((async () => ({ exitCode: 0, stdout: '', stderr: '' })) as never);

    const { issues, lines } = await runDoctor(cfgPath);

    // git is required → fail
    expect(lines.some(l => /git.*not found/i.test(l))).toBe(true);
    // gh is recommended → warn
    expect(lines.some(l => /gh.*not found/i.test(l))).toBe(true);
    // claude is recommended → warn
    expect(lines.some(l => /claude.*not found/i.test(l))).toBe(true);
    // git config user.name / user.email → fail
    expect(lines.some(l => /git config.*not set/i.test(l))).toBe(true);
    // No vaults → 'no vaults' message (not part of issue count)
    expect(lines.some(l => /no vaults/i.test(l))).toBe(true);

    // 2 hard failures: git (required) + git config (required). gh and claude are warnings.
    expect(issues).toBe(2);
    expect(lines.some(l => new RegExp(`${issues} issue\\(s\\) found`).test(l))).toBe(true);
  });
});

// ── D-17: issue count return value matches summary line ───────────────────────

describe('D-17: issue count return value', () => {
  it('returns exactly the number of failures shown in the summary line', async () => {
    const cfgPath = join(tmp, '.claude.json');
    // 1 hard fail: vault dir missing. gh/claude/git all ok.
    writeCfg(cfgPath, { GhostA: { dir: join(tmp, 'no-such-dir-a'), hash: null } });
    mockAllToolsFound();
    mockGhAuth(true);

    const { issues, lines } = await runDoctor(cfgPath);

    expect(issues).toBe(1);
    expect(lines.some(l => /1 issue\(s\) found/.test(l))).toBe(true);
  });

  it('returns 0 and prints "everything looks good" when nothing is wrong', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    mockAllToolsFound();
    mockGhAuth(true);

    const { issues, lines } = await runDoctor(cfgPath);

    expect(issues).toBe(0);
    expect(lines.some(l => /everything looks good/i.test(l))).toBe(true);
  });
});

// ── D-18: gh auth status stderr variance — generic unauthenticated handling ───

describe('D-18: gh auth status non-zero exit produces warn regardless of stderr', () => {
  it('classifies any non-zero exit as not authenticated (no stderr-aware classification)', async () => {
    // Doctor uses exitCode === 0 as the only signal for authenticated state.
    // This test pins that simple binary so a future "stderr-aware
    // classification" change surfaces explicitly.
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    mockAllToolsFound();
    vi.mocked(execa).mockImplementation((async (cmd: string, args?: readonly string[]) => {
      if (args?.[0] === 'auth' && args?.[1] === 'status') {
        return { exitCode: 1, stdout: '', stderr: 'token has expired or been revoked' };
      }
      if (args?.includes('user.name')) return { exitCode: 0, stdout: 'Test', stderr: '' };
      if (args?.includes('user.email')) return { exitCode: 0, stdout: 'a@b.c', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const { lines } = await runDoctor(cfgPath);

    expect(lines.some(l => /not authenticated/i.test(l))).toBe(true);
    expect(lines.some(l => /gh auth login/i.test(l))).toBe(true);
  });
});

// ── D-19: gitLine format assertion (tightens D-3's toBeDefined) ───────────────

describe('D-19: git line format', () => {
  it('formats the git not-found line with the canonical "x fail" prefix', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'git') return null;
      return `/usr/bin/${name}`;
    });
    mockGitConfig();

    const { lines } = await runDoctor(cfgPath);

    // The git not-found output should follow the doctor format:
    //   "  x fail  git: not found"
    // (two leading spaces, "x fail" marker, two trailing spaces, name+message)
    const gitLine = lines.find(l => /git/i.test(l) && /not found/i.test(l));
    expect(gitLine).toMatch(/^\s+x fail\s+git:\s*not found$/);
  });
});
