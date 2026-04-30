import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAllVaults, getVaultDir, getExpectedHash } from '../../src/lib/registry.js';

let tmp: string;
beforeEach(() => {
  tmp = join(tmpdir(), `vk-test-${Date.now()}`);
  mkdirSync(tmp);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeCfg(obj: unknown): string {
  writeFileSync(join(tmp, '.claude.json'), JSON.stringify(obj), 'utf8');
  return join(tmp, '.claude.json');
}

const vaultEntry = (dir: string, hash: string | null) => ({
  command: 'node',
  args: hash
    ? [`${dir}/.mcp-start.js`, `--expected-sha256=${hash}`]
    : [`${dir}/.mcp-start.js`],
});

describe('getAllVaults', () => {
  it('returns empty array when config file does not exist', async () => {
    expect(await getAllVaults(join(tmp, '.claude.json'))).toEqual([]);
  });

  it('returns empty array when mcpServers is absent', async () => {
    const cfg = writeCfg({});
    expect(await getAllVaults(cfg)).toEqual([]);
  });

  it('returns empty array when mcpServers is empty', async () => {
    const cfg = writeCfg({ mcpServers: {} });
    expect(await getAllVaults(cfg)).toEqual([]);
  });

  it('ignores non-vault MCP servers (no .mcp-start.js arg)', async () => {
    const cfg = writeCfg({
      mcpServers: {
        someOtherServer: { command: 'npx', args: ['-y', 'some-mcp-server'] },
      },
    });
    expect(await getAllVaults(cfg)).toEqual([]);
  });

  it('returns a vault with pinned hash', async () => {
    const dir = '/home/user/vaults/MyVault';
    const cfg = writeCfg({ mcpServers: { MyVault: vaultEntry(dir, 'abc123') } });
    expect(await getAllVaults(cfg)).toEqual([{ name: 'MyVault', dir, hash: 'abc123' }]);
  });

  it('returns a vault with null hash when no --expected-sha256 arg', async () => {
    const dir = '/home/user/vaults/MyVault';
    const cfg = writeCfg({ mcpServers: { MyVault: vaultEntry(dir, null) } });
    expect(await getAllVaults(cfg)).toEqual([{ name: 'MyVault', dir, hash: null }]);
  });

  it('sorts vaults by name', async () => {
    const cfg = writeCfg({
      mcpServers: {
        Zebra: vaultEntry('/vaults/Zebra', null),
        Alpha: vaultEntry('/vaults/Alpha', 'hash1'),
        Mango: vaultEntry('/vaults/Mango', 'hash2'),
      },
    });
    const result = await getAllVaults(cfg);
    expect(result.map(v => v.name)).toEqual(['Alpha', 'Mango', 'Zebra']);
  });

  it('returns empty array for malformed JSON', async () => {
    writeFileSync(join(tmp, '.claude.json'), 'not json', 'utf8');
    expect(await getAllVaults(join(tmp, '.claude.json'))).toEqual([]);
  });

  it('ignores non-vault entries mixed with vault entries', async () => {
    const dir = '/vaults/MyVault';
    const cfg = writeCfg({
      mcpServers: {
        MyVault: vaultEntry(dir, 'abc'),
        claude_desktop: { command: 'npx', args: ['-y', 'some-tool'] },
      },
    });
    const result = await getAllVaults(cfg);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('MyVault');
  });
});

describe('getVaultDir', () => {
  it('returns null when config does not exist', async () => {
    expect(await getVaultDir('MyVault', join(tmp, '.claude.json'))).toBeNull();
  });

  it('returns null for unknown vault name', async () => {
    const cfg = writeCfg({ mcpServers: {} });
    expect(await getVaultDir('Unknown', cfg)).toBeNull();
  });

  it('returns the vault directory', async () => {
    const dir = '/home/user/vaults/MyVault';
    const cfg = writeCfg({ mcpServers: { MyVault: vaultEntry(dir, 'abc') } });
    expect(await getVaultDir('MyVault', cfg)).toBe(dir);
  });

  it('returns null for non-vault MCP server', async () => {
    const cfg = writeCfg({
      mcpServers: { notAVault: { command: 'npx', args: ['some-tool'] } },
    });
    expect(await getVaultDir('notAVault', cfg)).toBeNull();
  });
});

describe('getExpectedHash', () => {
  it('returns null when config does not exist', async () => {
    expect(await getExpectedHash('MyVault', join(tmp, '.claude.json'))).toBeNull();
  });

  it('returns null for unknown vault name', async () => {
    const cfg = writeCfg({ mcpServers: {} });
    expect(await getExpectedHash('Unknown', cfg)).toBeNull();
  });

  it('returns the pinned hash', async () => {
    const dir = '/vaults/MyVault';
    const cfg = writeCfg({ mcpServers: { MyVault: vaultEntry(dir, 'deadbeef') } });
    expect(await getExpectedHash('MyVault', cfg)).toBe('deadbeef');
  });

  it('returns null when no --expected-sha256 arg present', async () => {
    const dir = '/vaults/MyVault';
    const cfg = writeCfg({ mcpServers: { MyVault: vaultEntry(dir, null) } });
    expect(await getExpectedHash('MyVault', cfg)).toBeNull();
  });
});
