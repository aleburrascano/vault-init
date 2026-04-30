import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execa } from 'execa';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'vk-backup-test-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function writeCfg(cfgPath: string, vaults: Record<string, string>): void {
  const mcpServers: Record<string, { command: string; args: string[] }> = {};
  for (const [name, dir] of Object.entries(vaults)) {
    mcpServers[name] = { command: 'node', args: [`${dir}/.mcp-start.js`] };
  }
  writeFileSync(cfgPath, JSON.stringify({ mcpServers }), 'utf8');
}

async function makeCommittedRepo(dir: string): Promise<void> {
  await execa('git', ['init', '-b', 'main', dir]);
  await execa('git', ['-C', dir, 'config', 'user.email', 'test@test.com']);
  await execa('git', ['-C', dir, 'config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), 'content');
  await execa('git', ['-C', dir, 'add', '.']);
  await execa('git', ['-C', dir, 'commit', '-m', 'init']);
}

describe('backup command', () => {
  it('throws for invalid vault name', async () => {
    const { run } = await import('../../src/commands/backup.js');
    await expect(run('bad/name', { cfgPath: join(tmp, '.claude.json'), backupsDir: tmp }))
      .rejects.toThrow();
  });

  it('throws when vault not registered', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const { run } = await import('../../src/commands/backup.js');
    await expect(run('Unknown', { cfgPath, backupsDir: tmp })).rejects.toThrow(/not registered/i);
  });

  it('creates a zip backup of a vault', async () => {
    const vaultDir = join(tmp, 'MyVault');
    mkdirSync(vaultDir);
    await makeCommittedRepo(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: vaultDir });
    const backupsDir = join(tmp, '.backups');
    const { run } = await import('../../src/commands/backup.js');
    const zipPath = await run('MyVault', { cfgPath, backupsDir });
    expect(existsSync(zipPath)).toBe(true);
    expect(zipPath).toMatch(/MyVault.*\.zip$/);
  });
});
