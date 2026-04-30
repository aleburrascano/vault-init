import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execa } from 'execa';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'vk-update-test-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function writeCfg(cfgPath: string, vaults: Record<string, string>): void {
  const mcpServers: Record<string, { command: string; args: string[] }> = {};
  for (const [name, dir] of Object.entries(vaults)) {
    mcpServers[name] = { command: 'node', args: [`${dir}/.mcp-start.js`] };
  }
  writeFileSync(cfgPath, JSON.stringify({ mcpServers }), 'utf8');
}

describe('update command', () => {
  it('throws for invalid vault name', async () => {
    const { run } = await import('../../src/commands/update.js');
    await expect(run('bad/name', { cfgPath: join(tmp, '.claude.json') })).rejects.toThrow();
  });

  it('throws when vault not registered', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const { run } = await import('../../src/commands/update.js');
    await expect(run('Unknown', { cfgPath })).rejects.toThrow();
  });

  it('creates missing layout files in a git repo with remote', async () => {
    const bare = join(tmp, 'bare.git');
    const vaultDir = join(tmp, 'MyVault');
    await execa('git', ['init', '--bare', '-b', 'main', bare]);
    await execa('git', ['clone', bare, vaultDir]);
    await execa('git', ['-C', vaultDir, 'config', 'user.email', 'test@test.com']);
    await execa('git', ['-C', vaultDir, 'config', 'user.name', 'Test']);
    writeFileSync(join(vaultDir, 'placeholder.txt'), '');
    await execa('git', ['-C', vaultDir, 'add', '.']);
    await execa('git', ['-C', vaultDir, 'commit', '-m', 'init']);
    await execa('git', ['-C', vaultDir, 'push', '-u', 'origin', 'main']);

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: vaultDir });

    const { run } = await import('../../src/commands/update.js');
    await run('MyVault', { cfgPath, skipConfirm: true, log: () => {} });

    expect(existsSync(join(vaultDir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(vaultDir, '.mcp-start.js'))).toBe(true);
    expect(existsSync(join(vaultDir, 'raw'))).toBe(true);
    expect(existsSync(join(vaultDir, 'wiki'))).toBe(true);
  });
});
