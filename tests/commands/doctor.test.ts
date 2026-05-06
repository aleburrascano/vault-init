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
  // Pass `fix: false` explicitly so the test never tries to dispatch
  // a repair (the diagnostic-only path is what these tests pin) — also
  // avoids the interactive prompt path on a TTY.
  const issues = await run(undefined, { cfgPath, fix: false, log: arrayLogger(lines) });
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
    // Per the 3.0 UX principle, doctor's diagnostic output no longer
    // emits per-line `Hint: vaultkit X` strings. Repairable issues
    // surface via the trailing "Re-run with --fix to repair" line; the
    // un-fixable cases (dir missing / launcher missing) get a "Cannot
    // auto-fix" line. Assert the right surface for the issue category.
    expect(lines.some(l => /Re-run with --fix|Cannot auto-fix/i.test(l))).toBe(true);
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
    // Per the 3.0 UX principle, the unknown-SHA case prints "Auto-fix
    // refused without --force" rather than a `vaultkit verify` hint.
    expect(lines.some(l => /Auto-fix refused without --force|--force/i.test(l))).toBe(true);
    expect(issues).toBeGreaterThan(0);
  });
});

// ── D-10b: hash mismatch — historical SHA (outdated after upgrade) ────────────

describe('D-10b: hash mismatch — historical SHA', () => {
  it('warns (not fails) and surfaces the historical version label + repair offer', async () => {
    // Write known content to the launcher and inject its SHA into the
    // historical table at runtime. Avoids depending on cross-platform
    // git text-conversion quirks that shift template byte hashes between
    // CRLF/LF working-tree configurations.
    const vaultDir = join(tmp, 'OutdatedVault');
    mkdirSync(vaultDir, { recursive: true });
    const launcherContent = '// pretend pre-2.8.0 launcher';
    writeFileSync(join(vaultDir, '.mcp-start.js'), launcherContent, 'utf8');

    const { createHash } = await import('node:crypto');
    const onDiskSha = createHash('sha256').update(launcherContent).digest('hex');

    const { HISTORICAL_LAUNCHER_SHAS } = await import('../../src/lib/notices/launcher-history.js');
    HISTORICAL_LAUNCHER_SHAS[onDiskSha] = 'pre-2.8.0';

    try {
      const cfgPath = join(tmp, '.claude.json');
      writeCfg(cfgPath, { OutdatedVault: { dir: vaultDir, hash: 'b'.repeat(64) } });
      mockAllToolsFound();
      mockGhAuth(true);

      const { issues, lines } = await runDoctor(cfgPath);

      expect(lines.some(l => /hash mismatch/i.test(l))).toBe(true);
      expect(lines.some(l => /outdated after upgrade/i.test(l))).toBe(true);
      expect(lines.some(l => /pre-2\.8\.0/i.test(l))).toBe(true);
      // Per the 3.0 UX principle, doctor's diagnostic output no longer
      // emits `Hint: vaultkit update --all` per vault. Instead, a single
      // trailing line offers the repair (`Re-run with --fix`).
      expect(lines.some(l => /Re-run with --fix/i.test(l))).toBe(true);
      // Per the 3.0 contract, repairable issues count toward the return
      // value (so the user sees a non-zero exit and knows to re-run with
      // --fix). The "warn vs fail" distinction now lives in the log
      // mark on the per-vault line — historical drift uses `! warn`,
      // unknown drift uses `x fail`. Assert that the line carries the
      // warn mark, not the fail mark, even though `issues` is non-zero.
      expect(lines.some(l => /^.*! warn.*hash mismatch/i.test(l))).toBe(true);
      expect(lines.some(l => /^.*x fail.*hash mismatch/i.test(l))).toBe(false);
      expect(issues).toBeGreaterThan(0);
    } finally {
      delete HISTORICAL_LAUNCHER_SHAS[onDiskSha];
    }
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
    // Per the 3.0 UX principle, doctor's diagnostic output no longer
    // emits per-line `Hint: vaultkit X` strings. Repairable issues
    // surface via the trailing "Re-run with --fix to repair" line; the
    // un-fixable cases (dir missing / launcher missing) get a "Cannot
    // auto-fix" line. Assert the right surface for the issue category.
    expect(lines.some(l => /Re-run with --fix|Cannot auto-fix/i.test(l))).toBe(true);
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
    // Per the 3.0 UX principle, doctor's diagnostic output no longer
    // emits per-line `Hint: vaultkit X` strings. Repairable issues
    // surface via the trailing "Re-run with --fix to repair" line; the
    // un-fixable cases (dir missing / launcher missing) get a "Cannot
    // auto-fix" line. Assert the right surface for the issue category.
    expect(lines.some(l => /Re-run with --fix|Cannot auto-fix/i.test(l))).toBe(true);
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

// ── D-FIX-1: doctor --no-fix never enters the repair path ────────────────────

describe('D-FIX-1: --no-fix is diagnose-only', () => {
  it('does not call update.run when --no-fix is set, even with repairable issues', async () => {
    // Stand up a vault that would normally be repairable: launcher
    // exists but its on-disk SHA does not match the pinned hash AND the
    // on-disk SHA is in the historical table → classified as
    // historical-drift → would normally call update.run on --fix.
    const vaultDir = join(tmp, 'WouldRepair');
    mkdirSync(vaultDir, { recursive: true });
    const launcherContent = '// historical-launcher-content';
    writeFileSync(join(vaultDir, '.mcp-start.js'), launcherContent, 'utf8');
    const { createHash } = await import('node:crypto');
    const onDiskSha = createHash('sha256').update(launcherContent).digest('hex');
    const { HISTORICAL_LAUNCHER_SHAS } = await import('../../src/lib/notices/launcher-history.js');
    HISTORICAL_LAUNCHER_SHAS[onDiskSha] = 'pre-2.8.0';

    try {
      const cfgPath = join(tmp, '.claude.json');
      writeCfg(cfgPath, { WouldRepair: { dir: vaultDir, hash: 'b'.repeat(64) } });
      mockAllToolsFound();
      mockGhAuth(true);

      // Spy on update.run; expectation is "never called" with --no-fix.
      const updateMod = await import('../../src/commands/update.js');
      const updateSpy = vi.spyOn(updateMod, 'run').mockResolvedValue(undefined);

      const { run } = await import('../../src/commands/doctor.js');
      const lines: string[] = [];
      await run(undefined, { cfgPath, fix: false, log: arrayLogger(lines) });

      expect(updateSpy).not.toHaveBeenCalled();
      // Critical: doctor's diagnostic output should explicitly tell the
      // user how to repair (the "Re-run with --fix" message), per the
      // 3.0 UX principle.
      expect(lines.some(l => /Re-run with --fix/i.test(l))).toBe(true);
      updateSpy.mockRestore();
    } finally {
      delete HISTORICAL_LAUNCHER_SHAS[onDiskSha];
    }
  });
});

// ── D-FIX-2: --fix dispatches to update.run for historical drift ─────────────

describe('D-FIX-2: --fix on historical drift calls update', () => {
  it('classifies historical drift and dispatches to update.run with skipConfirm', async () => {
    // Same fixture as D-FIX-1 — historical drift on one vault.
    const vaultDir = join(tmp, 'NeedsUpdate');
    mkdirSync(vaultDir, { recursive: true });
    const launcherContent = '// historical-launcher-content-2';
    writeFileSync(join(vaultDir, '.mcp-start.js'), launcherContent, 'utf8');
    const { createHash } = await import('node:crypto');
    const onDiskSha = createHash('sha256').update(launcherContent).digest('hex');
    const { HISTORICAL_LAUNCHER_SHAS } = await import('../../src/lib/notices/launcher-history.js');
    HISTORICAL_LAUNCHER_SHAS[onDiskSha] = 'pre-2.8.0';

    try {
      const cfgPath = join(tmp, '.claude.json');
      writeCfg(cfgPath, { NeedsUpdate: { dir: vaultDir, hash: 'c'.repeat(64) } });
      mockAllToolsFound();
      mockGhAuth(true);

      const updateMod = await import('../../src/commands/update.js');
      const updateSpy = vi.spyOn(updateMod, 'run').mockResolvedValue(undefined);

      const { run } = await import('../../src/commands/doctor.js');
      await run(undefined, { cfgPath, fix: true, log: arrayLogger([]) });

      expect(updateSpy).toHaveBeenCalledTimes(1);
      const callArgs = updateSpy.mock.calls[0];
      expect(callArgs?.[0]).toBe('NeedsUpdate');
      // skipConfirm: true bypasses update's per-vault PROCEED prompt so
      // a single doctor invocation covers every vault non-interactively.
      expect((callArgs?.[1] as { skipConfirm?: boolean })?.skipConfirm).toBe(true);
      updateSpy.mockRestore();
    } finally {
      delete HISTORICAL_LAUNCHER_SHAS[onDiskSha];
    }
  });
});

// ── D-FIX-3: --fix refuses unknown drift without --force ─────────────────────

describe('D-FIX-3: --fix refuses unknown drift without --force', () => {
  it('skips unknown-SHA vaults and logs the refusal reason', async () => {
    const vaultDir = join(tmp, 'Suspect');
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(vaultDir, '.mcp-start.js'), '// totally unknown content', 'utf8');

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { Suspect: { dir: vaultDir, hash: 'd'.repeat(64) } });
    mockAllToolsFound();
    mockGhAuth(true);

    const verifyMod = await import('../../src/commands/verify.js');
    const verifySpy = vi.spyOn(verifyMod, 'run').mockResolvedValue(undefined);

    const { run } = await import('../../src/commands/doctor.js');
    const lines: string[] = [];
    const issues = await run(undefined, { cfgPath, fix: true, log: arrayLogger(lines) });

    // verify.run is the only path that re-pins to on-disk for unknown
    // SHA — must NOT fire without --force (security posture).
    expect(verifySpy).not.toHaveBeenCalled();
    expect(lines.some(l => /skipped.*unknown launcher SHA|--force/i.test(l))).toBe(true);
    expect(issues).toBeGreaterThan(0);
    verifySpy.mockRestore();
  });
});
