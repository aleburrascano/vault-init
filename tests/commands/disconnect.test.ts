import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'vk-disconnect-test-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function writeCfg(cfgPath: string, vaults: Record<string, string>): void {
  const mcpServers: Record<string, { command: string; args: string[] }> = {};
  for (const [name, dir] of Object.entries(vaults)) {
    mcpServers[name] = { command: 'node', args: [`${dir}/.mcp-start.js`] };
  }
  writeFileSync(cfgPath, JSON.stringify({ mcpServers }), 'utf8');
}

function makeVaultDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), '');
  mkdirSync(join(dir, 'raw'), { recursive: true });
  mkdirSync(join(dir, 'wiki'), { recursive: true });
}

describe('disconnect command', () => {
  it('throws for invalid vault name', async () => {
    const { run } = await import('../../src/commands/disconnect.js');
    await expect(
      run('bad/name', { cfgPath: join(tmp, '.claude.json'), skipConfirm: true })
    ).rejects.toThrow();
  });

  it('throws when vault not registered', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const { run } = await import('../../src/commands/disconnect.js');
    await expect(
      run('Unknown', { cfgPath, skipConfirm: true })
    ).rejects.toThrow(/not registered/i);
  });

  it('throws when directory does not look like a vault', async () => {
    const dir = join(tmp, 'NotAVault');
    mkdirSync(dir);
    // Empty dir — no .obsidian, no CLAUDE.md+raw+wiki
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { NotAVault: dir });
    const { run } = await import('../../src/commands/disconnect.js');
    await expect(
      run('NotAVault', { cfgPath, skipConfirm: true })
    ).rejects.toThrow(/does not look like/i);
  });

  it('removes the local directory when skipConfirm is true', async () => {
    const vaultDir = join(tmp, 'MyVault');
    makeVaultDir(vaultDir);
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { MyVault: vaultDir });
    const { run } = await import('../../src/commands/disconnect.js');
    await run('MyVault', { cfgPath, skipConfirm: true, skipMcp: true });
    expect(existsSync(vaultDir)).toBe(false);
  });
});

// ── LIVE: disconnect removes local dir but keeps GitHub repo ──────────────────

const LIVE = !!process.env.VAULTKIT_LIVE_TEST;
const LIVE_VAULT = `vk-live-disconnect-${Date.now()}`;

describe.skipIf(!LIVE)('live: disconnect removes local dir, keeps GitHub repo', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    const { run } = await import('../../src/commands/init.js');
    await run(LIVE_VAULT, { publishMode: 'private', skipInstallCheck: true, log: () => {} });
  });

  afterAll(async () => {
    // Cleanup GitHub repo (disconnect only removes local)
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

  it('removes local vault directory', async () => {
    const { getVaultDir } = await import('../../src/lib/registry.js');
    const dir = await getVaultDir(LIVE_VAULT);

    const { run } = await import('../../src/commands/disconnect.js');
    await run(LIVE_VAULT, { skipConfirm: true, skipMcp: true, confirmName: LIVE_VAULT, log: () => {} });

    const { existsSync } = await import('node:fs');
    expect(existsSync(dir as string)).toBe(false);
  });

  it('removes vault from registry', async () => {
    const { getVaultDir } = await import('../../src/lib/registry.js');
    const dir = await getVaultDir(LIVE_VAULT);
    expect(dir).toBeNull();
  });

  it('GitHub repo still exists', async () => {
    const { repoExists, getCurrentUser } = await import('../../src/lib/github.js');
    const user = await getCurrentUser();
    expect(await repoExists(`${user}/${LIVE_VAULT}`)).toBe(true);
  });
});
