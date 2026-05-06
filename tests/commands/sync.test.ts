import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { silent, arrayLogger } from '../helpers/logger.js';
import { writeCfg } from '../helpers/registry.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'vk-pull-test-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('sync command', () => {
  it('reports skipped vault when directory missing', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MissingVault: '/nonexistent/path/vault' });
    const { run } = await import('../../src/commands/sync.js');
    const lines: string[] = [];
    await run({ cfgPath, log: arrayLogger(lines) });
    expect(lines.some(l => /missing|skip/i.test(l))).toBe(true);
  });

  it('reports already up to date for a local repo at HEAD', async () => {
    const bare = join(tmp, 'bare.git');
    const vaultDir = join(tmp, 'MyVault');
    await execa('git', ['init', '--bare', '-b', 'main', bare]);
    await execa('git', ['clone', bare, vaultDir]);
    await execa('git', ['-C', vaultDir, 'config', 'user.email', 'test@test.com']);
    await execa('git', ['-C', vaultDir, 'config', 'user.name', 'Test']);
    writeFileSync(join(vaultDir, 'README.md'), 'hello');
    await execa('git', ['-C', vaultDir, 'add', '.']);
    await execa('git', ['-C', vaultDir, 'commit', '-m', 'init']);
    await execa('git', ['-C', vaultDir, 'push', '-u', 'origin', 'main']);

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: vaultDir });

    const { run } = await import('../../src/commands/sync.js');
    const lines: string[] = [];
    await run({ cfgPath, log: arrayLogger(lines) });
    expect(lines.some(l => /up.to.date|already/i.test(l))).toBe(true);
  });

  it('handles empty registry gracefully', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const { run } = await import('../../src/commands/sync.js');
    await run({ cfgPath, log: silent });
  });

  it('logs synced when new commits are pulled', async () => {
    const bare = join(tmp, 'bare.git');
    const c1 = join(tmp, 'c1');
    const vaultDir = join(tmp, 'MyVault');
    await execa('git', ['init', '--bare', '-b', 'main', bare]);
    await execa('git', ['clone', bare, c1]);
    await execa('git', ['clone', bare, vaultDir]);
    for (const d of [c1, vaultDir]) {
      await execa('git', ['-C', d, 'config', 'user.email', 'test@test.com']);
      await execa('git', ['-C', d, 'config', 'user.name', 'Test']);
    }
    // c1 commits and pushes; vaultDir is behind
    writeFileSync(join(c1, 'newfile.txt'), 'content');
    await execa('git', ['-C', c1, 'add', '.']);
    await execa('git', ['-C', c1, 'commit', '-m', 'new commit']);
    await execa('git', ['-C', c1, 'push', '-u', 'origin', 'main']);
    await execa('git', ['-C', vaultDir, 'fetch']);

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: vaultDir });
    const { run } = await import('../../src/commands/sync.js');
    const lines: string[] = [];
    await run({ cfgPath, log: arrayLogger(lines) });
    expect(lines.some(l => /synced/i.test(l))).toBe(true);
  }, 15000);

  it('skips missing vaults and pulls the rest', async () => {
    const bare = join(tmp, 'bare.git');
    const vaultDir = join(tmp, 'RealVault');
    await execa('git', ['init', '--bare', '-b', 'main', bare]);
    await execa('git', ['clone', bare, vaultDir]);
    await execa('git', ['-C', vaultDir, 'config', 'user.email', 'test@test.com']);
    await execa('git', ['-C', vaultDir, 'config', 'user.name', 'Test']);
    writeFileSync(join(vaultDir, 'f.txt'), 'hi');
    await execa('git', ['-C', vaultDir, 'add', '.']);
    await execa('git', ['-C', vaultDir, 'commit', '-m', 'init']);
    await execa('git', ['-C', vaultDir, 'push', '-u', 'origin', 'main']);

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, {
      GhostVault: '/nonexistent/ghost',
      RealVault: vaultDir,
    });
    const { run } = await import('../../src/commands/sync.js');
    const lines: string[] = [];
    await run({ cfgPath, log: arrayLogger(lines) });
    expect(lines.some(l => /GhostVault.*miss|skip/i.test(l))).toBe(true);
    expect(lines.some(l => /RealVault.*(up.to.date|synced)/i.test(l))).toBe(true);
  }, 15000);
});
