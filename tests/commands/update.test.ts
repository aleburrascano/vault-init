import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { silent } from '../helpers/logger.js';
import { writeCfg } from '../helpers/registry.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'vk-update-test-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('update command', () => {
  it('throws for invalid vault name', async () => {
    const { run } = await import('../../src/commands/update.js');
    await expect(run('bad/name', { cfgPath: join(tmp, '.claude.json') })).rejects.toThrow(/owner\/repo|vault name/i);
  });

  it('throws when vault not registered', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const { run } = await import('../../src/commands/update.js');
    await expect(run('Unknown', { cfgPath })).rejects.toThrow(/not a registered vault/i);
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
    await run('MyVault', { cfgPath, skipConfirm: true, log: silent });

    expect(existsSync(join(vaultDir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(vaultDir, '.mcp-start.js'))).toBe(true);
    expect(existsSync(join(vaultDir, 'raw'))).toBe(true);
    expect(existsSync(join(vaultDir, 'wiki'))).toBe(true);
  });

  it('throws when neither name nor --all is given', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const { run } = await import('../../src/commands/update.js');
    await expect(run(undefined, { cfgPath })).rejects.toThrow(/requires a vault name/i);
  });

  it('throws when both name and --all are given', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const { run } = await import('../../src/commands/update.js');
    await expect(run('MyVault', { cfgPath, all: true })).rejects.toThrow(/either a vault name OR --all/i);
  });

  it('--all with empty registry is a no-op', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const lines: string[] = [];
    const log = {
      info: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(`WARN: ${m}`),
      error: (m: string) => lines.push(`ERROR: ${m}`),
      debug: () => {},
    };
    const { run } = await import('../../src/commands/update.js');
    await run(undefined, { cfgPath, all: true, log });
    expect(lines.some(l => /no registered vaults/i.test(l))).toBe(true);
  });
});
