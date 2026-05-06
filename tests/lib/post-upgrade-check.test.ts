import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { arrayLogger } from '../helpers/logger.js';
import { writeCfg } from '../helpers/registry.js';

// homedir() is read at module-load time to compute CACHE_PATH. Mock it so
// the post-upgrade cache lives in a tmp dir (matches update-check.test.ts).
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>();
  const { mkdtempSync } = await import('node:fs');
  const home = mkdtempSync(join(real.tmpdir(), 'vk-post-upgrade-home-'));
  return { ...real, homedir: () => home };
});

import { checkPostUpgrade, _CACHE_PATH } from '../../src/lib/notices/post-upgrade-check.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vk-post-upgrade-test-'));
  rmSync(_CACHE_PATH, { force: true });
  delete process.env.VAULTKIT_NO_UPDATE_CHECK;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(_CACHE_PATH, { force: true });
  delete process.env.VAULTKIT_NO_UPDATE_CHECK;
});

function writeLauncherAndComputeSha(dir: string, content: string): string {
  writeFileSync(join(dir, '.mcp-start.js'), content, 'utf8');
  return createHash('sha256').update(content).digest('hex');
}

describe('checkPostUpgrade', () => {
  it('first run (no cache) silently records the version and emits no notice', async () => {
    const lines: string[] = [];
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');

    await checkPostUpgrade('2.9.0', cfgPath, arrayLogger(lines));

    expect(lines).toEqual([]);
    const cached = JSON.parse(readFileSync(_CACHE_PATH, 'utf8')) as { lastSeenVersion: string };
    expect(cached.lastSeenVersion).toBe('2.9.0');
  });

  it('same-version invocation emits no notice', async () => {
    writeFileSync(_CACHE_PATH, JSON.stringify({ lastSeenVersion: '2.9.0' }), 'utf8');
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');

    const lines: string[] = [];
    await checkPostUpgrade('2.9.0', cfgPath, arrayLogger(lines));

    expect(lines).toEqual([]);
  });

  it('version-changed run with all vaults up to date prints "all vaults up to date"', async () => {
    writeFileSync(_CACHE_PATH, JSON.stringify({ lastSeenVersion: '2.8.0' }), 'utf8');

    const vaultDir = join(tmp, 'GoodVault');
    mkdirSync(vaultDir, { recursive: true });
    const realSha = writeLauncherAndComputeSha(vaultDir, '// up-to-date launcher');

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { GoodVault: { dir: vaultDir, hash: realSha } });

    const lines: string[] = [];
    await checkPostUpgrade('2.9.0', cfgPath, arrayLogger(lines));

    expect(lines.some(l => /upgraded from 2\.8\.0 to 2\.9\.0/i.test(l))).toBe(true);
    expect(lines.some(l => /up to date/i.test(l))).toBe(true);
    // 3.0: post-upgrade now points at `vaultkit doctor --fix --all`
    // (not the deprecated `vaultkit update --all`).
    expect(lines.some(l => /vaultkit doctor --fix --all/i.test(l))).toBe(false);

    // Cache must update so the notice does not repeat.
    const cached = JSON.parse(readFileSync(_CACHE_PATH, 'utf8')) as { lastSeenVersion: string };
    expect(cached.lastSeenVersion).toBe('2.9.0');
  });

  it('version-changed run with historical-SHA vault enumerates stale vaults and points at doctor --fix --all', async () => {
    writeFileSync(_CACHE_PATH, JSON.stringify({ lastSeenVersion: '2.8.0' }), 'utf8');

    const vaultDir = join(tmp, 'OutdatedVault');
    mkdirSync(vaultDir, { recursive: true });
    const onDiskSha = writeLauncherAndComputeSha(vaultDir, '// pretend pre-2.9.0 launcher');

    // Inject the on-disk SHA into the historical table so classify
    // returns 'historical' regardless of platform line-ending quirks.
    const { HISTORICAL_LAUNCHER_SHAS } = await import('../../src/lib/notices/launcher-history.js');
    HISTORICAL_LAUNCHER_SHAS[onDiskSha] = 'pre-2.9.0';

    try {
      const cfgPath = join(tmp, '.claude.json');
      // Pin a different "current" hash so the comparison fires mismatch.
      writeCfg(cfgPath, { OutdatedVault: { dir: vaultDir, hash: 'b'.repeat(64) } });

      const lines: string[] = [];
      await checkPostUpgrade('2.9.0', cfgPath, arrayLogger(lines));

      expect(lines.some(l => /upgraded from 2\.8\.0 to 2\.9\.0/i.test(l))).toBe(true);
      expect(lines.some(l => /1 vault\(s\) need launcher migration/i.test(l))).toBe(true);
      expect(lines.some(l => /OutdatedVault.*pre-2\.9\.0/i.test(l))).toBe(true);
      // 3.0: replaced `vaultkit update --all` with `vaultkit doctor --fix --all`.
      expect(lines.some(l => /vaultkit doctor --fix --all/i.test(l))).toBe(true);
    } finally {
      delete HISTORICAL_LAUNCHER_SHAS[onDiskSha];
    }
  });

  it('version-changed run with unknown-SHA vault calls out possible tampering', async () => {
    writeFileSync(_CACHE_PATH, JSON.stringify({ lastSeenVersion: '2.8.0' }), 'utf8');

    const vaultDir = join(tmp, 'UnknownVault');
    mkdirSync(vaultDir, { recursive: true });
    writeLauncherAndComputeSha(vaultDir, '// random unknown content');

    const cfgPath = join(tmp, '.claude.json');
    writeCfg(cfgPath, { UnknownVault: { dir: vaultDir, hash: 'b'.repeat(64) } });

    const lines: string[] = [];
    await checkPostUpgrade('2.9.0', cfgPath, arrayLogger(lines));

    expect(lines.some(l => /matching no known vaultkit version/i.test(l))).toBe(true);
    // 3.0: replaced `vaultkit verify <name>` with `vaultkit doctor <name> --fix --force`.
    expect(lines.some(l => /vaultkit doctor.*--fix --force/i.test(l))).toBe(true);
  });

  it('VAULTKIT_NO_UPDATE_CHECK=1 disables the notice entirely', async () => {
    writeFileSync(_CACHE_PATH, JSON.stringify({ lastSeenVersion: '2.8.0' }), 'utf8');
    process.env.VAULTKIT_NO_UPDATE_CHECK = '1';

    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), 'utf8');

    const lines: string[] = [];
    await checkPostUpgrade('2.9.0', cfgPath, arrayLogger(lines));

    expect(lines).toEqual([]);
    // Cache is also untouched — gate fires before any state mutation.
    const cached = JSON.parse(readFileSync(_CACHE_PATH, 'utf8')) as { lastSeenVersion: string };
    expect(cached.lastSeenVersion).toBe('2.8.0');
  });

  it('cache is updated even when subsequent vault enumeration throws (no infinite-notice loop)', async () => {
    writeFileSync(_CACHE_PATH, JSON.stringify({ lastSeenVersion: '2.8.0' }), 'utf8');

    // Corrupt the registry so getAllVaults throws.
    const cfgPath = join(tmp, '.claude.json');
    writeFileSync(cfgPath, '{ this is not json', 'utf8');

    const lines: string[] = [];
    await checkPostUpgrade('2.9.0', cfgPath, arrayLogger(lines));

    expect(lines.some(l => /upgraded from 2\.8\.0 to 2\.9\.0/i.test(l))).toBe(true);
    expect(lines.some(l => /could not enumerate.*doctor/i.test(l))).toBe(true);

    const cached = JSON.parse(readFileSync(_CACHE_PATH, 'utf8')) as { lastSeenVersion: string };
    expect(cached.lastSeenVersion).toBe('2.9.0');
  });
});
