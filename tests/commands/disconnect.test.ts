import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { silent } from '../helpers/logger.js';
import { writeCfg } from '../helpers/registry.js';
import { liveDescribe } from '../helpers/live-describe.js';
import { getFixtureName } from '../helpers/live-fixture.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'vk-disconnect-test-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function makeVaultDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), '');
  mkdirSync(join(dir, 'raw'), { recursive: true });
  mkdirSync(join(dir, 'wiki'), { recursive: true });
}

describe('disconnect command', () => {
  it('throws INVALID_NAME for slashed input', async () => {
    const { run } = await import('../../src/commands/disconnect.js');
    await expect(
      run('bad/name', { cfgPath: join(tmp, '.claude.json'), skipConfirm: true })
    ).rejects.toThrow(/owner\/repo|vault name/i);
  });

  it('throws when vault not registered', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const { run } = await import('../../src/commands/disconnect.js');
    await expect(
      run('Unknown', { cfgPath, skipConfirm: true })
    ).rejects.toThrow(/not a registered vault/i);
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

liveDescribe('live: disconnect removes local dir, keeps GitHub repo', { timeout: 60_000 }, () => {
  // Operates on the shared fixture from `tests/global-fixture.ts` instead
  // of creating its own `vk-live-disconnect-*` repo. The `beforeEach`
  // restores the registered + on-disk baseline (so the test order across
  // files doesn't matter); the `it` collapses what was 3 ordered
  // assertions into one — they were really verifying one operation.

  beforeEach(async () => {
    const fixtureName = getFixtureName();
    const { getVaultDir } = await import('../../src/lib/registry.js');
    const stillRegistered = (await getVaultDir(fixtureName)) !== null;
    if (!stillRegistered) {
      // A previous test (e.g. our own disconnect) left the fixture
      // unregistered. Re-clone from the still-extant GitHub repo to
      // restore the baseline. No GitHub WRITE — clone is read-only.
      const { getCurrentUser } = await import('../../src/lib/github.js');
      const user = await getCurrentUser();
      const { run: connectRun } = await import('../../src/commands/connect.js');
      await connectRun(`${user}/${fixtureName}`, { skipMcp: true, log: silent });
    }
  });

  it('removes local dir + registry entry while leaving GitHub repo intact', async () => {
    const fixtureName = getFixtureName();
    const { getVaultDir } = await import('../../src/lib/registry.js');
    const dirBefore = await getVaultDir(fixtureName);

    const { run } = await import('../../src/commands/disconnect.js');
    await run(fixtureName, { skipConfirm: true, skipMcp: true, confirmName: fixtureName, log: silent });

    expect(existsSync(dirBefore as string)).toBe(false);
    expect(await getVaultDir(fixtureName)).toBeNull();

    const { repoExists, getCurrentUser } = await import('../../src/lib/github.js');
    const user = await getCurrentUser();
    expect(await repoExists(`${user}/${fixtureName}`)).toBe(true);
  });
});
