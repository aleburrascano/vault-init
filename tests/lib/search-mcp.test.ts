import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Hoisted mocks: tests need to inspect the `claude mcp add` argv shape
// without spawning a real claude CLI.
vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import {
  SEARCH_MCP_NAME,
  searchLauncherDir,
  searchLauncherPath,
  installSearchLauncher,
  runSearchMcpAdd,
  runSearchMcpRemove,
  runSearchMcpRepin,
  manualSearchMcpAddCommand,
  isSearchMcpRegistered,
} from '../../src/lib/search-mcp.js';
import { getSearchLauncherTemplate } from '../../src/lib/template-paths.js';

let homeOverride: string;
let originalHome: string | undefined;

beforeEach(() => {
  homeOverride = mkdtempSync(join(tmpdir(), 'vk-search-mcp-test-'));
  originalHome = process.env.HOME;
  process.env.HOME = homeOverride;
  // Windows uses USERPROFILE; override that too so `homedir()` picks up
  // the test dir on both platforms.
  process.env.USERPROFILE = homeOverride;
  vi.mocked(execa).mockReset();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(homeOverride, { recursive: true, force: true });
});

describe('searchLauncherDir / searchLauncherPath', () => {
  it('returns ~/.vaultkit and ~/.vaultkit/search-launcher.js', () => {
    expect(searchLauncherDir()).toMatch(/[/\\]\.vaultkit$/);
    expect(searchLauncherPath()).toMatch(/[/\\]\.vaultkit[/\\]search-launcher\.js$/);
  });
});

describe('SEARCH_MCP_NAME', () => {
  it('is the expected literal vaultkit-search', () => {
    expect(SEARCH_MCP_NAME).toBe('vaultkit-search');
  });
});

describe('installSearchLauncher', () => {
  it('copies the byte-immutable template into ~/.vaultkit/search-launcher.js with stable SHA', async () => {
    const result = await installSearchLauncher();
    expect(existsSync(result.launcherPath)).toBe(true);
    expect(result.launcherPath).toBe(searchLauncherPath());
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);

    // Bytes match the source template (no preprocessing).
    const installed = readFileSync(result.launcherPath, 'utf8');
    const source = readFileSync(getSearchLauncherTemplate(), 'utf8');
    expect(installed).toBe(source);

    // Re-installing produces the same SHA — idempotent.
    const second = await installSearchLauncher();
    expect(second.hash).toBe(result.hash);
  });
});

describe('runSearchMcpAdd', () => {
  it('calls claude with the canonical argv shape including --expected-sha256', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never);
    await runSearchMcpAdd('/usr/bin/claude');
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1);
    // Pull the args explicitly so we can inspect the SHA pin shape.
    // mock.calls[N] is typed as the overloaded execa signature tuple;
    // narrow via cast to `unknown[]` to side-step the picked overload.
    const call = vi.mocked(execa).mock.calls[0] as unknown as [string, string[]];
    expect(call[0]).toBe('/usr/bin/claude');
    const args = call[1];
    expect(args).toContain('mcp');
    expect(args).toContain('add');
    expect(args).toContain('--scope');
    expect(args).toContain('user');
    expect(args).toContain(SEARCH_MCP_NAME);
    expect(args).toContain('--');
    expect(args).toContain('node');
    expect(args).toContain(searchLauncherPath());
    const pinArg = args.find(a => a.startsWith('--expected-sha256='));
    expect(pinArg).toBeDefined();
    expect(pinArg).toMatch(/^--expected-sha256=[0-9a-f]{64}$/);
  });

  it('installs the launcher file as a side effect of registration', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never);
    expect(existsSync(searchLauncherPath())).toBe(false);
    await runSearchMcpAdd('/usr/bin/claude');
    expect(existsSync(searchLauncherPath())).toBe(true);
  });
});

describe('runSearchMcpRemove', () => {
  it('returns { removed: true } on exit code 0', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never);
    const result = await runSearchMcpRemove('/usr/bin/claude');
    expect(result.removed).toBe(true);
    const call = vi.mocked(execa).mock.calls[0] as unknown as [string, string[]];
    expect(call[1]).toEqual(['mcp', 'remove', SEARCH_MCP_NAME, '--scope', 'user']);
  });

  it('returns { removed: false } when claude exits non-zero (entry not present)', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not found' } as never);
    const result = await runSearchMcpRemove('/usr/bin/claude');
    expect(result.removed).toBe(false);
  });

  it('uses reject:false so a missing entry does not throw', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' } as never);
    await expect(runSearchMcpRemove('/usr/bin/claude')).resolves.not.toThrow();
    const call = vi.mocked(execa).mock.calls[0] as unknown as [string, string[], { reject: boolean }];
    expect(call[2]).toMatchObject({ reject: false });
  });
});

describe('runSearchMcpRepin', () => {
  it('removes then adds, in that order', async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);
    await runSearchMcpRepin('/usr/bin/claude');
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(2);
    const first = vi.mocked(execa).mock.calls[0] as unknown as [string, string[]];
    const second = vi.mocked(execa).mock.calls[1] as unknown as [string, string[]];
    expect(first[1][1]).toBe('remove');
    expect(second[1][1]).toBe('add');
  });
});

describe('manualSearchMcpAddCommand', () => {
  it('produces a copy-pasteable command line with the same argv shape as runSearchMcpAdd', () => {
    const cmd = manualSearchMcpAddCommand('/Users/x/.vaultkit/search-launcher.js', 'abc123');
    expect(cmd).toBe(
      'claude mcp add --scope user vaultkit-search -- node "/Users/x/.vaultkit/search-launcher.js" --expected-sha256=abc123',
    );
  });
});

describe('isSearchMcpRegistered', () => {
  function writeCfg(servers: Record<string, unknown> | undefined): string {
    const path = join(homeOverride, 'cfg.json');
    writeFileSync(path, JSON.stringify({ mcpServers: servers }), 'utf8');
    return path;
  }

  it('returns false when ~/.claude.json does not exist', () => {
    expect(isSearchMcpRegistered(join(homeOverride, 'nope.json'))).toBe(false);
  });

  it('returns false when mcpServers is missing or empty', () => {
    expect(isSearchMcpRegistered(writeCfg(undefined))).toBe(false);
    expect(isSearchMcpRegistered(writeCfg({}))).toBe(false);
    expect(isSearchMcpRegistered(writeCfg({ 'some-other': {} }))).toBe(false);
  });

  it('returns true when vaultkit-search is in mcpServers', () => {
    expect(isSearchMcpRegistered(writeCfg({ 'vaultkit-search': { command: 'node' } }))).toBe(true);
  });

  it('returns false on corrupt JSON (does not throw)', () => {
    const path = join(homeOverride, 'broken.json');
    writeFileSync(path, '{not-json', 'utf8');
    expect(isSearchMcpRegistered(path)).toBe(false);
  });
});
