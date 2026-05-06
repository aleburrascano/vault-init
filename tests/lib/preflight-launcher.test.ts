import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { arrayLogger } from '../helpers/logger.js';
import { writeCfg } from '../helpers/registry.js';
import { preflightLauncherCheck, preflightAllVaults } from '../../src/lib/notices/preflight-launcher.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-preflight-test-'));
  delete process.env.VAULTKIT_NO_LAUNCHER_PREFLIGHT;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.VAULTKIT_NO_LAUNCHER_PREFLIGHT;
});

function writeLauncherAndComputeSha(dir: string, content: string): string {
  writeFileSync(join(dir, '.mcp-start.js'), content, 'utf8');
  return createHash('sha256').update(content).digest('hex');
}

describe('preflightLauncherCheck (single vault)', () => {
  it('silent when vault is not registered', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const lines: string[] = [];
    await preflightLauncherCheck('NoSuch', cfgPath, arrayLogger(lines));
    expect(lines).toEqual([]);
  });

  it('silent when vault has no launcher on disk', async () => {
    const vaultDir = join(tmp, 'NoLauncherVault');
    mkdirSync(vaultDir, { recursive: true });
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { NoLauncherVault: { dir: vaultDir, hash: 'a'.repeat(64) } });
    const lines: string[] = [];
    await preflightLauncherCheck('NoLauncherVault', cfgPath, arrayLogger(lines));
    expect(lines).toEqual([]);
  });

  it('silent when vault has no pinned hash (legacy)', async () => {
    const vaultDir = join(tmp, 'LegacyVault');
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(vaultDir, '.mcp-start.js'), '// launcher', 'utf8');
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { LegacyVault: { dir: vaultDir, hash: null } });
    const lines: string[] = [];
    await preflightLauncherCheck('LegacyVault', cfgPath, arrayLogger(lines));
    expect(lines).toEqual([]);
  });

  it('silent when on-disk SHA matches the pinned hash', async () => {
    const vaultDir = join(tmp, 'GoodVault');
    mkdirSync(vaultDir, { recursive: true });
    const realSha = writeLauncherAndComputeSha(vaultDir, '// up-to-date launcher');
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { GoodVault: { dir: vaultDir, hash: realSha } });
    const lines: string[] = [];
    await preflightLauncherCheck('GoodVault', cfgPath, arrayLogger(lines));
    expect(lines).toEqual([]);
  });

  it('warns and points at vaultkit update <name> when SHA is historical', async () => {
    const vaultDir = join(tmp, 'OutdatedVault');
    mkdirSync(vaultDir, { recursive: true });
    const onDiskSha = writeLauncherAndComputeSha(vaultDir, '// pretend pre-2.8.0 launcher');

    const { HISTORICAL_LAUNCHER_SHAS } = await import('../../src/lib/notices/launcher-history.js');
    HISTORICAL_LAUNCHER_SHAS[onDiskSha] = 'pre-2.8.0';

    try {
      const cfgPath = join(tmp, '.claude.json');
      writeCfg(cfgPath, { OutdatedVault: { dir: vaultDir, hash: 'b'.repeat(64) } });
      const lines: string[] = [];
      await preflightLauncherCheck('OutdatedVault', cfgPath, arrayLogger(lines));

      expect(lines.some(l => /outdated after a vaultkit upgrade/i.test(l))).toBe(true);
      expect(lines.some(l => /pre-2\.8\.0/i.test(l))).toBe(true);
      expect(lines.some(l => /vaultkit update OutdatedVault/i.test(l))).toBe(true);
    } finally {
      delete HISTORICAL_LAUNCHER_SHAS[onDiskSha];
    }
  });

  it('warns and points at vaultkit verify <name> when SHA is unknown', async () => {
    const vaultDir = join(tmp, 'UnknownVault');
    mkdirSync(vaultDir, { recursive: true });
    writeLauncherAndComputeSha(vaultDir, '// random unknown content');

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { UnknownVault: { dir: vaultDir, hash: 'b'.repeat(64) } });
    const lines: string[] = [];
    await preflightLauncherCheck('UnknownVault', cfgPath, arrayLogger(lines));

    expect(lines.some(l => /matches no known vaultkit version/i.test(l))).toBe(true);
    expect(lines.some(l => /vaultkit verify UnknownVault/i.test(l))).toBe(true);
  });

  it('VAULTKIT_NO_LAUNCHER_PREFLIGHT=1 disables the check', async () => {
    process.env.VAULTKIT_NO_LAUNCHER_PREFLIGHT = '1';
    const vaultDir = join(tmp, 'WouldWarnVault');
    mkdirSync(vaultDir, { recursive: true });
    writeLauncherAndComputeSha(vaultDir, '// random unknown content');

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { WouldWarnVault: { dir: vaultDir, hash: 'b'.repeat(64) } });
    const lines: string[] = [];
    await preflightLauncherCheck('WouldWarnVault', cfgPath, arrayLogger(lines));

    expect(lines).toEqual([]);
  });

  it('silent when name is invalid (does not throw)', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const lines: string[] = [];
    await preflightLauncherCheck('bad/name', cfgPath, arrayLogger(lines));
    expect(lines).toEqual([]);
  });
});

describe('preflightAllVaults (multi-vault)', () => {
  it('silent when registry is empty', async () => {
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const lines: string[] = [];
    await preflightAllVaults(cfgPath, arrayLogger(lines));
    expect(lines).toEqual([]);
  });

  it('silent when all vaults are up to date', async () => {
    const vaultDir = join(tmp, 'GoodVault');
    mkdirSync(vaultDir, { recursive: true });
    const realSha = writeLauncherAndComputeSha(vaultDir, '// up-to-date launcher');
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { GoodVault: { dir: vaultDir, hash: realSha } });
    const lines: string[] = [];
    await preflightAllVaults(cfgPath, arrayLogger(lines));
    expect(lines).toEqual([]);
  });

  it('aggregates stale vaults into one summary line plus per-vault detail', async () => {
    const v1Dir = join(tmp, 'OutdatedA');
    const v2Dir = join(tmp, 'OutdatedB');
    mkdirSync(v1Dir, { recursive: true });
    mkdirSync(v2Dir, { recursive: true });
    const onDiskA = writeLauncherAndComputeSha(v1Dir, '// stale launcher A');
    const onDiskB = writeLauncherAndComputeSha(v2Dir, '// stale launcher B');

    const { HISTORICAL_LAUNCHER_SHAS } = await import('../../src/lib/notices/launcher-history.js');
    HISTORICAL_LAUNCHER_SHAS[onDiskA] = 'pre-2.8.0';
    HISTORICAL_LAUNCHER_SHAS[onDiskB] = 'pre-2.8.0';

    try {
      const cfgPath = join(tmp, '.claude.json');
      writeCfg(cfgPath, {
        OutdatedA: { dir: v1Dir, hash: 'b'.repeat(64) },
        OutdatedB: { dir: v2Dir, hash: 'c'.repeat(64) },
      });

      const lines: string[] = [];
      await preflightAllVaults(cfgPath, arrayLogger(lines));

      expect(lines.some(l => /2 vault\(s\) have outdated launchers/i.test(l))).toBe(true);
      expect(lines.some(l => /OutdatedA.*pre-2\.8\.0/.test(l))).toBe(true);
      expect(lines.some(l => /OutdatedB.*pre-2\.8\.0/.test(l))).toBe(true);
      expect(lines.some(l => /vaultkit update --all/i.test(l))).toBe(true);
    } finally {
      delete HISTORICAL_LAUNCHER_SHAS[onDiskA];
      delete HISTORICAL_LAUNCHER_SHAS[onDiskB];
    }
  });

  it('mixed historical + unknown SHAs produce both calls-to-action', async () => {
    const v1Dir = join(tmp, 'OutdatedA');
    const v2Dir = join(tmp, 'TamperedB');
    mkdirSync(v1Dir, { recursive: true });
    mkdirSync(v2Dir, { recursive: true });
    const onDiskA = writeLauncherAndComputeSha(v1Dir, '// historical launcher');
    writeLauncherAndComputeSha(v2Dir, '// unknown content');

    const { HISTORICAL_LAUNCHER_SHAS } = await import('../../src/lib/notices/launcher-history.js');
    HISTORICAL_LAUNCHER_SHAS[onDiskA] = 'pre-2.8.0';

    try {
      const cfgPath = join(tmp, '.claude.json');
      writeCfg(cfgPath, {
        OutdatedA: { dir: v1Dir, hash: 'b'.repeat(64) },
        TamperedB: { dir: v2Dir, hash: 'c'.repeat(64) },
      });

      const lines: string[] = [];
      await preflightAllVaults(cfgPath, arrayLogger(lines));

      expect(lines.some(l => /2 vault\(s\) have launcher SHA mismatches/i.test(l))).toBe(true);
      expect(lines.some(l => /OutdatedA.*outdated/i.test(l))).toBe(true);
      expect(lines.some(l => /TamperedB.*possible tampering/i.test(l))).toBe(true);
      expect(lines.some(l => /vaultkit update --all/i.test(l))).toBe(true);
      expect(lines.some(l => /vaultkit verify <name>/i.test(l))).toBe(true);
    } finally {
      delete HISTORICAL_LAUNCHER_SHAS[onDiskA];
    }
  });

  it('VAULTKIT_NO_LAUNCHER_PREFLIGHT=1 disables the check', async () => {
    process.env.VAULTKIT_NO_LAUNCHER_PREFLIGHT = '1';
    const vaultDir = join(tmp, 'WouldWarnVault');
    mkdirSync(vaultDir, { recursive: true });
    writeLauncherAndComputeSha(vaultDir, '// random unknown content');
    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { WouldWarnVault: { dir: vaultDir, hash: 'b'.repeat(64) } });

    const lines: string[] = [];
    await preflightAllVaults(cfgPath, arrayLogger(lines));
    expect(lines).toEqual([]);
  });
});
