import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { arrayLogger } from '../helpers/logger.js';

/**
 * S4 wiring tests: setup.ts registers (or repins) the vaultkit-search
 * MCP after the prereq checks. These tests are independent of the
 * existing setup.test.ts cases (which predate the search MCP) so we
 * can pin the new behavior without modifying that file's tightly-
 * scoped existing assertions.
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

/**
 * Configure the execa mock to handle every call setup makes:
 *   - gh auth status → authed with the requested scopes
 *   - git config user.name / user.email → already set
 *   - claude mcp add/remove/list → succeed silently (returns 0)
 * Tests can inspect `vi.mocked(execa).mock.calls` afterwards to
 * verify which MCP-related argv shapes were passed.
 */
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

describe('setup wires the vaultkit-search MCP', () => {
  it('registers vaultkit-search via `claude mcp add` when not previously registered', async () => {
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'gh') return '/usr/bin/gh';
      if (name === 'claude') return '/usr/bin/claude';
      return null;
    });
    mockHealthyExeca();

    // Empty cfg → vaultkit-search not registered yet
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');

    const { run } = await import('../../src/commands/setup.js');
    const lines: string[] = [];
    const issues = await run({ cfgPath, skipInstallCheck: true, log: arrayLogger(lines) });

    expect(issues).toBe(0);
    const mcpCalls = mcpArgvCalls();
    // Exactly one mcp invocation, and it must be `add`
    const addCall = mcpCalls.find(args => args[1] === 'add');
    expect(addCall).toBeDefined();
    expect(addCall).toContain('vaultkit-search');
    expect(addCall?.some(a => a.startsWith('--expected-sha256='))).toBe(true);

    expect(lines.some(l => /\+ ok\s+vaultkit-search:\s+registered$/.test(l))).toBe(true);
  });

  it('repins vaultkit-search when already registered (idempotent)', async () => {
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'gh') return '/usr/bin/gh';
      if (name === 'claude') return '/usr/bin/claude';
      return null;
    });
    mockHealthyExeca();

    // Pre-existing entry → repin path
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
    await run({ cfgPath, skipInstallCheck: true, log: arrayLogger(lines) });

    const mcpCalls = mcpArgvCalls();
    // Repin = remove + add. Both must be present.
    expect(mcpCalls.some(a => a[1] === 'remove' && a.includes('vaultkit-search'))).toBe(true);
    expect(mcpCalls.some(a => a[1] === 'add' && a.includes('vaultkit-search'))).toBe(true);

    expect(lines.some(l => /\+ ok\s+vaultkit-search:\s+registered \(re-pinned\)/.test(l))).toBe(true);
  });

  it('skips MCP registration silently when claude CLI is missing', async () => {
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'gh') return '/usr/bin/gh';
      if (name === 'claude') return null;
      return null;
    });
    // Mock confirm to refuse the install prompt
    const { confirm } = await import('@inquirer/prompts');
    vi.mocked(confirm).mockResolvedValue(false);
    mockHealthyExeca();

    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');

    const { run } = await import('../../src/commands/setup.js');
    const lines: string[] = [];
    const issues = await run({ cfgPath, log: arrayLogger(lines) });

    expect(issues).toBe(0);
    // No mcp calls at all when claude is missing
    expect(mcpArgvCalls()).toHaveLength(0);
    // The launcher is still pre-installed so a future claude install
    // can register against the same bytes.
    const { existsSync } = await import('node:fs');
    const { searchLauncherPath } = await import('../../src/lib/search-mcp.js');
    expect(existsSync(searchLauncherPath())).toBe(true);
  });

  it('logs a warning but does not increment issues when MCP registration fails', async () => {
    vi.mocked(findTool).mockImplementation(async (name: string) => {
      if (name === 'gh') return '/usr/bin/gh';
      if (name === 'claude') return '/usr/bin/claude';
      return null;
    });
    // Make `claude mcp add` fail. Other execa calls succeed.
    vi.mocked(execa).mockImplementation((async (cmd: string, args?: readonly string[]) => {
      if (cmd === '/usr/bin/claude' && args?.[1] === 'add') {
        throw new Error('fake mcp add failure');
      }
      if (args?.[0] === 'auth' && args?.[1] === 'status') {
        return { exitCode: 0, stdout: '', stderr: "Token scopes: 'repo', 'workflow'" };
      }
      if (args?.[0] === 'config' && args?.[1] === 'user.name') return { exitCode: 0, stdout: 'X', stderr: '' };
      if (args?.[0] === 'config' && args?.[1] === 'user.email') return { exitCode: 0, stdout: 'x@y', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as never);

    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');

    const { run } = await import('../../src/commands/setup.js');
    const lines: string[] = [];
    const issues = await run({ cfgPath, skipInstallCheck: true, log: arrayLogger(lines) });

    // Issues count stays at 0 — search is value-add, not critical-path.
    expect(issues).toBe(0);
    expect(lines.some(l => /! warn\s+vaultkit-search:/.test(l))).toBe(true);
  });
});
