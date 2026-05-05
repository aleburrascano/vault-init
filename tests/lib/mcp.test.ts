import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execa } from 'execa';
import { silent } from '../helpers/logger.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('../../src/lib/platform.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/platform.js')>();
  return {
    ...real,
    findTool: vi.fn(),
    npmGlobalBin: vi.fn(),
  };
});

import {
  runMcpAdd,
  runMcpRemove,
  runMcpRepin,
  manualMcpAddCommand,
  manualMcpRemoveCommand,
  manualMcpRepinCommands,
  findOrInstallClaude,
} from '../../src/lib/mcp.js';
import { findTool, npmGlobalBin } from '../../src/lib/platform.js';

beforeEach(() => {
  vi.mocked(execa).mockReset();
  vi.mocked(findTool).mockReset();
  vi.mocked(npmGlobalBin).mockReset();
  vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);
});

describe('runMcpAdd — security invariant', () => {
  it('always passes --expected-sha256=<hash> and --schema-version=<n> to claude mcp add', async () => {
    const { CURRENT_SCHEMA_VERSION } = await import('../../src/lib/breaking-changes.js');
    await runMcpAdd('/path/to/claude', 'MyVault', '/vaults/MyVault/.mcp-start.js', 'abc123');
    expect(vi.mocked(execa)).toHaveBeenCalledWith(
      '/path/to/claude',
      [
        'mcp', 'add', '--scope', 'user',
        'MyVault', '--', 'node', '/vaults/MyVault/.mcp-start.js',
        '--expected-sha256=abc123',
        `--schema-version=${CURRENT_SCHEMA_VERSION}`,
      ],
    );
  });

  it('uses --scope user (not project or local)', async () => {
    await runMcpAdd('/c', 'V', '/p/.mcp-start.js', 'h');
    const call = vi.mocked(execa).mock.calls[0];
    const args = call?.[1] as string[];
    expect(args).toContain('--scope');
    const scopeIdx = args.indexOf('--scope');
    expect(args[scopeIdx + 1]).toBe('user');
  });

  it('places vault name before -- and node command after', async () => {
    await runMcpAdd('/c', 'MyVault', '/p/.mcp-start.js', 'h');
    const args = vi.mocked(execa).mock.calls[0]?.[1] as string[];
    const dashDashIdx = args.indexOf('--');
    expect(args[dashDashIdx - 1]).toBe('MyVault');
    expect(args[dashDashIdx + 1]).toBe('node');
    expect(args[dashDashIdx + 2]).toBe('/p/.mcp-start.js');
  });
});

describe('runMcpRemove', () => {
  it('issues claude mcp remove with --scope user', async () => {
    await runMcpRemove('/path/to/claude', 'MyVault');
    expect(vi.mocked(execa)).toHaveBeenCalledWith(
      '/path/to/claude',
      ['mcp', 'remove', 'MyVault', '--scope', 'user'],
      { reject: false },
    );
  });

  it('returns { removed: true } when claude exits 0', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never);
    const result = await runMcpRemove('/c', 'V');
    expect(result).toEqual({ removed: true });
  });

  it('returns { removed: false } when entry is not registered (non-zero exit)', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not found' } as never);
    const result = await runMcpRemove('/c', 'V');
    expect(result).toEqual({ removed: false });
  });

  it('does not throw when claude reports a missing entry', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not found' } as never);
    await expect(runMcpRemove('/c', 'V')).resolves.toBeDefined();
  });
});

describe('runMcpRepin', () => {
  it('removes existing entry then re-adds with new hash', async () => {
    await runMcpRepin('/path/to/claude', 'MyVault', '/p/.mcp-start.js', 'newhash');
    const calls = vi.mocked(execa).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toEqual(['mcp', 'remove', 'MyVault', '--scope', 'user']);
    expect(calls[1]?.[1]).toContain('--expected-sha256=newhash');
  });

});

describe('manualMcpAddCommand', () => {
  it('produces a copy-pasteable command matching the runMcpAdd argv', async () => {
    const { CURRENT_SCHEMA_VERSION } = await import('../../src/lib/breaking-changes.js');
    const cmd = manualMcpAddCommand('MyVault', '/vaults/MyVault/.mcp-start.js', 'abc123');
    expect(cmd).toBe(
      `claude mcp add --scope user MyVault -- node "/vaults/MyVault/.mcp-start.js" --expected-sha256=abc123 --schema-version=${CURRENT_SCHEMA_VERSION}`,
    );
  });

  it('always includes --expected-sha256', () => {
    const cmd = manualMcpAddCommand('V', '/p', 'hashvalue');
    expect(cmd).toMatch(/--expected-sha256=hashvalue/);
  });
});

describe('manualMcpRemoveCommand', () => {
  it('produces a copy-pasteable command matching the runMcpRemove argv', () => {
    expect(manualMcpRemoveCommand('MyVault')).toBe('claude mcp remove MyVault --scope user');
  });
});

describe('manualMcpRepinCommands', () => {
  it('returns matching remove and add commands', async () => {
    const { CURRENT_SCHEMA_VERSION } = await import('../../src/lib/breaking-changes.js');
    const { remove, add } = manualMcpRepinCommands('MyVault', '/p/.mcp-start.js', 'hash');
    expect(remove).toBe('claude mcp remove MyVault --scope user');
    expect(add).toBe(`claude mcp add --scope user MyVault -- node "/p/.mcp-start.js" --expected-sha256=hash --schema-version=${CURRENT_SCHEMA_VERSION}`);
  });
});

describe('findOrInstallClaude', () => {
  it('returns the path immediately if Claude is already installed', async () => {
    vi.mocked(findTool).mockResolvedValueOnce('/usr/local/bin/claude');
    const promptInstall = vi.fn();
    const result = await findOrInstallClaude({ log: silent, promptInstall });
    expect(result).toBe('/usr/local/bin/claude');
    expect(promptInstall).not.toHaveBeenCalled();
  });

  it('returns null if Claude is missing and the user declines to install', async () => {
    vi.mocked(findTool).mockResolvedValueOnce(null);
    const result = await findOrInstallClaude({
      log: silent,
      promptInstall: () => Promise.resolve(false),
    });
    expect(result).toBeNull();
    expect(vi.mocked(execa)).not.toHaveBeenCalled();
  });

  it('installs and re-finds when missing and user confirms', async () => {
    vi.mocked(findTool)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('/post-install/claude');
    vi.mocked(npmGlobalBin).mockResolvedValueOnce('/global/bin');
    const result = await findOrInstallClaude({
      log: silent,
      promptInstall: () => Promise.resolve(true),
    });
    expect(vi.mocked(execa)).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', '@anthropic-ai/claude-code'],
      { reject: false },
    );
    expect(result).toBe('/post-install/claude');
  });
});
