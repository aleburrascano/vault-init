import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { silent, arrayLogger } from '../helpers/logger.js';

// Mock interactive prompt so tests never block waiting for user input
vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn() }));

// Mock execa for network-free git fetch/diff/pull
vi.mock('execa', async (importOriginal) => {
  const real = await importOriginal<typeof import('execa')>();
  return { ...real, execa: vi.fn() };
});

// Mock findTool to control whether claude is "installed"
vi.mock('../../src/lib/platform.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/platform.js')>();
  return { ...real, findTool: vi.fn() };
});

import { confirm } from '@inquirer/prompts';
import { execa } from 'execa';
import { findTool } from '../../src/lib/platform.js';
import { writeCfg } from '../helpers/registry.js';
import { makeLocalVault, type LocalVault } from '../helpers/local-vault.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-verify-test-'));
  vi.mocked(confirm).mockReset();
  vi.mocked(execa).mockReset();
  vi.mocked(findTool).mockReset();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function writeLauncher(dir: string, content: string = '// launcher'): string {
  writeFileSync(join(dir, '.mcp-start.js'), content, 'utf8');
  return computeHash(content);
}

function mockNoGit(): void {
  // No .git directory, so upstream drift check is skipped
  vi.mocked(execa).mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' } as never);
}

async function runVerify(name: string, cfgPath: string): Promise<string[]> {
  const { run } = await import('../../src/commands/verify.js');
  const lines: string[] = [];
  await run(name, { cfgPath, log: arrayLogger(lines) });
  return lines;
}

// ── V-1: invalid vault name ───────────────────────────────────────────────────

describe('V-1: invalid vault name', () => {
  it('throws on invalid name format', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');

    const { run } = await import('../../src/commands/verify.js');
    await expect(run('bad name!', { cfgPath, log: silent })).rejects.toThrow(/letters, numbers, hyphens/i);
  });
});

// ── V-2: vault not registered ─────────────────────────────────────────────────

describe('V-2: vault not registered', () => {
  it('throws with "not a registered vault" message', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');

    const { run } = await import('../../src/commands/verify.js');
    await expect(run('NoSuchVault', { cfgPath, log: silent })).rejects.toThrow(/not a registered vault/i);
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
    await expect(run('NoLauncher', { cfgPath, log: silent })).rejects.toThrow(/vaultkit update/i);
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

// ── V-5b: hash mismatch — historical SHA shows causal context ───────────────

describe('V-5b: hash mismatch — historical SHA', () => {
  it('prefaces the re-pin prompt with "outdated after upgrade" causal context', async () => {
    const vaultDir = join(tmp, 'OutdatedVault');
    mkdirSync(vaultDir, { recursive: true });
    const launcherContent = '// pretend pre-2.8.0 launcher';
    writeFileSync(join(vaultDir, '.mcp-start.js'), launcherContent, 'utf8');
    const onDiskSha = computeHash(launcherContent);

    const { HISTORICAL_LAUNCHER_SHAS } = await import('../../src/lib/notices/launcher-history.js');
    HISTORICAL_LAUNCHER_SHAS[onDiskSha] = 'pre-2.8.0';

    try {
      const cfgPath = join(tmp, '.claude.json');
      writeCfg(cfgPath, { OutdatedVault: { dir: vaultDir, hash: 'b'.repeat(64) } });

      mockNoGit();
      vi.mocked(confirm).mockResolvedValueOnce(false);

      const lines = await runVerify('OutdatedVault', cfgPath);

      expect(lines.some(l => /outdated after a vaultkit upgrade/i.test(l))).toBe(true);
      expect(lines.some(l => /pre-2\.8\.0/i.test(l))).toBe(true);
      expect(lines.some(l => /vaultkit update --all/i.test(l))).toBe(true);
      expect(lines.some(l => /aborted/i.test(l))).toBe(true);
    } finally {
      delete HISTORICAL_LAUNCHER_SHAS[onDiskSha];
    }
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
    vi.mocked(execa).mockImplementation((async () => ({ exitCode: 0, stdout: '', stderr: '' })) as never);

    const lines = await runVerify('RepinVault', cfgPath);

    expect(lines.some(l => /re-pinning/i.test(l))).toBe(true);
    expect(lines.some(l => /done/i.test(l))).toBe(true);
    // claude mcp remove called
    const removeCalls = vi.mocked(execa).mock.calls.filter(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args.includes('remove');
    });
    expect(removeCalls.length).toBeGreaterThan(0);
    // claude mcp add called with expected-sha256
    const addCalls = vi.mocked(execa).mock.calls.filter(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args.some((a: unknown) => typeof a === 'string' && a.includes('expected-sha256'));
    });
    expect(addCalls.length).toBeGreaterThan(0);
    expect(addCalls[0]?.[1]).toContain(`--expected-sha256=${realHash}`);
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
    const lines: string[] = [];
    await expect(run('NoClaude', { cfgPath, log: arrayLogger(lines) })).rejects.toThrow(/Claude Code not found/i);
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

// ── V-9: --yes flag auto-accepts hash-mismatch re-pin (no prompt) ────────────

describe('V-9: --yes flag bypasses confirm on hash mismatch', () => {
  it('re-pins without prompting when yes=true', async () => {
    const vaultDir = join(tmp, 'YesVault');
    mkdirSync(vaultDir, { recursive: true });
    const realHash = writeLauncher(vaultDir, '// new bytes');

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { YesVault: { dir: vaultDir, hash: 'a'.repeat(64) } });

    mockNoGit();
    vi.mocked(findTool).mockResolvedValue('/usr/bin/claude');
    vi.mocked(execa).mockImplementation((async () => ({ exitCode: 0, stdout: '', stderr: '' })) as never);

    const { run } = await import('../../src/commands/verify.js');
    const lines: string[] = [];
    await run('YesVault', { cfgPath, yes: true, log: arrayLogger(lines) });

    // confirm was NEVER called — --yes bypassed it
    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
    expect(lines.some(l => /re-pinning/i.test(l))).toBe(true);
    // The actual on-disk hash was passed to mcp add
    const addCalls = vi.mocked(execa).mock.calls.filter(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args.some((a: unknown) => String(a).includes('expected-sha256'));
    });
    expect(addCalls[0]?.[1]).toContain(`--expected-sha256=${realHash}`);
  });
});

// ── V-10: --yes flag auto-pulls on upstream drift ─────────────────────────────

describe('V-10: --yes flag auto-pulls upstream drift', () => {
  it('runs git pull --ff-only without prompting when yes=true', async () => {
    const vaultDir = join(tmp, 'DriftYesVault');
    mkdirSync(vaultDir, { recursive: true });
    mkdirSync(join(vaultDir, '.git'), { recursive: true });
    const launcherContent = '// pre-pull launcher';
    const preHash = writeLauncher(vaultDir, launcherContent);

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { DriftYesVault: { dir: vaultDir, hash: preHash } });

    let pullCalled = false;
    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      // git fetch / rev-parse @{u} both succeed → upstream exists
      if (args?.includes('rev-parse') && args.includes('@{u}')) {
        return { exitCode: 0, stdout: 'origin/main', stderr: '' };
      }
      // git diff --name-only HEAD..@{u} — returns .mcp-start.js (drift on launcher)
      if (args?.includes('diff') && args.includes('--name-only')) {
        return { exitCode: 0, stdout: '.mcp-start.js', stderr: '' };
      }
      // git --no-pager diff (the visual diff log line)
      if (args?.includes('--no-pager')) {
        return { exitCode: 0, stdout: '+ new line\n- old line', stderr: '' };
      }
      // git pull --ff-only (the actual auto-pull)
      if (args?.includes('pull')) {
        pullCalled = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);
    vi.mocked(findTool).mockResolvedValue('/usr/bin/claude');

    const { run } = await import('../../src/commands/verify.js');
    await run('DriftYesVault', { cfgPath, yes: true, log: silent });

    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
    expect(pullCalled).toBe(true);
  });
});

// ── V-11: git pull --ff-only failure during re-pin → PARTIAL_FAILURE ──────────

describe('V-11: git pull failure on upstream drift', () => {
  it('throws PARTIAL_FAILURE when git pull --ff-only exits non-zero', async () => {
    const vaultDir = join(tmp, 'PullFailVault');
    mkdirSync(vaultDir, { recursive: true });
    mkdirSync(join(vaultDir, '.git'), { recursive: true });
    const hash = writeLauncher(vaultDir, '// existing');

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { PullFailVault: { dir: vaultDir, hash } });

    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args?.includes('rev-parse') && args.includes('@{u}')) {
        return { exitCode: 0, stdout: 'origin/main', stderr: '' };
      }
      if (args?.includes('diff') && args.includes('--name-only')) {
        return { exitCode: 0, stdout: '.mcp-start.js', stderr: '' };
      }
      if (args?.includes('--no-pager')) {
        return { exitCode: 0, stdout: 'diff', stderr: '' };
      }
      if (args?.includes('pull')) {
        // ff-only fails (e.g., diverged branches)
        return { exitCode: 1, stdout: '', stderr: 'Not possible to fast-forward' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    const { run } = await import('../../src/commands/verify.js');
    await expect(run('PullFailVault', { cfgPath, log: silent }))
      .rejects.toThrow(/git pull failed|Resolve manually/i);
  });
});

// ── V-12: upstream drift on a non-launcher file → no drift reported ───────────

describe('V-12: upstream drift on unrelated files', () => {
  it('does not flag drift when only non-launcher files changed upstream', async () => {
    const vaultDir = join(tmp, 'OtherDriftVault');
    mkdirSync(vaultDir, { recursive: true });
    mkdirSync(join(vaultDir, '.git'), { recursive: true });
    const hash = writeLauncher(vaultDir, '// matched');

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { OtherDriftVault: { dir: vaultDir, hash } });

    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args?.includes('rev-parse') && args.includes('@{u}')) {
        return { exitCode: 0, stdout: 'origin/main', stderr: '' };
      }
      // diff scoped to .mcp-start.js — empty result means no change to launcher
      if (args?.includes('diff') && args.includes('--name-only')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const { run } = await import('../../src/commands/verify.js');
    const lines: string[] = [];
    await run('OtherDriftVault', { cfgPath, log: arrayLogger(lines) });

    // Hash matches AND no launcher drift → verified, no prompt
    expect(lines.some(l => /verified/i.test(l))).toBe(true);
    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
  });
});

// ── V-13: vault has .git but no upstream branch — drift check skipped ─────────

describe('V-13: no upstream branch configured', () => {
  it('skips drift check when rev-parse @{u} fails (no upstream)', async () => {
    const vaultDir = join(tmp, 'NoUpstreamVault');
    mkdirSync(vaultDir, { recursive: true });
    mkdirSync(join(vaultDir, '.git'), { recursive: true });
    const hash = writeLauncher(vaultDir, '// matched');

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { NoUpstreamVault: { dir: vaultDir, hash } });

    vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
      if (args?.includes('rev-parse') && args.includes('@{u}')) {
        // No upstream: git rev-parse @{u} exits non-zero
        return { exitCode: 128, stdout: '', stderr: 'no upstream configured' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    const { run } = await import('../../src/commands/verify.js');
    const lines: string[] = [];
    await run('NoUpstreamVault', { cfgPath, log: arrayLogger(lines) });

    expect(lines.some(l => /verified/i.test(l))).toBe(true);
    // No diff was attempted (only fetch + rev-parse called)
    const diffCalls = vi.mocked(execa).mock.calls.filter(c => {
      const args = c[1] as unknown;
      return Array.isArray(args) && args.includes('diff');
    });
    expect(diffCalls.length).toBe(0);
  });
});

// ── V-14: hash-format boundaries in registry ──────────────────────────────────

describe('V-14: hash format boundaries', () => {
  it('treats empty-string pinned hash as "(none registered)" — same as null', async () => {
    const vaultDir = join(tmp, 'EmptyHashVault');
    mkdirSync(vaultDir, { recursive: true });
    writeLauncher(vaultDir);

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { EmptyHashVault: { dir: vaultDir, hash: '' } });

    mockNoGit();
    vi.mocked(confirm).mockResolvedValueOnce(false);

    const lines = await runVerify('EmptyHashVault', cfgPath);
    expect(lines.some(l => /none registered/i.test(l))).toBe(true);
    expect(lines.some(l => /aborted/i.test(l))).toBe(true);
  });

  it('handles a registered hash that is the wrong length without crashing', async () => {
    const vaultDir = join(tmp, 'ShortHashVault');
    mkdirSync(vaultDir, { recursive: true });
    writeLauncher(vaultDir);

    const cfgPath = join(tmp, '.claude.json');
    // Short hash (not 64 hex chars) — should mismatch normally, not crash
    writeCfg(cfgPath, { ShortHashVault: { dir: vaultDir, hash: 'abc' } });

    mockNoGit();
    vi.mocked(confirm).mockResolvedValueOnce(false);

    const lines = await runVerify('ShortHashVault', cfgPath);
    expect(lines.some(l => /aborted/i.test(l))).toBe(true);
    // The short hash is shown verbatim as the pinned value
    expect(lines.some(l => /Pinned SHA-256:\s+abc/.test(l))).toBe(true);
  });
});

// ── LIVE-LOCAL: verify checks real launcher hash on a local-only vault ────────

const LIVE_VAULT = `vk-live-verify-${Date.now()}`;

// Converted from a GitHub-touching live test (created a real `vk-live-*`
// repo per run) to a fully-local test. verify computes SHA-256 of the
// launcher and compares it against the registered expected-hash — it
// never talks to GitHub or git. The previous test only used `init` to
// bootstrap a real vault layout; we now lay that down directly via
// makeLocalVault, which copies the byte-immutable launcher template
// the same way init does. This cuts ~10 GH-API calls per CI run and
// lets the test run on Windows alongside Ubuntu.
describe('live: verify checks real launcher hash (local-only)', { timeout: 30_000 }, () => {
  let live: LocalVault;

  async function restoreReal() {
    const { execa: realExeca } = await vi.importActual<typeof import('execa')>('execa');
    vi.mocked(execa).mockImplementation(realExeca as never);
    const realPlatform = await vi.importActual<typeof import('../../src/lib/platform.js')>('../../src/lib/platform.js');
    vi.mocked(findTool).mockImplementation(realPlatform.findTool);
  }

  beforeEach(restoreReal);

  beforeAll(async () => {
    await restoreReal();
    live = await makeLocalVault({ name: LIVE_VAULT });
  }, 30_000);

  afterAll(async () => {
    try { await restoreReal(); } catch { /* don't let mock-restore failures skip cleanup */ }
    if (live) await live.cleanup();
  });

  it('verifies launcher hash matches pinned hash', async () => {
    const { run } = await import('../../src/commands/verify.js');
    const lines: string[] = [];
    await run(LIVE_VAULT, { yes: false, log: arrayLogger(lines) });
    expect(lines.some(l => /verified/i.test(l))).toBe(true);
  });
});
