import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { arrayLogger } from '../helpers/logger.js';

/**
 * Phase 4 migration tests: setup.ts step 6 cleans up the legacy
 * `vaultkit-search` MCP registration plus the byte-pinned
 * `~/.vaultkit/search-launcher.js` from pre-2.8 vaultkit. Search is
 * now folded into the per-vault MCP server (per ADR-0011).
 *
 * Replaces the previous setup-search tests that asserted the old
 * register / repin behavior. The legacy code path (registering a
 * second global MCP) doesn't exist anymore in setup.ts.
 */

vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn(), input: vi.fn() }));
vi.mock('execa', async (importOriginal) => {
  const real = await importOriginal<typeof import('execa')>();
  return { ...real, execa: vi.fn() };
});
vi.mock('../../src/lib/platform.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/platform.js')>();
  return { ...real, findTool: vi.fn(), installGhForPlatform: vi.fn() };
});

import { execa } from 'execa';
import { findTool } from '../../src/lib/platform.js';

let homeOverride: string;
let originalHome: string | undefined;
let originalUserprofile: string | undefined;
let cfgPath: string;

beforeEach(() => {
  homeOverride = mkdtempSync(join(tmpdir(), 'vk-setup-search-test-'));
  originalHome = process.env.HOME;
  originalUserprofile = process.env.USERPROFILE;
  process.env.HOME = homeOverride;
  process.env.USERPROFILE = homeOverride;
  cfgPath = join(homeOverride, 'cfg.json');
  vi.mocked(execa).mockReset();
  vi.mocked(findTool).mockReset();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserprofile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserprofile;
  rmSync(homeOverride, { recursive: true, force: true });
});

function mockHealthyExeca(): void {
  vi.mocked(execa).mockImplementation((async (_cmd: string, args?: readonly string[]) => {
    if (args?.[0] === 'auth' && args?.[1] === 'status') {
      return { exitCode: 0, stdout: '', stderr: "Token scopes: 'repo', 'workflow'" };
    }
    if (args?.[0] === 'config' && args?.[1] === 'user.name') {
      return { exitCode: 0, stdout: 'Test User', stderr: '' };
    }
    if (args?.[0] === 'config' && args?.[1] === 'user.email') {
      return { exitCode: 0, stdout: 'test@example.com', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }) as never);
}

function mcpArgvCalls(): ReadonlyArray<readonly string[]> {
  const out: Array<readonly string[]> = [];
  for (const call of vi.mocked(execa).mock.calls) {
    const args = (call as unknown as [string, readonly string[]])[1];
    if (Array.isArray(args) && args[0] === 'mcp') out.push(args);
  }
  return out;
}

function makeLegacyLauncher(): string {
  const dir = join(homeOverride, '.vaultkit');
  mkdirSync(dir, { recursive: true });
  const launcher = join(dir, 'search-launcher.js');
  writeFileSync(launcher, '// stale launcher bytes\n', 'utf8');
  return launcher;
}

describe('setup cleans up legacy vaultkit-search state (Phase 4 migration)', () => {
  it('removes the legacy MCP registration via `claude mcp remove` when present', async () => {
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'gh') return '/usr/bin/gh';
      if (name === 'claude') return '/usr/bin/claude';
      return null;
    });
    mockHealthyExeca();

    // Pre-existing legacy entry → cleanup path
    writeFileSync(
      cfgPath,
      JSON.stringify({
        mcpServers: {
          'vaultkit-search': {
            command: 'node',
            args: ['/some/old/path.js', '--expected-sha256=stale_hash'],
          },
        },
      }),
      'utf8',
    );

    const { run } = await import('../../src/commands/setup.js');
    const lines: string[] = [];
    const issues = await run({ cfgPath, skipInstallCheck: true, log: arrayLogger(lines) });

    expect(issues).toBe(0);
    const calls = mcpArgvCalls();
    expect(calls.some((a) => a[1] === 'remove' && a.includes('vaultkit-search'))).toBe(true);
    expect(calls.some((a) => a[1] === 'add')).toBe(false);
    expect(lines.some((l) => /legacy registration removed/.test(l))).toBe(true);
  });

  it('no-ops silently when vaultkit-search is not registered', async () => {
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'gh') return '/usr/bin/gh';
      if (name === 'claude') return '/usr/bin/claude';
      return null;
    });
    mockHealthyExeca();

    // No vaultkit-search entry
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');

    const { run } = await import('../../src/commands/setup.js');
    const lines: string[] = [];
    const issues = await run({ cfgPath, skipInstallCheck: true, log: arrayLogger(lines) });

    expect(issues).toBe(0);
    // No mcp calls at all when nothing to clean up
    expect(mcpArgvCalls()).toHaveLength(0);
    expect(lines.some((l) => /vaultkit-search/.test(l))).toBe(false);
  });

  it('deletes ~/.vaultkit/search-launcher.js when present', async () => {
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'gh') return '/usr/bin/gh';
      if (name === 'claude') return '/usr/bin/claude';
      return null;
    });
    mockHealthyExeca();
    const launcher = makeLegacyLauncher();
    expect(existsSync(launcher)).toBe(true);

    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');

    const { run } = await import('../../src/commands/setup.js');
    const lines: string[] = [];
    await run({ cfgPath, skipInstallCheck: true, log: arrayLogger(lines) });

    expect(existsSync(launcher)).toBe(false);
    expect(lines.some((l) => /removed legacy launcher/.test(l))).toBe(true);
  });

  it('still cleans up the launcher file when claude CLI is missing', async () => {
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'gh') return '/usr/bin/gh';
      if (name === 'claude') return null;
      return null;
    });
    const { confirm } = await import('@inquirer/prompts');
    vi.mocked(confirm).mockResolvedValue(false);
    mockHealthyExeca();
    const launcher = makeLegacyLauncher();

    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');

    const { run } = await import('../../src/commands/setup.js');
    const lines: string[] = [];
    const issues = await run({ cfgPath, log: arrayLogger(lines) });

    expect(issues).toBe(0);
    // Launcher gone even though claude was missing → MCP cleanup skipped
    expect(existsSync(launcher)).toBe(false);
    // No mcp invocations because claude is unavailable
    expect(mcpArgvCalls()).toHaveLength(0);
  });

  it('does not delete ~/.vaultkit-search.db (the per-vault MCP server still reads it)', async () => {
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'gh') return '/usr/bin/gh';
      if (name === 'claude') return '/usr/bin/claude';
      return null;
    });
    mockHealthyExeca();
    const dbPath = join(homeOverride, '.vaultkit-search.db');
    writeFileSync(dbPath, 'simulated SQLite bytes', 'utf8');

    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');

    const { run } = await import('../../src/commands/setup.js');
    await run({ cfgPath, skipInstallCheck: true, log: arrayLogger([]) });

    expect(existsSync(dbPath)).toBe(true);
  });

  it('logs a warning but does not increment issues when legacy MCP removal fails', async () => {
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'gh') return '/usr/bin/gh';
      if (name === 'claude') return '/usr/bin/claude';
      return null;
    });
    vi.mocked(execa).mockImplementation((async (cmd: string, args?: readonly string[]) => {
      if (cmd === '/usr/bin/claude' && args?.[1] === 'remove') {
        throw new Error('fake mcp remove failure');
      }
      if (args?.[0] === 'auth' && args?.[1] === 'status') {
        return { exitCode: 0, stdout: '', stderr: "Token scopes: 'repo', 'workflow'" };
      }
      if (args?.[0] === 'config' && args?.[1] === 'user.name') return { exitCode: 0, stdout: 'X', stderr: '' };
      if (args?.[0] === 'config' && args?.[1] === 'user.email') return { exitCode: 0, stdout: 'x@y', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    writeFileSync(
      cfgPath,
      JSON.stringify({
        mcpServers: {
          'vaultkit-search': { command: 'node', args: ['/old/path.js'] },
        },
      }),
      'utf8',
    );

    const { run } = await import('../../src/commands/setup.js');
    const lines: string[] = [];
    const issues = await run({ cfgPath, skipInstallCheck: true, log: arrayLogger(lines) });

    expect(issues).toBe(0); // search cleanup is best-effort; not a setup blocker
    expect(lines.some((l) => /legacy cleanup failed/.test(l))).toBe(true);
  });
});
