import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { silent } from '../helpers/logger.js';
import { writeCfg } from '../helpers/registry.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'vk-destroy-test-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('destroy command', () => {
  it('throws for invalid vault name', async () => {
    const { run } = await import('../../src/commands/destroy.js');
    await expect(run('bad/name', { cfgPath: join(tmp, '.claude.json'), skipConfirm: true })).rejects.toThrow(/owner\/repo|vault name/i);
  });

  it('throws when vault not registered', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const { run } = await import('../../src/commands/destroy.js');
    await expect(run('Unknown', { cfgPath, skipConfirm: true })).rejects.toThrow(/not.*registered/i);
  });

  it('throws when directory does not look like a vault', async () => {
    const dir = join(tmp, 'BadDir');
    mkdirSync(dir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { BadDir: dir });
    const { run } = await import('../../src/commands/destroy.js');
    await expect(run('BadDir', { cfgPath, skipConfirm: true })).rejects.toThrow(/does not look like/i);
  });

  it('deletes local directory with skipConfirm and skipMcp', async () => {
    const vaultDir = join(tmp, 'MyVault');
    mkdirSync(vaultDir);
    writeFileSync(join(vaultDir, 'CLAUDE.md'), '');
    mkdirSync(join(vaultDir, 'raw'));
    mkdirSync(join(vaultDir, 'wiki'));
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: vaultDir });
    const { run } = await import('../../src/commands/destroy.js');
    await run('MyVault', { cfgPath, skipConfirm: true, skipMcp: true });
    expect(existsSync(vaultDir)).toBe(false);
  });
});

// ── LIVE: destroy removes real GitHub repo ────────────────────────────────────

const LIVE_VAULT = `vk-live-destroy-${Date.now()}`;

describe('live: destroy removes real GitHub repo', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    const { run } = await import('../../src/commands/init.js');
    await run(LIVE_VAULT, { publishMode: 'private', skipInstallCheck: true, log: silent });
  });

  afterAll(async () => {
    // Force cleanup in case test failed before destroy ran
    const { repoExists, getCurrentUser } = await import('../../src/lib/github.js');
    const { execa } = await import('execa');
    const { findTool } = await import('../../src/lib/platform.js');
    const user = await getCurrentUser().catch(() => null);
    if (user) {
      const still = await repoExists(`${user}/${LIVE_VAULT}`).catch(() => false);
      if (still) {
        const gh = await findTool('gh');
        if (gh) await execa(gh, ['repo', 'delete', `${user}/${LIVE_VAULT}`, '--yes'], { reject: false });
      }
    }
  });

  it('deletes the GitHub repo', async () => {
    const { run } = await import('../../src/commands/destroy.js');
    await run(LIVE_VAULT, { skipConfirm: true, skipMcp: true, confirmName: LIVE_VAULT, log: silent });

    const { repoExists, getCurrentUser } = await import('../../src/lib/github.js');
    const user = await getCurrentUser();
    expect(await repoExists(`${user}/${LIVE_VAULT}`)).toBe(false);
  });

  it('removes vault from registry', async () => {
    const { getVaultDir } = await import('../../src/lib/registry.js');
    const dir = await getVaultDir(LIVE_VAULT);
    expect(dir).toBeNull();
  });
});
